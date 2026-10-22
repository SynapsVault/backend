/**
 * #53 — uncaughtException handler must flush Sentry and call process.exit(1).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Intercept process.exit so the test process doesn't actually terminate.
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

// vi.mock factories are hoisted above imports, so shared mocks must be too.
const flushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: flushMock,
}));

vi.mock("./config.js", () => ({
  config: { SENTRY_DSN: undefined, PORT: 0, IDEMPOTENCY_TTL_MS: 1000, WORKERS_ENABLED: false },
}));
vi.mock("./lib/sentry.js", () => ({
  initSentry: vi.fn(),
  captureServerException: vi.fn(),
}));
vi.mock("./lib/logger.js", () => ({
  rootLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("./app.js", () => ({ default: { listen: vi.fn(() => ({ close: vi.fn() })) } }));
vi.mock("./db/client.js", () => ({
  pgClient: Object.assign(vi.fn(), { reserve: vi.fn(), end: vi.fn() }),
  startPoolMetrics: vi.fn(),
  stopPoolMetrics: vi.fn(),
}));
vi.mock("./lib/lifecycle.js", () => ({ beginShutdown: vi.fn(), whenDrained: vi.fn(), inFlightCount: vi.fn(() => 0) }));
vi.mock("./lib/rateLimit/index.js", () => ({ closeRateLimitStore: vi.fn() }));
vi.mock("./workers/retryPendingWorker.js", () => ({
  startRetryPendingWorker: vi.fn(),
  stopRetryPendingWorker: vi.fn(),
}));
vi.mock("./workers/eventListener.js", () => ({
  startEventListener: vi.fn(),
  stopEventListener: vi.fn(),
}));
vi.mock("./workers/webhookOutboxWorker.js", () => ({
  startWebhookOutboxWorker: vi.fn(),
  stopWebhookOutboxWorker: vi.fn(),
}));
vi.mock("./lib/idempotency.js", () => ({ useSharedIdempotencyStore: vi.fn() }));
vi.mock("./lib/idempotencyPgStore.js", () => ({
  createPostgresRowStore: vi.fn(),
  createSharedIdempotencyStore: vi.fn(),
}));
vi.mock("./tracing.js", () => ({}));

describe("#53 uncaughtException handler", () => {
  afterEach(() => {
    exitSpy.mockClear();
    flushMock.mockClear();
  });

  it("calls process.exit(1) after an uncaught exception", async () => {
    // Import index.ts to register the handler. We need to let async settle.
    await import("./index.js");

    const err = new Error("boom — uncaught");
    (process.emit as (event: string, ...args: unknown[]) => boolean)(
      "uncaughtException",
      err,
      "uncaughtException",
    );

    // Allow the flush promise to resolve.
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
