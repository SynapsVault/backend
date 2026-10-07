import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const { state, mockDeliver } = vi.hoisted(() => ({
  state: {
    publisher: null as Record<string, unknown> | null,
    lastSet: null as Record<string, unknown> | null,
  },
  mockDeliver: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "production",
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 1000,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
  },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { id: "id", rateLimitRpm: "rate_limit_rpm" },
  resources: {},
  payments: {},
}));

// update().set().where().returning() — echoes the merged row back.
vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.lastSet = values;
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...state.publisher, ...values }]),
          }),
        };
      },
    }),
  },
}));

vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: any, res: any, next: any) => {
    if (!state.publisher) {
      res.status(401).json({ error: "Missing x-api-key header" });
      return;
    }
    req.publisher = state.publisher;
    next();
  },
}));

vi.mock("../middleware/rateLimiters.js", () => ({
  publisherRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher: vi.fn(),
  getPublisherResources: vi.fn(),
}));

vi.mock("../services/webhookService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/webhookService.js")>()),
  deliver: mockDeliver,
}));

import publisherRouter from "./publishers.js";
import { errorHandler } from "../middleware/errorHandler.js";

const app = express().use(express.json()).use(publisherRouter).use(errorHandler);

function basePublisher(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-1",
    name: "Alice",
    email: "alice@example.com",
    walletAddress: "GALICE",
    rateLimitRpm: null,
    webhookUrl: null,
    webhookSecret: null,
    webhookEvents: null,
    webhookEnabled: false,
    ...overrides,
  };
}

describe("publisher rate-limit routes", () => {
  beforeEach(() => {
    state.publisher = basePublisher();
    state.lastSet = null;
  });

  it("requires authentication", async () => {
    state.publisher = null;
    expect((await request(app).get("/publishers/me/rate-limit")).status).toBe(401);
    expect((await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: 5 })).status).toBe(401);
  });

  it("returns the platform default when there is no override", async () => {
    const res = await request(app).get("/publishers/me/rate-limit");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rateLimitRpm: 60,
      override: null,
      defaultRpm: 60,
      maxRpm: 1000,
      windowMs: 60_000,
    });
  });

  it("updates the override", async () => {
    const res = await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: 120 });
    expect(res.status).toBe(200);
    expect(state.lastSet).toEqual({ rateLimitRpm: 120 });
    expect(res.body).toMatchObject({ rateLimitRpm: 120, override: 120 });
  });

  it("resets the override with null", async () => {
    state.publisher = basePublisher({ rateLimitRpm: 500 });
    const res = await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rateLimitRpm: 60, override: null });
  });

  it.each([{ rateLimitRpm: -5 }, { rateLimitRpm: "fast" }, { rateLimitRpm: 5000 }, {}, { rateLimitRpm: 5, extra: 1 }])(
    "rejects invalid payload %j",
    async (body) => {
      const res = await request(app).patch("/publishers/me/rate-limit").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(state.lastSet).toBeNull();
    },
  );
});

describe("publisher webhook routes", () => {
  beforeEach(() => {
    state.publisher = basePublisher();
    state.lastSet = null;
    mockDeliver.mockReset();
  });

  it("requires authentication", async () => {
    state.publisher = null;
    expect((await request(app).get("/publishers/me/webhooks")).status).toBe(401);
    expect((await request(app).patch("/publishers/me/webhooks").send({ webhookEnabled: true })).status).toBe(401);
    expect((await request(app).post("/publishers/me/webhooks/test")).status).toBe(401);
  });

  it("returns the configuration with a masked secret", async () => {
    state.publisher = basePublisher({
      webhookUrl: "https://hooks.example.com/a",
      webhookSecret: "abcdefghijklmnop1234",
      webhookEvents: ["resource.purchased"],
      webhookEnabled: true,
    });
    const res = await request(app).get("/publishers/me/webhooks");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      webhookUrl: "https://hooks.example.com/a",
      webhookSecret: "****************1234",
      webhookEvents: ["resource.purchased"],
      webhookEnabled: true,
    });
  });

  it("returns an empty configuration by default", async () => {
    const res = await request(app).get("/publishers/me/webhooks");
    expect(res.body).toEqual({ webhookUrl: null, webhookSecret: null, webhookEvents: [], webhookEnabled: false });
  });

  it("updates the configuration and masks the secret in the response", async () => {
    const res = await request(app).patch("/publishers/me/webhooks").send({
      webhookUrl: "https://hooks.example.com/b",
      webhookSecret: "a-very-long-secret-value",
      webhookEvents: ["payment.received"],
      webhookEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).toMatchObject({ webhookUrl: "https://hooks.example.com/b", webhookEnabled: true });
    expect(res.body.webhookSecret).toMatch(/^\*+alue$/);
    expect(res.body.webhookEvents).toEqual(["payment.received"]);
  });

  it("disables delivery when the URL is cleared", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a", webhookEnabled: true });
    const res = await request(app).patch("/publishers/me/webhooks").send({ webhookUrl: null });
    expect(res.status).toBe(200);
    expect(state.lastSet).toEqual({ webhookUrl: null, webhookEnabled: false });
  });

  it.each([
    [{ webhookUrl: "not-a-url" }],
    [{ webhookUrl: "https://127.0.0.1/hook" }],
    [{ webhookUrl: "http://hooks.example.com/plain" }],
    [{ webhookSecret: "short" }],
    [{ webhookEvents: ["article.published"] }],
    [{ webhookEnabled: true }],
    [{}],
  ])("rejects %j", async (body) => {
    const res = await request(app).patch("/publishers/me/webhooks").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(state.lastSet).toBeNull();
  });

  it("requires a configured URL to send a test event", async () => {
    const res = await request(app).post("/publishers/me/webhooks/test");
    expect(res.status).toBe(400);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("sends a signed test event", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a", webhookSecret: "s".repeat(16) });
    mockDeliver.mockResolvedValue({ delivered: true, attempts: 1, status: 200 });

    const res = await request(app).post("/publishers/me/webhooks/test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ delivered: true, attempts: 1, status: 200 });
    expect(mockDeliver).toHaveBeenCalledWith(
      { url: "https://hooks.example.com/a", secret: "s".repeat(16) },
      expect.objectContaining({ event: "webhook.test", data: { publisherId: "pub-1" } }),
      { maxAttempts: 1 },
    );
  });

  it("returns 502 when the test delivery fails", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a" });
    mockDeliver.mockResolvedValue({ delivered: false, attempts: 3, error: "HTTP 500", status: 500 });
    const res = await request(app).post("/publishers/me/webhooks/test");
    expect(res.status).toBe(502);
    expect(res.body.delivered).toBe(false);
  });
});
