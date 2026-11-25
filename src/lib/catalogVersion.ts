import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { catalogVersion } from '../db/schema.js';

/**
 * Shared catalog cache-version token.
 *
 * The token lives in the database so that every backend replica observes the
 * same value. Mutations bump the token; readers compare the token they last
 * cached against the current one to decide whether their local caches are
 * stale. This provides cross-replica invalidation without a message bus.
 *
 * Reads are memoized locally for a short window (MEMO_TTL_MS) so that we do
 * not hit the database on every request. The memo window bounds the freshness
 * guarantee: after a remote mutation, other replicas observe the new token
 * within MEMO_TTL_MS.
 */

/** How long a fetched version token is trusted locally before re-reading. */
export const MEMO_TTL_MS = 1000;

/** Key used to store the catalog version token in the shared store. */
const CATALOG_VERSION_KEY = 'catalog_version';

interface MemoizedVersion {
  value: number;
  fetchedAt: number;
}

let memo: MemoizedVersion | null = null;

/**
 * Minimal shape of the shared key/value store used for the version token.
 * Implemented on top of the existing `db` client.
 */
async function readVersionFromDb(): Promise<number> {
  const [row] = await db.select({ version: catalogVersion.version })
    .from(catalogVersion).where(eq(catalogVersion.id, "global")).limit(1);
  return row?.version ?? 0;
}

/**
 * Return the current shared catalog version token.
 *
 * The value is memoized for MEMO_TTL_MS to avoid a database round-trip on
 * every request. Callers that need a guaranteed-fresh value can pass
 * `{ force: true }` to bypass the memo.
 */
export async function getCatalogVersion(
  options: { force?: boolean } = {},
): Promise<number> {
  const now = Date.now();

  if (!options.force && memo && now - memo.fetchedAt < MEMO_TTL_MS) {
    return memo.value;
  }

  const value = await readVersionFromDb();
  memo = { value, fetchedAt: now };
  return value;
}

/**
 * Bump the shared catalog version token and return the new value.
 *
 * Every replica that reads the token afterwards will observe a value
 * different from the one it previously cached, and can invalidate its local
 * caches accordingly. The local memo is updated immediately so the bumping
 * replica does not need to re-read the database.
 */
export async function bumpCatalogVersion(): Promise<number> {
  const [row] = await db.insert(catalogVersion)
    .values({ id: "global", version: 1 })
    .onConflictDoUpdate({
      target: catalogVersion.id,
      set: { version: sql`${catalogVersion.version} + 1`, updatedAt: new Date() },
    })
    .returning({ version: catalogVersion.version });
  const next = row.version;

  memo = { value: next, fetchedAt: Date.now() };
  return next;
}

/**
 * Clear the local memo. Intended for tests and for callers that want the next
 * read to hit the database.
 */
export function resetCatalogVersionMemo(): void {
  memo = null;
}