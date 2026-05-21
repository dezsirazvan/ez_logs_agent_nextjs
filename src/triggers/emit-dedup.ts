// Audit-log emit dedup — per-request set of audit-row IDs we've already
// emitted as `database_callback` events.
//
// The HTTP capture path can call `flushAuditLog` multiple times within
// one request: middleware fires it on page-nav, the route handler fires
// it on Server-Action exit, and the generic capture path fires it on
// HTTP-event emit. Each call re-reads `ezlogs_audit_log WHERE
// correlation_id = $1`, so a row created mid-request would be emitted
// once per remaining flush — 2× or 3× duplicates on the wire.
//
// The reader filters out rows whose `id` is already in this set before
// calling `emitAuditRows`. The set is scoped to one request via the
// same `createScopedStorage` plumbing the rest of the agent uses, so
// concurrent requests don't share state.
//
// The id is stored as a string. Drivers vary on bigint shape — `pg`
// returns the audit log id as a string, drizzle's `db.execute` returns
// numbers below 2^53. Normalizing to string at read time sidesteps the
// `Set.has(BigInt(1)) !== Set.has(1)` membership trap.
//
// Why a Set rather than a max-id high-water mark:
//   - Concurrent INSERTs from inside the same request (e.g. parallel
//     `Promise.all([insertA, insertB])`) can land with non-monotonic
//     audit log ids if the trigger evaluates them in interleaved order.
//     A high-water mark would skip the second row by accident.
//   - The set is bounded by per-request mutation count (typically < 100),
//     so memory is negligible.

import { createScopedStorage } from "../edge-fallback.js";

const storage = createScopedStorage<Set<string>>(
  Symbol.for("ezlogs-nextjs:audit-emitted-ids-storage"),
);

/**
 * Read the current request's emitted-id set, if a scope is open.
 * Returns null when no scope is active — callers treat that as
 * "dedup disabled, emit unconditionally" (adapter call sites that
 * bypass the HTTP wrapper, tests, etc.).
 */
export function currentEmittedAuditIds(): Set<string> | null {
  return storage.read();
}

/**
 * Run `callback` inside an emitted-ids scope. If a scope is already
 * open (nested capturer — e.g. a Server Action wrapped by
 * `captureServerAction` invoked from inside `captureRoute`'s scope),
 * reuse the parent's Set so the inner flush and the outer flush
 * share dedup state. Without this reuse, each capturer would open a
 * fresh Set and emit the same audit rows once per layer.
 *
 * Only the outermost capturer per request opens a fresh Set.
 */
export function runWithEmittedAuditIdsScope<R>(callback: () => R): R {
  const existing = storage.read();
  if (existing !== null) return callback();
  return storage.run(new Set<string>(), callback);
}

/** Test-only — clears the Edge fallback. */
export function _resetEmittedAuditIdsForTests(): void {
  storage._resetForTests();
}
