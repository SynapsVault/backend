import { getLogger } from "../lib/logger.js";

export type WebhookEvent =
  | "resource.purchased"
  | "resource.listed"
  | "resource.delisted"
  | "payment.received"
  | "payment.refunded"
  | "subscription.started"
  | "subscription.renewed"
  | "subscription.cancelled";

export interface WebhookPayload {
  event:     WebhookEvent;
  timestamp: string;
  data:      Record<string, unknown>;
}

interface Target { url: string; secret?: string; }

const log        = getLogger();
const DELAYS     = [1_000, 5_000, 15_000];

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw",
    new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Buffer.from(sig).toString("hex");
}

export async function deliver(t: Target, payload: WebhookPayload, attempt = 0): Promise<void> {
  const body    = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-SynapsVault-Event":     payload.event,
    "X-SynapsVault-Timestamp": payload.timestamp,
  };
  if (t.secret) headers["X-SynapsVault-Signature"] = await sign(body, t.secret);

  try {
    const res = await fetch(t.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info({ url: t.url, event: payload.event }, "webhook ok");
  } catch (err) {
    log.warn({ url: t.url, attempt, err }, "webhook failed");
    if (attempt < DELAYS.length) {
      await new Promise((r) => setTimeout(r, DELAYS[attempt]));
      return deliver(t, payload, attempt + 1);
    }
    log.error({ url: t.url, event: payload.event }, "webhook max retries exceeded");
  }
}

export function emit(targets: Target[], event: WebhookEvent, data: Record<string, unknown>) {
  const payload: WebhookPayload = { event, timestamp: new Date().toISOString(), data };
  targets.forEach((t) => deliver(t, payload));
}
