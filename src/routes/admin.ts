/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { Router, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments } from "../db/schema.js";
import { desc, count, eq } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { AppError, ErrorCode } from "../lib/errors.js";

const router = Router();
const log    = getLogger();

function adminAuth(req: Request, _res: Response, next: () => void) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    throw new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized");
  }
  next();
}

/** GET /admin/stats */
router.get("/admin/stats", adminAuth, async (_req, res) => {
  try {
    const [totalResources] = await db.select({ count: count() }).from(resources);
    const [totalPublishers] = await db.select({ count: count() }).from(publishers);
    const [totalPayments]  = await db.select({ count: count() }).from(payments);

    res.json({
      resources:  totalResources.count,
      publishers: totalPublishers.count,
      payments:   totalPayments.count,
      uptime:     process.uptime(),
      timestamp:  new Date().toISOString(),
    });
  } catch (err) {
    log.error({ err }, "admin stats error");
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Internal server error");
  }
});

/** POST /admin/delist/:id */
router.post("/admin/delist/:id", adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.update(resources).set({ listed: false }).where(eq(resources.id, id));
    log.warn({ resourceId: id, event: "admin_delist" });
    res.json({ success: true, id, delistedAt: new Date().toISOString() });
  } catch (err) {
    log.error({ err, id }, "admin delist error");
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Internal server error");
  }
});

/** GET /admin/audit */
router.get("/admin/audit", adminAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const page  = Math.max(Number(req.query.page ?? 1), 1);
  const offset = (page - 1) * limit;

  try {
    const rows = await db
      .select({ id: payments.id, resourceId: payments.resourceId,
                payer: payments.payerAddress, amount: payments.amount, paidAt: payments.paidAt })
      .from(payments)
      .orderBy(desc(payments.paidAt))
      .limit(limit)
      .offset(offset);

    res.json({ page, limit, entries: rows });
  } catch (err) {
    log.error({ err }, "admin audit error");
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Internal server error");
  }
});

export default router;
