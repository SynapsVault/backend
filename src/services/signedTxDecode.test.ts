import { describe, it, expect, vi } from "vitest";

vi.mock("./registryClient.js", () => ({ NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" }));

import { Account, Address, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { decodeNewCreator, decodeSetPrice } from "./signedTxDecode.js";

const PASS = "Test SDF Network ; September 2015";
const kp = Keypair.random();
const contractId = "CBQEIMSRPSRKJJHGOELZTP3CISZVHZ6WPKZTWJMYZXHFXPGHHWFQBD4H";

function build(fn: string, ...args: any[]): string {
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: PASS })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

describe("signed tx decoding (#74)", () => {
  const priceXdr = build("set_price", nativeToScVal("r1", { type: "string" }), nativeToScVal(5_000_000n, { type: "i128" }));

  it("returns the on-chain price when the body matches", () => {
    expect(decodeSetPrice(priceXdr, "0.5")).toBe("0.5");
  });

  it("rejects a price that differs from the signed operation", () => {
    expect(() => decodeSetPrice(priceXdr, "9")).toThrow(/price/);
  });

  it("checks the new owner", () => {
    const owner = Keypair.random().publicKey();
    const xdr = build("transfer_ownership", nativeToScVal("r1", { type: "string" }), new Address(owner).toScVal());
    expect(decodeNewCreator(xdr, owner)).toBe(owner);
    expect(() => decodeNewCreator(xdr, Keypair.random().publicKey())).toThrow(/newCreator/);
  });
});
