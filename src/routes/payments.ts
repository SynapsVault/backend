import { Router, type Router as RouterType } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { emitToPublisher } from "../webhooks/emitter.js";
import { AppError } from "../errors.js";

const router: RouterType = Router();

// GET /payments/:id/receipt — payment receipt endpoint
router.get("/payments/:id/receipt", async (req, res) => {
  const id = req.params.id as string;
  const payment = await db
    .select({
      id: payments.id,
      resourceId: payments.resourceId,
      amount: payments.amount,
      payerAddress: payments.payerAddress,
      recipientAddress: payments.recipientAddress,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.id, id))
    .then((rows) => rows[0] ?? null);

  if (!payment) {
    throw new AppError("NOT_FOUND", "Receipt not found");
  }

  res.json(payment);
});

// GET /buyers/:address/payments — buyer payment history
router.get("/buyers/:address/payments", async (req, res) => {
  const address = req.params.address as string;
  const buyerPayments = await db
    .select({
      id: payments.id,
      resourceId: payments.resourceId,
      amount: payments.amount,
      payerAddress: payments.payerAddress,
      recipientAddress: payments.recipientAddress,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.payerAddress, address))
    .orderBy(desc(payments.paidAt));

  res.json(buyerPayments);
});

// POST /payments — record a successful payment and grant access
router.post("/payments", async (req, res) => {
  const { resourceId, amount, payerAddress, recipientAddress, publisherId } =
    req.body ?? {};

  if (
    typeof resourceId !== "string" ||
    resourceId.length === 0 ||
    typeof amount !== "string" ||
    amount.length === 0 ||
    typeof payerAddress !== "string" ||
    payerAddress.length === 0 ||
    typeof recipientAddress !== "string" ||
    recipientAddress.length === 0
  ) {
    throw new AppError(
      "BAD_REQUEST",
      "resourceId, amount, payerAddress and recipientAddress are required"
    );
  }

  const [payment] = await db
    .insert(payments)
    .values({
      resourceId,
      amount,
      payerAddress,
      recipientAddress,
    })
    .returning();

  // Access is granted as part of recording the payment.
  const accessGranted = true;

  if (accessGranted && publisherId) {
    // Fire-and-forget: never block the response on webhook emission.
    void Promise.resolve()
      .then(() =>
        emitToPublisher(publisherId, "resource.purchased", {
          paymentId: payment.id,
          resourceId: payment.resourceId,
          amount: payment.amount,
          payerAddress: payment.payerAddress,
          recipientAddress: payment.recipientAddress,
          paidAt: payment.paidAt,
        })
      )
      .catch(() => {
        // Swallow emission errors so they never affect the response.
      });

    void Promise.resolve()
      .then(() =>
        emitToPublisher(publisherId, "payment.received", {
          paymentId: payment.id,
          resourceId: payment.resourceId,
          amount: payment.amount,
          payerAddress: payment.payerAddress,
          recipientAddress: payment.recipientAddress,
          paidAt: payment.paidAt,
        })
      )
      .catch(() => {
        // Swallow emission errors so they never affect the response.
      });
  }

  res.status(201).json(payment);
});

export default router;