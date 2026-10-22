import { and, asc, eq, like, lt, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/client.js";
import { resources, pendingCleanup } from "../db/schema.js";
import {
  NETWORK_PASSPHRASE,
  pollTransactionStatus,
  registryClient,
  registryKeypair,
  resourceExists,
} from "../services/registryClient.js";
import { deleteFile, downloadFile, uploadFile } from "../storage/supabaseStorage.js";
import { MAX_THUMBNAIL_PIXELS } from "../lib/uploadValidation.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";

const WORKER_INTERVAL_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_CLEANUP_ATTEMPTS = 5;
const THUMBNAIL_WIDTH = 320;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startRetryPendingWorker(): void {
  getLogger().info(
    { event: "retry_worker_start", intervalMs: WORKER_INTERVAL_MS },
    "starting retry-pending worker",
  );

  tick();
  intervalHandle = setInterval(tick, WORKER_INTERVAL_MS);
}

export function stopRetryPendingWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) {
    getLogger().debug(
      { event: "retry_worker_tick_skipped" },
      "previous retry worker tick still running; skipping",
    );
    return;
  }

  inFlight = true;
  try {
    // Each pass handles its own errors, so one failing never starves the others.
    await processStuckRegistrations();
    await processCleanupJobs();
    await processThumbnailJobs();
  } finally {
    inFlight = false;
  }
}

async function processStuckRegistrations(): Promise<void> {
  try {
    const cutoff = sql`NOW() - INTERVAL '5 minutes'`;

    const stuck = await db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.onchainStatus, "pending"),
          lt(resources.onchainPendingSince, cutoff),
        ),
      )
      .limit(config.RETRY_WORKER_BATCH_SIZE);

    if (stuck.length === 0) return;

    getLogger().info(
      { event: "retry_worker_tick", stuckCount: stuck.length },
      "found stuck resources to retry",
    );

    for (const resource of stuck) {
      try {
        await withTimeout(
          retryResource(resource),
          config.RETRY_WORKER_ITEM_TIMEOUT_MS,
          resource.id,
        );
      } catch (err) {
        // A timed-out item must not abort the rest of the batch.
        getLogger().error({ event: "retry_worker_item_error", resourceId: resource.id, err }, "retry item failed");
      }
    }
  } catch (err) {
    getLogger().error({ event: "retry_worker_tick_error", err }, "retry worker tick failed");
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, resourceId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`retryResource timed out after ${ms}ms for ${resourceId}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processCleanupJobs(): Promise<void> {
  const log = getLogger();
  try {
    const jobs = await db
      .select()
      .from(pendingCleanup)
      .orderBy(asc(pendingCleanup.createdAt))
      .limit(config.RETRY_WORKER_BATCH_SIZE);

    for (const job of jobs) {
      try {
        await deleteFile(job.storagePath);
        await db.delete(pendingCleanup).where(eq(pendingCleanup.id, job.id));
        log.info(
          { event: "cleanup_job_done", jobId: job.id, storagePath: job.storagePath },
          "pending cleanup job completed",
        );
      } catch (err: any) {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_CLEANUP_ATTEMPTS) {
          await db.delete(pendingCleanup).where(eq(pendingCleanup.id, job.id));
          log.error(
            {
              event: "cleanup_job_dropped",
              jobId: job.id,
              storagePath: job.storagePath,
              attempts,
              err: err?.message ?? String(err),
            },
            "pending cleanup job dropped after max attempts",
          );
        } else {
          await db
            .update(pendingCleanup)
            .set({ attempts })
            .where(eq(pendingCleanup.id, job.id));
          log.warn(
            {
              event: "cleanup_job_failed",
              jobId: job.id,
              storagePath: job.storagePath,
              attempts,
              err: err?.message ?? String(err),
            },
            "pending cleanup job failed; will retry",
          );
        }
      }
    }
  } catch (err) {
    log.error({ event: "cleanup_pass_error", err }, "cleanup processing pass failed");
  }
}

async function processThumbnailJobs(): Promise<void> {
  const log = getLogger();
  try {
    const pending = await db
      .select()
      .from(resources)
      .where(and(eq(resources.thumbnailStatus, "pending"), like(resources.mimeType, "image/%")))
      .limit(config.RETRY_WORKER_BATCH_SIZE);

    for (const resource of pending) {
      const rlog = log.child({ resourceId: resource.id });
      try {
        if (!resource.storagePath) throw new Error("resource has no stored file");
        const original = await downloadFile(resource.storagePath);
        // limitInputPixels rejects decompression bombs before decoding (#89).
        const thumbnail = await sharp(original.buffer, { limitInputPixels: MAX_THUMBNAIL_PIXELS })
          .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
          .jpeg()
          .toBuffer();

        // Must match the path GET /resources/:id/thumbnail reads.
        const filename = resource.storagePath.split("/").pop();
        const thumbnailPath = await uploadFile(resource.id, thumbnail, `thumb_${filename}`, "image/jpeg");

        await db
          .update(resources)
          .set({ thumbnailPath, thumbnailStatus: "ready" })
          .where(eq(resources.id, resource.id));

        rlog.info(
          { event: "thumbnail_generated", thumbnailPath },
          "thumbnail generated",
        );
      } catch (err: any) {
        await db
          .update(resources)
          .set({ thumbnailStatus: "failed" })
          .where(eq(resources.id, resource.id));
        rlog.error(
          { event: "thumbnail_failed", err: err?.message ?? String(err) },
          "thumbnail generation failed",
        );
      }
    }
  } catch (err) {
    log.error({ event: "thumbnail_pass_error", err }, "thumbnail processing pass failed");
  }
}

async function retryResource(resource: typeof resources.$inferSelect): Promise<void> {
  const log = getLogger().child({ resourceId: resource.id });

  let attempts = 0;

  try {
    const [incremented] = await db
      .update(resources)
      .set({ onchainAttempts: sql`${resources.onchainAttempts} + 1` })
      .where(eq(resources.id, resource.id))
      .returning({ onchainAttempts: resources.onchainAttempts });

    attempts = incremented?.onchainAttempts ?? 0;

    if (attempts > MAX_RETRY_ATTEMPTS) {
      log.warn(
        { event: "retry_exhausted", attempts },
        "max retry attempts exhausted; marking as failed",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
      return;
    }

    if (resource.onchainTxHash) {
      // One immediate lookup; the next tick re-checks if it's still pending.
      const { status } = await pollTransactionStatus(resource.onchainTxHash, {
        maxAttempts: 1,
        intervalMs: 0,
      });

      if (status === "PENDING") {
        log.info(
          { event: "retry_still_pending", txHash: resource.onchainTxHash },
          "stored transaction still pending; leaving resource pending",
        );
        return;
      }

      if (status === "SUCCESS") {
        await db
          .update(resources)
          .set({ onchainStatus: "registered" })
          .where(eq(resources.id, resource.id));
        log.info(
          { event: "retry_confirmed", txHash: resource.onchainTxHash },
          "stored transaction confirmed; marking resource registered",
        );
        return;
      }

      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
      log.warn(
        { event: "retry_tx_failed", txHash: resource.onchainTxHash },
        "stored transaction failed on-chain; marking resource failed",
      );
      return;
    }

    const exists = await resourceExists(resource.id);
    if (exists) {
      log.info(
        { event: "retry_already_registered" },
        "resource already registered on-chain; updating DB",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "registered" })
        .where(eq(resources.id, resource.id));
      return;
    }

    // Never register under a creator other than the resource's wallet address,
    // and the server can only sign for its own registry key. Any other creator
    // must sign client-side: mark it failed so the owner can resubmit a signed
    // XDR via POST /resources/:id/register (failed is retryable there).
    const creator = resource.walletAddress;
    if (creator !== registryKeypair.publicKey()) {
      log.warn(
        { event: "retry_needs_client_signature" },
        "registration requires the creator's signature; marking failed for client resubmission",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
      return;
    }

    log.info(
      { event: "retry_attempt", attempt: attempts, maxAttempts: MAX_RETRY_ATTEMPTS },
      "re-attempting on-chain registration",
    );

    const priceStroops = Math.round(parseFloat(resource.price) * 10_000_000);
    const metadata = JSON.stringify({
      title: resource.title,
      description: resource.description ?? "",
      contentHash: resource.contentHash,
    });

    const tx = await registryClient.register({
      creator,
      id: resource.id,
      price: BigInt(priceStroops),
      metadata,
      tags: [],
    });

    const { Transaction } = await import("@stellar/stellar-sdk");
    const sent = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const stellarTx = new Transaction(xdr, NETWORK_PASSPHRASE);
        stellarTx.sign(registryKeypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
    const txHash = sent?.sendTransactionResponse?.hash ?? "";

    await db
      .update(resources)
      .set({
        onchainStatus: "registered",
        ...(txHash ? { onchainTxHash: txHash } : {}),
      })
      .where(eq(resources.id, resource.id));

    log.info(
      { event: "retry_success", txHash: txHash || undefined },
      "on-chain registration retry succeeded",
    );
  } catch (err: any) {
    log.error(
      { event: "retry_error", err: err?.message ?? String(err) },
      "on-chain registration retry failed",
    );

    if (attempts > MAX_RETRY_ATTEMPTS) {
      log.warn(
        { event: "retry_exhausted_on_error", attempts },
        "max retry attempts exhausted after error; marking as failed",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
    }
  }
}
