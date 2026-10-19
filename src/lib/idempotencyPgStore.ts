import type { IdempotencyRecord } from "./idempotency.js";

// Shared idempotency store (#71). Records live in the `idempotency_records`
// Postgres table (unique key, JSON record, expiry) so a retry that lands on a
// different replica sees the original result instead of creating a duplicate.
// The in-memory TtlCache remains the default (and is what tests use).

export interface IdempotencyRow {
  record: IdempotencyRecord;
  expiresAt: Date;
}

// Thin persistence seam so the store logic can be tested against a shared fake.
export interface IdempotencyRowStore {
  select(key: string): Promise<IdempotencyRow | undefined>;
  upsert(key: string, record: IdempotencyRecord, expiresAt: Date): Promise<void>;
  remove(key: string): Promise<void>;
  removeAll(): Promise<void>;
}

// Minimal shape of the postgres.js tagged-template client.
export type PgSql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export function createPostgresRowStore(sql: PgSql): IdempotencyRowStore {
  return {
    async select(key) {
      const rows = await sql`SELECT record, expires_at FROM idempotency_records WHERE key = ${key}`;
      const row = rows[0];
      if (!row) return undefined;
      const record =
        typeof row.record === "string" ? (JSON.parse(row.record) as IdempotencyRecord) : row.record;
      return { record, expiresAt: new Date(row.expires_at) };
    },
    async upsert(key, record, expiresAt) {
      await sql`
        INSERT INTO idempotency_records (key, record, expires_at)
        VALUES (${key}, ${JSON.stringify(record)}::jsonb, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at`;
    },
    async remove(key) {
      await sql`DELETE FROM idempotency_records WHERE key = ${key}`;
    },
    async removeAll() {
      await sql`DELETE FROM idempotency_records`;
    },
  };
}

export interface SharedIdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, value: IdempotencyRecord, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createSharedIdempotencyStore(
  rows: IdempotencyRowStore,
  options: { defaultTtlMs: number; now?: () => number },
): SharedIdempotencyStore {
  const now = options.now ?? Date.now;
  return {
    async get(key) {
      const row = await rows.select(key);
      if (!row) return undefined;
      if (now() >= row.expiresAt.getTime()) {
        await rows.remove(key);
        return undefined;
      }
      return row.record;
    },
    async set(key, value, ttlMs) {
      await rows.upsert(key, value, new Date(now() + (ttlMs ?? options.defaultTtlMs)));
    },
    delete: (key) => rows.remove(key),
    clear: () => rows.removeAll(),
  };
}
