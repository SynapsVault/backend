import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPaymentMiddleware = vi.fn(
  () => (_req: unknown, _res: unknown, next: () => void) => next(),
);
const mockGetOnChainPrice = vi.fn();
const mockNormalizeUsdcPrice = vi.fn((value: string) => value);

class MockOnChainLookupError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OnChainLookupError";
    this.cause = cause;
  }
}

vi.mock("@x402/express", () => ({
  paymentMiddleware: mockPaymentMiddleware,
}));
vi.mock("../lib/x402.js", () => ({
  network: "stellar:testnet",
  sharedX402ResourceServer: {},
}));
vi.mock("../lib/logger.js", () => ({
  getRequestId: () => "test-request-id",
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));
vi.mock("../services/registryClient.js", () => ({
  getResource: vi.fn(),
}));
vi.mock("../lib/stellarRegistry.js", () => ({
  getOnChainPrice: mockGetOnChainPrice,
  normalizeUsdcPrice: mockNormalizeUsdcPrice,
  stroopsToUsdc: (stroops: bigint | string) => {
    const value = BigInt(stroops);
    const whole = value / 10_000_000n;
    const fraction = (value % 10_000_000n).toString().padStart(7, "0");
    return `${whole}.${fraction}`;
  },
  OnChainLookupError: MockOnChainLookupError,
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

function makeDbSelect(resource: unknown) {
  const where = vi.fn(() => Promise.resolve(resource ? [resource] : []));
  const from = vi.fn(() => ({ where }));
  return {
    select: vi.fn(() => ({ from })),
  };
}

function listedResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    listed: true,
    price: "1.00",
    walletAddress: "GABC",
    title: "Test resource",
    onchainStatus: "registered",
    ...overrides,
  };
}

function createResponse() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

function createRequest(resourceId: string) {
  return {
    params: { id: resourceId },
    headers: {},
  } as any;
}

function createNext() {
  return vi.fn();
}

describe("dynamicPaywall middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentMiddleware.mockReset();
    mockGetOnChainPrice.mockReset();
    mockNormalizeUsdcPrice.mockReset();
  });

  it("returns 404 when the resource is missing", async () => {
    const dbMock = makeDbSelect(null);
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    const req = createRequest("missing");
    const res = createResponse();
    const next = createNext();

    // Errors are thrown as AppError and rendered by the global errorHandler.
    await expect(dynamicPaywall(req, res, next)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 404 when a listed resource is not active", async () => {
    const dbMock = makeDbSelect({
      id: "r1",
      listed: false,
      price: "1.00",
      walletAddress: "GABC",
      title: "Test resource",
      onchainStatus: "none",
    });
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    const req = createRequest("r1");
    const res = createResponse();
    const next = createNext();

    await expect(dynamicPaywall(req, res, next)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not listed",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 503 when Soroban RPC lookup fails", async () => {
    const dbMock = makeDbSelect(listedResource({ id: "r2", onchainStatus: "none" }));
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    const rpcError = new Error("Soroban RPC unavailable");
    mockGetOnChainPrice.mockRejectedValue(
      new MockOnChainLookupError("Failed to read on-chain record for resource r2", rpcError),
    );

    const req = createRequest("r2");
    const res = createResponse();
    const next = createNext();

    await expect(dynamicPaywall(req, res, next)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Unable to verify resource price. Please try again later.",
      details: { resourceId: "r2" },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 503 when the registry has no on-chain record", async () => {
    const dbMock = makeDbSelect(listedResource({ id: "r-missing" }));
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    mockGetOnChainPrice.mockRejectedValue(
      new MockOnChainLookupError("Resource r-missing not found on-chain"),
    );

    const req = createRequest("r-missing");
    const res = createResponse();
    const next = createNext();

    await expect(dynamicPaywall(req, res, next)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      details: { resourceId: "r-missing" },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 409 when DB and on-chain prices mismatch", async () => {
    const dbMock = makeDbSelect(listedResource({ id: "r3", price: "1.00" }));
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    mockGetOnChainPrice.mockResolvedValue({ price: "1.5000000", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("1.0000000");

    const req = createRequest("r3");
    const res = createResponse();
    const next = createNext();

    await expect(dynamicPaywall(req, res, next)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message:
        "Resource price is temporarily unavailable due to a configuration issue. Please try again later.",
      details: { resourceId: "r3" },
    });
    expect(mockNormalizeUsdcPrice).toHaveBeenCalledWith("1.00");
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates to payment middleware when prices match", async () => {
    const resource = listedResource({ id: "r4", price: "0.50", onchainStatus: "none" });
    const dbMock = makeDbSelect(resource);
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    mockGetOnChainPrice.mockResolvedValue({ price: "0.5000000", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("0.5000000");
    mockPaymentMiddleware.mockReturnValue((_req, _res, next) => next());

    const req = createRequest("r4");
    const res = createResponse();
    const next = createNext();

    await dynamicPaywall(req, res, next);

    expect(mockPaymentMiddleware).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("formats a 1-stroop price as 0.0000001 for the payment middleware", async () => {
    const resource = listedResource({ id: "r-stroop", price: "0.0000001", onchainStatus: "none" });
    const dbMock = makeDbSelect(resource);
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    // getOnChainPrice has already converted the 1-stroop on-chain value.
    mockGetOnChainPrice.mockResolvedValue({ price: "0.0000001", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("0.0000001");
    mockPaymentMiddleware.mockReturnValue((_req, _res, next) => next());

    const req = createRequest("r-stroop");
    const res = createResponse();
    const next = createNext();

    await dynamicPaywall(req, res, next);

    expect(mockPaymentMiddleware).toHaveBeenCalled();
    const routes = (mockPaymentMiddleware.mock.calls[0] as unknown[])[0] as Record<string, any>;
    const route = routes["GET /resources/r-stroop"];
    expect(route).toBeDefined();
    expect(route.accepts.price).toBe("0.0000001");
    expect(next).toHaveBeenCalled();
  });

  // The per-TTL RPC dedupe lives in getOnChainPrice (see stellarRegistry.test.ts);
  // here we check the middleware reuses its own payment middleware instance.
  it("reuses the payment middleware for a resource within the TTL window", async () => {
    const resource = listedResource({ id: "r-ttl", price: "0.50", onchainStatus: "none" });
    const dbMock = makeDbSelect(resource);
    const { db } = await import("../db/client.js");
    const { dynamicPaywall } = await import("./dynamicPaywall.js");
    (db as any).select = dbMock.select;

    mockGetOnChainPrice.mockResolvedValue({ price: "0.5000000", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("0.5000000");
    mockPaymentMiddleware.mockReturnValue((_req, _res, next) => next());

    await dynamicPaywall(createRequest("r-ttl"), createResponse(), createNext());
    await dynamicPaywall(createRequest("r-ttl"), createResponse(), createNext());

    expect(mockPaymentMiddleware).toHaveBeenCalledTimes(1);
  });

  it("evicts expired middleware cache entries after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const resource = listedResource({ id: "r-evict", price: "0.50", onchainStatus: "none" });
      const dbMock = makeDbSelect(resource);
      const { db } = await import("../db/client.js");
      const { dynamicPaywall, middlewareCache } = await import("./dynamicPaywall.js");
      (db as any).select = dbMock.select;
      middlewareCache.clear();

      mockGetOnChainPrice.mockResolvedValue({ price: "0.5000000", creator: "GABC" });
      mockNormalizeUsdcPrice.mockReturnValue("0.5000000");
      mockPaymentMiddleware.mockReturnValue((_req, _res, next) => next());

      await dynamicPaywall(createRequest("r-evict"), createResponse(), createNext());
      expect(middlewareCache.size).toBeGreaterThan(0);

      vi.advanceTimersByTime(10 * 60 * 1000);

      await dynamicPaywall(createRequest("r-evict"), createResponse(), createNext());

      expect(middlewareCache.size).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the middleware cache size under the configured cap", async () => {
    const { dynamicPaywall, middlewareCache, MIDDLEWARE_CACHE_MAX_SIZE } = await import(
      "./dynamicPaywall.js"
    );

    mockPaymentMiddleware.mockReturnValue((_req, _res, next) => next());

    for (let i = 0; i < MIDDLEWARE_CACHE_MAX_SIZE + 50; i++) {
      const id = `r-cap-${i}`;
      const dbMock = makeDbSelect(listedResource({ id, price: "0.50", onchainStatus: "none" }));
      const { db } = await import("../db/client.js");
      (db as any).select = dbMock.select;

      mockGetOnChainPrice.mockResolvedValue({ price: "0.5000000", creator: "GABC" });
      mockNormalizeUsdcPrice.mockReturnValue("0.5000000");

      await dynamicPaywall(createRequest(id), createResponse(), createNext());
    }

    expect(middlewareCache.size).toBeLessThanOrEqual(MIDDLEWARE_CACHE_MAX_SIZE);
  });
});
