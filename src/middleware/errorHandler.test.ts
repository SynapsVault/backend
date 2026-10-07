import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/sentry.js", () => ({ captureServerException: vi.fn() }));

import { errorHandler, notFoundHandler } from "./errorHandler.js";
import { AppError } from "../lib/errors.js";
import { captureServerException } from "../lib/sentry.js";
import { runWithRequestContext } from "../lib/logger.js";

function buildApp(thrower: () => unknown) {
  const app = express();
  app.use((_req, _res, next) => runWithRequestContext("req-123", () => next()));
  app.use(express.json());
  app.get("/boom", async () => {
    throw thrower();
  });
  app.post("/json", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("maps AppError to its status, code and message", async () => {
    const res = await request(buildApp(() => new AppError("NOT_FOUND", "Resource not found"))).get("/boom");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found", code: "NOT_FOUND", requestId: "req-123" });
  });

  it("includes details when provided", async () => {
    const res = await request(
      buildApp(() => new AppError("VALIDATION_ERROR", "Invalid request body", { field: "title" })),
    ).get("/boom");
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ field: "title" });
  });

  it("hides the message of unexpected errors and reports them", async () => {
    const res = await request(buildApp(() => new Error("db password leaked"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR", requestId: "req-123" });
    expect(captureServerException).toHaveBeenCalled();
  });

  it("uses upstream timeout status codes", async () => {
    const res = await request(buildApp(() => new AppError("GATEWAY_TIMEOUT", "timed out"))).get("/boom");
    expect(res.status).toBe(504);
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const res = await request(buildApp(() => null))
      .post("/json")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(buildApp(() => null)).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND", error: "Route GET /nope not found" });
  });
});
