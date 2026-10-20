import { describe, expect, it } from "vitest";
import { RedisSlidingWindowStore } from "./stores.js";

describe("RedisSlidingWindowStore with unreachable Redis", () => {
  it("does not leave an unhandled rejection and consume rejects cleanly", async () => {
    const store = new RedisSlidingWindowStore("redis://127.0.0.1:1");
    await expect(store.consume("k", 5, 1000)).rejects.toThrow();
    await store.close();
  });
});
