/**
 * Tests for the IP rate limit on POST /publishers (#38).
 *
 * Split into two layers:
 *  1. Unit tests — exercise `createIpRateLimiter` directly with a controlled
 *     in-memory store and a fake handler, so window/clock/limit are all
 *     under our control.
 *  2. Integration test — verify that publishers.ts wires the limiter; the
 *     limiter is replaced with a middleware that rejects on demand so the
 *     integration test is deterministic without touching real config.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createIpRateLimiter, RATE_LIMITED } from "../middleware/rateLimit.js";
import { MemorySlidingWindowStore } from "../lib/rateLimit/stores.js";

// ── 1. Unit tests — createIpRateLimiter behaviour ─────────────────────────

describe("createIpRateLimiter — registration window", () => {
  function buildApp(max: number, windowMs: number, clockFn?: () => number) {
    const store = new MemorySlidingWindowStore(clockFn);
    const app = express();
    app.use(createIpRateLimiter(store, "register", max, windowMs, "register_ip"));
    app.post("/publishers", (_req, res) => res.status(201).json({ ok: true }));
    return app;
  }

  it("allows requests up to the limit and sets RateLimit-* headers", async () => {
    const app = buildApp(3, 60_000);

    const r1 = await request(app).post("/publishers").send({});
    expect(r1.status).toBe(201);
    expect(r1.headers["ratelimit-limit"]).toBe("3");
    expect(Number(r1.headers["ratelimit-remaining"])).toBe(2);

    const r2 = await request(app).post("/publishers").send({});
    expect(r2.status).toBe(201);
    expect(Number(r2.headers["ratelimit-remaining"])).toBe(1);

    const r3 = await request(app).post("/publishers").send({});
    expect(r3.status).toBe(201);
    expect(Number(r3.headers["ratelimit-remaining"])).toBe(0);
  });

  it("returns 429 after the limit is exceeded", async () => {
    const app = buildApp(2, 60_000);

    await request(app).post("/publishers").send({}); // 1 — ok
    await request(app).post("/publishers").send({}); // 2 — ok (limit reached)

    const res = await request(app).post("/publishers").send({}); // 3 — blocked
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "Too many requests",
      code: RATE_LIMITED,
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("429 response includes Retry-After and RateLimit-Remaining=0 headers", async () => {
    const app = buildApp(1, 60_000);

    await request(app).post("/publishers").send({});
    const res = await request(app).post("/publishers").send({});

    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(res.headers["ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("resets the counter after the window elapses", async () => {
    let ts = 0;
    const windowMs = 60_000;
    const app = buildApp(1, windowMs, () => ts);

    const r1 = await request(app).post("/publishers").send({});
    expect(r1.status).toBe(201);

    const blocked = await request(app).post("/publishers").send({});
    expect(blocked.status).toBe(429);

    // Advance clock past the window — the old request drops out of the
    // sliding window, so the limit resets.
    ts += windowMs + 1;

    const r3 = await request(app).post("/publishers").send({});
    expect(r3.status).toBe(201);
  });

  it("tracks counters per IP independently (independent stores)", async () => {
    // Confirm that two independent stores share no state (each represents a
    // different server instance or IP namespace in this test).
    const store1 = new MemorySlidingWindowStore();
    const app1 = express();
    app1.use(createIpRateLimiter(store1, "register", 1, 60_000, "register_ip"));
    app1.post("/publishers", (_req, res) => res.status(201).json({ ok: true }));

    const store2 = new MemorySlidingWindowStore();
    const app2 = express();
    app2.use(createIpRateLimiter(store2, "register", 1, 60_000, "register_ip"));
    app2.post("/publishers", (_req, res) => res.status(201).json({ ok: true }));

    // Exhaust app1.
    await request(app1).post("/publishers").send({});
    const blocked = await request(app1).post("/publishers").send({});
    expect(blocked.status).toBe(429);

    // app2 has its own store — still has capacity.
    const ok = await request(app2).post("/publishers").send({});
    expect(ok.status).toBe(201);
  });
});

// ── 2. Integration test — publishers router wires the limiter ──────────────
//
// Replace rateLimiters with a controlled implementation so we can verify the
// real route returns 429 when registerIpRateLimit fires.

vi.mock("../db/schema.js", () => ({
  publishers: { __table: "publishers" },
  resources: { __table: "resources" },
  payments: { __table: "payments" },
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 10_000,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_REGISTER_IP_MAX: 10,
    RATE_LIMIT_REGISTER_IP_WINDOW_MS: 3_600_000,
  },
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher: vi.fn().mockResolvedValue({
    publisher: {
      id: "pub-1",
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
      createdAt: new Date("2026-01-01"),
    },
    apiKey: "mv_freshkey",
  }),
  getPublisherResources: vi.fn().mockResolvedValue([]),
  rotateApiKey: vi.fn().mockResolvedValue("mv_newkey"),
}));

// Build the registerIpRateLimit inside the factory (no outer-scope variables).
vi.mock("../middleware/rateLimiters.js", async () => {
  const { createIpRateLimiter: factory } = await import("../middleware/rateLimit.js");
  const { MemorySlidingWindowStore: Store } = await import("../lib/rateLimit/stores.js");
  // Limit of 2 so the integration test triggers 429 after two requests.
  const integrationStore = new Store();
  return {
    registerIpRateLimit: factory(integrationStore, "register", 2, 60_000, "register_ip"),
    publisherRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import publisherRouter from "./publishers.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createIntegrationApp() {
  const app = express();
  app.use(express.json());
  app.use(publisherRouter);
  app.use(errorHandler);
  return app;
}

const validBody = {
  name: "Alice",
  email: "alice@example.com",
  walletAddress: "GALICE",
};

describe("POST /publishers — registerIpRateLimit wired into route (#38)", () => {
  it("returns 429 once the per-IP limit is reached on the real route", async () => {
    const app = createIntegrationApp();

    await request(app).post("/publishers").send(validBody); // 1 — ok
    await request(app).post("/publishers").send(validBody); // 2 — ok (limit reached)

    const res = await request(app).post("/publishers").send(validBody); // 3 — blocked
    expect(res.status).toBe(429);
    expect(res.body.code).toBe(RATE_LIMITED);
  });
});
