import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const TEST_SIGNING_SECRET = "svs_test_signing_secret_value_for_hmac";

vi.mock("../config.js", () => ({
  config: {
    REQUIRE_REQUEST_SIGNATURE: true,
    SIGNATURE_MAX_SKEW_MS: 300_000,
    SIGNING_SECRET_KEY: undefined, // no encryption in tests — plain storage
    REDIS_URL: undefined,
  },
}));

// Mock the DB so the middleware can look up the publisher's signing secret
// without a real database connection.
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ signingSecret: TEST_SIGNING_SECRET }]),
        }),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { apiKeyHash: "api_key_hash", signingSecret: "signing_secret" },
}));

vi.mock("../utils/crypto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/crypto.js")>()),
  hashApiKey: (key: string) => `hashed_${key}`,
  decryptSigningSecret: (val: string) => val,
}));

import { __resetSignatureReplayCache, requestSignatureAuth } from "./requestSignatureAuth.js";
import {
  EMPTY_BODY_HASH,
  hashRequestBody,
  signPublisherRequest,
} from "../utils/requestSignature.js";
import { AppError } from "../lib/errors.js";

function expectRejected(next: NextFunction, message: string) {
  expect(next).toHaveBeenCalledOnce();
  const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status: 401, code: "UNAUTHORIZED", message });
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("requestSignatureAuth", () => {
  // Use the signing secret (not the API key) for HMAC — #42
  const secret = TEST_SIGNING_SECRET;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = "/resources/res-1/register";
  const rawBody = JSON.stringify({ signedXdr: "AAAA" });
  const bodyHash = hashRequestBody(rawBody);
  const signature = signPublisherRequest({
    secret,
    method: "POST",
    path,
    timestamp,
    bodyHash,
  });

  beforeEach(() => {
    __resetSignatureReplayCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(timestamp) * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid signed request (uses signing secret, not API key)", async () => {
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key", // API key just identifies the publisher; secret is separate
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a stale timestamp", async () => {
    vi.setSystemTime(new Date(Number(timestamp) * 1000 + 600_000));
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Request timestamp outside allowed window");
  });

  it("rejects a tampered body", async () => {
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      rawBody: Buffer.from(JSON.stringify({ signedXdr: "BBBB" }), "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Invalid request signature");
  });

  it("accepts DELETE with empty body hash", async () => {
    const deletePath = "/resources/res-1";
    const deleteSignature = signPublisherRequest({
      secret,
      method: "DELETE",
      path: deletePath,
      timestamp,
      bodyHash: EMPTY_BODY_HASH,
    });
    const req = {
      method: "DELETE",
      originalUrl: deletePath,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": timestamp,
        "x-signature": deleteSignature,
      },
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a replayed request with the same signature", async () => {
    const makeReq = () =>
      ({
        method: "POST",
        originalUrl: path,
        headers: {
          "x-api-key": "any_api_key",
          "x-timestamp": timestamp,
          "x-signature": signature,
        },
        rawBody: Buffer.from(rawBody, "utf8"),
      }) as unknown as Request;

    const firstRes = mockResponse();
    const firstNext = vi.fn() as NextFunction;
    await requestSignatureAuth(makeReq(), firstRes, firstNext);
    expect(firstNext).toHaveBeenCalledWith();

    const secondRes = mockResponse();
    const secondNext = vi.fn() as NextFunction;
    await requestSignatureAuth(makeReq(), secondRes, secondNext);
    expectRejected(secondNext, "Request signature already used");
  });

  it("does not record replays for invalid signatures", async () => {
    const makeReq = (sig: string) =>
      ({
        method: "POST",
        originalUrl: path,
        headers: { "x-api-key": "any_api_key", "x-timestamp": timestamp, "x-signature": sig },
        rawBody: Buffer.from(JSON.stringify({ signedXdr: "CCCC" }), "utf8"),
      }) as unknown as Request;
    const forged = "ab".repeat(32);

    const first = vi.fn() as NextFunction;
    await requestSignatureAuth(makeReq(forged), mockResponse(), first);
    expectRejected(first, "Invalid request signature");

    const second = vi.fn() as NextFunction;
    await requestSignatureAuth(makeReq(forged), mockResponse(), second);
    expectRejected(second, "Invalid request signature");
  });

  it("rejects a request with a missing signature header", async () => {
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": timestamp,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Missing request signature headers");
  });

  it("rejects a request with a missing timestamp header", async () => {
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-signature": signature,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Missing request signature headers");
  });

  it("rejects a request with a non-numeric timestamp", async () => {
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": "not-a-number",
        "x-signature": signature,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Invalid request timestamp");
  });

  it("rejects a signature made with the API key instead of the signing secret (#42)", async () => {
    // Old behavior: sign with the API key directly. Must be rejected.
    const badSignature = signPublisherRequest({
      secret: "any_api_key", // using the API key as the HMAC secret — must fail
      method: "POST",
      path,
      timestamp,
      bodyHash,
    });
    const req = {
      method: "POST",
      originalUrl: path,
      headers: {
        "x-api-key": "any_api_key",
        "x-timestamp": timestamp,
        "x-signature": badSignature,
      },
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await requestSignatureAuth(req, res, next);
    expectRejected(next, "Invalid request signature");
  });
});

describe("requestSignatureAuth disabled", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is a no-op when REQUIRE_REQUEST_SIGNATURE is false", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        REQUIRE_REQUEST_SIGNATURE: false,
        SIGNATURE_MAX_SKEW_MS: 300_000,
        SIGNING_SECRET_KEY: undefined,
        REDIS_URL: undefined,
      },
    }));
    vi.doMock("../db/client.js", () => ({ db: {} }));
    vi.doMock("../db/schema.js", () => ({ publishers: {} }));
    const { requestSignatureAuth: disabledAuth } = await import("./requestSignatureAuth.js");
    const req = { method: "POST", originalUrl: "/resources", headers: {} } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    await disabledAuth(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });
});
