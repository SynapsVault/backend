import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// This mock is hoisted before any import, so docs.ts sees NODE_ENV="test"
// (non-production) and registers the /docs route.
vi.mock("../config.js", () => ({
  config: { NODE_ENV: "test" },
}));

import docsRouter from "./docs.js";
import { openApiSpec } from "../openapi.js";

const app = express().use(docsRouter);

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectRefs(child, refs));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

describe("docs routes", () => {
  it("GET /openapi.json returns a valid OpenAPI 3 document", async () => {
    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toContain("max-age");
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBeTypeOf("string");
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
  });

  it("GET /docs/json serves the same document", async () => {
    const [canonical, alias] = await Promise.all([
      request(app).get("/openapi.json"),
      request(app).get("/docs/json"),
    ]);
    expect(alias.status).toBe(200);
    expect(alias.body).toEqual(canonical.body);
  });

  it("GET /docs serves the Swagger UI page", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("swagger-ui");
    expect(res.text).toContain("/openapi.json");
  });

  // ── Acceptance criterion: SRI integrity attributes (#54) ──────────────────

  it("GET /docs HTML contains an integrity attribute for the CSS asset (#54)", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/rel="stylesheet"[^>]*integrity="sha384-/);
  });

  it("GET /docs HTML contains an integrity attribute for the JS asset (#54)", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<script[^>]+integrity="sha384-/);
  });

  it("GET /docs HTML carries crossorigin='anonymous' on both assets (#54)", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    const matches = res.text.match(/crossorigin="anonymous"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /docs HTML uses an exact pinned version, not a floating range (#54)", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    // Must not have a bare major version like @5/ or @5"
    expect(res.text).not.toMatch(/swagger-ui-dist@\d+[/"]/);
    // Must have a full semver like @5.34.0
    expect(res.text).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+/);
  });

  it("every $ref resolves to a defined component", () => {
    const spec = openApiSpec as unknown as { components: Record<string, Record<string, unknown>> };
    const missing = collectRefs(openApiSpec).filter((ref) => {
      const [, , section, name] = ref.split("/");
      return !spec.components?.[section]?.[name];
    });
    expect(missing).toEqual([]);
  });

  it("documents every operation with a unique operationId", () => {
    const ids: string[] = [];
    for (const methods of Object.values(
      openApiSpec.paths as Record<string, Record<string, { operationId?: string }>>,
    )) {
      for (const op of Object.values(methods)) {
        expect(op.operationId, JSON.stringify(op).slice(0, 80)).toBeTypeOf("string");
        ids.push(op.operationId!);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
