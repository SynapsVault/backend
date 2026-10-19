import { describe, it, expect } from "vitest";
import { parseIdempotencyKey } from "./idempotencyKey.js";

describe("parseIdempotencyKey", () => {
  it("returns undefined when the header is absent", () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it("accepts valid keys", () => {
    expect(parseIdempotencyKey("abc_DEF-123")).toBe("abc_DEF-123");
    expect(parseIdempotencyKey("a".repeat(255))).toBe("a".repeat(255));
  });

  it("rejects a 300-character key", () => {
    expect(() => parseIdempotencyKey("a".repeat(300))).toThrow(/Idempotency-Key/);
  });

  it("rejects empty keys and invalid characters", () => {
    expect(() => parseIdempotencyKey("")).toThrow();
    expect(() => parseIdempotencyKey("bad key!")).toThrow();
  });
});
