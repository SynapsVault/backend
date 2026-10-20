import { z } from "zod/v4";
import { usdcToStroops } from "../utils/usdc.js";

/** Zod string for a positive USDC price with at most 7 decimals. */
export const priceSchema = z.string().refine((v) => {
  try {
    return usdcToStroops(v) > 0n;
  } catch {
    return false;
  }
}, "must be a positive decimal number with at most 7 decimal places");
