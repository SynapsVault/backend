/**
 * Webhook Outbox Worker (#48)
 *
 * Polls the `webhook_outbox` table for pending rows and delivers them with
 * exponential backoff. Because deliveries are persisted in Postgres before
 * the first attempt, a process crash during retries does not lose the event —
 * the next worker run picks it up where it left off.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { webhookOutbox } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { deliver } from "../services/webhookService.js";
import { resolveTarget } from "../services/webhookService.js";
import type { WebhookPayload } from "../services/webhookService.js";

const WORKER_INTERVAL_MS = 10_000; // poll every 10 s
const BASE_BACKOFF_MS = 1_000;     // 1 s, 2 s, 4 s, …

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startWebhookOutboxWorker(): void {
  getLogger().info(
    { event: "webhook_outbox_worker_start", intervalMs: WORKER_INTERVAL_MS },
    "starting webhook outbox worker",
  );
  tick();
  intervalHandle = setInterval(tick, WORKER_INTERVAL_MS);
}

export function stopWebhookOutboxWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await processPending();
  } catch (err) {
    getLogger().error({ err, event: "webhook_outbox_tick_error" }, "webhook outbox worker tick failed");
  } finally {
    inFlight = false;
  }
}

async function processPending(): Promise<void> {
  const log = getLogger();
  const batchSize = config.RETRY_WORKER_BATCH_SIZE;

  // Fetch pending rows whose next_attempt_at has elapsed.
  const rows = await db
    .select()
    .from(webhookOutbox)
    .where(
      and(
        eq(webhookOutbox.status, "pending"),
        lte(webhookOutbox.nextAttemptAt, sql`now()`),
      ),
    )
    .limit(batchSize);

  if (rows.length === 0) return;

  log.debug({ event: "webhook_outbox_batch", count: rows.length }, "processing outbox batch");

  for (const row of rows) {
    try {
      await processRow(row);
    } catch (err) {
      log.error({ err, event: "webhook_outbox_row_error", outboxId: row.id }, "outbox row processing failed");
    }
  }
}

async function processRow(row: typeof webhookOutbox.$inferSelect): Promise<void> {
  const log = getLogger();
  const attempt = row.attempts + 1;

  const target = await resolveTarget(row.publisherId);
  if (!target) {
    // Publisher has disabled / removed their webhook — mark as failed.
    await db
      .update(webhookOutbox)
      .set({ status: "failed", lastError: "publisher webhook not configured", attempts: attempt })
      .where(eq(webhookOutbox.id, row.id));
    return;
  }

  const payload = row.payload as WebhookPayload;
  const result = await deliver(target, payload, { maxAttempts: 1 });

  if (result.delivered) {
    await db
      .update(webhookOutbox)
      .set({
        status: "delivered",
        attempts: attempt,
        deliveredAt: new Date(),
        deliveryId: result.status !== undefined ? row.deliveryId : row.deliveryId,
      })
      .where(eq(webhookOutbox.id, row.id));

    log.info(
      { event: "webhook_outbox_delivered", outboxId: row.id, publisherId: row.publisherId },
      "outbox webhook delivered",
    );
    return;
  }

  // Delivery failed.
  const maxAttempts = row.maxAttempts;
  if (attempt >= maxAttempts) {
    await db
      .update(webhookOutbox)
      .set({ status: "failed", attempts: attempt, lastError: result.error ?? "unknown error" })
      .where(eq(webhookOutbox.id, row.id));

    log.error(
      { event: "webhook_outbox_exhausted", outboxId: row.id, publisherId: row.publisherId, error: result.error },
      "outbox webhook exhausted all attempts",
    );
    return;
  }

  // Schedule next attempt with exponential backoff.
  const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
  const nextAttemptAt = new Date(Date.now() + backoffMs);
  await db
    .update(webhookOutbox)
    .set({ attempts: attempt, lastError: result.error ?? "unknown error", nextAttemptAt })
    .where(eq(webhookOutbox.id, row.id));

  log.warn(
    { event: "webhook_outbox_retry_scheduled", outboxId: row.id, attempt, nextAttemptAt },
    "outbox webhook retry scheduled",
  );
}
