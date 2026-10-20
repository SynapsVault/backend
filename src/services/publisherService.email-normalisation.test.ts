/**
 * Unit tests for email normalisation in registerPublisher (#39).
 *
 * These tests exercise the service directly (not via the HTTP layer) so they
 * verify that the normalisation happens inside the service itself — the
 * defence-in-depth layer that protects against callers that bypass the Zod
 * schema.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockInsertValues = vi.fn();
const mockInsertReturning = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => {
        mockInsertValues(row);
        return { returning: mockInsertReturning };
      },
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { __table: "publishers" },
  resources: { __table: "resources" },
}));

// ── Crypto mock — return deterministic values so we can assert row shape ─────

vi.mock("../utils/crypto.js", () => ({
  generateApiKey: () => "mv_testkey",
  hashApiKey: () => "hashed_testkey",
  generateSigningSecret: () => "test_signing_secret",
  encryptSigningSecret: (s: string) => `encrypted:${s}`,
}));

vi.mock("../config.js", () => ({
  config: { SIGNING_SECRET_KEY: undefined },
}));

// ── Import the module under test after mocks are in place ────────────────────

import { registerPublisher } from "./publisherService.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_WALLET = "GDEJJLXV2CNHF5HEGX34MU4G6L4PRVUAGD4ANF77ZDYTQJKSDSDYVVI6";

function makePublisher(email: string) {
  return {
    id: "pub-1",
    name: "Alice",
    email,
    walletAddress: VALID_WALLET,
    apiKeyHash: "hashed_testkey",
    createdAt: new Date("2026-01-01"),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerPublisher — email normalisation (#39)", () => {
  beforeEach(() => {
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
  });

  it("lowercases an uppercase email before inserting", async () => {
    const normalised = "ada@x.com";
    mockInsertReturning.mockResolvedValue([makePublisher(normalised)]);

    await registerPublisher({ name: "Ada", email: "ADA@X.COM", walletAddress: VALID_WALLET });

    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.email).toBe(normalised);
  });

  it("trims whitespace from the email before inserting", async () => {
    const normalised = "ada@x.com";
    mockInsertReturning.mockResolvedValue([makePublisher(normalised)]);

    await registerPublisher({ name: "Ada", email: "  ada@x.com  ", walletAddress: VALID_WALLET });

    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.email).toBe(normalised);
  });

  it("trims and lowercases together", async () => {
    const normalised = "ada@x.com";
    mockInsertReturning.mockResolvedValue([makePublisher(normalised)]);

    await registerPublisher({ name: "Ada", email: "  Ada@X.Com  ", walletAddress: VALID_WALLET });

    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.email).toBe(normalised);
  });

  it("leaves an already-normalised email unchanged", async () => {
    const email = "ada@x.com";
    mockInsertReturning.mockResolvedValue([makePublisher(email)]);

    await registerPublisher({ name: "Ada", email, walletAddress: VALID_WALLET });

    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.email).toBe(email);
  });

  it("returns the normalised email from the publisher row", async () => {
    const normalised = "ada@x.com";
    mockInsertReturning.mockResolvedValue([makePublisher(normalised)]);

    const { publisher } = await registerPublisher({
      name: "Ada",
      email: "Ada@X.Com",
      walletAddress: VALID_WALLET,
    });

    expect(publisher.email).toBe(normalised);
  });
});

describe("publishers route — 409 on case-insensitive duplicate (#39)", () => {
  /**
   * The route already has a 409 test for exact-match duplicates.  This block
   * adds a complementary test that verifies the same 409 path is hit when the
   * DB rejects an insert that collides with a differently-cased row — i.e. the
   * service normalises the email, hits the unique constraint, and the route
   * converts that into a 409.
   *
   * Because the route test mocks registerPublisher we test the mapping of the
   * DB error → 409 here at the service boundary instead.
   */
  beforeEach(() => {
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
  });

  it("propagates a unique-constraint error when the normalised email already exists", async () => {
    const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    mockInsertReturning.mockRejectedValue(dbError);

    await expect(
      registerPublisher({ name: "Ada", email: "Ada@X.Com", walletAddress: VALID_WALLET }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
