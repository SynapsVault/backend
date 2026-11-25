/**
 * Webhook Outbox Worker (#48)
 *
 * Polls the `webhook_outbox` table for pending rows and delivers them with
 * exponential backoff. Because deliveries are persisted in Postgres before
 * the first attempt, a process crash during retries does not lose the event —
 * the next worker run picks it up where it left off.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { webhookOutbox } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { deliver } from "../services/webhookService.js";
import { resolveTarget } from "../services/webhookService.js";
import type { WebhookPayload } from "../services/webhookService.js";
import { webhookOutboxExhaustedTotal } from "../lib/metrics.js";
import { recordWorkerPass } from "../lib/workerStatus.js";

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
    await cleanupExpiredOutbox();
    recordWorkerPass("webhookOutbox");
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
  const deliveryId = row.deliveryId ?? `wh_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!row.deliveryId) {
    await db.update(webhookOutbox).set({ deliveryId }).where(eq(webhookOutbox.id, row.id));
  }
  const result = await deliver(target, payload, { maxAttempts: 1, deliveryId });

  if (result.delivered) {
    await db
      .update(webhookOutbox)
      .set({
        status: "delivered",
        attempts: attempt,
        deliveredAt: new Date(),
        deliveryId,
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
  if (result.retryable === false || attempt >= maxAttempts) {
    await db
      .update(webhookOutbox)
      .set({ status: "failed", attempts: attempt, lastError: result.error ?? "unknown error" })
      .where(eq(webhookOutbox.id, row.id));

    log.error(
      { event: "webhook_outbox_exhausted", outboxId: row.id, publisherId: row.publisherId, error: result.error },
      "outbox webhook exhausted all attempts",
    );
    webhookOutboxExhaustedTotal.inc();
    return;
  }

  // Schedule next attempt with exponential backoff.
  const backoffMs = result.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt;
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

/**
 * Replays a failed terminal webhook outbox row (#156).
 * Restricted to the owning publisher; preserves event identity, audits replay,
 * and rejects delivered or foreign rows.
 */
export async function replayWebhookDelivery(
  outboxId: string,
  publisherId: string,
): Promise<typeof webhookOutbox.$inferSelect> {
  const log = getLogger();

  const [row] = await db
    .select()
    .from(webhookOutbox)
    .where(eq(webhookOutbox.id, outboxId))
    .limit(1);

  if (!row) {
    throw new AppError("NOT_FOUND", "Webhook delivery not found");
  }

  if (row.publisherId !== publisherId) {
    throw new AppError("FORBIDDEN", "Not authorized to replay foreign webhook delivery");
  }

  if (row.status === "delivered") {
    throw new AppError("CONFLICT", "Cannot replay already delivered webhook");
  }

  if (row.status === "pending") {
    throw new AppError("CONFLICT", "Cannot replay pending webhook delivery");
  }

  const [updated] = await db
    .update(webhookOutbox)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: sql`now()`,
      lastError: null,
    })
    .where(eq(webhookOutbox.id, outboxId))
    .returning();

  log.info(
    { event: "webhook_outbox_replay", outboxId, publisherId, webhookEvent: row.event },
    "outbox webhook replayed",
  );

  return updated;
}

/**
 * Deletes terminal outbox rows (delivered or failed) after a configurable retention interval (#157).
 * Retains pending rows and returns the number of cleaned rows.
 */
export async function cleanupExpiredOutbox(
  options: { retentionDays?: number; batchSize?: number } = {},
): Promise<number> {
  const log = getLogger();
  const retentionDays = options.retentionDays ?? config.WEBHOOK_OUTBOX_RETENTION_DAYS;
  const batchSize = options.batchSize ?? config.WEBHOOK_OUTBOX_CLEANUP_BATCH_SIZE;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Find terminal rows older than cutoff (retains pending rows)
  const expired = await db
    .select({ id: webhookOutbox.id })
    .from(webhookOutbox)
    .where(
      and(
        inArray(webhookOutbox.status, ["delivered", "failed"]),
        or(
          lte(webhookOutbox.deliveredAt, cutoff),
          and(isNull(webhookOutbox.deliveredAt), lte(webhookOutbox.createdAt, cutoff)),
        ),
      ),
    )
    .limit(batchSize);

  if (expired.length === 0) return 0;

  const expiredIds = expired.map((r) => r.id);
  await db.delete(webhookOutbox).where(inArray(webhookOutbox.id, expiredIds));

  log.info(
    { event: "webhook_outbox_cleanup", count: expired.length, retentionDays },
    "expired terminal webhook outbox rows cleaned",
  );

  return expired.length;
}
