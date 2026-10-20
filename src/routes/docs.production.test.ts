/**
 * Production-gate tests for the docs router (#54).
 *
 * This file must stay separate from docs.test.ts because vi.mock() is hoisted
 * to the top of each test *file*, giving each file its own module registry.
 * Setting NODE_ENV="production" here means docs.ts is loaded with the gate
 * closed (the `if` block skipped) for every test in this file.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// This mock is hoisted before any imports, so docs.ts sees NODE_ENV=production
// when it evaluates `if (config.NODE_ENV !== "production")`.
vi.mock("../config.js", () => ({
  config: { NODE_ENV: "production" },
}));

import docsRouter from "./docs.js";

const app = express().use(docsRouter);

describe("docs router — production gate (#54)", () => {
  it("GET /docs returns 404 when NODE_ENV=production", async () => {
    const res = await request(app).get("/docs");
    // The route is not registered in production, so Express falls through to a 404.
    expect(res.status).toBe(404);
  });

  it("GET /openapi.json still returns 200 in production", async () => {
    const res = await request(app).get("/openapi.json");
    // The OpenAPI spec endpoint is always available regardless of NODE_ENV.
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });

  it("GET /docs/json still returns 200 in production", async () => {
    const res = await request(app).get("/docs/json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });
});
