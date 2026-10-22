import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pendingCleanup, resources } from "../db/schema.js";

// Durable job queue for background work, backed by Postgres so jobs survive
// restarts. The retry worker (src/workers/retryPendingWorker.ts) drains both.

/**
 * Queue a storage object for deletion after an inline delete failed (#87).
 */
export async function enqueueStorageCleanup(job: {
  resourceId: string;
  storagePath: string;
}): Promise<void> {
  await db.insert(pendingCleanup).values({
    resourceId: job.resourceId,
    storagePath: job.storagePath,
  });
}

/**
 * Mark an image resource as awaiting thumbnail generation (#89). The worker
 * re-reads the original from storage, so the upload buffer isn't persisted.
 */
export async function enqueueThumbnailJob(job: {
  resourceId: string;
  fileBuffer?: Buffer;
  filename?: string;
}): Promise<void> {
  await db
    .update(resources)
    .set({ thumbnailStatus: "pending" })
    .where(eq(resources.id, job.resourceId));
}
