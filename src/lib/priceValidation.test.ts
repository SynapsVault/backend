import { describe, expect, it } from "vitest";
import { priceSchema } from "./priceValidation.js";

describe("priceSchema", () => {
  it.each(["1", "0.50", "12.1234567", "0.0000001"])("accepts %s", (v) => {
    expect(priceSchema.safeParse(v).success).toBe(true);
  });
  it.each(["abc", "-1", "0", "0.0", "1.23456789", "", "1e3", " 1", "1."])("rejects %s", (v) => {
    expect(priceSchema.safeParse(v).success).toBe(false);
  });
});
