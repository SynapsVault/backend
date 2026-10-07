import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";

vi.mock("../lib/logger.js", () => ({
  getRequestId: () => undefined,
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { createPublisherRateLimiter } from "./rateLimit.js";
import { MemorySlidingWindowStore } from "../lib/rateLimit/stores.js";
import type { RateLimitStore } from "../lib/rateLimit/types.js";

type Pub = { id: string; rateLimitRpm: number | null };

function buildApp(store: RateLimitStore, opts: { defaultRpm: number; maxRpm: number }) {
  const app = express();
  // Stand-in for apiKeyAuth: publisher id/override come from test headers.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.headers["x-test-publisher"];
    if (typeof id === "string") {
      const rpm = req.headers["x-test-rpm"];
      req.publisher = { id, rateLimitRpm: rpm ? Number(rpm) : null } as Pub as Request["publisher"];
    }
    next();
  });
  app.use(createPublisherRateLimiter({ store, windowMs: 60_000, ...opts }));
  app.get("/", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function hit(app: express.Express, publisher?: string, rpm?: number) {
  const req = request(app).get("/");
  if (publisher) req.set("x-test-publisher", publisher);
  if (rpm !== undefined) req.set("x-test-rpm", String(rpm));
  return req;
}

describe("createPublisherRateLimiter", () => {
  let store: MemorySlidingWindowStore;

  beforeEach(() => {
    store = new MemorySlidingWindowStore();
  });

  it("keys limits per publisher", async () => {
    const app = buildApp(store, { defaultRpm: 1, maxRpm: 100 });
    expect((await hit(app, "alpha")).status).toBe(200);
    expect((await hit(app, "beta")).status).toBe(200);
    expect((await hit(app, "alpha")).status).toBe(429);
  });

  it("applies the publisher's rpm override", async () => {
    const app = buildApp(store, { defaultRpm: 1, maxRpm: 100 });
    for (let i = 0; i < 3; i++) expect((await hit(app, "alpha", 3)).status).toBe(200);
    expect((await hit(app, "alpha", 3)).status).toBe(429);
  });

  it("caps overrides at maxRpm", async () => {
    const app = buildApp(store, { defaultRpm: 1, maxRpm: 2 });
    expect((await hit(app, "alpha", 1000)).status).toBe(200);
    expect((await hit(app, "alpha", 1000)).status).toBe(200);
    const res = await hit(app, "alpha", 1000);
    expect(res.status).toBe(429);
    expect(res.headers["ratelimit-limit"]).toBe("2");
  });

  it("sets 429 headers including Retry-After", async () => {
    const app = buildApp(store, { defaultRpm: 1, maxRpm: 10 });
    await hit(app, "alpha");
    const res = await hit(app, "alpha");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("skips unauthenticated requests", async () => {
    const app = buildApp(store, { defaultRpm: 1, maxRpm: 10 });
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
  });

  it("fails open when the store throws", async () => {
    const broken: RateLimitStore = { consume: vi.fn().mockRejectedValue(new Error("down")) };
    const app = buildApp(broken, { defaultRpm: 1, maxRpm: 10 });
    expect((await hit(app, "alpha")).status).toBe(200);
  });
});
