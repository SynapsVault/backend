import { describe, expect, it, vi } from "vitest";
import { createTtlCache } from "./ttlCache.js";
import { IDEMPOTENCY_IN_PROGRESS_TTL_MS } from "./idempotency.js";

describe("in-progress idempotency TTL", () => {
  it("expires abandoned in-progress records well before the full TTL", () => {
    let t = 0;
    const cache = createTtlCache<{ inProgress: boolean }>({
      defaultTtlMs: 24 * 3600_000,
      cacheName: "test",
      now: () => t,
    } as never);
    cache.set("k", { inProgress: true }, IDEMPOTENCY_IN_PROGRESS_TTL_MS);
    t = IDEMPOTENCY_IN_PROGRESS_TTL_MS + 1;
    expect(cache.get("k")).toBeUndefined();
    vi.restoreAllMocks();
  });
});
