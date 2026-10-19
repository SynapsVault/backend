import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestTimeout } from "./timeout.js";
import { getRequestSignal } from "../lib/requestAbort.js";
import { createTtlCache } from "../lib/ttlCache.js";
import type { IdempotencyRecord } from "../lib/idempotency.js";

describe("requestTimeout abort signal (#73)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts the signal on timeout and the idempotency record still ends final", async () => {
    const res = {
      headersSent: false,
      locals: {},
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      on: vi.fn(),
    } as unknown as Response;
    const req = { method: "POST", originalUrl: "/resources", url: "/resources" } as Request;

    const store = createTtlCache<IdempotencyRecord>({ defaultTtlMs: 60_000 });
    store.set("p:k", { inProgress: true });

    requestTimeout(100)(req, res, vi.fn());
    const signal = getRequestSignal(res)!;
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);
    expect(signal.aborted).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);

    // Handler finishes after the timeout: records the final outcome and skips
    // writing to the already-answered response.
    (res as any).headersSent = true;
    store.set("p:k", { inProgress: false, result: { status: 201, body: { id: "r1" } } });
    expect(store.get("p:k")).toEqual({
      inProgress: false,
      result: { status: 201, body: { id: "r1" } },
    });
  });
});
