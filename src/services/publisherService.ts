import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers, resources } from "../db/schema.js";
import {
  generateApiKey,
  hashApiKey,
  generateSigningSecret,
  encryptSigningSecret,
  encryptWebhookSecret,
} from "../utils/crypto.js";
import { signingKeyring, webhookKeyring } from "../lib/secretKeys.js";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { and, lt, lte, or, desc, asc } from "drizzle-orm";

export async function registerPublisher(data: {
  name: string;
  email: string;
  walletAddress: string;
}) {
  // Normalise the email so that Ada@x.com and ada@x.com are treated as the
  // same address and the unique constraint reliably catches duplicates (#39).
  const email = data.email.trim().toLowerCase();

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  // Issue a signing secret and encrypt it at rest (#42). When
  // SIGNING_SECRET_KEY is not configured, signing secrets are stored
  // unencrypted (acceptable only in development / before signatures are
  // required).
  const signingSecret = generateSigningSecret();
  const keyring = signingKeyring();
  const storedSigningSecret = keyring ? encryptSigningSecret(signingSecret, keyring) : signingSecret;

  const [publisher] = await db
    .insert(publishers)
    .values({
      name: data.name,
      email,
      walletAddress: data.walletAddress,
      apiKeyHash,
      signingSecret: storedSigningSecret,
    })
    .returning();

  return { publisher, apiKey, signingSecret };
}

export async function getPublisherById(id: string) {
  return db
    .select()
    .from(publishers)
    .where(eq(publishers.id, id))
    .then((rows) => rows[0] ?? null);
}

export async function getPublisherResources(publisherId: string) {
  return db.select().from(resources).where(eq(resources.publisherId, publisherId));
}

// ── Publisher resource cursor pagination (#220) ──────────────────────────────
//
// Opaque cursors encode (createdAt, id) so the page boundary is stable even
// when two resources share the same createdAt timestamp.  The cursor is
// base64url-encoded JSON: { t: ISO string, id: string }.
//
// Security: cursors are publisher-scoped.  The route layer enforces that the
// decoded publisherId matches the authenticated publisher before executing the
// query, so a cursor minted for publisher A cannot expose rows for publisher B.
//
// Maximum page size is 100; the default is 20.

export const PUBLISHER_RESOURCES_MAX_LIMIT = 100;
export const PUBLISHER_RESOURCES_DEFAULT_LIMIT = 20;

/** Encode an opaque cursor from a createdAt timestamp and row id. */
export function encodeResourceCursor(createdAt: Date, id: string): string {
  const payload = JSON.stringify({ t: createdAt.toISOString(), id });
  return Buffer.from(payload).toString("base64url");
}

/** Decode an opaque cursor. Returns null when the cursor is malformed. */
export function decodeResourceCursor(cursor: string): { t: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).t !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      return null;
    }
    const t = new Date((parsed as Record<string, unknown>).t as string);
    if (isNaN(t.getTime())) return null;
    return { t, id: (parsed as Record<string, unknown>).id as string };
  } catch {
    return null;
  }
}

export interface ResourcePage {
  resources: Array<typeof resources.$inferSelect>;
  /** Opaque cursor to pass as `after` for the next page. Absent on the last page. */
  nextCursor: string | null;
  /** True when there is at least one more page after this one. */
  hasNextPage: boolean;
}

/**
 * Fetch a single page of a publisher's resources ordered by (createdAt DESC, id DESC).
 *
 * Ordering by (createdAt DESC, id DESC) means newest resources appear first.
 * When two resources share the same createdAt the tie-break on id (a CUID2)
 * is arbitrary but stable, so no rows are skipped or duplicated across pages.
 *
 * @param publisherId  Publisher whose resources to list.
 * @param limit        Page size (1–100). Defaults to 20.
 * @param afterCursor  Opaque cursor from a previous response. When omitted the
 *                     first page is returned. The cursor must have been minted
 *                     by this publisher's listing — a foreign cursor returns a
 *                     validation error.
 */
export async function getPublisherResourcesPage(
  publisherId: string,
  limit = PUBLISHER_RESOURCES_DEFAULT_LIMIT,
  afterCursor?: string,
): Promise<ResourcePage> {
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), PUBLISHER_RESOURCES_MAX_LIMIT);

  let cursorCondition: ReturnType<typeof and> | undefined;

  if (afterCursor !== undefined) {
    const decoded = decodeResourceCursor(afterCursor);
    if (!decoded) {
      throw new AppError("VALIDATION_ERROR", "Invalid pagination cursor");
    }

    // Seek past (decoded.t, decoded.id):
    //   createdAt < t  → definitely after the cursor row
    //   createdAt = t  → need id < cursor id  (DESC ordering, so lower id comes later)
    cursorCondition = or(
      lt(resources.createdAt, decoded.t),
      and(
        lte(resources.createdAt, decoded.t),
        lt(resources.id, decoded.id),
      ),
    );
  }

  // Fetch one extra row to determine whether a next page exists.
  const rows = await db
    .select()
    .from(resources)
    .where(
      cursorCondition
        ? and(eq(resources.publisherId, publisherId), cursorCondition)
        : eq(resources.publisherId, publisherId),
    )
    .orderBy(desc(resources.createdAt), desc(resources.id))
    .limit(pageSize + 1);

  const hasNextPage = rows.length > pageSize;
  const pageRows = hasNextPage ? rows.slice(0, pageSize) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeResourceCursor(lastRow.createdAt, lastRow.id) : null;

  return { resources: pageRows, nextCursor, hasNextPage };
}

/**
 * Rotate the API key for a publisher (#40).
 *
 * Atomically replaces the stored key hash with a new one and clears any
 * previous revocation so the fresh key is immediately accepted by apiKeyAuth.
 * The old key stops working the instant its hash is overwritten.
 *
 * Returns the new plaintext key (shown to the caller once, never stored).
 */
export async function rotateApiKey(publisherId: string): Promise<string> {
  const newApiKey = generateApiKey();
  const newApiKeyHash = hashApiKey(newApiKey);

  await db
    .update(publishers)
    .set({
      apiKeyHash: newApiKeyHash,
      // Clear any prior revocation — the new key is active.
      apiKeyRevokedAt: null,
    })
    .where(eq(publishers.id, publisherId));

  return newApiKey;
}

/**
 * Rotate the per-publisher HMAC signing secret (#42).
 *
 * Generates a new secret, encrypts it, persists it, and returns the plaintext
 * (shown once — the caller must store it; the server never exposes it again).
 */
export async function rotateSigningSecret(publisherId: string): Promise<string> {
  const signingSecret = generateSigningSecret();
  const keyring = signingKeyring();
  const storedSigningSecret = keyring ? encryptSigningSecret(signingSecret, keyring) : signingSecret;

  await db
    .update(publishers)
    .set({ signingSecret: storedSigningSecret })
    .where(eq(publishers.id, publisherId));

  return signingSecret;
}

export async function getPublisherWebhookConfig(publisherId: string) {
  const publisher = await getPublisherById(publisherId);
  if (!publisher) {
    return null;
  }

  return {
    url: publisher.webhookUrl ?? null,
    secret: publisher.webhookSecret ?? null,
    events: publisher.webhookEvents ?? [],
    enabled: publisher.webhookEnabled ?? false,
  };
}

type WebhookSecretConfig = Parameters<typeof webhookKeyring>[0] & {
  WEBHOOK_SECRET_ENCRYPTION_REQUIRED?: boolean;
};

/**
 * Prepare a webhook secret for storage (#47).
 *
 * Encrypts with the active WEBHOOK_ENCRYPTION_KEY. When no key is configured
 * the write is rejected if WEBHOOK_SECRET_ENCRYPTION_REQUIRED is on (default in
 * production); otherwise the secret is stored as plain text for dev setups.
 * Only new writes are affected — existing plaintext rows keep being delivered.
 */
export function encodeWebhookSecretForStorage(secret: string, cfg: WebhookSecretConfig = config): string {
  const keyring = webhookKeyring(cfg);
  if (keyring) return encryptWebhookSecret(secret, keyring);
  if (cfg.WEBHOOK_SECRET_ENCRYPTION_REQUIRED) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Webhook secrets cannot be stored: encryption at rest is required but not configured on this server",
    );
  }
  return secret;
}
