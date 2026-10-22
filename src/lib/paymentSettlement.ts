import type { Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { getLogger } from "./logger.js";

/**
 * Resolves a payment row's settlement status once the response is sent (#99).
 *
 * @x402/express verifies the payment before the handler runs but settles it
 * only after the handler responds; when settlement fails it discards the
 * buffered response and sends an error status instead. A 2xx/3xx finish
 * therefore means the payment settled, anything else means it did not.
 */
export function recordSettlementOnFinish(res: Response, paymentId: string): void {
  res.once("finish", () => {
    const status = res.statusCode < 400 ? "settled" : "failed";
    // Wrapped so a synchronous throw is logged like a rejected query.
    Promise.resolve()
      .then(() => db.update(payments).set({ status }).where(eq(payments.id, paymentId)))
      .catch((err: unknown) => {
        getLogger().error(
          { event: "payment_settlement_update_failed", paymentId, status, err },
          "failed to record payment settlement status",
        );
      });
  });
}
