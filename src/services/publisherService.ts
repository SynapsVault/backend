import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers, resources } from "../db/schema.js";
import { generateApiKey, hashApiKey, generateSigningSecret, encryptSigningSecret } from "../utils/crypto.js";
import { config } from "../config.js";

export async function registerPublisher(data: {
  name: string;
  email: string;
  walletAddress: string;
}) {
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  // Issue a signing secret and encrypt it at rest (#42). When
  // SIGNING_SECRET_KEY is not configured, signing secrets are stored
  // unencrypted (acceptable only in development / before signatures are
  // required).
  const signingSecret = generateSigningSecret();
  const storedSigningSecret = config.SIGNING_SECRET_KEY
    ? encryptSigningSecret(signingSecret, config.SIGNING_SECRET_KEY)
    : signingSecret;

  const [publisher] = await db
    .insert(publishers)
    .values({
      name: data.name,
      email: data.email,
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
  const storedSigningSecret = config.SIGNING_SECRET_KEY
    ? encryptSigningSecret(signingSecret, config.SIGNING_SECRET_KEY)
    : signingSecret;

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
