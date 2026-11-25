import { z } from "zod/v4";
import { config } from "../config.js";
import { stellarAddressSchema } from "../lib/stellarAddressValidation.js";
import { priceSchema } from "../lib/priceValidation.js";
import { webhookEventValues } from "./webhooks.js";
import { httpUrlSchema } from "../lib/externalUrlValidation.js";

export const publisherRegisterSchema = z
  .object({
    name: z.string().min(1),
    // Normalise email at the boundary: trim whitespace and lowercase so the
    // unique constraint reliably catches case-insensitive duplicates (#39).
    email: z.email().transform((e) => e.trim().toLowerCase()),
    walletAddress: stellarAddressSchema,
  })
  .strict();

export const linkPublishSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    price: priceSchema,
    walletAddress: stellarAddressSchema.optional(),
    externalUrl: httpUrlSchema,
  })
  .strict();

export const filePublishBodySchema = z
  .object({
    title: z.string().min(1),
    price: priceSchema,
    description: z.string().optional(),
    walletAddress: stellarAddressSchema.optional(),
  })
  .strict();

export const verifyContentSchema = z
  .object({
    content: z.string().min(1),
    resourceId: z.string().min(1).optional(),
  })
  .strict();

export const registerResourceSchema = z
  .object({
    signedXdr: z.string().min(1).optional(),
  })
  .strict();

export const preparePriceSchema = z
  .object({
    price: priceSchema,
  })
  .strict();

export const setPriceSchema = z
  .object({
    signedXdr: z.string().min(1),
    price: priceSchema,
  })
  .strict();

export const prepareOwnershipSchema = z
  .object({
    newCreator: stellarAddressSchema,
  })
  .strict();

export const transferOwnershipSchema = z
  .object({
    signedXdr: z.string().min(1),
    newCreator: stellarAddressSchema,
  })
  .strict();

/**
 * Shared query-parameter validation policy (#226).
 *
 * Express parses query strings with the `qs` library, so a repeated parameter
 * (`?foo=a&foo=b`) arrives as an array and a bracketed parameter
 * (`?foo[bar]=baz`) arrives as an object. Both are ambiguous for single-valued
 * filters, so every single-valued query param is validated with
 * {@link strictQueryString}, which rejects arrays and objects instead of
 * silently ignoring them.
 *
 * Unknown keys are rejected per endpoint: `catalogQuerySchema` and
 * `adminAuditQuerySchema` are both `.strict()`, so any unrecognised key is a
 * validation error rather than being dropped.
 *
 * Repeated parameters: only the catalog `tags` filter accepts repeated values
 * (`?tags=a&tags=b`, equivalent to `?tags=a,b`). Every other query parameter
 * rejects arrays.
 */
export const strictQueryString = <T extends z.ZodType<string>>(schema: T) =>
  z.union([schema, z.array(z.unknown()), z.record(z.string(), z.unknown())]).transform((value, ctx) => {
    if (Array.isArray(value)) {
      ctx.addIssue({
        code: "custom",
        message: "must be a single value; repeated parameters are not supported",
      });
      return z.NEVER;
    }
    if (typeof value === "object" && value !== null) {
      ctx.addIssue({
        code: "custom",
        message: "must be a single value; object parameters are not supported",
      });
      return z.NEVER;
    }
    return value as z.output<T>;
  });

/** Sort values supported by GET /resources (#163). */
export const catalogSortValues = ["newest", "price_asc", "price_desc", "title"] as const;

export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

/** Maximum number of tags accepted by the catalog `tags` filter (#222). */
export const CATALOG_MAX_TAGS = 10;
/** Maximum length of a single tag accepted by the catalog `tags` filter (#222). */
export const CATALOG_MAX_TAG_LENGTH = 64;

/**
 * Normalise a single tag: trim surrounding whitespace and lowercase it so
 * matching is case-insensitive and exact against the stored `tags` column.
 */
const normalizeCatalogTag = (tag: string): string => tag.trim().toLowerCase();

/**
 * Catalog `tags` filter (#222).
 *
 * Accepts either a comma-separated string (`tags=audio,music`) or repeated
 * query values (`tags=audio&tags=music`), which Express surfaces as an array.
 * Each tag is trimmed and lowercased; empty entries are rejected. Matching is
 * exact (whole-tag equality, not substring) and multiple tags use AND
 * semantics: a resource must carry *all* requested tags to be returned.
 */
export const catalogTagsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx) => {
    const raw = Array.isArray(value) ? value : value.split(",");
    const tags: string[] = [];
    for (const entry of raw) {
      const tag = normalizeCatalogTag(entry);
      if (tag.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "tags must not contain empty entries",
        });
        return z.NEVER;
      }
      if (tag.length > CATALOG_MAX_TAG_LENGTH) {
        ctx.addIssue({
          code: "custom",
          message: `each tag must be at most ${CATALOG_MAX_TAG_LENGTH} characters`,
        });
        return z.NEVER;
      }
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
    if (tags.length > CATALOG_MAX_TAGS) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${CATALOG_MAX_TAGS} tags may be requested`,
      });
      return z.NEVER;
    }
    return tags;
  });

/** Query params for GET /resources (public catalog). */
/** Body for PATCH /publishers/me/rate-limit. `null` resets to the platform default. */
export const updateRateLimitSchema = z
  .object({
    rateLimitRpm: z
      .number()
      .int()
      .min(1)
      .max(config.PUBLISHER_RATE_LIMIT_MAX_RPM)
      .nullable(),
  })
  .strict();

/** Body for PATCH /publishers/me/webhooks. `null` clears the URL or secret. */
export const updateWebhookConfigSchema = z
  .object({
    webhookUrl: z.url({ protocol: /^https?$/ }).nullable().optional(),
    webhookSecret: z.string().min(16).max(256).nullable().optional(),
    webhookEvents: z.array(z.enum(webhookEventValues)).max(webhookEventValues.length).optional(),
    webhookEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field is required" });

/**
 * Query params for GET /resources (public catalog).
 *
 * Unknown keys are rejected (`.strict()`). All params except `tags` are
 * single-valued: repeated parameters (`?search=a&search=b`) and object
 * parameters (`?search[x]=a`) are rejected. `tags` is the only param that
 * accepts repeated values (`?tags=a&tags=b`), which is equivalent to the
 * comma-separated form (`?tags=a,b`).
 */
export const catalogQuerySchema = z
  .object({
    verificationStatus: strictQueryString(z.enum(["verified", "pending", "rejected"])).optional(),
    minPrice: strictQueryString(z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number")).optional(),
    maxPrice: strictQueryString(z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number")).optional(),
    search: strictQueryString(z.string()).optional(),
    resourceType: strictQueryString(z.enum(["file", "link"])).optional(),
    owner: strictQueryString(z.string()).optional(),
    sort: strictQueryString(z.enum(catalogSortValues)).optional(),
    /**
     * Exact-match tag filter (#222). Comma-separated or repeated values;
     * multiple tags are combined with AND semantics (all must be present).
     * This is the only catalog param that accepts repeated values.
     */
    tags: catalogTagsSchema.optional(),
    limit: strictQueryString(z.string().regex(/^\d+$/)).transform((value) => Number(value)).pipe(z.number().int().min(1).max(CATALOG_MAX_LIMIT)).optional(),
    offset: strictQueryString(z.string().regex(/^\d+$/)).transform((value) => Number(value)).pipe(z.number().int().min(0)).optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.minPrice !== undefined && data.maxPrice !== undefined) {
        return parseFloat(data.minPrice) <= parseFloat(data.maxPrice);
      }
      return true;
    },
    {
      message: "minPrice cannot be greater than maxPrice",
      path: ["minPrice"],
    },
  );

/** Maximum page size accepted by the admin payment audit endpoint (#227). */
export const ADMIN_AUDIT_MAX_LIMIT = 200;
export const ADMIN_AUDIT_DEFAULT_LIMIT = 20;

/** Strict positive-integer string (no permissive Number coercion) (#227). */
const strictPositiveIntString = (max?: number) => {
  let schema = z.string().regex(/^\d+$/, "must be a positive integer");
  if (max !== undefined) {
    schema = schema.refine((value) => Number(value) <= max, {
      message: `must be at most ${max}`,
    }) as typeof schema;
  }
  return schema.refine((value) => Number(value) >= 1, {
    message: "must be at least 1",
  });
};

/**
 * Query params for the admin payment audit endpoint (#227).
 *
 * `page` and `limit` are strict integer strings (rejecting values like `1.5`,
 * `1e3`, `+1` or `abc` that permissive Number coercion would accept). `from`
 * and `to` are optional ISO date strings; an inverted range (`from > to`) is
 * rejected. The existing resource/payer/date filters from #111 are preserved.
 *
 * Unknown keys are rejected (`.strict()`). Every param is single-valued:
 * repeated parameters (`?page=1&page=2`) and object parameters
 * (`?page[x]=1`) are rejected (#226).
 */
export const adminAuditQuerySchema = z
  .object({
    page: strictQueryString(strictPositiveIntString()).optional(),
    limit: strictQueryString(strictPositiveIntString(ADMIN_AUDIT_MAX_LIMIT)).optional(),
    from: strictQueryString(z.iso.datetime({ offset: true })).optional(),
    to: strictQueryString(z.iso.datetime({ offset: true })).optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.from !== undefined && data.to !== undefined) {
        return Date.parse(data.from) <= Date.parse(data.to);
      }
      return true;
    },
    {
      message: "from cannot be after to",
      path: ["from"],
    },
  );

/**
 * Alias for {@link adminAuditQuerySchema} used by admin routes (#226).
 *
 * Admin endpoints reject unknown keys and repeated/object parameters; see
 * {@link strictQueryString} for the shared policy.
 */
export const adminQuerySchema = adminAuditQuerySchema;
