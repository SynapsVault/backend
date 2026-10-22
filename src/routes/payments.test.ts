import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../db/client.js", () => ({ db: { select } }));

import paymentsRouter from "./payments.js";
import { errorHandler } from "../middleware/errorHandler.js";

const payer = Keypair.random();
const recipient = Keypair.random();
const other = Keypair.random();
const receiptPath = "/payments/pay_123/receipt";
const payment = {
  id: "pay_123",
  resourceId: "resource_123",
  payerAddress: payer.publicKey(),
  recipientAddress: recipient.publicKey(),
  amount: "1.00",
  paidAt: "2026-01-01T00:00:00.000Z",
};

function app() {
  const server = express();
  server.use(paymentsRouter);
  server.use(errorHandler);
  return server;
}

function rows(value: unknown[]) {
  const result = Promise.resolve(value);
  select.mockReturnValueOnce({
    from: () => ({ where: () => Object.assign(result, { orderBy: () => result }) }),
  });
}

function auth(key: Keypair, path: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "x-wallet-address": key.publicKey(),
    "x-wallet-timestamp": timestamp,
    "x-wallet-signature": key.sign(Buffer.from(`synapsvault-wallet-auth-v1\nGET\n${path}\n${timestamp}`)).toString("base64"),
  };
}

beforeEach(() => vi.resetAllMocks());

describe("GET /payments/:id/receipt", () => {
  it("returns a receipt to its payer using a real Stellar signature", async () => {
    rows([payment]);
    const res = await request(app()).get(receiptPath).set(auth(payer, receiptPath));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payment);
  });

  it("returns a receipt to the recipient authenticated with an API key", async () => {
    rows([{ walletAddress: recipient.publicKey() }]);
    rows([payment]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "publisher-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payment);
  });

  it("rejects unauthenticated requests before querying payments", async () => {
    const res = await request(app()).get(receiptPath);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects an invalid API key", async () => {
    rows([]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "invalid-key");
    expect(res.status).toBe(401);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrelated wallet", async () => {
    rows([payment]);
    const res = await request(app()).get(receiptPath).set(auth(other, receiptPath));
    expect(res.status).toBe(403);
  });

  it("rejects an unrelated publisher", async () => {
    rows([{ walletAddress: other.publicKey() }]);
    rows([payment]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "other-key");
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing receipt", async () => {
    rows([]);
    const res = await request(app()).get(receiptPath).set(auth(payer, receiptPath));
    expect(res.status).toBe(404);
  });
});

describe("GET /buyers/:address/payments", () => {
  const path = `/buyers/${payer.publicKey()}/payments`;

  it("returns history to the authenticated buyer", async () => {
    rows([payment]);
    const res = await request(app()).get(path).set(auth(payer, path));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([payment]);
  });

  it.each(["missing", "invalid", "expired", "other-wallet", "other-path"])("rejects %s signatures", async (kind) => {
    const headers: Record<string, string> = kind === "missing" ? {} : auth(
      kind === "other-wallet" ? other : payer,
      kind === "other-path" ? receiptPath : path,
      kind === "expired" ? String(Math.floor(Date.now() / 1000) - 600) : undefined,
    );
    if (kind === "invalid") headers["x-wallet-signature"] = "invalid";
    const res = await request(app()).get(path).set(headers);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });
});
