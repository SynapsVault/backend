/** Webhook event types a publisher can subscribe to. */
export const webhookEventValues = [
  "resource.purchased",
  "resource.listed",
  "resource.delisted",
  "payment.received",
] as const;

export type WebhookEvent = (typeof webhookEventValues)[number];
