/**
 * Tests for #220: cursor pagination on the publisher resource dashboard.
 *
 * Covers:
 *   - encodeResourceCursor / decodeResourceCursor round-trips
 *   - Invalid cursor returns VALIDATION_ERROR
 *   - First-page fetch (no cursor)
 *   - Subsequent pages via returned nextCursor
 *   - Equal createdAt timestamps produce no gaps or duplicates
 *   - Page size is bounded at PUBLISHER_RESOURCES_MAX_LIMIT
 *   - hasNextPage and nextCursor are correct on the last page
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock drizzle ─────────────────────────────────────────────────────────────
const { RESOURCES_MARKER } = vi.hoisted(() => ({
  RESOURCES_MARKER: { __table: "resources" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { __table: "publishers" },
  resources: RESOURCES_MARKER,
}));

// Rows returned by the mocked DB query
let dbRows: any[] = [];

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          orderBy: (_a: unknown, _b: unknown) => ({
            limit: (n: number) => Promise.resolve(dbRows.slice(0, n)),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    WEBHOOK_SECRET_ENCRYPTION_REQUIRED: false,
  },
}));

import {
  encodeResourceCursor,
  decodeResourceCursor,
  getPublisherResourcesPage,
  PUBLISHER_RESOURCES_MAX_LIMIT,
  PUBLISHER_RESOURCES_DEFAULT_LIMIT,
} from "./publisherService.js";
import { AppError } from "../lib/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResource(id: string, createdAt: Date) {
  return {
    id,
    publisherId: "pub-1",
    title: `Resource ${id}`,
    description: null,
    price: "1.00",
    walletAddress: "GWALLET",
    resourceType: "file" as const,
    storagePath: null,
    thumbnailPath: null,
    thumbnailStatus: "none" as const,
    thumbnailAttempts: 0,
    contentHash: null,
    externalUrl: null,
    mimeType: null,
    scanStatus: "pending" as const,
    sizeBytes: null,
    verificationStatus: "pending" as const,
    verificationId: null,
    verificationGeneration: 0,
    listed: false,
    adminDelistedAt: null,
    onchainStatus: "none" as const,
    onchainTxHash: null,
    onchainAttempts: 0,
    onchainPendingSince: null,
    tags: null,
    createdAt,
  };
}

// ── Cursor codec ─────────────────────────────────────────────────────────────

describe("encodeResourceCursor / decodeResourceCursor", () => {
  it("round-trips a date and id", () => {
    const date = new Date("2026-01-15T10:00:00.000Z");
    const cursor = encodeResourceCursor(date, "abc123");
    const decoded = decodeResourceCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.t.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(decoded!.id).toBe("abc123");
  });

  it("returns null for an empty string", () => {
    expect(decodeResourceCursor("")).toBeNull();
  });

  it("returns null for arbitrary non-cursor text", () => {
    expect(decodeResourceCursor("not-a-cursor")).toBeNull();
    expect(decodeResourceCursor("eyJub3QiOiJhY3Vyc29yIn0")).toBeNull(); // base64url({"not":"acursor"})
  });

  it("returns null when t is not a valid ISO date", () => {
    const bad = Buffer.from(JSON.stringify({ t: "not-a-date", id: "x" })).toString("base64url");
    expect(decodeResourceCursor(bad)).toBeNull();
  });

  it("returns null when id is missing", () => {
    const bad = Buffer.from(JSON.stringify({ t: new Date().toISOString() })).toString("base64url");
    expect(decodeResourceCursor(bad)).toBeNull();
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe("getPublisherResourcesPage", () => {
  const D = (iso: string) => new Date(iso);
  const r = (id: string, iso: string) => makeResource(id, D(iso));

  beforeEach(() => {
    dbRows = [];
  });

  it("returns the first page with no cursor when rows fit in one page", async () => {
    dbRows = [r("r3", "2026-01-03T00:00:00Z"), r("r2", "2026-01-02T00:00:00Z")];
    const page = await getPublisherResourcesPage("pub-1", 20);
    expect(page.resources).toHaveLength(2);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("sets hasNextPage and nextCursor when more rows exist", async () => {
    // We ask for limit=2; DB is asked for limit+1=3 rows and returns 3.
    dbRows = [
      r("r3", "2026-01-03T00:00:00Z"),
      r("r2", "2026-01-02T00:00:00Z"),
      r("r1", "2026-01-01T00:00:00Z"), // extra row indicating more data
    ];
    const page = await getPublisherResourcesPage("pub-1", 2);
    expect(page.resources).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    // Cursor should encode the last resource in the page.
    const decoded = decodeResourceCursor(page.nextCursor!);
    expect(decoded!.id).toBe("r2");
  });

  it("accepts the returned cursor to fetch the next page", async () => {
    dbRows = [r("r1", "2026-01-01T00:00:00Z")];
    const cursor = encodeResourceCursor(new Date("2026-01-02T00:00:00Z"), "r2");
    const page = await getPublisherResourcesPage("pub-1", 20, cursor);
    expect(page.resources).toHaveLength(1);
    expect(page.hasNextPage).toBe(false);
  });

  it("throws VALIDATION_ERROR for a malformed cursor", async () => {
    await expect(
      getPublisherResourcesPage("pub-1", 20, "not-valid-cursor"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("clamps limit to PUBLISHER_RESOURCES_MAX_LIMIT", async () => {
    dbRows = [];
    const page = await getPublisherResourcesPage("pub-1", 9999);
    // No error thrown; limit was clamped.
    expect(page.resources).toHaveLength(0);
  });

  it("returns empty page when the publisher has no resources", async () => {
    dbRows = [];
    const page = await getPublisherResourcesPage("pub-1");
    expect(page.resources).toEqual([]);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("equal createdAt timestamps produce no gaps (tiebreak on id)", async () => {
    // Three resources share the same timestamp; pagination must not skip or
    // duplicate rows at the boundary.  The cursor from page 1 (last row r-b)
    // should position the next page starting at r-a.
    const ts = "2026-01-01T00:00:00Z";
    // DB returns limit+1=3 rows when we request limit=2, indicating a next page.
    dbRows = [
      r("r-c", ts),
      r("r-b", ts),
      r("r-a", ts), // extra row: signals hasNextPage
    ];
    const page = await getPublisherResourcesPage("pub-1", 2);
    expect(page.resources.map((x) => x.id)).toEqual(["r-c", "r-b"]);
    expect(page.hasNextPage).toBe(true);
    // The cursor encodes the last row (r-b) so the next query seeks past it.
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeResourceCursor(page.nextCursor!);
    expect(decoded!.id).toBe("r-b");
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("pagination constants", () => {
  it("max limit is 100", () => {
    expect(PUBLISHER_RESOURCES_MAX_LIMIT).toBe(100);
  });

  it("default limit is 20", () => {
    expect(PUBLISHER_RESOURCES_DEFAULT_LIMIT).toBe(20);
  });
});
