import { z } from "zod/v4";
import { StrKey } from "@stellar/stellar-sdk";

/** Zod string that must be a valid Stellar ed25519 public key (G...). */
export const stellarAddressSchema = z
  .string()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), "must be a valid Stellar public key (G..., 56 chars)");
