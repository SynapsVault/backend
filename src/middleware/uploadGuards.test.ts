import { describe, it, expect, beforeAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";

// uploadGuards imports config; mock it so the test doesn't need a full env.
vi.mock("../config.js", () => ({
  config: {
    MAX_FILE_SIZE_MB: 1,
    MAX_CONCURRENT_UPLOADS: 6,
    ALLOWED_UPLOAD_MIME_TYPES: "application/pdf,image/png,text/plain",
  },
}));

vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/logger.js")>()),
  getRequestId: () => "test-request-id",
}));

import {
  singleFileUpload,
  validateUploadContentType,
  __getActiveUploadCount,
} from "./uploadGuards.js";
import { errorHandler } from "./errorHandler.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp(): Express {
  const app = express();
  app.post("/upload", singleFileUpload("file"), validateUploadContentType, (req, res) => {
    res.status(201).json({ ok: true, mimetype: req.file?.mimetype ?? null });
  });
  app.use(errorHandler);
  return app;
}

describe("upload guards middleware", () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("accepts an allow-listed file whose bytes match", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a disallowed content type with 415", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        filename: "a.zip",
        contentType: "application/zip",
      });
    expect(res.status).toBe(415);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects when declared type does not match detected bytes (415)", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PNG, { filename: "fake.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/does not match/i);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects oversized uploads with 413", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2MB > 1MB limit
    const res = await request(app)
      .post("/upload")
      .attach("file", big, { filename: "big.txt", contentType: "text/plain" });
    expect(res.status).toBe(413);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects malformed multipart bodies with 400", async () => {
    const res = await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=----broken")
      .send("not a valid multipart body");
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("passes through requests with no file", async () => {
    const res = await request(app).post("/upload").send();
    expect(res.status).toBe(201);
    expect(res.body.mimetype).toBeNull();
  });

  it("streams uploads to disk instead of buffering in memory", async () => {
    let capturedPath: string | undefined;
    let capturedBuffer: unknown;
    const probe = express();
    probe.post(
      "/upload",
      singleFileUpload("file"),
      validateUploadContentType,
      (req, res) => {
        capturedPath = req.file?.path;
        capturedBuffer = (req.file as unknown as { buffer?: unknown })?.buffer;
        res.status(201).json({ ok: true });
      },
    );

    const res = await request(probe)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(capturedBuffer).toBeUndefined();
    expect(typeof capturedPath).toBe("string");
    expect(capturedPath && fs.existsSync(capturedPath)).toBe(true);
  });

  it("keeps concurrent large uploads on disk rather than in memory", async () => {
    // Heap deltas are unreliable here (supertest shares the process and holds
    // the request bodies), so assert the mechanism instead: every concurrent
    // upload is disk-backed and never exposes an in-memory buffer.
    const nearLimit = Buffer.alloc(900 * 1024, 0x41); // just under 1MB limit
    const concurrency = 6;
    const seen: { path?: string; buffer?: unknown }[] = [];
    const probe = express();
    probe.post("/upload", singleFileUpload("file"), validateUploadContentType, (req, res) => {
      seen.push({
        path: req.file?.path,
        buffer: (req.file as unknown as { buffer?: unknown })?.buffer,
      });
      res.status(201).json({ ok: true });
    });
    probe.use(errorHandler);

    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        request(probe)
          .post("/upload")
          .attach("file", nearLimit, { filename: `big-${i}.txt`, contentType: "text/plain" }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(201);
    }
    expect(seen).toHaveLength(concurrency);
    for (const file of seen) {
      expect(file.buffer).toBeUndefined();
      expect(typeof file.path).toBe("string");
    }
  });

  it("caps the number of simultaneous uploads", async () => {
    const nearLimit = Buffer.alloc(900 * 1024, 0x41);
    const concurrency = 8;

    const pending = Array.from({ length: concurrency }, (_, i) =>
      request(app)
        .post("/upload")
        .attach("file", nearLimit, {
          filename: `cap-${i}.txt`,
          contentType: "text/plain",
        }),
    );

    // While requests are in flight the active count must never exceed the cap.
    let maxObserved = 0;
    const poll = setInterval(() => {
      maxObserved = Math.max(maxObserved, __getActiveUploadCount());
    }, 1);

    const responses = await Promise.all(pending);
    clearInterval(poll);

    for (const res of responses) {
      // Either accepted, or rejected with 503 when the limiter is saturated.
      expect([201, 503]).toContain(res.status);
    }
    expect(responses.some((res) => res.status === 503)).toBe(true);
    expect(maxObserved).toBeLessThanOrEqual(6);
    expect(__getActiveUploadCount()).toBe(0);
  });
});
