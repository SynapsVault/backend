import { describe, it, expect, beforeEach, vi } from "vitest";

// Captures the values passed to `.set(...)` on the update chain.
const { setCalls, returnedRows } = vi.hoisted(() => ({
  setCalls: [] as Array<Record<string, unknown>>,
  returnedRows: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve(returnedRows.rows),
          }),
        };
      },
    }),
  },
}));

vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { adminDelistResource } from "./resourceService.js";

describe("adminDelistResource", () => {
  beforeEach(() => {
    setCalls.length = 0;
    returnedRows.rows = [];
  });

  it("delists and stamps adminDelistedAt so the resource cannot be relisted", async () => {
    returnedRows.rows = [{ id: "res-1" }];

    const before = Date.now();
    const result = await adminDelistResource("res-1");

    expect(result).toEqual({ id: "res-1" });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].listed).toBe(false);
    expect(setCalls[0].adminDelistedAt).toBeInstanceOf(Date);
    expect((setCalls[0].adminDelistedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("returns null for an unknown id", async () => {
    returnedRows.rows = [];

    expect(await adminDelistResource("missing")).toBeNull();
  });
});
