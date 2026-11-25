import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { and, eq, desc, inArray, isNotNull, isNull, sum, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources, verifications, payments } from "../db/schema.js";
import {
  checkOriginality,
  reserveVerificationSpend,
  releaseVerificationSpend,
  claimVerificationGeneration,
} from "../services/verificationService.js";
import { enqueueWebhookEvent } from "../services/webhookService.js";

import { config } from "../config.js";
import { buildPurchaseSnapshot } from "../lib/purchaseSnapshot.js";
import { AppError } from "../lib/errors.js";
import { INPUT_CONTRACT_VERSION, type ReviewResourceType } from "../lib/verificationContract.js";
import { getLogger } from "../lib/logger.js";
import { businessEventsTotal, verificationCostUsd } from "../lib/metrics.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { verifyIpRateLimit, verifyWalletRateLimit } from "../middleware/rateLimiters.js";
import { validate } from "../middleware/validate.js";
import { verifyContentSchema } from "../schemas/requests.js";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";
import { parsePayerFromXPayment } from "../lib/parseXPayment.js";
import { recordSettlementOnFinish, settlementKeyFromHeader } from "../lib/paymentSettlement.js";

const router: RouterType = Router();

const verifyRoutes: RoutesConfig = {
  "POST /verify-content": {
    accepts: {
      scheme: "exact" as const,
      network,
      payTo: config.PAY_TO,
      price: `$${config.VERIFICATION_PRICE}`,
    },
    description: "AI content originality verification",
  },
};

const verifyPaywall = paymentMiddleware(verifyRoutes, sharedX402ResourceServer);

/**
 * Only publishers may attach a verification to their own resource, so a
 * `resourceId` in the body requires `x-api-key`. Requests without one skip
 * this entirely and keep the anonymous paid check.
 */
function requireApiKeyForResource(req: Request, res: Response, next: NextFunction) {
  if (!req.body?.resourceId) return next();
  return apiKeyAuth(req, res, next);
}

/** True when `content` is exactly what the server stored for the resource. */
function contentMatchesResource(
  content: string,
  resource: { resourceType: "file" | "link"; title: string; contentHash: string | null },
): boolean {
  if (!resource.contentHash) return false;
  try {
    const computed =
      resource.resourceType === "link"
        ? hashLinkResource(content, resource.title)
        : hashFileResource(Buffer.from(content, "utf8"), resource.title);
    return computed === resource.contentHash;
  } catch {
    // hashLinkResource throws on a value that isn't a URL.
    return false;
  }
}

/**
 * Runs before the x402 paywall, so a request that would be refused is never
 * charged. Checks that the resource belongs to the caller, has not been
 * delisted by an admin, and that `content` hashes to the stored content_hash.
 */
async function checkResourceForVerification(req: Request, res: Response, next: NextFunction) {
  const { resourceId, content } = req.body ?? {};
  if (!resourceId) return next();

  const [resource] = await db
    .select({
      publisherId: resources.publisherId,
      title: resources.title,
      resourceType: resources.resourceType,
      contentHash: resources.contentHash,
      adminDelistedAt: resources.adminDelistedAt,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  if (!resource) throw new AppError("NOT_FOUND", "Resource not found");
  if (resource.publisherId !== req.publisher?.id) {
    throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
  }
  if (resource.adminDelistedAt) {
    throw new AppError("FORBIDDEN", "Resource was delisted by an administrator and cannot be relisted");
  }
  // Kept for the fee's purchase snapshot so its receipt records which
  // content was verified even if the resource changes later.
  res.locals.verificationResource = resource;
  // Non-string content is rejected by validate() after payment; only hash-check real strings here.
  if (typeof content === "string" && !contentMatchesResource(content, resource)) {
    throw new AppError("CONFLICT", "Content does not match the resource's stored content");
  }
  // The review input is the stored content as its resource type (#189).
  res.locals.reviewResourceType = resource.resourceType;
  next();
}

// POST /verify-content — AI originality check (x402 paywalled)
router.post(
  "/verify-content",
  verifyIpRateLimit,
  // Structural validation runs before any payment processing (#181): a
  // malformed body (missing content, wrong types, a non-string resourceId)
  // is rejected here, before facilitator verification or settlement is ever
  // attempted, and before the DB lookup in checkResourceForVerification.
  validate(verifyContentSchema),
  requireApiKeyForResource,
  checkResourceForVerification,
  verifyPaywall,
  verifyWalletRateLimit,
  async (req, res) => {
    const { content, resourceId } = req.body;

    // Cancellation policy (#184): if the client disconnects or the response
    // closes before we finish, the model call is aborted and NOTHING is
    // persisted (no verification row, no fee record, no resource change). The
    // x402 fee is only settled for a successful (<400) response, so a
    // canceled request is not charged.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const reviewType: ReviewResourceType = res.locals.reviewResourceType ?? "text";

    // Daily spend budget gate (#186): reserve estimated spend before any paid
    // provider call. The reservation is shared across processes, so concurrent
    // requests cannot collectively exceed the documented daily budget. A
    // rejected request is never charged (the x402 fee only settles on <400).
    let reservation;
    try {
      reservation = await reserveVerificationSpend();
    } catch (err) {
      if ((err as Error)?.name === "VerificationBudgetExceededError") {
        businessEventsTotal.inc({ event: "verification.completed", outcome: "budget_exceeded" });
        res.setHeader("Retry-After", "3600");
        throw new AppError("SERVICE_UNAVAILABLE", "Daily verification budget exhausted; retry later", {
          retryable: true,
          reason: "budget_exceeded",
        });
      }
      throw err;
    }

    // Claim a new verification generation for the resource (#183). The final
    // resource update only applies while this generation is still current, so
    // a slow older check cannot overwrite a newer verdict or verificationId.
    let generation: number | undefined;
    if (resourceId) {
      try {
        generation = await claimVerificationGeneration(resourceId);
      } catch (err) {
        await releaseVerificationSpend(reservation);
        throw err;
      }
    }

    let result;
    try {
      result = await checkOriginality(content, reviewType, {
        signal: abort.signal,
        timeoutMs: config.VERIFICATION_TIMEOUT_MS,
      });
    } catch (err) {
      // The provider call did not consume budget; release the reservation.
      await releaseVerificationSpend(reservation);
      const name = (err as Error)?.name;
      if (name === "VerificationCanceledError" || abort.signal.aborted) return;
      if (name === "VerificationProviderError") {
        // Outage/protocol failure (#187): retryable, never a content verdict.
        // Nothing is written, so an existing valid verdict is not overwritten,
        // and the 503 means the x402 payment is not settled (no fee).
        businessEventsTotal.inc({ event: "verification.completed", outcome: "provider_failure" });
        res.setHeader("Retry-After", "30");
        throw new AppError("SERVICE_UNAVAILABLE", "Verification provider unavailable; retry later", {
          retryable: true,
          reason: (err as { reason?: string }).reason,
        });
      }
      throw err;
    }
    if (abort.signal.aborted) {
      await releaseVerificationSpend(reservation);
      return;
    }
    const { usage } = result;

    // Record business metrics for the completed verification.
    businessEventsTotal.inc({
      event: "verification.completed",
      outcome: result.isOriginal ? "original" : "not_original",
    });
    verificationCostUsd.inc(usage.estimatedCostUsd);

    // Structured usage log so verification spend is visible (#283). No content
    // or secrets are logged — only token counts and the estimated cost.
    getLogger().info(
      {
        event: "verification_usage",
        resourceId: resourceId ?? null,
        model: result.model,
        promptVersion: result.promptVersion,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      },
      "verification token usage",
    );

    // If a resourceId is provided, save the verification result. The
    // verification row, its linked payment, and the resource status update
    // commit as one transaction (#182): a failure partway through — e.g. the
    // resource update failing a stale ownership/delist re-check — rolls back
    // the verification and payment too, instead of leaving a verification or
    // fee recorded with no matching resource state.
    if (resourceId) {
      const shouldList = result.isOriginal && result.deterministicPassed;
      const paymentHeader = req.headers["x-payment"];
      const payer =
        typeof paymentHeader === "string" ? parsePayerFromXPayment(paymentHeader).payer : undefined;

      const { payment, updated } = await db.transaction(async (tx) => {
        const [verification] = await tx
          .insert(verifications)
          .values({
            resourceId,
            isOriginal: result.isOriginal,
            inputContractVersion: INPUT_CONTRACT_VERSION,
            confidence: result.confidence,
            flags: JSON.stringify(result.flags),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            estimatedCost: usage.estimatedCostUsd.toString(),
            model: result.model,
            promptVersion: result.promptVersion,
          })
          .returning();

        // Record the verification fee so agent earnings come from settled
        // payments rather than count × price (#99).
        const [payment] = await tx
          .insert(payments)
          .values({
            resourceId,
            verificationId: verification.id,
            payerAddress: payer ?? "unknown",
            recipientAddress: config.PAY_TO,
            amount: config.VERIFICATION_PRICE,
            settlementKey: settlementKeyFromHeader(paymentHeader),
          })
          .onConflictDoNothing({ target: payments.settlementKey })
          .returning({ id: payments.id });

        // Update resource status — listing is independent of on-chain registration.
        // Re-checks ownership and the admin delist so a change made since the
        // pre-payment check can't be overwritten. A listing only goes live when
        // the model approves *and* the deterministic check agrees (#96).
        // The generation guard (#183) ensures a slow older check cannot replace
        // a newer verdict or verificationId claimed after it started.
        const [updated] = await tx
          .update(resources)
          .set({
            verificationStatus: shouldList
              ? "verified"
              : result.needsReview
                ? "review_required"
                : "rejected",
            verificationId: verification.id,
            listed: shouldList,
          })
          .where(
            and(
              eq(resources.id, resourceId),
              eq(resources.publisherId, req.publisher!.id),
              isNull(resources.adminDelistedAt),
              eq(resources.verificationGeneration, generation!),
            ),
          )
          .returning({ publisherId: resources.publisherId, title: resources.title });

        return { payment, updated };
      });

      // A replayed authorization conflicts on the settlement key: no second row.
      if (payment) recordSettlementOnFinish(res, payment.id);

      // The provider call consumed the reserved budget; settle it as consumed.
      await releaseVerificationSpend(reservation, { consumed: true });

      if (updated && shouldList) {
        void enqueueWebhookEvent(updated.publisherId, "resource.listed", {
          resourceId,
          title: updated.title,
        });
      }
    }

    res.json(result);
  },
);

// GET /agent/status — public agent stats
router.get("/agent/status", async (_req, res) => {
  // Aggregate counters in SQL so the cost stays constant as usage grows (#98).
  const [aggregates] = await db
    .select({
      totalVerifications: sql<number>`count(*)::int`,
      verified: sql<number>`count(*) filter (where ${verifications.isOriginal})::int`,
      rejected: sql<number>`count(*) filter (where not ${verifications.isOriginal})::int`,
      avgConfidence: sql<number>`coalesce(avg(${verifications.confidence}), 0)::float8`,
      totalPromptTokens: sql<number>`coalesce(sum(${verifications.promptTokens}), 0)::bigint`,
      totalCompletionTokens: sql<number>`coalesce(sum(${verifications.completionTokens}), 0)::bigint`,
      totalTokens: sql<number>`coalesce(sum(${verifications.totalTokens}), 0)::bigint`,
      totalEstimatedCost: sql<number>`coalesce(sum(${verifications.estimatedCost}), 0)::float8`,
    })
    .from(verifications);

  // Group new results by the model and prompt version that produced them
  // (#185). Historical rows with null model/prompt_version remain readable and
  // are grouped under a null bucket.
  const byModelVersion = await db
    .select({
      model: verifications.model,
      promptVersion: verifications.promptVersion,
      totalVerifications: sql<number>`count(*)::int`,
      verified: sql<number>`count(*) filter (where ${verifications.isOriginal})::int`,
      rejected: sql<number>`count(*) filter (where not ${verifications.isOriginal})::int`,
      totalEstimatedCost: sql<number>`coalesce(sum(${verifications.estimatedCost}), 0)::float8`,
    })
    .from(verifications)
    .groupBy(verifications.model, verifications.promptVersion);

  // Only the 10 most recent rows are read for the activity list.
  const recentVerifications = await db
    .select({
      id: verifications.id,
      resourceId: verifications.resourceId,
      isOriginal: verifications.isOriginal,
      confidence: verifications.confidence,
      flags: verifications.flags,
      checkedAt: verifications.checkedAt,
      model: verifications.model,
      promptVersion: verifications.promptVersion,
    })
    .from(verifications)
    .orderBy(desc(verifications.checkedAt))
    .limit(10);

  // Get resource titles for recent activity in a single batched query
  const recentResourceIds = [...new Set(recentVerifications.map((v) => v.resourceId))];

  const titleRows =
    recentResourceIds.length > 0
      ? await db
          .select({ id: resources.id, title: resources.title })
          .from(resources)
          .where(inArray(resources.id, recentResourceIds))
      : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  const recentWithTitles = recentVerifications.map((v) => ({
    id: v.id,
    resourceTitle: titleById.get(v.resourceId) || "Unknown",
    isOriginal: v.isOriginal,
    confidence: v.confidence,
    flags: v.flags ? JSON.parse(v.flags) : [],
    checkedAt: v.checkedAt,
    model: v.model,
    promptVersion: v.promptVersion,
  }));

  const totalVerifications = Number(aggregates?.totalVerifications ?? 0);
  const verified = Number(aggregates?.verified ?? 0);
  const rejected = Number(aggregates?.rejected ?? 0);

  // Sum the amounts actually recorded for settled verification fees paid to
  // the agent's wallet (#99). Failed or unsettled payments are excluded, and
  // historical price changes are reflected because we sum recorded amounts,
  // not list price. The fee is earned whatever the verdict.
  const [earningsRow] = await db
    .select({
      total: sum(sql<string>`cast(${payments.amount} as numeric)`),
    })
    .from(payments)
    .where(
      and(
        isNotNull(payments.verificationId),
        eq(payments.recipientAddress, config.PAY_TO),
        eq(payments.status, "settled"),
      ),
    );

  const totalEarned = earningsRow?.total ? Number(earningsRow.total) : 0;

  const avgConfidence = Number(aggregates?.avgConfidence ?? 0);

  // Aggregate model token usage + estimated spend across all verifications (#283).
  const totalPromptTokens = Number(aggregates?.totalPromptTokens ?? 0);
  const totalCompletionTokens = Number(aggregates?.totalCompletionTokens ?? 0);
  const totalTokens = Number(aggregates?.totalTokens ?? 0);
  const totalEstimatedCost = Number(aggregates?.totalEstimatedCost ?? 0);

  res.json({
    agent: {
      name: "SynapsVault Verification Agent",
      walletAddress: config.PAY_TO,
      network: config.NETWORK,
      endpoint: `${config.BASE_URL}/verify-content`,
      pricePerVerification: config.VERIFICATION_PRICE,
      currency: "USDC",
      status: "active",
    },
    stats: {
      totalVerifications,
      verified,
      rejected,
      totalEarned: totalEarned.toFixed(4),
      avgConfidence: avgConfidence.toFixed(2),
    },
    usage: {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      estimatedCostUsd: totalEstimatedCost.toFixed(6),
      model: config.OPENROUTER_MODEL,
      // Per model/prompt-version breakdown of new verdicts (#185).
      byModelVersion: byModelVersion.map((row) => ({
        model: row.model,
        promptVersion: row.promptVersion,
        totalVerifications: Number(row.totalVerifications),
        verified: Number(row.verified),
        rejected: Number(row.rejected),
        estimatedCostUsd: Number(row.totalEstimatedCost).toFixed(6),
      })),
    },
    recentActivity: recentWithTitles,
  });
});

export default router;