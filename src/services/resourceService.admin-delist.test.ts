import { describe, it, expect, beforeEach, vi } from "vitest";

// Captures the values passed to `.set(...)` on the update chain.
const { setCalls, returnedRows } = vi.hoisted(() => ({
  setCalls: [] as Array<Record<string, unknown>>,
  returnedRows: { rows: [] as Array<Record<string, unknown>> },
}));

// Insert / delete bookkeeping for the createFileResource tests.
const { insertedRows, deletedIds, insertValues } = vi.hoisted(() => ({
  insertedRows: { rows: [] as Array<Record<string, unknown>> },
  deletedIds: [] as Array<unknown>,
  insertValues: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve(returnedRows.rows),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: () => Promise.resolve(insertedRows.rows),
        };
      },
    }),
    delete: () => ({
      where: (condition: unknown) => {
        deletedIds.push(condition);
        return Promise.resolve();
      },
    }),
  },
}));

const { uploadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));

vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: uploadFileMock,
  deleteFile: deleteFileMock,
}));

// Thumbnail worker mock: records calls and lets tests control completion.
const { thumbnailCalls, thumbnailState } = vi.hoisted(() => ({
  thumbnailCalls: [] as Array<Record<string, unknown>>,
  thumbnailState: {
    resolve: null as null | (() => void),
    reject: null as null | ((err: unknown) => void),
    promise: null as null | Promise<void>,
  },
}));

// The service imports { enqueueStorageCleanup, enqueueThumbnailJob } from './workerQueue.js'
vi.mock("./workerQueue.js", () => ({
  enqueueStorageCleanup: vi.fn().mockResolvedValue(undefined),
  enqueueThumbnailJob: (input: Record<string, unknown>) => {
    thumbnailCalls.push(input);
    // Return the controlled promise so tests can resolve/reject as needed.
    return thumbnailState.promise ?? Promise.resolve();
  },
}));

vi.mock("./webhookService.js", () => ({
  emitToPublisher: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    CATALOG_CACHE_TTL_MS: 60_000,
    CATALOG_CACHE_MAX_KEYS: 500,
  },
}));

vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { adminDelistResource, createFileResource } from "./resourceService.js";

describe("adminDelistResource", () => {
  beforeEach(() => {
    setCalls.length = 0;
    insertValues.length = 0;
    returnedRows.rows = [];
  });

  it("delists and stamps adminDelistedAt so the resource cannot be relisted", async () => {
    returnedRows.rows = [{ id: "res-1" }];

    const before = Date.now();
    const result = await adminDelistResource("res-1");

    expect(result).toEqual({ id: "res-1" });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].listed).toBe(false);
    expect(setCalls[0].adminDelistedAt).toBeInstanceOf(Date);
    expect((setCalls[0].adminDelistedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("writes a moderation_events row with action, resource, reason and actor (#50)", async () => {
    returnedRows.rows = [{ id: "res-2" }];

    await adminDelistResource("res-2", { reason: "spam content", actor: "admin:abc123" });

    // The insert into moderation_events must follow the update.
    const moderationInsert = insertValues.find(
      (v) => v.action === "admin_delist" && v.resourceId === "res-2",
    );
    expect(moderationInsert).toBeDefined();
    expect(moderationInsert!.reason).toBe("spam content");
    expect(moderationInsert!.actor).toBe("admin:abc123");
  });

  it("uses default actor when no actor is provided", async () => {
    returnedRows.rows = [{ id: "res-3" }];

    await adminDelistResource("res-3");

    const moderationInsert = insertValues.find(
      (v) => v.action === "admin_delist" && v.resourceId === "res-3",
    );
    expect(moderationInsert).toBeDefined();
    expect(moderationInsert!.actor).toBe("admin");
    expect(moderationInsert!.reason).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    returnedRows.rows = [];

    expect(await adminDelistResource("missing")).toBeNull();
  });
});

describe("createFileResource", () => {
  // Minimal valid input matching the actual createFileResource signature.
  const validInput = {
    publisherId: "pub-1",
    title: "My Resource",
    description: "A description",
    price: "1.00",
    walletAddress: "GABCD1234",
    fileBuffer: Buffer.from("data"),
    filename: "cover.png",
    mimeType: "image/png",
  };

  beforeEach(() => {
    insertValues.length = 0;
    deletedIds.length = 0;
    insertedRows.rows = [];
    returnedRows.rows = [];
    thumbnailCalls.length = 0;
    thumbnailState.resolve = null;
    thumbnailState.reject = null;
    thumbnailState.promise = null;
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
  });

  it("leaves no row behind when the upload fails", async () => {
    insertedRows.rows = [{ id: "res-1", storagePath: null, mimeType: "image/png" }];
    uploadFileMock.mockRejectedValue(new Error("upload boom"));

    await expect(
      createFileResource(validInput),
    ).rejects.toThrow("upload boom");

    // The compensating delete must have run for the inserted row.
    expect(deletedIds).toHaveLength(1);
    expect(insertedRows.rows[0].id).toBe("res-1");
  });

  it("does not wait for thumbnail generation before resolving", async () => {
    const resource = { id: "res-1", storagePath: "path/cover.png", mimeType: "image/png" };
    insertedRows.rows = [resource];
    returnedRows.rows = [resource];
    uploadFileMock.mockResolvedValue("path/cover.png");
    // Thumbnail job resolves immediately.
    thumbnailState.promise = Promise.resolve();

    const result = await createFileResource(validInput);

    expect(result).toEqual(resource);
    // enqueueThumbnailJob was called for the image resource.
    expect(thumbnailCalls).toHaveLength(1);
  });

  it("rejects oversized images via the pixel limit in the worker", async () => {
    const resource = { id: "res-1", storagePath: "path/cover.png", mimeType: "image/png" };
    insertedRows.rows = [resource];
    returnedRows.rows = [resource];
    uploadFileMock.mockResolvedValue("path/cover.png");
    // Thumbnail job rejects — the service should catch and log, not throw.
    thumbnailState.promise = Promise.reject(new Error("Input image exceeds pixel limit"));

    // The function catches enqueueThumbnailJob errors and still resolves.
    const result = await createFileResource(validInput);
    expect(result).toEqual(resource);
    expect(thumbnailCalls).toHaveLength(1);
  });
});
