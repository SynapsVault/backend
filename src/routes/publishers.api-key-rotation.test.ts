/**
 * Tests for POST /publishers/me/api-keys/rotate (#40)
 *
 * Acceptance criteria:
 *  - The old key returns 401 after rotation.
 *  - The new key works (200 on subsequent authenticated endpoints).
 *  - The rotate endpoint itself returns the new plaintext key + rotatedAt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema + DB mocks (same pattern as publishers.test.ts)
// ---------------------------------------------------------------------------

const { PUBLISHERS_MARKER, RESOURCES_MARKER, PAYMENTS_MARKER } = vi.hoisted(() => ({
  PUBLISHERS_MARKER: { __table: "publishers" },
  RESOURCES_MARKER: { __table: "resources" },
  PAYMENTS_MARKER: { __table: "payments" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: PUBLISHERS_MARKER,
  resources: RESOURCES_MARKER,
  payments: PAYMENTS_MARKER,
}));

// Pre-compute known key/hash pairs so we can assert auth outcomes precisely.
const OLD_API_KEY = "mv_old-key";
const OLD_API_KEY_HASH = createHash("sha256").update(OLD_API_KEY).digest("hex");

const NEW_API_KEY = "mv_new-key";
const NEW_API_KEY_HASH = createHash("sha256").update(NEW_API_KEY).digest("hex");

/**
 * Rows returned by the DB mock for publisher lookups.
 * Tests control this to simulate which key is currently valid.
 * The mock always returns this exact array — set it to [] for "no match".
 */
let publishersLookupRows: any[];

vi.mock("../db/client.js", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === PUBLISHERS_MARKER) {
          return {
            // apiKeyAuth calls .where(eq(publishers.apiKeyHash, hash)).then(rows => rows[0]).
            // The drizzle eq() expression stores the compared value at queryChunks[3],
            // so we can filter the lookup rows by the queried hash.
            where: (expr: any) => {
              const queriedHash: string | undefined = expr?.queryChunks?.[3];
              const matched = queriedHash
                ? publishersLookupRows.filter((r) => r.apiKeyHash === queriedHash)
                : publishersLookupRows;
              return {
                then: (resolve: (rows: any[]) => unknown) =>
                  Promise.resolve(matched).then(resolve),
              };
            },
          };
        }
        throw new Error(`unexpected table in select().from(): ${JSON.stringify(table)}`);
      },
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 600,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
  },
}));

// ---------------------------------------------------------------------------
// Service mock — rotateApiKey
// ---------------------------------------------------------------------------

const { mockRotateApiKey, mockRegisterPublisher, mockGetPublisherResources } = vi.hoisted(() => ({
  mockRotateApiKey: vi.fn(),
  mockRegisterPublisher: vi.fn(),
  mockGetPublisherResources: vi.fn(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher: mockRegisterPublisher,
  getPublisherResources: mockGetPublisherResources,
  rotateApiKey: mockRotateApiKey,
}));

import publisherRouter from "./publishers.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(publisherRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePublisher(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-1",
    name: "Alice",
    email: "alice@example.com",
    walletAddress: "GALICE",
    apiKeyHash: OLD_API_KEY_HASH,
    apiKeyRevokedAt: null,
    rateLimitRpm: null,
    webhookUrl: null,
    webhookSecret: null,
    webhookEvents: null,
    webhookEnabled: false,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /publishers/me/api-keys/rotate (#40)", () => {
  beforeEach(() => {
    mockRotateApiKey.mockReset();
    // Default: old key is valid and active.
    publishersLookupRows = [makePublisher()];
  });

  it("returns 401 when the x-api-key header is missing", async () => {
    const res = await request(createTestApp()).post("/publishers/me/api-keys/rotate");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing x-api-key header");
    expect(mockRotateApiKey).not.toHaveBeenCalled();
  });

  it("returns 401 when an unrecognised key is supplied", async () => {
    // No matching row for an unknown key.
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", "mv_unknown");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid API key");
    expect(mockRotateApiKey).not.toHaveBeenCalled();
  });

  it("rotates the key and returns the new plaintext key with a timestamp", async () => {
    mockRotateApiKey.mockResolvedValue(NEW_API_KEY);

    const before = Date.now();
    const res = await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe(NEW_API_KEY);
    expect(res.body.rotatedAt).toBeDefined();
    expect(new Date(res.body.rotatedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(res.body.rotatedAt).getTime()).toBeLessThanOrEqual(after);
    expect(mockRotateApiKey).toHaveBeenCalledWith("pub-1");
  });

  it("calls rotateApiKey with the authenticated publisher's id", async () => {
    mockRotateApiKey.mockResolvedValue(NEW_API_KEY);

    await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);

    expect(mockRotateApiKey).toHaveBeenCalledTimes(1);
    expect(mockRotateApiKey).toHaveBeenCalledWith("pub-1");
  });

  it("does not expose the old key in the response", async () => {
    mockRotateApiKey.mockResolvedValue(NEW_API_KEY);

    const res = await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(OLD_API_KEY);
    expect(JSON.stringify(res.body)).not.toContain(OLD_API_KEY_HASH);
  });
});

describe("Old key → 401 after rotation, new key → 200 (#40 acceptance criteria)", () => {
  beforeEach(() => {
    mockRotateApiKey.mockReset();
  });

  it("old key returns 401 after rotation (hash replaced in the DB)", async () => {
    // Initially: old key is valid.
    publishersLookupRows = [makePublisher({ apiKeyHash: OLD_API_KEY_HASH })];

    // The service rotation replaces the hash in the DB. Simulate by swapping
    // publishersLookupRows when rotateApiKey is called.
    mockRotateApiKey.mockImplementation(async () => {
      publishersLookupRows = [makePublisher({ apiKeyHash: NEW_API_KEY_HASH })];
      return NEW_API_KEY;
    });

    // Perform the rotation.
    const rotateRes = await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.apiKey).toBe(NEW_API_KEY);

    // Old key is now rejected — its hash is no longer in the DB.
    const oldKeyRes = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", OLD_API_KEY);

    expect(oldKeyRes.status).toBe(401);
    expect(oldKeyRes.body.error).toBe("Invalid API key");
  });

  it("new key returns 200 after rotation", async () => {
    publishersLookupRows = [makePublisher({ apiKeyHash: OLD_API_KEY_HASH })];

    mockRotateApiKey.mockImplementation(async () => {
      publishersLookupRows = [makePublisher({ apiKeyHash: NEW_API_KEY_HASH })];
      return NEW_API_KEY;
    });

    // Rotate using the old key.
    await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);

    // New key is now accepted.
    const newKeyRes = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", NEW_API_KEY);

    expect(newKeyRes.status).toBe(200);
    expect(newKeyRes.body.id).toBe("pub-1");
  });

  it("revoked key (apiKeyRevokedAt set) returns 401 even if the hash matches", async () => {
    // Simulate an admin revocation: same hash but apiKeyRevokedAt is non-null.
    publishersLookupRows = [
      makePublisher({ apiKeyRevokedAt: new Date("2026-06-01T00:00:00Z") }),
    ];

    const res = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", OLD_API_KEY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("API key has been revoked");
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("rotate endpoint itself is blocked when the caller's key is already revoked", async () => {
    publishersLookupRows = [
      makePublisher({ apiKeyRevokedAt: new Date("2026-06-01T00:00:00Z") }),
    ];

    const res = await request(createTestApp())
      .post("/publishers/me/api-keys/rotate")
      .set("x-api-key", OLD_API_KEY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("API key has been revoked");
    expect(mockRotateApiKey).not.toHaveBeenCalled();
  });
});
