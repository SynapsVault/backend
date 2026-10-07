/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments } from "../db/schema.js";
import { desc, count } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { adminDelistResource } from "../services/resourceService.js";

const router = Router();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of X-Admin-Key against ADMIN_API_KEY (disabled when unset). */
function adminAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  const key = req.headers["x-admin-key"];
  if (!expected || typeof key !== "string" || !timingSafeEqual(digest(key), digest(expected))) {
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }
  next();
}

/** GET /admin/stats */
router.get("/admin/stats", adminAuth, async (_req, res) => {
  const [[totalResources], [totalPublishers], [totalPayments]] = await Promise.all([
    db.select({ count: count() }).from(resources),
    db.select({ count: count() }).from(publishers),
    db.select({ count: count() }).from(payments),
  ]);

  res.json({
    resources:  totalResources.count,
    publishers: totalPublishers.count,
    payments:   totalPayments.count,
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
  });
});

/** POST /admin/delist/:id */
router.post("/admin/delist/:id", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const resource = await adminDelistResource(id);
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  getLogger().warn({ resourceId: id, event: "admin_delist" }, "resource delisted by admin");
  res.json({ success: true, id, delistedAt: new Date().toISOString() });
});

/** GET /admin/audit */
router.get("/admin/audit", adminAuth, async (req, res) => {
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 200);
  const page  = Math.max(Math.trunc(Number(req.query.page)) || 1, 1);
  const offset = (page - 1) * limit;

  const rows = await db
    .select({ id: payments.id, resourceId: payments.resourceId,
              payer: payments.payerAddress, amount: payments.amount, paidAt: payments.paidAt })
    .from(payments)
    .orderBy(desc(payments.paidAt))
    .limit(limit)
    .offset(offset);

  res.json({ page, limit, entries: rows });
});

export default router;
