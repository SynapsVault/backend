import { describe, it, expect } from "vitest";
import {
  createSharedIdempotencyStore,
  type IdempotencyRow,
  type IdempotencyRowStore,
} from "./idempotencyPgStore.js";

// A fake "database" shared by several store instances (simulating replicas).
function fakeDatabase(): IdempotencyRowStore {
  const table = new Map<string, IdempotencyRow>();
  return {
    async select(key) {
      const row = table.get(key);
      return row ? structuredClone(row) : undefined;
    },
    async upsert(key, record, expiresAt) {
      table.set(key, { record: structuredClone(record), expiresAt });
    },
    async remove(key) {
      table.delete(key);
    },
    async removeAll() {
      table.clear();
    },
  };
}

describe("shared idempotency store", () => {
  it("returns the original result on retry from another instance", async () => {
    const db = fakeDatabase();
    const a = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });
    const b = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });
    const result = { status: 201, body: { id: "r1" } };

    await a.set("pub:k", { inProgress: true });
    expect(await b.get("pub:k")).toEqual({ inProgress: true });
    await a.set("pub:k", { inProgress: false, result });
    expect(await b.get("pub:k")).toEqual({ inProgress: false, result });
  });

  it("expires records and supports delete", async () => {
    let t = 1_000;
    const db = fakeDatabase();
    const s = createSharedIdempotencyStore(db, { defaultTtlMs: 100, now: () => t });
    await s.set("k", { inProgress: true });
    t += 200;
    expect(await s.get("k")).toBeUndefined();
    await s.set("k2", { inProgress: true });
    await s.delete("k2");
    expect(await s.get("k2")).toBeUndefined();
  });
});
