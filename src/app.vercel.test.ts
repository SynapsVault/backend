import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("./db/client.js", () => ({ db: {}, pgClient: vi.fn().mockResolvedValue([]) }));
vi.mock("./tracing.js", () => ({}));

import app from "./app.js";
import { getIdempotencyStore } from "./lib/idempotency.js";

describe("Vercel Express entry point", () => {
  it("exports an initialized handler that serves health requests", async () => {
    expect(typeof app).toBe("function");
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "synapsvault" });
  });

  it("uses shared idempotency storage for serverless replicas", async () => {
    expect(getIdempotencyStore()).toMatchObject({
      get: expect.any(Function), set: expect.any(Function), delete: expect.any(Function),
    });
    const result = getIdempotencyStore().get("missing");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
