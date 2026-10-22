import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";

const h = vi.hoisted(() => ({
  checkOriginality: vi.fn(),
  resourceRows: [] as Array<Record<string, unknown>>,
  paywallHits: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  setValues: vi.fn(),
  // Aggregate results returned by the mocked db for /agent/status.
  aggregateRow: { totalVerifications: 0, verified: 0, rejected: 0, avgConfidence: 0 } as Record<
    string,
    unknown
  >,
  // Settled verification-fee sum returned by the earnings query (#99).
  earnedTotal: null as string | null,
  recentRows: [] as Array<Record<string, unknown>>,
  // Records how many rows each select path was asked to return.
  selectCalls: [] as Array<{ kind: "aggregate" | "recent" | "other"; limit?: number }>,
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PAY_TO: "GTEST123456789",
    NETWORK: "testnet",
    VERIFICATION_PRICE: "0.10",
    OPENROUTER_MODEL: "test-model",
  },
}));

vi.mock("../services/verificationService.js", () => ({
  checkOriginality: h.checkOriginality,
}));

vi.mock("../services/webhookService.js", () => ({ emitToPublisher: vi.fn(), enqueueWebhookEvent: vi.fn() }));

vi.mock("../db/client.js", () => {
  // A select() chain that supports the resource lookup (where -> limit) and
  // the /agent/status aggregate, earnings and recent-activity queries.
  const isAggregate = (fields: Record<string, unknown> | undefined) =>
    !!fields && "totalVerifications" in fields;
  const isEarnings = (fields: Record<string, unknown> | undefined) =>
    !!fields && "total" in fields && !("totalVerifications" in fields);
  const makeChain = (fields: Record<string, unknown> | undefined) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      limit: (n: number) => {
        // Distinguish the resource lookup from the recent-activity query by
        // whether the caller selected aggregate fields.
        if (isAggregate(fields)) {
          h.selectCalls.push({ kind: "aggregate", limit: n });
          return Promise.resolve([h.aggregateRow]);
        }
        if (n === 10) {
          h.selectCalls.push({ kind: "recent", limit: n });
          return Promise.resolve(h.recentRows);
        }
        h.selectCalls.push({ kind: "other", limit: n });
        return Promise.resolve(h.resourceRows);
      },
      // Aggregate queries may resolve directly (no limit) or via groupBy.
      then: (resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) => {
        if (isAggregate(fields)) {
          h.selectCalls.push({ kind: "aggregate" });
          return Promise.resolve([h.aggregateRow]).then(resolve, reject);
        }
        if (isEarnings(fields)) {
          h.selectCalls.push({ kind: "aggregate" });
          return Promise.resolve([{ total: h.earnedTotal }]).then(resolve, reject);
        }
        return Promise.resolve(h.resourceRows).then(resolve, reject);
      },
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn((fields?: Record<string, unknown>) => makeChain(fields)),
      insert: (...args: unknown[]) => h.insert(...args),
      update: (...args: unknown[]) => h.update(...args),
    },
  };
});

vi.mock("../db/schema.js", () => ({
  resources: {},
  verifications: {},
  payments: {},
}));

vi.mock("../lib/x402.js", () => ({
  network: "testnet",
  sharedX402ResourceServer: {},
}));

vi.mock("@x402/express", () => ({
  paymentMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    h.paywallHits();
    next();
  },
}));

// Stand-in for apiKeyAuth: maps a known key to a publisher, rejects anything else.
vi.mock("../middleware/apiKeyAuth.js", async () => {
  const { AppError } = await import("../lib/errors.js");
  const publishers: Record<string, { id: string }> = {
    "key-pub-1": { id: "pub-1" },
    "key-pub-2": { id: "pub-2" },
  };
  return {
    apiKeyAuth: (req: any, _res: unknown, next: (err?: unknown) => void) => {
      const key = req.headers["x-api-key"];
      if (typeof key !== "string" || !publishers[key]) {
        next(new AppError("UNAUTHORIZED", "Missing x-api-key header"));
        return;
      }
      req.publisher = publishers[key];
      next();
    },
  };
});

vi.mock("../middleware/rateLimiters.js", () => ({
  verifyIpRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyWalletRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import verifyRouter from "./verify.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(verifyRouter);
  app.use(errorHandler);
  return app;
}

const mockUsage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  estimatedCostUsd: 0.001,
};

const DOC_TEXT = "A comprehensive dataset for machine learning";
const LINK_URL = "https://example.com/dataset";

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-1",
    publisherId: "pub-1",
    title: "Doc",
    resourceType: "file",
    contentHash: hashFileResource(Buffer.from(DOC_TEXT, "utf8"), "Doc"),
    adminDelistedAt: null,
    ...overrides,
  };
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-link",
    publisherId: "pub-1",
    title: "Link",
    resourceType: "link",
    contentHash: hashLinkResource(LINK_URL, "Link"),
    adminDelistedAt: null,
    ...overrides,
  };
}

function approved(confidence = 0.95) {
  return {
    isOriginal: true,
    confidence,
    flags: ["Genuine resource"],
    usage: mockUsage,
    deterministicPassed: true,
  };
}

function rejected() {
  return {
    isOriginal: false,
    confidence: 0.2,
    flags: ["Low effort"],
    usage: mockUsage,
    deterministicPassed: true,
  };
}

function expectNothingChanged() {
  expect(h.checkOriginality).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
}

describe("POST /verify-content — AI content verification endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resourceRows = [];
    h.checkOriginality.mockReset();
    h.insert.mockImplementation(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "v1" }])),
      })),
    }));
    h.update.mockImplementation(() => ({
      set: vi.fn((values: unknown) => {
        h.setValues(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ publisherId: "pub-1", title: "Doc" }])),
          })),
        };
      }),
    }));
  });

  describe("without resourceId (anonymous paid check, unchanged)", () => {
    it("returns verification result for approved content", async () => {
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp())
        .post("/verify-content")
        .send({ content: DOC_TEXT });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        isOriginal: true,
        confidence: 0.95,
        flags: ["Genuine resource"],
        usage: mockUsage,
        deterministicPassed: true,
      });
      expect(h.checkOriginality).toHaveBeenCalledWith(DOC_TEXT, "text");
    });

    it("returns verification result for rejected content", async () => {
      h.checkOriginality.mockResolvedValue({
        isOriginal: false,
        confidence: 0.15,
        flags: ["Content appears to be spam or gibberish"],
        usage: mockUsage,
      });

      const res = await request(createTestApp()).post("/verify-content").send({ content: "test123 asdf" });

      expect(res.status).toBe(200);
      expect(res.body.isOriginal).toBe(false);
      expect(res.body.confidence).toBe(0.15);
    });

    it("does not touch resources or verifications rows", async () => {
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp()).post("/verify-content").send({ content: DOC_TEXT });

      expect(res.status).toBe(200);
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    });

    it("handles verification service errors gracefully", async () => {
      h.checkOriginality.mockResolvedValue({
        isOriginal: false,
        confidence: 0,
        flags: ["No response from verification model"],
        usage: mockUsage,
      });

      const res = await request(createTestApp()).post("/verify-content").send({ content: "test content" });

      expect(res.status).toBe(200);
      expect(res.body.isOriginal).toBe(false);
      expect(res.body.confidence).toBe(0);
    });
  });

  describe("with resourceId", () => {
    it("requires an API key and does not run the AI check without one", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(401);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("lets the owner verify their own resource and lists it when approved", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved(0.88));

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(res.body.isOriginal).toBe(true);
      // One verification row plus its fee payment row (#99).
      expect(h.insert).toHaveBeenCalledTimes(2);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "verified",
        verificationId: "v1",
        listed: true,
      });
    });

    it("does not list the resource when the deterministic injection check fails (#96)", async () => {
      h.resourceRows = [fileRow()];
      // Simulate the model being fooled by injected instructions.
      h.checkOriginality.mockResolvedValue({ ...approved(0.99), deterministicPassed: false });

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "rejected",
        verificationId: "v1",
        listed: false,
      });
    });

    it("records a rejection for the owner when the content is not original", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(rejected());

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "rejected",
        verificationId: "v1",
        listed: false,
      });
    });

    it("rejects a non-owner with 403 before payment, and changes nothing", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-2")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(403);
      expect(res.body.error.message ?? res.body.error).toMatch(/do not own/);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown resource and changes nothing", async () => {
      h.resourceRows = [];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "missing" });

      expect(res.status).toBe(404);
      expectNothingChanged();
    });

    it("blocks relisting an admin-delisted resource, even for its owner", async () => {
      h.resourceRows = [fileRow({ adminDelistedAt: new Date("2026-01-01T00:00:00Z") })];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(403);
      expect(res.body.error.message ?? res.body.error).toMatch(/administrator/);
      expectNothingChanged();
    });

    it("rejects content whose hash does not match the stored content with 409", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: "unrelated original text", resourceId: "res-1" });

      expect(res.status).toBe(409);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("rejects with 409 when the resource has no stored content_hash", async () => {
      h.resourceRows = [fileRow({ contentHash: null })];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(409);
      expectNothingChanged();
    });

    it("binds link resources to their URL", async () => {
      h.resourceRows = [linkRow()];
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: LINK_URL, resourceId: "res-link" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith(expect.objectContaining({ listed: true }));
    });

    it("rejects a link resource when the content is not its URL", async () => {
      h.resourceRows = [linkRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: "https://attacker.example/other", resourceId: "res-link" });

      expect(res.status).toBe(409);
      expectNothingChanged();
    });
  });
});

describe("GET /agent/status — public agent stats endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.aggregateRow = { totalVerifications: 0, verified: 0, rejected: 0, avgConfidence: 0 };
    h.earnedTotal = null;
    h.recentRows = [];
    h.selectCalls = [];
  });

  it("returns agent status with correct shape", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agent");
    expect(res.body).toHaveProperty("stats");
    expect(res.body).toHaveProperty("recentActivity");

    expect(res.body.agent).toMatchObject({
      name: "SynapsVault Verification Agent",
      walletAddress: "GTEST123456789",
      network: "testnet",
      endpoint: "http://localhost:4021/verify-content",
      pricePerVerification: "0.10",
      currency: "USDC",
      status: "active",
    });

    expect(res.body.stats).toMatchObject({
      totalVerifications: expect.any(Number),
      verified: expect.any(Number),
      rejected: expect.any(Number),
      totalEarned: expect.any(String),
      avgConfidence: expect.any(String),
    });

    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("returns stats with zero values when no verifications exist", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.stats.totalVerifications).toBe(0);
    expect(res.body.stats.verified).toBe(0);
    expect(res.body.stats.rejected).toBe(0);
    expect(res.body.stats.totalEarned).toBe("0.0000");
    expect(res.body.stats.avgConfidence).toBe("0.00");
  });

  it("returns recent activity array with correct structure", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("computes totals from SQL aggregates and matches the old in-memory values", async () => {
    // Old implementation summed these rows in memory.
    const rows = [
      { isOriginal: true, confidence: 0.9, amountPaid: "0.10" },
      { isOriginal: true, confidence: 0.8, amountPaid: "0.10" },
      { isOriginal: false, confidence: 0.2, amountPaid: "0.10" },
    ];
    const expectedTotal = rows.length;
    const expectedVerified = rows.filter((r) => r.isOriginal).length;
    const expectedRejected = rows.filter((r) => !r.isOriginal).length;
    const expectedEarned = rows.reduce((sum, r) => sum + Number(r.amountPaid), 0).toFixed(4);
    const expectedAvg = (rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length).toFixed(2);

    h.aggregateRow = {
      totalVerifications: expectedTotal,
      verified: expectedVerified,
      rejected: expectedRejected,
      avgConfidence: rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length,
    };
    h.earnedTotal = rows.reduce((sum, r) => sum + Number(r.amountPaid), 0).toString();

    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.stats.totalVerifications).toBe(expectedTotal);
    expect(res.body.stats.verified).toBe(expectedVerified);
    expect(res.body.stats.rejected).toBe(expectedRejected);
    expect(res.body.stats.totalEarned).toBe(expectedEarned);
    expect(res.body.stats.avgConfidence).toBe(expectedAvg);
  });

  it("does not read the full verifications table: only aggregates and 10 recent rows", async () => {
    h.aggregateRow = { totalVerifications: 5, verified: 4, rejected: 1, avgConfidence: 0.8 };
    h.earnedTotal = "0.5";
    h.recentRows = Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      isOriginal: i % 2 === 0,
      confidence: 0.8,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));

    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.recentActivity).toHaveLength(10);

    // Every select must be either an aggregate or the limited recent query.
    for (const call of h.selectCalls) {
      expect(call.kind).not.toBe("other");
      if (call.kind === "recent") {
        expect(call.limit).toBe(10);
      }
    }
    expect(h.selectCalls.some((c) => c.kind === "aggregate")).toBe(true);
    expect(h.selectCalls.some((c) => c.kind === "recent" && c.limit === 10)).toBe(true);
  });
});
