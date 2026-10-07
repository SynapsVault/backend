import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
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
    for (const methods of Object.values(openApiSpec.paths as Record<string, Record<string, { operationId?: string }>>)) {
      for (const op of Object.values(methods)) {
        expect(op.operationId, JSON.stringify(op).slice(0, 80)).toBeTypeOf("string");
        ids.push(op.operationId!);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
