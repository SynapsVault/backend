import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => {
  class SignedTxValidationError extends Error {
    readonly code = "VALIDATION_ERROR";
  }
  return {
    SignedTxValidationError,
    registryCount: vi.fn(),
    submitSignedTx: vi.fn(),
    validateSignedTx: vi.fn(),
    getResourceById: vi.fn(),
    // Every db.update(...).set(values) call, in order.
    setCalls: [] as Array<Record<string, unknown>>,
    // Rows returned by the atomic register claim (update ... returning()).
    claimRows: vi.fn(),
  };
});

vi.mock("../services/registryClient.js", () => ({
  registryClient: { count: h.registryCount },
  submitSignedTx: h.submitSignedTx,
  validateSignedTx: h.validateSignedTx,
  SignedTxValidationError: h.SignedTxValidationError,
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  registryKeypair: {},
  setPrice: vi.fn(),
  transferOwnership: vi.fn(),
  buildRegisterTx: vi.fn(),
  delistOnChain: vi.fn(),
  getResource: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.setCalls.push(values);
        const result = Promise.resolve(undefined);
        return {
          where: () =>
            Object.assign(result, {
              returning: () => Promise.resolve(h.claimRows(values)),
            }),
        };
      },
    }),
  },
}));

vi.mock("../services/resourceService.js", () => ({
  getResourceById: h.getResourceById,
  createFileResource: vi.fn(),
  createLinkResource: vi.fn(),
  listCatalog: vi.fn(),
  countCatalog: vi.fn(),
  getResourceMeta: vi.fn(),
  getVerificationDetails: vi.fn(),
  delistResource: vi.fn(),
}));

vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: any, _res: unknown, next: () => void) => {
    req.publisher = { id: "pub-1" };
    next();
  },
}));
vi.mock("../middleware/requestSignatureAuth.js", () => ({
  requestSignatureAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/dynamicPaywall.js", () => ({
  dynamicPaywall: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/rateLimiters.js", () => ({
  publishIpRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  publishWalletRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// The signed operation is the source of truth; echo the body values back.
vi.mock("../services/signedTxDecode.js", () => ({
  decodeSetPrice: (_xdr: string, price: string) => price,
  decodeNewCreator: (_xdr: string, creator: string) => creator,
}));
vi.mock("../services/webhookService.js", () => ({
  emitToPublisher: vi.fn(),
  enqueueWebhookEvent: vi.fn(),
}));

import registryRouter from "./registry.js";
import resourcesRouter from "./resources.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { config } from "../config.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(registryRouter);
  app.use(resourcesRouter);
  app.use(errorHandler);
  return app;
}

const OWNER = "GDEJJLXV2CNHF5HEGX34MU4G6L4PRVUAGD4ANF77ZDYTQJKSDSDYVVI6";
const NEW_OWNER = "GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG";
const RESOURCE_ID = "res-1";
const TX_HASH = "abc123hash";
const SIGNED_XDR = "AAAA...signed...";

function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    publisherId: "pub-1",
    walletAddress: OWNER,
    price: "1.00",
    title: "Doc",
    description: null,
    verificationStatus: "verified",
    onchainStatus: "none",
    onchainTxHash: null,
    ...overrides,
  };
}

const ROUTES = {
  register: { path: `/resources/${RESOURCE_ID}/register`, body: { signedXdr: SIGNED_XDR } },
  price: { path: `/resources/${RESOURCE_ID}/price`, body: { signedXdr: SIGNED_XDR, price: "2.50" } },
  ownership: {
    path: `/resources/${RESOURCE_ID}/ownership`,
    body: { signedXdr: SIGNED_XDR, newCreator: NEW_OWNER },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.setCalls = [];
  h.getResourceById.mockResolvedValue(resourceRow());
  h.claimRows.mockImplementation((values: Record<string, unknown>) => [{ ...resourceRow(), ...values }]);
  h.validateSignedTx.mockImplementation(() => undefined);
});

describe("GET /registry/status — public registry metadata endpoint", () => {
  it("returns registry status with correct shape on success", async () => {
    h.registryCount.mockResolvedValue({ result: 42 });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contractId: config.REGISTRY_CONTRACT_ID,
      // "stellar:testnet" is reported without its namespace prefix.
      network: "testnet",
      resourceCount: 42,
    });
  });

  it("sets Cache-Control header with 30 second max-age", async () => {
    h.registryCount.mockResolvedValue({ result: 10 });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("returns 503 when the registry client fails", async () => {
    h.registryCount.mockRejectedValue(new Error("RPC connection failed"));

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: "Unable to fetch registry status. Please try again later.",
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("converts a string resource count to a number", async () => {
    h.registryCount.mockResolvedValue({ result: "100" });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.body.resourceCount).toBe(100);
  });

  it("handles zero resource count", async () => {
    h.registryCount.mockResolvedValue({ result: 0 });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body.resourceCount).toBe(0);
  });
});

describe("signed XDR validation (issue #75)", () => {
  it.each(Object.entries(ROUTES))(
    "rejects a mismatched signed transaction on %s with 400 before submitting",
    async (_name, route) => {
      h.validateSignedTx.mockImplementation(() => {
        throw new h.SignedTxValidationError("Transaction invokes contract CXYZ, expected CABC");
      });

      const res = await request(createTestApp()).post(route.path).send(route.body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details.detail).toMatch(/contract/);
      expect(h.submitSignedTx).not.toHaveBeenCalled();
    },
  );

  it("marks a register attempt failed when the signed transaction does not match", async () => {
    h.validateSignedTx.mockImplementation(() => {
      throw new h.SignedTxValidationError("source account mismatch");
    });

    await request(createTestApp()).post(ROUTES.register.path).send(ROUTES.register.body);

    expect(h.setCalls.at(-1)).toEqual({ onchainStatus: "failed" });
  });

  it.each([
    ["register", "register"],
    ["price", "set_price"],
    ["ownership", "transfer_ownership"],
  ] as const)(
    "passes the expected function, resource id and owner for %s",
    async (name, functionName) => {
      h.submitSignedTx.mockResolvedValue({ state: "pending", txHash: TX_HASH });

      await request(createTestApp()).post(ROUTES[name].path).send(ROUTES[name].body);

      const expected = { functionName, resourceId: RESOURCE_ID, owner: OWNER };
      expect(h.validateSignedTx).toHaveBeenCalledWith(SIGNED_XDR, expected);
      expect(h.submitSignedTx).toHaveBeenCalledWith(SIGNED_XDR, expected);
    },
  );
});

describe("pending submissions return 202 with hash (issue #76)", () => {
  it("price handler returns 202 with the tx hash while pending", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "pending", txHash: TX_HASH });

    const res = await request(createTestApp()).post(ROUTES.price.path).send(ROUTES.price.body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: RESOURCE_ID, txHash: TX_HASH, status: "pending" });
    // The DB price only changes once the transaction confirms.
    expect(h.setCalls).toEqual([]);
  });

  it("ownership handler returns 202 with the tx hash while pending", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "pending", txHash: TX_HASH });

    const res = await request(createTestApp()).post(ROUTES.ownership.path).send(ROUTES.ownership.body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: RESOURCE_ID, txHash: TX_HASH, status: "pending" });
  });

  it("syncs the DB price from the signed operation once confirmed", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "confirmed", txHash: TX_HASH });

    const res = await request(createTestApp()).post(ROUTES.price.path).send(ROUTES.price.body);

    expect(res.status).toBe(200);
    expect(h.setCalls).toEqual([{ price: "2.50" }]);
  });

  it("surfaces an on-chain failure as 502 with the error detail", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "failed", txHash: TX_HASH, error: "tx_failed" });

    const res = await request(createTestApp()).post(ROUTES.ownership.path).send(ROUTES.ownership.body);

    expect(res.status).toBe(502);
    expect(res.body.details).toMatchObject({ detail: "tx_failed", txHash: TX_HASH });
  });
});

describe("timeout leaves status pending (issue #77)", () => {
  it("keeps onchainStatus pending and stores the hash when submission times out", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "pending", txHash: TX_HASH });

    const res = await request(createTestApp()).post(ROUTES.register.path).send(ROUTES.register.body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: RESOURCE_ID, onchainStatus: "pending", txHash: TX_HASH });
    expect(h.setCalls.at(-1)).toEqual({ onchainStatus: "pending", onchainTxHash: TX_HASH });
    expect(h.setCalls.some((values) => values.onchainStatus === "failed")).toBe(false);
  });

  it("marks the resource registered when the submission confirms", async () => {
    h.submitSignedTx.mockResolvedValue({ state: "confirmed", txHash: TX_HASH });

    const res = await request(createTestApp()).post(ROUTES.register.path).send(ROUTES.register.body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: RESOURCE_ID, onchainStatus: "registered", txHash: TX_HASH });
  });
});

describe("register concurrency (issue #78)", () => {
  it("only one of two concurrent register requests submits; the other gets 409", async () => {
    let claimed = false;
    h.claimRows.mockImplementation((values: Record<string, unknown>) => {
      // The atomic claim (status none/failed → pending) succeeds only once.
      if (values.onchainStatus !== "pending" || !("onchainPendingSince" in values)) {
        return [{ ...resourceRow(), ...values }];
      }
      if (claimed) return [];
      claimed = true;
      return [{ ...resourceRow(), ...values }];
    });
    h.submitSignedTx.mockResolvedValue({ state: "pending", txHash: TX_HASH });

    const app = createTestApp();
    const [first, second] = await Promise.all([
      request(app).post(ROUTES.register.path).send(ROUTES.register.body),
      request(app).post(ROUTES.register.path).send(ROUTES.register.body),
    ]);

    expect([first.status, second.status].sort()).toEqual([202, 409]);
    expect(h.submitSignedTx).toHaveBeenCalledTimes(1);
  });

  it("rejects registering while a registration is already pending", async () => {
    h.getResourceById.mockResolvedValue(resourceRow({ onchainStatus: "pending" }));

    const res = await request(createTestApp()).post(ROUTES.register.path).send(ROUTES.register.body);

    expect(res.status).toBe(409);
    expect(h.submitSignedTx).not.toHaveBeenCalled();
  });
});
