import { TransactionBuilder, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { AppError } from "../lib/errors.js";
import { NETWORK_PASSPHRASE } from "./registryClient.js";
import { stroopsToUsdc, usdcToStroops } from "../utils/usdc.js";

// Decodes the registry invocation arguments from a signed transaction (#74) so
// routes can take price / new owner from the signed operation instead of the
// request body. Call after validateSignedTx has checked contract and function.
export function decodeInvokeArgs(signedXdr: string): unknown[] {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const op = (tx as any).operations[0];
    const hostFn = op.func as xdr.HostFunction;
    return hostFn.invokeContract().args().map((a: xdr.ScVal) => scValToNative(a));
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", "Could not decode signed transaction", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function mismatch(field: string): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    `Request ${field} does not match the signed transaction`,
  );
}

// Returns the price (USDC decimal string) encoded in a signed set_price tx.
// Throws a 400 when `bodyPrice` disagrees with it.
export function decodeSetPrice(signedXdr: string, bodyPrice: string): string {
  const args = decodeInvokeArgs(signedXdr);
  const raw = args[1];
  if (typeof raw !== "bigint" && typeof raw !== "number") {
    throw new AppError("VALIDATION_ERROR", "Signed transaction has no price argument");
  }
  const onChain = BigInt(raw);
  let requested: bigint;
  try {
    requested = usdcToStroops(bodyPrice);
  } catch {
    throw mismatch("price");
  }
  if (requested !== onChain) throw mismatch("price");
  return stroopsToUsdc(onChain);
}

// Returns the new owner address encoded in a signed transfer_ownership tx.
// Throws a 400 when `bodyNewCreator` disagrees with it.
export function decodeNewCreator(signedXdr: string, bodyNewCreator: string): string {
  const raw = decodeInvokeArgs(signedXdr)[1];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Signed transaction has no new owner argument");
  }
  if (raw !== bodyNewCreator) throw mismatch("newCreator");
  return raw;
}
