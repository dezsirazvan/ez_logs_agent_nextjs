// Audit-snapshot — per-request bookkeeping for the time-window
// fallback path of the audit-log reader.
//
// Phase 5's primary path tags audit rows with `actor_id` + `correlation_id`
// via SET LOCAL inside the customer's transaction. supabase-js doesn't
// expose explicit transactions to the client (it speaks HTTP to PostgREST
// and auto-commits each request), so its writes land in the audit log
// with NULL context. Without a snapshot they're invisible to the
// reader's `WHERE correlation_id = $current` filter.
//
// The snapshot fix:
//   1. At the start of each HTTP request (HTTP capturer hook), the
//      agent runs `SELECT MAX(id) FROM ezlogs_audit_log` and remembers
//      the value on the per-request scope.
//   2. At the end of the request, the reader drains rows where:
//        id > snapshot_max
//        AND (correlation_id = $current OR correlation_id IS NULL)
//      The first arm catches trigger-tagged rows (Phase 5 primary path).
//      The second catches supabase-js / no-SET-LOCAL rows.
//   3. The reader synthesizes actor + correlation onto NULL-context rows
//      using the request scope the agent already knows.
//
// Concurrency: each request has its own snapshot. Cross-request blur
// happens only when two simultaneous requests both write supabase-js
// rows in the same window — the rows' `id` ordering still distinguishes
// them, but if two requests' actors differ and the rows interleave,
// only the request whose handler ran the supabase mutation can attribute
// it correctly. In practice supabase-js mutations are user-bound (each
// request has its own actor), and concurrent same-user mutations come
// from the same person clicking fast — usually fine. For high-concurrency
// shared-mutation patterns, customers should still wire SET LOCAL.

import { createScopedStorage } from "../edge-fallback.js";

/**
 * Pinned to globalThis under a stable Symbol so multi-bundle layers
 * (app-ssr / app-rsc / edge) all see the same snapshot for the same
 * request — same reasoning as `correlation.ts` and `actor.ts`.
 */
const storage = createScopedStorage<bigint>(
  Symbol.for("ezlogs-nextjs:audit-snapshot-storage"),
);

/** Read the current request's audit snapshot, if any. */
export function currentAuditSnapshot(): bigint | null {
  return storage.read();
}

/** Set the audit snapshot for the current scope. */
export function setAuditSnapshot(value: bigint): void {
  storage.update(value);
}

/** Run `callback` inside a fresh audit-snapshot scope. */
export function runWithAuditSnapshotScope<R>(callback: () => R): R {
  return storage.run(0n, callback);
}

/** Test-only — clears the Edge fallback. */
export function _resetAuditSnapshotForTests(): void {
  storage._resetForTests();
}
