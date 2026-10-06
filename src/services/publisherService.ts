import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers, resources } from "../db/schema.js";
import { generateApiKey, hashApiKey } from "../utils/crypto.js";

export async function registerPublisher(data: {
  name: string;
  email: string;
  walletAddress: string;
}) {
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  const [publisher] = await db
    .insert(publishers)
    .values({
      name: data.name,
      email: data.email,
      walletAddress: data.walletAddress,
      apiKeyHash,
    })
    .returning();

  return { publisher, apiKey };
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

export async function updatePublisherRateLimit(publisherId: string, rpm: number) {
  const [publisher] = await db
    .update(publishers)
    .set({ rateLimitRpm: rpm })
    .where(eq(publishers.id, publisherId))
    .returning();

  return publisher ?? null;
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

export async function updatePublisherWebhookConfig(
  publisherId: string,
  config: {
    url?: string | null;
    secret?: string | null;
    events?: string[] | null;
    enabled?: boolean;
  },
) {
  const updates: Record<string, unknown> = {};

  if (config.url !== undefined) {
    updates.webhookUrl = config.url;
  }
  if (config.secret !== undefined) {
    updates.webhookSecret = config.secret;
  }
  if (config.events !== undefined) {
    updates.webhookEvents = config.events;
  }
  if (config.enabled !== undefined) {
    updates.webhookEnabled = config.enabled;
  }

  if (Object.keys(updates).length === 0) {
    return getPublisherWebhookConfig(publisherId);
  }

  const [publisher] = await db
    .update(publishers)
    .set(updates)
    .where(eq(publishers.id, publisherId))
    .returning();

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

export async function getEffectiveRateLimit(publisherId: string): Promise<number | null> {
  const publisher = await getPublisherById(publisherId);
  if (!publisher) {
    return null;
  }

  return publisher.rateLimitRpm ?? null;
}