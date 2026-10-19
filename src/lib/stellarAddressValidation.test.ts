import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { stellarAddressSchema } from "./stellarAddressValidation.js";

describe("stellarAddressSchema", () => {
  it("accepts a valid address", () => {
    expect(stellarAddressSchema.safeParse(Keypair.random().publicKey()).success).toBe(true);
  });
  it("rejects malformed values", () => {
    expect(stellarAddressSchema.safeParse("G" + "A".repeat(55)).success).toBe(false);
    expect(stellarAddressSchema.safeParse("abc").success).toBe(false);
    expect(stellarAddressSchema.safeParse("").success).toBe(false);
  });
});
