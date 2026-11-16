// Audit-log reader — turn `ezlogs_audit_log` rows into the agent's
// canonical `database_callback` events.
//
// This is the bridge the trigger-based capture path needs. The
// SQL trigger (00_install.sql) writes a JSONB old_row / new_row
// per mutation, tagged with the correlation id of the request that
// made it (from the `ezlogs.correlation_id` GUC on direct `pg`
// connections, or PostgREST's `request.headers` for supabase-js).
// At the end of each request, the HTTP capturer calls
// `flushAuditLog`, which CLAIMS (deletes and returns) every row
// tagged with the current correlation id and emits one
// `database_callback` event per row through `emitDbEvent`.
//
// Correlation rule (CLAUDE.md §4: partial is OK, wrong is not):
// a request only ever emits rows carrying ITS OWN correlation id.
// Rows with no correlation id (writes from a client the agent can't
// tag: Prisma's default Rust engine, postgres.js, cron scripts…) are
// never attributed to whichever request happens to be open. A
// throttled sweep emits them as their own actions, without an actor.
// (Before 0.2.0 a "snapshot" fallback claimed every untagged row
// written during a request; under concurrency that stamped other
// users' writes with the wrong actor.)
//
// Retention: rows are deleted when claimed, so the table only holds
// rows not yet emitted. Untagged rows and rows older than
// ORPHAN_AGE are drained by the sweep; rows older than PRUNE_AGE are
// deleted without emitting (e.g. when no request ran for a day).
//
// The reader itself doesn't open transactions or connections; it
// takes a `SqlExecutor` (the same shape `applyDatabaseContext` uses).

import { logger } from "../logger.js";
import {
  emitDbEvent,
  type DbAttributeChange,
  type DbOperation,
} from "../db/shared.js";
import {
  current as currentCorrelation,
  generate as generateCorrelation,
  runWithCorrelation,
} from "../correlation.js";
import { runWithActorScope } from "../actor.js";
import { currentEmittedAuditIds } from "./emit-dedup.js";
import type { SqlExecutor } from "./context.js";

/**
 * Shape of one row returned by the audit-log query. Matches the
 * column list in `00_install.sql`. Drivers vary on how they
 * deserialize jsonb (`pg` returns plain objects; some serverless
 * drivers return strings) — `coerceJsonb` below handles both.
 */
export interface AuditRow {
  /**
   * The audit log row's primary key, stringified. Used only for
   * within-request emit dedup — never reaches the wire.
   */
  id: string;
  table_name: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  old_row: Record<string, unknown> | string | null;
  new_row: Record<string, unknown> | string | null;
  resource_id: string | null;
  /** Stored correlation id (null when the write couldn't be tagged). */
  correlation_id?: string | null;
  /** Postgres transaction id — groups untagged rows into one action. */
  txid?: string | null;
  /** When the trigger fired — becomes the event timestamp. */
  captured_at?: Date | null;
}

/**
 * Result shape from `exec`. Drivers diverge; we accept the most
 * common: `{ rows: [...] }` (pg, postgres.js with `.array()`),
 * a bare array (drizzle's `db.execute` returns the rows directly),
 * and `{ rowCount, rows }`. Anything else falls back to "no rows."
 */
type ExecResult =
  | { rows?: ReadonlyArray<unknown> }
  | ReadonlyArray<unknown>
  | null
  | undefined;

const COLUMNS =
  "id, table_name, op, old_row, new_row, resource_id, correlation_id, txid, captured_at";

/** Rows older than this are drained by the sweep even if tagged (their request never flushed). */
const ORPHAN_AGE = "5 minutes";
/** Rows older than this are deleted without emitting (and never swept). */
const PRUNE_AGE = "24 hours";
const SWEEP_BATCH = 100;
// shortcut: 2k rows per 10 min (~290k/day) of expired rows; a bigger
// backlog takes longer to clear but stays invisible (never swept).
const PRUNE_BATCH = 2_000;
const SWEEP_INTERVAL_MS = 10_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;

// Module state is per process (per bundle layer); duplicates only mean
// an extra cheap sweep, never a double emit (claims are DELETEs).
let lastSweepAt = 0;
let lastPruneAt = 0;
// DELETE denied (read-only reader role): fall back to SELECT and
// leave retention to the customer.
let deleteDenied = false;
// txid → generated correlation id, so an untagged transaction split
// across two sweep batches still lands in one action.
const txCorrelation = new Map<string, string>();

/**
 * Claim (delete + return) the audit rows tagged with `correlationId`,
 * oldest first. A row can only be claimed once, so concurrent flushes
 * never emit the same row twice.
 *
 * If the reader role may not DELETE, falls back to a plain SELECT
 * (rows then stay until the customer cleans them up) and warns once.
 *
 * Errors are caught and returned as `[]` — a failed audit read must
 * never break the host request.
 */
export async function readAuditRows(
  exec: SqlExecutor,
  correlationId: string,
): Promise<AuditRow[]> {
  try {
    if (!deleteDenied) {
      try {
        return sortById(
          extractRows(
            (await exec(
              `DELETE FROM ezlogs_audit_log WHERE correlation_id = $1 RETURNING ${COLUMNS}`,
              [correlationId],
            )) as ExecResult,
          ).map(normalizeAuditRow),
        );
      } catch (err) {
        if (!isPermissionDenied(err)) throw err;
        deleteDenied = true;
        logger.warn(
          "the database role used by the agent cannot DELETE from ezlogs_audit_log. " +
            "Rows will not be cleaned up after they are sent; grant DELETE or schedule " +
            "`DELETE FROM ezlogs_audit_log WHERE captured_at < now() - interval '24 hours'`.",
        );
      }
    }
    const result = (await exec(
      `SELECT ${COLUMNS} FROM ezlogs_audit_log WHERE correlation_id = $1 ORDER BY id ASC`,
      [correlationId],
    )) as ExecResult;
    return extractRows(result).map(normalizeAuditRow);
  } catch (err) {
    logger.debug(
      `readAuditRows failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Drain rows no request will claim: untagged rows, and tagged rows
 * older than ORPHAN_AGE. Each is emitted under its stored correlation
 * id, or — when it has none — under one fresh id per database
 * transaction, always with no actor. Never attributes a row to the
 * request that happens to run the sweep.
 *
 * Returns the number of rows emitted. Errors are swallowed.
 */
export async function sweepAuditLog(exec: SqlExecutor): Promise<number> {
  if (deleteDenied) return 0;
  try {
    const rows = sortById(
      extractRows(
        (await exec(
          `DELETE FROM ezlogs_audit_log
            WHERE id IN (
              SELECT id FROM ezlogs_audit_log
               WHERE (correlation_id IS NULL
                      OR captured_at < now() - interval '${ORPHAN_AGE}')
                 -- Never resurface history: past the retention cap a
                 -- row is pruned, not sent as new activity.
                 AND captured_at > now() - interval '${PRUNE_AGE}'
               ORDER BY id
               LIMIT ${SWEEP_BATCH}
               FOR UPDATE SKIP LOCKED)
            RETURNING ${COLUMNS}`,
          [],
        )) as ExecResult,
      ).map(normalizeAuditRow),
    );
    for (const row of rows) {
      const correlationId = row.correlation_id ?? correlationForTx(row.txid);
      runWithCorrelation(correlationId, () =>
        runWithActorScope(() => emitOne(row)),
      );
    }
    return rows.length;
  } catch (err) {
    logger.debug(
      `sweepAuditLog failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/** Delete rows older than PRUNE_AGE without emitting them. Errors swallowed. */
export async function pruneAuditLog(exec: SqlExecutor): Promise<void> {
  if (deleteDenied) return;
  try {
    await exec(
      `DELETE FROM ezlogs_audit_log
        WHERE id IN (
          SELECT id FROM ezlogs_audit_log
           WHERE captured_at < now() - interval '${PRUNE_AGE}'
           LIMIT ${PRUNE_BATCH})`,
      [],
    );
  } catch (err) {
    logger.debug(
      `pruneAuditLog failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Probe whether `ezlogs_audit_log` exists. `true` / `false` when the
 * query answered, `null` when it failed (database unreachable) — the
 * caller must not treat a transient failure as "not installed".
 */
export async function auditLogInstalled(exec: SqlExecutor): Promise<boolean | null> {
  try {
    const rows = extractRows(
      (await exec(
        `SELECT to_regclass('public.ezlogs_audit_log') IS NOT NULL AS installed`,
        [],
      )) as ExecResult,
    );
    const installed = (rows[0] as { installed?: unknown } | undefined)?.installed;
    return typeof installed === "boolean" ? installed : null;
  } catch {
    return null;
  }
}

/**
 * Warn once when the reader's role can't see the audit log's rows.
 * ezlogs_audit_log has row-level security with no policies, so a role
 * that is not the owner (and not superuser / BYPASSRLS) reads 0 rows —
 * silently — even with GRANTs. Returns true when access looks blocked.
 * Errors are swallowed (returns false).
 */
export async function checkAuditLogAccess(exec: SqlExecutor): Promise<boolean> {
  try {
    const rows = extractRows(
      (await exec(
        `SELECT current_user AS role
           FROM pg_class c
           JOIN pg_roles r ON r.rolname = current_user
          WHERE c.oid = 'public.ezlogs_audit_log'::regclass
            AND c.relrowsecurity
            AND NOT r.rolsuper
            AND NOT r.rolbypassrls
            AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
            AND NOT EXISTS (SELECT 1 FROM pg_policies p
                             WHERE p.schemaname = 'public'
                               AND p.tablename = 'ezlogs_audit_log')`,
        [],
      )) as ExecResult,
    );
    const role = (rows[0] as { role?: unknown } | undefined)?.role;
    if (typeof role !== "string") return false;
    logger.warn(
      `the database role "${role}" is not the owner of ezlogs_audit_log, which has ` +
        "row-level security, so the agent reads 0 rows and no DB changes are sent. As the " +
        `table owner, run: GRANT SELECT, DELETE ON ezlogs_audit_log TO "${role}"; ` +
        `CREATE POLICY ezlogs_reader ON ezlogs_audit_log TO "${role}" USING (true);`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which tables have the `ezlogs_audit` trigger attached. Used
 * by the per-ORM adapters to decide whether their per-mutation emit
 * is redundant (the audit reader will surface the same write with
 * full old/new state) or needs to fire (table isn't tracked, the
 * adapter is the only path that captures it).
 *
 * Read once at agent startup. The result is a Set of table names —
 * we don't read the schema, since `ezlogs_track` only attaches to
 * `public.<table>` and the customer's mutations resolve through the
 * default search_path the same way.
 *
 * Returns null on failure. Callers treat null as "detection unknown,
 * fall back to original suppress-all behavior" — that's the
 * conservative choice: silently double-emitting for trigger-tracked
 * tables is worse than missing capture for an untracked one, because
 * detection failure usually means the trigger install itself isn't
 * complete and there's nothing to read anyway.
 */
export async function detectTriggerTrackedTables(
  exec: SqlExecutor,
): Promise<Set<string> | null> {
  try {
    const result = (await exec(
      `SELECT event_object_table AS table_name
         FROM information_schema.triggers
        WHERE trigger_name = 'ezlogs_audit'
          AND trigger_schema = 'public'`,
      [],
    )) as ExecResult;
    const rows = extractRows(result);
    const tables = new Set<string>();
    for (const row of rows) {
      const r = (row ?? {}) as { table_name?: unknown };
      if (typeof r.table_name === "string" && r.table_name.length > 0) {
        tables.add(r.table_name);
      }
    }
    return tables;
  } catch (err) {
    logger.debug(
      `detectTriggerTrackedTables failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Push every fetched row into the existing `emitDbEvent` pipeline.
 * Public so tests and advanced customers can call it directly.
 */
export function emitAuditRows(rows: ReadonlyArray<AuditRow>): void {
  for (const row of rows) {
    emitOne(row);
  }
}

/**
 * End-of-request entry point. Claims rows for the current correlation
 * id and emits each one, then runs the throttled sweep (untagged /
 * orphaned rows, as their own actions) and prune. Skips when no
 * correlation is in scope or no exec is supplied.
 *
 * The HTTP capturers call this after the user's handler returns,
 * before they push the HTTP event itself, so DB events arrive
 * grouped under the same correlation as the HTTP card.
 */
export async function flushAuditLog(exec: SqlExecutor | null | undefined): Promise<void> {
  if (!exec) return;
  const correlationId = currentCorrelation();
  if (!correlationId) return;
  const rows = await readAuditRows(exec, correlationId);
  emitFresh(rows);

  const now = Date.now();
  // Prune first, so the sweep never sees rows past the retention cap.
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    // Awaited: a customer-supplied reader may be a single client, and
    // overlapping queries on it would interleave. Small batch (indexed
    // on captured_at) keeps the cost to a few ms on the request path.
    await pruneAuditLog(exec);
  }
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    await sweepAuditLog(exec);
  }
}

/** Test-only. */
export function _resetAuditReaderForTests(): void {
  lastSweepAt = 0;
  lastPruneAt = 0;
  deleteDenied = false;
  txCorrelation.clear();
}

function emitFresh(rows: AuditRow[]): void {
  if (rows.length === 0) return;
  // Within-request dedup. Claims are DELETEs so a row normally comes
  // back once, but the SELECT fallback (no DELETE privilege) re-reads
  // the same rows on every flush of the request. Null = no scope open
  // = adapter call path; emit unconditionally.
  const emitted = currentEmittedAuditIds();
  if (emitted === null) {
    emitAuditRows(rows);
    return;
  }
  const fresh: AuditRow[] = [];
  for (const row of rows) {
    if (row.id === "" || emitted.has(row.id)) continue;
    emitted.add(row.id);
    fresh.push(row);
  }
  emitAuditRows(fresh);
}

function correlationForTx(txid: string | null | undefined): string {
  if (!txid) return generateCorrelation();
  let id = txCorrelation.get(txid);
  if (!id) {
    if (txCorrelation.size >= 1000) txCorrelation.clear();
    id = generateCorrelation();
    txCorrelation.set(txid, id);
  }
  return id;
}

function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42501";
}

function sortById(rows: AuditRow[]): AuditRow[] {
  // RETURNING order is unspecified; emit in capture order.
  return rows.sort((a, b) =>
    a.id.length !== b.id.length ? a.id.length - b.id.length : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

function emitOne(row: AuditRow): void {
  const op = mapOp(row.op);
  if (!op) return;

  const oldRow = coerceJsonb(row.old_row);
  const newRow = coerceJsonb(row.new_row);

  // For creates we ship the full new row as initial_attributes;
  // shared.ts strips ignored fields + sensitive keys. For updates
  // we compute changed-only diffs from old/new. For deletes we have
  // no business-meaningful payload — emit the bare event so the
  // dashboard at least surfaces the deletion.
  if (op === "create" && newRow) {
    emitDbEvent({
      modelClass: row.table_name,
      operation: "create",
      resourceId: row.resource_id,
      initialAttributes: newRow,
      modelInstance: newRow,
      displayName: null,
      timestamp: row.captured_at ?? null,
      _fromTrigger: true,
    });
    return;
  }

  if (op === "update" && oldRow && newRow) {
    const changes = computeChanges(oldRow, newRow);
    if (changes.length === 0) {
      // Trigger fired but no business attributes changed (e.g. a
      // touch-only update of `updated_at`). Skip — users don't want
      // empty cards.
      return;
    }
    emitDbEvent({
      modelClass: row.table_name,
      operation: "update",
      resourceId: row.resource_id,
      changes,
      // Prefer the post-state for the display name — that's what the
      // user just told the system to call this row.
      modelInstance: newRow,
      displayName: null,
      timestamp: row.captured_at ?? null,
      _fromTrigger: true,
    });
    return;
  }

  if (op === "destroy" && oldRow) {
    // Delete: keep the pre-state visible so the card has something
    // to render ("Razvan deleted invite alice@…"). filterMeaningful…
    // strips ignored + sensitive fields.
    // filterMeaningfulAttributes returns null when nothing survives —
    // emitDbEvent itself will run the same filter again, so we just
    // pass the raw oldRow through and let the canonical pipe handle
    // the empty case.
    emitDbEvent({
      modelClass: row.table_name,
      operation: "destroy",
      resourceId: row.resource_id,
      initialAttributes: oldRow,
      modelInstance: oldRow,
      displayName: null,
      timestamp: row.captured_at ?? null,
      _fromTrigger: true,
    });
    return;
  }
}

function mapOp(op: AuditRow["op"]): DbOperation | null {
  if (op === "INSERT") return "create";
  if (op === "UPDATE") return "update";
  if (op === "DELETE") return "destroy";
  return null;
}

function computeChanges(
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
): DbAttributeChange[] {
  const out: DbAttributeChange[] = [];
  // Iterate the new row's keys (a delete-only column wouldn't appear
  // in newRow on an UPDATE — Postgres triggers fire AFTER UPDATE so
  // the schema is the same on both sides).
  for (const key of Object.keys(newRow)) {
    const before = oldRow[key];
    const after = newRow[key];
    if (deepEqual(before, after)) continue;
    out.push({ attribute: key, from: before, to: after });
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  // jsonb columns can hold nested objects/arrays. Cheap deep equal:
  // JSON.stringify is fine for the sizes we see (< 1 KB rows in the
  // 99% case). Keys are not guaranteed stable order across Postgres
  // versions, so we sort.
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]));
  return "{" + entries.join(",") + "}";
}

function extractRows(result: ExecResult): ReadonlyArray<unknown> {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeAuditRow(raw: unknown): AuditRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: r.id == null ? "" : String(r.id),
    table_name: String(r.table_name ?? ""),
    op: r.op as AuditRow["op"],
    old_row: (r.old_row ?? null) as AuditRow["old_row"],
    new_row: (r.new_row ?? null) as AuditRow["new_row"],
    resource_id: r.resource_id == null ? null : String(r.resource_id),
    correlation_id: r.correlation_id == null ? null : String(r.correlation_id),
    txid: r.txid == null ? null : String(r.txid),
    captured_at: toDate(r.captured_at),
  };
}

/**
 * Postgres jsonb usually round-trips as a parsed object via `pg`,
 * but some drivers (older postgres.js, Neon serverless HTTP) return
 * a JSON string. Coerce both shapes to a plain object.
 */
function coerceJsonb(
  value: Record<string, unknown> | string | null,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return null;
}
