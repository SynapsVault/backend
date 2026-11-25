import { Router, type Router as RouterType } from "express";
import { toReceiptTerms, RECEIPT_ASSET_CODE } from "../lib/purchaseSnapshot.js";
import { attachmentDisposition } from "../lib/contentDisposition.js";
import { promises as fs } from "node:fs";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { singleFileUpload, validateUploadContentType } from "../middleware/uploadGuards.js";
import { validate, validateFields } from "../middleware/validate.js";
import {
  filePublishBodySchema,
  catalogQuerySchema,
  linkPublishSchema,
  registerResourceSchema,
  preparePriceSchema,
  setPriceSchema,
  prepareOwnershipSchema,
  transferOwnershipSchema,
  CATALOG_DEFAULT_LIMIT,
} from "../schemas/requests.js";
import { dynamicPaywall } from "../middleware/dynamicPaywall.js";
import {
  createFileResource,
  createLinkResource,
  listCatalog,
  countCatalog,
  getResourceMeta,
  computeResourceEtag,
  getVerificationDetails,
  delistResource,
  getResourceById,
} from "../services/resourceService.js";
import {
  downloadFile,
  downloadFileRange,
  StorageNotFoundError,
} from "../storage/supabaseStorage.js";
import { db } from "../db/client.js";
import { payments, resources } from "../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { publishIpRateLimit, publishWalletRateLimit } from "../middleware/rateLimiters.js";
import {
  IDEMPOTENCY_IN_PROGRESS_TTL_MS,
  computeIdempotencyFingerprint,
  getIdempotencyStore,
  idempotencyCacheKey,
} from "../lib/idempotency.js";
import { parseIdempotencyKey } from "../lib/idempotencyKey.js";
import { calculateContentHash } from "../utils/crypto.js";
import { decodeNewCreator, decodeSetPrice } from "../services/signedTxDecode.js";
import { getRequestSignal } from "../lib/requestAbort.js";
import { buildRegistrationFailureGuidance, explorerTxUrl } from "../lib/registrationGuidance.js";
import {
  NETWORK_PASSPHRASE,
  SignedTxValidationError,
  registryClient,
  registryKeypair,
  setPrice,
  transferOwnership,
  buildRegisterTx,
  submitSignedTx,
  validateSignedTx,
  type ExpectedSignedTx,
} from "../services/registryClient.js";
import { parsePayerFromXPayment } from "../lib/parseXPayment.js";
import { recordSettlementOnFinish, settlementKeyFromHeader } from "../lib/paymentSettlement.js";
import { AppError, isAppError } from "../lib/errors.js";
import { emitToPublisher, enqueueWebhookEvent } from "../services/webhookService.js";

const router: RouterType = Router();

/** Rejects (400) a signed XDR that doesn't invoke the expected registry call. */
function assertSignedTx(signedXdr: string, expected: ExpectedSignedTx): void {
  try {
    validateSignedTx(signedXdr, expected);
  } catch (err) {
    if (err instanceof SignedTxValidationError) {
      throw new AppError("VALIDATION_ERROR", "Signed transaction does not match this resource", {
        detail: err.message,
      });
    }
    throw err;
  }
}

// Parses a single-range `Range` header (#233). Only the documented single-range
// form `bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>` is supported;
// multi-range requests are rejected as unsatisfiable rather than silently
// returning only the first range. Returns null when no Range header is present.
type ParsedRange = { start: number; end: number };

function parseSingleRange(
  header: string | undefined,
  size: number,
): { range: ParsedRange | null; unsatisfiable: boolean } {
  if (!header) return { range: null, unsatisfiable: false };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { range: null, unsatisfiable: true };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { range: null, unsatisfiable: true };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { range: null, unsatisfiable: true };
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0) {
      return { range: null, unsatisfiable: true };
    }
    if (rawEnd === "") {
      end = size - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isSafeInteger(end) || end < start) {
        return { range: null, unsatisfiable: true };
      }
      end = Math.min(end, size - 1);
    }
  }

  if (size === 0 || start >= size) return { range: null, unsatisfiable: true };
  return { range: { start, end }, unsatisfiable: false };
}

// Best-effort removal of a multer disk-stored temp file. Never throws.
async function cleanupTempFile(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await fs.unlink(path);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      getLogger().warn(
        { event: "upload_temp_cleanup_error", path, err },
        "failed to remove upload temp file",
      );
    }
  }
}

// POST /resources — publish a resource (authenticated)
router.post(
  "/resources",
  apiKeyAuth,
  publishIpRateLimit,
  publishWalletRateLimit,
  singleFileUpload("file"),
  validateUploadContentType,
  requestSignatureAuth,
  async (req, res) => {
    const publisher = req.publisher!;

    // Idempotency (#114): if the client supplies an Idempotency-Key, a retry
    // with the same key returns the original result instead of creating a
    // duplicate. Keys are scoped per publisher.
    const idemKey = parseIdempotencyKey(req.header("Idempotency-Key"));
    const store = getIdempotencyStore();
    const scopedKey = idemKey ? idempotencyCacheKey(publisher.id, idemKey) : null;
    // True once this request has actually claimed scopedKey's reservation.
    // Only then is it this request's to release on failure — a conflict
    // from someone else's live reservation must never delete their record.
    let ownsReservation = false;

    try {
      if (getRequestSignal(res)?.aborted) {
        // Timed out before any work started (#73); nothing was reserved yet.
        return;
      }

      // Read once, up front, so both the fingerprint (below) and the later
      // upload use the same bytes instead of reading the temp file twice.
      const fileBuffer = req.file ? await fs.readFile(req.file.path) : null;

      // Canonical fingerprint of the request content (#171). Computed before
      // the reservation below so reusing a key with different metadata or
      // file bytes is rejected as a conflict instead of racing to either
      // replay or overwrite an unrelated result.
      const fingerprint = scopedKey
        ? computeIdempotencyFingerprint({
            title: req.body?.title,
            description: req.body?.description,
            price: req.body?.price,
            walletAddress: req.body?.walletAddress,
            externalUrl: req.body?.externalUrl,
            fileContentHash: fileBuffer ? calculateContentHash(fileBuffer) : undefined,
            filename: req.file?.originalname,
            mimeType: req.file?.mimetype,
          })
        : "";

      if (scopedKey) {
        // Atomic reserve-or-read (#170): only one concurrent request with
        // this key claims it; every other request observes the claimant's
        // record instead of racing a separate get()-then-set().
        const existing = await store.reserve(
          scopedKey,
          { inProgress: true, fingerprint },
          IDEMPOTENCY_IN_PROGRESS_TTL_MS,
        );
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new AppError(
              "CONFLICT",
              "Idempotency-Key was already used with a different request",
            );
          }
          if (existing.inProgress) {
            // A concurrent request with the same key is still running.
            throw new AppError("CONFLICT", "Idempotent request already in progress");
          }
          res.status(existing.result.status).json(existing.result.body);
          return;
        }
        ownsReservation = true;
      }

      // Records the final result under the idempotency key (when keyed), then responds.
      const sendResult = async (status: number, body: unknown) => {
        if (scopedKey) {
          await store.set(scopedKey, { inProgress: false, fingerprint, result: { status, body } });
        }
        // After a request timeout (#73) the 503 is already sent; the final
        // outcome is still recorded above so retries see it.
        if (!res.headersSent) res.status(status).json(body);
      };

      // File upload
      if (req.file) {
        const parsed = validateFields(filePublishBodySchema, req.body);
        if (!parsed.success) {
          // Validation failures aren't a committed result — release the key so
          // a corrected retry can proceed.
          if (ownsReservation) await store.delete(scopedKey!);
          throw new AppError("VALIDATION_ERROR", "Invalid request body", {
            detail: parsed.error.format(),
          });
        }

        const { title, description, price, walletAddress } = parsed.data;

        // Thumbnail generation happens asynchronously in a worker (#89), so
        // the response does not wait on it. The per-publisher storage quota is
        // reserved atomically inside createFileResource before the storage
        // write, and released again if the write fails (#234).
        let resource: Awaited<ReturnType<typeof createFileResource>>;
        try {
          resource = await createFileResource({
            publisherId: publisher.id,
            title,
            description,
            price,
            walletAddress: walletAddress || publisher.walletAddress,
            fileBuffer: fileBuffer!,
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
          });
        } catch (err) {
          // Quota rejection (or any other failure) is not a committed result —
          // release the idempotency key so a corrected retry can proceed.
          if (ownsReservation) await store.delete(scopedKey!);
          throw err;
        }

        await sendResult(201, {
          ...resource,
          accessUrl: `${config.BASE_URL}/resources/${resource.id}`,
        });
        return;
      }

      // Link resource
      const parsed = linkPublishSchema.safeParse(req.body);
      if (!parsed.success) {
        if (ownsReservation) await store.delete(scopedKey!);
        throw new AppError("VALIDATION_ERROR", "Invalid request body", {
          detail: parsed.error.format(),
        });
      }

      const resource = await createLinkResource({
        publisherId: publisher.id,
        title: parsed.data.title,
        description: parsed.data.description,
        price: parsed.data.price,
        walletAddress: parsed.data.walletAddress || publisher.walletAddress,
        externalUrl: parsed.data.externalUrl,
      });

      await sendResult(201, {
        ...resource,
        accessUrl: `${config.BASE_URL}/resources/${resource.id}`,
      });
    } catch (err) {
      // Publish failed — release the key so the client can retry rather than
      // being stuck behind a stale in-progress marker. Only release it if
      // this request actually owns the reservation: a conflict error from
      // someone else's live reservation must not delete their record.
      if (ownsReservation) await store.delete(scopedKey!);
      throw err;
    } finally {
      // Always remove the disk-stored temp file, whether the request succeeded
      // or failed.
      await cleanupTempFile(req.file?.path);
    }
  },
);

// GET /resources — browse catalog (public)
//
// Pagination (#162): `limit` (default 20, max 100) and `offset` control the page.
// Metadata for fetching the next page is returned via response headers rather
// than the body, so the response stays a plain array for existing clients:
//   X-Total-Count, X-Limit, X-Offset, X-Next-Offset (omitted on the last page)
//
// Sorting (#163): `sort` accepts newest (default), price_asc, price_desc, title.
//
// Query validation policy (#226):
//   - Repeated parameters are rejected with VALIDATION_ERROR, except `tags`,
//     which is repeatable and ANDed: `?tags=art&tags=music`.
//   - Array/object syntax (e.g. `?limit[]=5`, `?filter[x]=y`) is rejected.
//   - Unknown query keys are rejected rather than silently ignored.
//   Examples:
//     GET /resources?tags=art&tags=music   → 200 (both tags required)
//     GET /resources?limit=5&limit=10      → 400 VALIDATION_ERROR
//     GET /resources?limit[]=5             → 400 VALIDATION_ERROR
//     GET /resources?unknown=1             → 400 VALIDATION_ERROR
router.get("/resources", async (req, res) => {
  // Query validation policy (#226): repeated/array/object values are rejected
  // with VALIDATION_ERROR, except `tags` which is documented as repeatable
  // (`?tags=a&tags=b`). Unknown keys are rejected rather than silently ignored.
  const parsed = catalogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid query params",
      { detail: parsed.error.format() },
    );
  }

  const hasFilters = Object.values(parsed.data).some((v) => v !== undefined);
  const limit = parsed.data.limit ?? CATALOG_DEFAULT_LIMIT;
  const offset = parsed.data.offset ?? 0;

  // `tags` (#222): exact, case-insensitive matching; multiple tags are ANDed
  // (a resource must carry every requested tag). Validated by the schema.
  const filters = { ...parsed.data, limit, offset };

  let catalog: Awaited<ReturnType<typeof listCatalog>>;
  let total: number;
  try {
    [catalog, total] = await Promise.all([
      listCatalog(filters),
      countCatalog(hasFilters ? parsed.data : undefined),
    ]);
  } catch (err: any) {
    // DB error details stay in the logs; they're not safe to return publicly.
    getLogger().error(
      { err, detail: err?.detail, hint: err?.hint, pgCode: err?.code, event: "catalog_error" },
      "catalog query failed",
    );
    throw new AppError("INTERNAL_ERROR", "Failed to load catalog", undefined, { cause: err });
  }

  const nextOffset = offset + catalog.length < total ? offset + catalog.length : null;

  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Limit", String(limit));
  res.setHeader("X-Offset", String(offset));
  if (nextOffset !== null) res.setHeader("X-Next-Offset", String(nextOffset));

  res.json(
    catalog.map((r) => ({
      ...r,
      accessUrl: `${config.BASE_URL}/resources/${r.id}`,
    })),
  );
});

// GET /resources/:id/meta — resource preview (public)
//
// Conditional reads (#223): the response carries a stable ETag derived from the
// public metadata. A matching If-None-Match yields 304 with no body. The
// validator is only emitted on this public route — private/owner-only
// responses never reuse it.
router.get("/resources/:id/meta", async (req, res) => {
  const meta = await getResourceMeta(req.params.id as string);
  if (!meta) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }

  // Weak validator: metadata equality, not byte-for-byte identity.
  const etag = `W/${computeResourceEtag(meta)}`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, no-cache");

  if (req.header("If-None-Match")?.split(",").some(value => { const tag = value.trim(); return tag === "*" || tag.replace(/^W\//, "") === etag.replace(/^W\//, ""); })) {
    res.status(304).end();
    return;
  }

  res.json({
    ...meta,
    accessUrl: `${config.BASE_URL}/resources/${meta.id}`,
    ...(meta.mimeType?.startsWith("image/")
      ? { thumbnailUrl: `${config.BASE_URL}/resources/${meta.id}/thumbnail` }
      : {}),
  });
});

// GET /resources/:id/verification — verification status and details (public)
router.get("/resources/:id/verification", async (req, res) => {
  const details = await getVerificationDetails(req.params.id as string);
  if (!details) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  res.json(details);
});

// GET /resources/:id/thumbnail — resource thumbnail (public)
router.get("/resources/:id/thumbnail", async (req, res) => {
  const resource = await getResourceById(req.params.id as string);
  if (!resource || !resource.storagePath || !resource.mimeType?.startsWith("image/")) {
    throw new AppError("NOT_FOUND", "Thumbnail not found");
  }

  const filename = resource.storagePath.split("/").pop();
  const thumbStoragePath = `${resource.id}/thumb_${filename}`;

  try {
    const { buffer, mimeType } = await downloadFile(thumbStoragePath);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(buffer);
  } catch (err) {
    // Only a genuinely missing object is a 404. Any other storage failure is an
    // outage and must surface as 503 so clients and monitoring can tell the
    // difference (#91).
    if (err instanceof StorageNotFoundError) {
      throw new AppError("NOT_FOUND", "Thumbnail not found");
    }
    getLogger().error(
      { err, event: "thumbnail_storage_error", resourceId: resource.id },
      "thumbnail storage download failed",
    );
    throw new AppError("SERVICE_UNAVAILABLE", "Thumbnail storage is temporarily unavailable", undefined, {
      cause: err,
    });
  }
});

// GET /resources/:id — access resource (x402 paywalled)
router.get("/resources/:id", dynamicPaywall, async (req, res) => {
  const resource = (req as any).resource;

  // Record payment — best-effort payer extraction, never blocks delivery
  let payerAddress = "unknown";
  const paymentHeader = req.headers["x-payment"];
  if (paymentHeader && typeof paymentHeader === "string") {
    const { payer, parseError } = parsePayerFromXPayment(paymentHeader);
    if (payer) {
      payerAddress = payer;
    } else if (parseError) {
      getLogger().warn(
        { event: "x_payment_parse_error", resourceId: resource.id, error: parseError },
        "failed to parse X-Payment header; payer recorded as unknown",
      );
    }
  }

  // Records a payment row with an explicit delivery status so an undelivered
  // purchase can be reconciled later (#86).
  const settlementKey = settlementKeyFromHeader(paymentHeader);
  const emitPurchase = (payment: typeof payments.$inferSelect) => {
    // Fire-and-forget: webhook delivery never delays or fails content access.
    const purchase = {
      paymentId: payment.id,
      resourceId: payment.resourceId,
      amount: payment.amount,
      payerAddress: payment.payerAddress,
      recipientAddress: payment.recipientAddress,
      paidAt: payment.paidAt,
    };
    void enqueueWebhookEvent(resource.publisherId, "resource.purchased", purchase);
    void enqueueWebhookEvent(resource.publisherId, "payment.received", purchase);
  };

  // Records a payment row with an explicit delivery status so an undelivered
  // purchase can be reconciled later (#86). A replayed authorization hits the
  // unique settlement key and reuses the existing row (#192).
  const recordPayment = async (deliveryStatus: "delivered" | "undelivered") => {
    const [inserted] = await db
      .insert(payments)
      .values({
        resourceId: resource.id,
        payerAddress,
        recipientAddress: resource.walletAddress,
        amount: resource.price,
        deliveryStatus,
        settlementKey,
      })
      .onConflictDoNothing({ target: payments.settlementKey })
      .returning();
    if (!inserted) {
      const [existing] = await db.select().from(payments).where(eq(payments.settlementKey, settlementKey!));
      return existing;
    }
    // Starts pending; flips to settled/failed once x402 settles (#99).
    // Purchase webhooks fire only after confirmed settlement (#193).
    recordSettlementOnFinish(res, inserted.id, emitPurchase);
    return inserted;
  };

  if (resource.resourceType === "link") {
    const payment = await recordPayment("delivered");
    res.json({
      url: resource.externalUrl,
      receipt: {
        paymentId: payment.id,
        amount: payment.amount,
        currency: "USDC",
        paidTo: payment.recipientAddress,
        paidAt: payment.paidAt,
        terms: toReceiptTerms(payment),
      },
    });
    return;
  }

  // Stream file from Supabase Storage
  if (!resource.storagePath) {
    throw new AppError("INTERNAL_ERROR", "Resource file not found");
  }

  // Fetch the content *before* recording the payment so a storage failure
  // never leaves a silently undelivered purchase. Range requests (#233) are
  // authorized by the same paywall middleware: a retry that reuses the same
  // settlement key hits the unique constraint in recordPayment and reuses the
  // existing authorization instead of charging again.
  const rangeHeader = req.headers.range;
  const rangeValue = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;

  let fileContent: Awaited<ReturnType<typeof downloadFile>>;
  let range: ParsedRange | null = null;
  let unsatisfiable = false;
  try {
    if (rangeValue) {
      // Range delivery needs the object size up front to validate the range.
      const head = await downloadFile(resource.storagePath);
      const parsedRange = parseSingleRange(rangeValue, head.buffer.length);
      if (parsedRange.unsatisfiable) {
        unsatisfiable = true;
        fileContent = head;
      } else {
        range = parsedRange.range;
        fileContent = range
          ? await downloadFileRange(resource.storagePath, range.start, range.end)
          : head;
      }
    } else {
      fileContent = await downloadFile(resource.storagePath);
    }
  } catch (err) {
    const payment = await recordPayment("undelivered");
    getLogger().error(
      {
        event: "resource_delivery_failed",
        resourceId: resource.id,
        paymentId: payment.id,
        payerAddress,
        storagePath: resource.storagePath,
        err,
      },
      "file download failed after payment; payment marked undelivered for reconciliation",
    );
    throw new AppError("UPSTREAM_ERROR", "Failed to deliver resource content", {
      paymentId: payment.id,
      deliveryStatus: "undelivered",
    });
  }

  // An unsatisfiable range is not a delivery: the purchase stays authorized
  // (recorded as undelivered) so the client can retry with a valid range
  // without being charged again.
  if (unsatisfiable) {
    const payment = await recordPayment("undelivered");
    res.status(416);
    res.setHeader("Content-Range", `bytes */${fileContent.buffer.length}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Payment-Id", payment.id);
    res.end();
    return;
  }

  const payment = await recordPayment("delivered");

  // Add receipt info in headers for file downloads
  res.setHeader("X-Payment-Id", payment.id);
  res.setHeader("X-Payment-Amount", `${payment.amount} USDC`);
  res.setHeader("X-Payment-Recipient", payment.recipientAddress);
  if (payment.network) res.setHeader("X-Payment-Network", payment.network);
  if (payment.asset) res.setHeader("X-Payment-Asset", `${RECEIPT_ASSET_CODE}:${payment.asset}`);
  if (payment.resourceContentHash) res.setHeader("X-Content-Hash", payment.resourceContentHash);

  const { buffer, mimeType } = fileContent;
  res.setHeader("Content-Type", mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", attachmentDisposition(resource.storagePath.split("/").pop() ?? ""));

  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${fileContent.buffer.length}`);
    res.setHeader("Content-Length", String(buffer.length));
  }

  res.send(buffer);
});

// DELETE /resources/:id — delist a resource (authenticated, owner only)
router.delete("/resources/:id", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  const resource = await delistResource(req.params.id as string, req.publisher!.id);
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found or not owned by you");
  }
  res.json({ message: "Resource delisted", id: resource.id });
});

// GET /resources/:id/register/prepare — get unsigned register tx (owner only)
router.get("/resources/:id/register/prepare", apiKeyAuth, async (req, res) => {
  const publisher = req.publisher!;
  const resourceId = req.params.id as string;

  const resource = await getResourceById(resourceId);
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  if (resource.publisherId !== publisher.id) {
    throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
  }
  if (resource.verificationStatus !== "verified") {
    throw new AppError("VALIDATION_ERROR", "Resource must be verified before registering on-chain");
  }
  if (resource.onchainStatus === "registered") {
    throw new AppError("CONFLICT", "Resource is already registered on-chain");
  }

  try {
    // Build metadata from resource
    const metadata = JSON.stringify({
      title: resource.title,
      description: resource.description ?? "",
      contentHash: resource.contentHash,
    });

    const unsignedXdr = await buildRegisterTx(
      resource.walletAddress,
      resourceId,
      resource.price,
      metadata,
    );

    res.json({
      unsignedXdr,
      networkPassphrase: NETWORK_PASSPHRASE,
      metadata: {
        resourceId,
        creator: resource.walletAddress,
        price: resource.price,
        title: resource.title,
        description: resource.description,
      },
    });
  } catch (err: any) {
    throw new AppError("UPSTREAM_ERROR", "Failed to build register transaction", {
      detail: err?.message,
    });
  }
});

// POST /resources/:id/register — register a verified resource on-chain (owner only)
// Can be called again to retry if onchainStatus is "failed".
router.post(
  "/resources/:id/register",
  apiKeyAuth,
  requestSignatureAuth,
  validate(registerResourceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      throw new AppError("NOT_FOUND", "Resource not found");
    }
    if (resource.publisherId !== publisher.id) {
      throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
    }
    if (resource.verificationStatus !== "verified") {
      throw new AppError(
        "VALIDATION_ERROR",
        "Resource must be verified before registering on-chain",
      );
    }
    if (resource.onchainStatus === "registered") {
      throw new AppError("CONFLICT", "Resource is already registered on-chain", {
        onchainTxHash: resource.onchainTxHash,
      });
    }
    // "pending" means a registration is already in-flight — don't double-submit
    if (resource.onchainStatus === "pending") {
      throw new AppError("CONFLICT", "Registration already in progress", {
        message:
          "An on-chain registration for this resource is already pending. A background worker retries pending registrations automatically for a few minutes.",
        nextSteps: [
          "Wait for the pending registration to settle — re-check this resource's onchainStatus shortly.",
          `If it is still pending after several minutes, the retry worker marks it "failed", after which you can retry with POST /resources/${resourceId}/register.`,
          ...(resource.onchainTxHash
            ? [`Inspect the in-flight transaction: ${explorerTxUrl(resource.onchainTxHash)}`]
            : []),
        ],
        ...(resource.onchainTxHash ? { txHash: resource.onchainTxHash } : {}),
      });
    }
    // "none" or "failed" → proceed (failed is retryable)

    const { signedXdr } = req.body;

    if (!signedXdr && !config.ALLOW_LEGACY_REGISTER) {
      throw new AppError(
        "GONE",
        "Server-signed registration is no longer supported",
        {
          message:
            "Registrations must be signed by the resource owner. Use GET /resources/:id/register/prepare to obtain an unsigned transaction, sign it client-side, then submit the signed XDR via POST /resources/:id/register.",
          nextSteps: [
            `Call GET /resources/${resourceId}/register/prepare to get the unsignedXdr.`,
            "Sign the transaction with the creator's wallet.",
            `Submit the signed XDR as { "signedXdr": "..." } to POST /resources/${resourceId}/register.`,
          ],
        },
      );
    }

    // Atomically claim the registration slot (#78): only one concurrent request
    // can transition the resource out of none/failed. The loser gets no row.
    const [claimed] = await db
      .update(resources)
      .set({ onchainStatus: "pending", onchainPendingSince: new Date() })
      .where(
        and(
          eq(resources.id, resourceId),
          inArray(resources.onchainStatus, ["none", "failed"]),
        ),
      )
      .returning();

    if (!claimed) {
      throw new AppError("CONFLICT", "Registration already in progress", {
        message:
          "An on-chain registration for this resource is already pending. A background worker retries pending registrations automatically for a few minutes.",
        nextSteps: [
          "Wait for the pending registration to settle — re-check this resource's onchainStatus shortly.",
          `If it is still pending after several minutes, the retry worker marks it "failed", after which you can retry with POST /resources/${resourceId}/register.`,
        ],
      });
    }

    try {
      if (signedXdr) {
        // New flow: verify the signed XDR targets this resource, then submit.
        const expected: ExpectedSignedTx = {
          functionName: "register",
          resourceId,
          owner: resource.walletAddress,
        };
        // A mismatch throws; the catch below marks the resource failed.
        assertSignedTx(signedXdr, expected);

        const result = await submitSignedTx(signedXdr, expected);

        if (result.state === "confirmed") {
          getLogger().info(
            {
              event: "onchain_register",
              resourceId,
              txHash: result.txHash,
              success: true,
            },
            "on-chain resource registration succeeded",
          );
          const [updated] = await db
            .update(resources)
            .set({ onchainStatus: "registered", onchainTxHash: result.txHash })
            .where(eq(resources.id, resourceId))
            .returning();

          res.json({
            id: updated.id,
            onchainStatus: updated.onchainStatus,
            txHash: result.txHash,
          });
        } else if (result.state === "pending") {
          // Still in flight — leave the resource pending so the worker can
          // resolve it by hash (#77). Do not mark it failed on timeout.
          getLogger().info(
            {
              event: "onchain_register",
              resourceId,
              txHash: result.txHash,
              success: true,
              pending: true,
            },
            "on-chain resource registration still pending",
          );
          await db
            .update(resources)
            .set({ onchainStatus: "pending", onchainTxHash: result.txHash })
            .where(eq(resources.id, resourceId));

          res.status(202).json({
            id: resourceId,
            onchainStatus: "pending",
            txHash: result.txHash,
          });
        } else {
          getLogger().warn(
            {
              event: "onchain_register",
              resourceId,
              txHash: result.txHash || undefined,
              success: false,
              error: result.error,
            },
            "on-chain resource registration failed",
          );
          await db
            .update(resources)
            .set({ onchainStatus: "failed" })
            .where(eq(resources.id, resourceId));
          const guidance = buildRegistrationFailureGuidance({
            resourceId,
            txHash: result.txHash,
            detail: result.error,
          });
          throw new AppError("UPSTREAM_ERROR", "On-chain registration failed", {
            detail: result.error,
            txHash: result.txHash || undefined,
            ...guidance,
          });
        }
      } else {
        // Legacy flow: server signs and submits
        const priceStroops = BigInt(Math.round(parseFloat(resource.price) * 1_000_000_0));
        const tx = await (registryClient as any).register(
          {
            creator: resource.walletAddress,
            id: resourceId,
            price: priceStroops,
            metadata: JSON.stringify({
              title: resource.title,
              description: resource.description ?? "",
            }),
            tags: [],
          },
          // signAndSend needs a simulated (footprinted) transaction.
          { simulate: true },
        );

        const sentTx = await tx.signAndSend({
          signTransaction: async (xdr: string) => {
            const { Transaction } = await import("@stellar/stellar-sdk");
            const stellarTx = new Transaction(xdr, NETWORK_PASSPHRASE);
            stellarTx.sign(registryKeypair);
            return { signedTxXdr: stellarTx.toXDR() };
          },
        });

        const legacyTxHash = sentTx?.sendTransactionResponse?.hash ?? "";
        getLogger().info(
          {
            event: "onchain_register",
            resourceId,
            txHash: legacyTxHash,
            success: true,
            flow: "legacy",
          },
          "on-chain resource registration succeeded",
        );

        const [updated] = await db
          .update(resources)
          .set({
            onchainStatus: "registered",
            ...(legacyTxHash ? { onchainTxHash: legacyTxHash } : {}),
          })
          .where(eq(resources.id, resourceId))
          .returning();

        res.json({
          id: updated.id,
          onchainStatus: updated.onchainStatus,
          ...(legacyTxHash ? { txHash: legacyTxHash } : {}),
        });
      }
    } catch (err: any) {
      // Mark failed but do NOT touch `listed` — resource stays available for purchase
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resourceId));

      // AppErrors raised inside the flow (e.g. the signed-flow failure) already
      // carry tx hash, explorer link and guidance, and were logged there — pass
      // them through unchanged so that context isn't lost or logged twice.
      if (isAppError(err)) {
        throw err;
      }

      getLogger().error(
        { event: "onchain_register", resourceId, success: false, err },
        "on-chain resource registration failed",
      );
      const guidance = buildRegistrationFailureGuidance({
        resourceId,
        detail: err?.message,
      });
      throw new AppError("UPSTREAM_ERROR", "On-chain registration failed", {
        detail: err?.message,
        ...guidance,
      });
    }
  },
);

// POST /resources/:id/price/prepare — build unsigned set_price tx (owner only)
// Returns the XDR of an unsigned transaction the owner must sign client-side.
router.post(
  "/resources/:id/price/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  validate(preparePriceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      throw new AppError("NOT_FOUND", "Resource not found");
    }
    if (resource.publisherId !== publisher.id) {
      throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
    }

    const { price } = req.body;

    const unsignedXdr = await setPrice(resourceId, price);
    res.json({ unsignedXdr, networkPassphrase: NETWORK_PASSPHRASE });
  },
);

// POST /resources/:id/price — submit signed set_price tx and sync DB price
router.post(
  "/resources/:id/price",
  apiKeyAuth,
  requestSignatureAuth,
  validate(setPriceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      throw new AppError("NOT_FOUND", "Resource not found");
    }
    if (resource.publisherId !== publisher.id) {
      throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
    }

    const { signedXdr, price } = req.body;

    const expected: ExpectedSignedTx = {
      functionName: "set_price",
      resourceId,
      owner: resource.walletAddress,
    };
    assertSignedTx(signedXdr, expected);

    // Take the price from the signed operation; reject a body that disagrees (#74).
    const onChainPrice = decodeSetPrice(signedXdr, price);

    const result = await submitSignedTx(signedXdr, expected);

    if (result.state === "failed") {
      throw new AppError("UPSTREAM_ERROR", "Transaction failed on-chain", {
        detail: result.error,
        txHash: result.txHash || undefined,
      });
    }

    if (result.state === "pending") {
      // Still in flight — return the hash so the client can poll status.
      res.status(202).json({ id: resourceId, txHash: result.txHash, status: "pending" });
      return;
    }

    // Sync the DB price to match the on-chain value
    const [updated] = await db
      .update(resources)
      .set({ price: onChainPrice })
      .where(eq(resources.id, resourceId))
      .returning();

    res.json({ id: updated.id, price: updated.price, status: "confirmed" });
  },
);

// POST /resources/:id/ownership/prepare — build unsigned transfer_ownership tx (owner only)
router.post(
  "/resources/:id/ownership/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  validate(prepareOwnershipSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      throw new AppError("NOT_FOUND", "Resource not found");
    }
    if (resource.publisherId !== publisher.id) {
      throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
    }

    const { newCreator } = req.body;

    const unsignedXdr = await transferOwnership(resourceId, newCreator);
    res.json({ unsignedXdr, networkPassphrase: NETWORK_PASSPHRASE });
  },
);

// POST /resources/:id/ownership — submit signed transfer_ownership tx and sync DB
router.post(
  "/resources/:id/ownership",
  apiKeyAuth,
  requestSignatureAuth,
  validate(transferOwnershipSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      throw new AppError("NOT_FOUND", "Resource not found");
    }
    if (resource.publisherId !== publisher.id) {
      throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
    }

    const { signedXdr, newCreator } = req.body;

    const expected: ExpectedSignedTx = {
      functionName: "transfer_ownership",
      resourceId,
      owner: resource.walletAddress,
    };
    assertSignedTx(signedXdr, expected);

    // Take the new owner from the signed operation; reject a mismatch (#74).
    const onChainCreator = decodeNewCreator(signedXdr, newCreator);

    const result = await submitSignedTx(signedXdr, expected);

    if (result.state === "failed") {
      throw new AppError("UPSTREAM_ERROR", "Transaction failed on-chain", {
        detail: result.error,
        txHash: result.txHash || undefined,
      });
    }

    if (result.state === "pending") {
      // Still in flight — return the hash so the client can poll status.
      res.status(202).json({ id: resourceId, txHash: result.txHash, status: "pending" });
      return;
    }

    const [updated] = await db
      .update(resources)
      .set({ walletAddress: onChainCreator })
      .where(eq(resources.id, resourceId))
      .returning();

    res.json({ id: updated.id, newCreator: updated.walletAddress, status: "confirmed" });
  },
);

export default router;