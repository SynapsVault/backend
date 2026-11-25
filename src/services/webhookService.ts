import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { promises as dns } from "node:dns";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { publishers, webhookOutbox } from "../db/schema.js";
import { getLogger } from "../lib/logger.js";
import { CURRENT_WEBHOOK_VERSION, type WebhookEvent } from "../schemas/webhooks.js";
import { decryptWebhookSecret } from "../utils/crypto.js";
import { webhookKeyring } from "../lib/secretKeys.js";

export type { WebhookEvent } from "../schemas/webhooks.js";
export { CURRENT_WEBHOOK_VERSION } from "../schemas/webhooks.js";

export interface WebhookPayload {
  version?: string;
  event: WebhookEvent | "webhook.test";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface WebhookTarget {
  publisherId: string;
  url: string;
  secret?: string;
  /** Subscribed events; empty means every event. */
  events: WebhookEvent[];
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export const SIGNATURE_HEADER = "X-SynapsVault-Signature";
export const DELIVERY_ID_HEADER = "X-SynapsVault-Id";

const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

/** Parses Retry-After seconds or an HTTP date, clamped to a safe one-day bound. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - now), MAX_RETRY_AFTER_MS);
}

/**
 * Hex HMAC-SHA256 of `${timestamp}.${body}`, keyed by the publisher's webhook
 * secret (#45). Including the timestamp in the signed payload means a receiver
 * can reject a replayed delivery whose timestamp falls outside a freshness window.
 */
export function signPayload(body: string, secret: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs the payload, retrying failures with exponential backoff
 * (1s, 2s, 4s, …) up to WEBHOOK_MAX_ATTEMPTS. Never throws.
 *
 * DNS is resolved before each attempt to guard against DNS rebinding (#46):
 * if any resolved address is private/link-local the delivery is aborted.
 */
export async function deliver(
  target: Pick<WebhookTarget, "url" | "secret">,
  payload: WebhookPayload,
  options: { maxAttempts?: number; deliveryId?: string } = {},
): Promise<DeliveryResult> {
  const log = getLogger();
  const body = JSON.stringify(payload);
  // Each delivery gets a unique, stable id so receivers can deduplicate
  // retried deliveries (#45).
  const deliveryId = options.deliveryId ?? `wh_${randomBytes(16).toString("hex")}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SynapsVault-Webhooks/1.0",
    "X-SynapsVault-Event": payload.event,
    "X-SynapsVault-Timestamp": payload.timestamp,
    [DELIVERY_ID_HEADER]: deliveryId,
  };
  // Sign ${timestamp}.${body} so the timestamp is covered by the HMAC (#45).
  if (target.secret) headers[SIGNATURE_HEADER] = signPayload(body, target.secret, payload.timestamp);

  const maxAttempts = Math.max(1, options.maxAttempts ?? config.WEBHOOK_MAX_ATTEMPTS);
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  // Parse the URL once — we need the hostname for DNS checks (#46).
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target.url);
  } catch {
    return { delivered: false, attempts: 0, error: "invalid webhook URL" };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Include DNS resolution in the overall per-attempt deadline (#154).
    const attemptSignal = AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS);

    // Resolve hostname before each attempt to guard against DNS rebinding (#46).
    try {
      const addrs = await resolveHostname(parsedUrl.hostname, attemptSignal);
      const blocked = addrs.find((ip) => isPrivateIp(ip));
      if (blocked) {
        log.warn(
          { event: "webhook_ssrf_blocked", url: target.url, ip: blocked },
          "webhook blocked: hostname resolves to a private IP (#46)",
        );
        return {
          delivered: false,
          attempts: attempt,
          error: `SSRF guard: ${parsedUrl.hostname} resolves to private IP ${blocked}`,
        };
      }
    } catch (resolveErr) {
      lastError = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
      log.warn({ event: "webhook_dns_error", url: target.url, attempt, error: lastError }, "webhook DNS resolution failed");
      if (attempt < maxAttempts) await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    let res: Response | undefined;
    try {
      res = await fetch(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: attemptSignal,
      });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        log.info({ event: "webhook_delivered", webhookEvent: payload.event, attempt }, "webhook delivered");
        return { delivered: true, attempts: attempt, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || PERMANENT_HTTP_STATUSES.has(res.status)) {
        return { delivered: false, attempts: attempt, status: res.status, error: lastError, retryable: false };
      }
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (attempt >= maxAttempts) {
        return { delivered: false, attempts: attempt, status: res.status, error: lastError, retryable: true, retryAfterMs };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (res) {
        await releaseResponseBody(res);
      }
    }

    log.warn({ event: "webhook_attempt_failed", webhookEvent: payload.event, attempt, error: lastError }, "webhook attempt failed");
    if (attempt < maxAttempts) await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
  }

  log.error({ event: "webhook_failed", webhookEvent: payload.event, attempts: maxAttempts, error: lastError }, "webhook delivery failed");
  return { delivered: false, attempts: maxAttempts, status: lastStatus, error: lastError, retryable: true };
}

function requestPinned(
  url: URL,
  address: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; retryAfter: string | null }> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, Host: url.host },
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] ?? null }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("webhook request timed out")));
    req.once("error", reject);
    req.end(body);
  });
}

/** Loads the publisher's enabled webhook target, or null when not configured. */
export async function resolveTarget(publisherId: string): Promise<WebhookTarget | null> {
  const [row] = await db
    .select({
      url: publishers.webhookUrl,
      secret: publishers.webhookSecret,
      events: publishers.webhookEvents,
      enabled: publishers.webhookEnabled,
    })
    .from(publishers)
    .where(eq(publishers.id, publisherId))
    .limit(1);

  if (!row || !row.enabled || !row.url) return null;

  // Decrypt the stored secret if an encryption key is configured (#47).
  let secret: string | undefined;
  if (row.secret) {
    const keyring = webhookKeyring();
    secret = keyring ? (decryptWebhookSecret(row.secret, keyring) ?? row.secret) : row.secret;
  }

  return {
    publisherId,
    url: row.url,
    secret,
    events: (row.events ?? []) as WebhookEvent[],
  };
}

/**
 * Delivers `event` to the publisher's webhook if they are subscribed to it.
 * Resolves once delivery finishes; never throws — callers should not await it
 * on a request's critical path.
 */
export async function emitToPublisher(
  publisherId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<DeliveryResult | null> {
  try {
    const target = await resolveTarget(publisherId);
    if (!target) return null;
    if (target.events.length > 0 && !target.events.includes(event)) return null;
    return await deliver(target, {
      version: CURRENT_WEBHOOK_VERSION,
      event,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch (err) {
    getLogger().error({ err, event: "webhook_emit_error", publisherId }, "webhook emit failed");
    return null;
  }
}

/**
 * Writes a webhook event to the persistent outbox so it survives restarts (#48).
 * The outbox worker picks it up and delivers it with exponential backoff.
 * Callers should use this instead of `emitToPublisher` on the request critical path.
 *
 * Returns the outbox row id, or null when the publisher has no active webhook
 * or is not subscribed to the event (fast-path skip, nothing enqueued).
 */
export async function enqueueWebhookEvent(
  publisherId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<string | null> {
  try {
    // Fast-path: skip publishers with no active webhook or not subscribed.
    const target = await resolveTarget(publisherId);
    if (!target) return null;
    if (target.events.length > 0 && !target.events.includes(event)) return null;

    const payload: WebhookPayload = {
      version: CURRENT_WEBHOOK_VERSION,
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const [row] = await db
      .insert(webhookOutbox)
      .values({
        publisherId,
        event,
        payload,
        maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
        deliveryId: `wh_${randomBytes(16).toString("hex")}`,
      })
      .returning({ id: webhookOutbox.id });

    getLogger().info(
      { event: "webhook_enqueued", outboxId: row?.id, publisherId, webhookEvent: event },
      "webhook event enqueued to outbox",
    );
    return row?.id ?? null;
  } catch (err) {
    getLogger().error({ err, event: "webhook_enqueue_error", publisherId }, "webhook enqueue failed");
    return null;
  }
}

const PRIVATE_IPV4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Returns true when the given IP address falls in a private, loopback,
 * link-local or otherwise non-routable range. Used to block SSRF at
 * delivery time after DNS resolution (#46).
 */
export function isPrivateIp(ip: string): boolean {
  // Strip IPv6-mapped IPv4 prefix (::ffff:a.b.c.d)
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();

  // IPv4 checks
  if (PRIVATE_IPV4.some((re) => re.test(normalized))) return true;

  // IPv6 loopback / unspecified
  if (normalized === "::1" || normalized === "::") return true;
  // Unique-local (fc00::/7 → fc and fd prefixes)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  // Link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  return false;
}

/**
 * Resolve the hostname of `url` and return all IP addresses. Throws when
 * the hostname cannot be resolved or when the attempt signal times out (#46, #154).
 */
export async function resolveHostname(hostname: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("DNS lookup timed out");
  }

  const lookupPromise = dns.lookup(hostname, { all: true, family: 0 }).then((addrs) => addrs.map((a) => a.address));
  if (!signal) return lookupPromise;

  return new Promise<string[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("DNS lookup timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    lookupPromise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Releases resources associated with a fetch response body (#155).
 * Drains up to 64KB so HTTP keep-alive connections can be reused,
 * or cancels the body stream/reader.
 */
export async function releaseResponseBody(res: Response | { body?: unknown }): Promise<void> {
  try {
    if (!res || !res.body) return;
    const body = res.body as any;
    if (typeof body.cancel === "function" && typeof body.getReader === "function") {
      const reader = body.getReader();
      let bytesRead = 0;
      try {
        while (bytesRead < 64 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value ? (value.byteLength ?? value.length ?? 0) : 0;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } else if (typeof body.cancel === "function") {
      await body.cancel().catch(() => {});
    }
  } catch {
    // Ignore errors during resource release
  }
}

/**
 * Basic SSRF guard for publisher-supplied webhook URLs: rejects loopback,
 * link-local and private-network literals (and requires https in production).
 * Returns a human-readable problem, or null when the URL is acceptable.
 *
 * NOTE: This check only inspects literal hostnames / IPs. A hostname that
 * resolves to a private address is blocked at delivery time by `deliver()`
 * which calls `resolveHostname` before sending the request (#46).
 */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "webhookUrl must be a valid URL";
  }
  if (url.protocol !== "https:" && (config.NODE_ENV === "production" || url.protocol !== "http:")) {
    return "webhookUrl must use https";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    PRIVATE_IPV4.some((re) => re.test(host)) ||
    host === "::" ||
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    host.startsWith("::ffff:")
  ) {
    return "webhookUrl must not point to a private or loopback address";
  }
  return null;
}
