import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { getLogger } from "../lib/logger.js";
import type { WebhookEvent } from "../schemas/webhooks.js";

export type { WebhookEvent } from "../schemas/webhooks.js";

export interface WebhookPayload {
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
}

const BASE_RETRY_DELAY_MS = 1_000;

export const SIGNATURE_HEADER = "X-SynapsVault-Signature";

/** Hex HMAC-SHA256 of the raw request body, keyed by the publisher's webhook secret. */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs the payload, retrying failures with exponential backoff
 * (1s, 2s, 4s, …) up to WEBHOOK_MAX_ATTEMPTS. Never throws.
 */
export async function deliver(
  target: Pick<WebhookTarget, "url" | "secret">,
  payload: WebhookPayload,
  options: { maxAttempts?: number } = {},
): Promise<DeliveryResult> {
  const log = getLogger();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SynapsVault-Webhooks/1.0",
    "X-SynapsVault-Event": payload.event,
    "X-SynapsVault-Timestamp": payload.timestamp,
  };
  if (target.secret) headers[SIGNATURE_HEADER] = signPayload(body, target.secret);

  const maxAttempts = Math.max(1, options.maxAttempts ?? config.WEBHOOK_MAX_ATTEMPTS);
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS),
      });
      lastStatus = res.status;
      if (res.ok) {
        log.info({ event: "webhook_delivered", webhookEvent: payload.event, attempt }, "webhook delivered");
        return { delivered: true, attempts: attempt, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    log.warn({ event: "webhook_attempt_failed", webhookEvent: payload.event, attempt, error: lastError }, "webhook attempt failed");
    if (attempt < maxAttempts) await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
  }

  log.error({ event: "webhook_failed", webhookEvent: payload.event, attempts: maxAttempts, error: lastError }, "webhook delivery failed");
  return { delivered: false, attempts: maxAttempts, status: lastStatus, error: lastError };
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
  return {
    publisherId,
    url: row.url,
    secret: row.secret ?? undefined,
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
    return await deliver(target, { event, timestamp: new Date().toISOString(), data });
  } catch (err) {
    getLogger().error({ err, event: "webhook_emit_error", publisherId }, "webhook emit failed");
    return null;
  }
}

const PRIVATE_IPV4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Basic SSRF guard for publisher-supplied webhook URLs: rejects loopback,
 * link-local and private-network literals (and requires https in production).
 * Returns a human-readable problem, or null when the URL is acceptable.
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
