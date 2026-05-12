// Audit-log reader — turn `ezlogs_audit_log` rows into the agent's
// canonical `database_callback` events.
//
// This is the bridge the trigger-based capture path needs. The
// SQL trigger (00_install.sql) writes a JSONB old_row / new_row
// per mutation, scoped by GUC-supplied correlation id. At the end
// of each request, the HTTP capturer calls `flushAuditLog` which
// reads back every row tagged with the current correlation_id and
// emits one `database_callback` event per row through the existing
// emit path (`emitDbEvent`).
//
// Why pull-at-end-of-request rather than push-from-the-trigger:
//   - The trigger runs inside the customer's transaction. We don't
//     want to do a network round-trip from inside it (latency hit
//     the customer didn't ask for).
//   - We don't need realtime: events are buffered and shipped on
//     the existing flush schedule. End-of-request reads are a few
//     ms on a sub-100-row table.
//   - The agent is already in scope at end of request — actor and
//     correlation id are still readable.
//
// The reader itself doesn't open transactions or connections; it
// takes a `SqlExecutor` (the same shape `applyDatabaseContext` uses)
// and runs a single SELECT. The customer wires that executor to
// their pg / drizzle / prisma client however they prefer.
//
// Per-row delete vs. retention: we don't delete rows after read.
// Customers schedule their own cleanup (e.g.
//   `DELETE FROM ezlogs_audit_log WHERE captured_at < now() - '7 days'`
// in a cron). The audit log doubles as a customer-facing forensic
// trail — users may want to keep it longer than the EZLogs
// retention.

import { logger } from "../logger.js";
import {
  emitDbEvent,
  type DbAttributeChange,
  type DbOperation,
} from "../db/shared.js";
import { current as currentCorrelation } from "../correlation.js";
import {
  currentAuditSnapshot,
  setAuditSnapshot,
} from "./audit-snapshot.js";
import type { SqlExecutor } from "./context.js";

/**
 * Shape of one row returned by the audit-log SELECT. Matches the
 * column list in `00_install.sql` exactly. Drivers vary on how they
 * deserialize jsonb (`pg` returns plain objects; some serverless
 * drivers return strings) — `coerceJsonb` below handles both.
 */
export interface AuditRow {
  table_name: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  old_row: Record<string, unknown> | string | null;
  new_row: Record<string, unknown> | string | null;
  resource_id: string | null;
  // actor_id and correlation_id are also on the row but the agent
  // already knows both from request scope — no need to round-trip.
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

/**
 * Fetch audit rows tagged with `correlationId` in capture order.
 *
 * Returns rows oldest-first (matches the trigger's `clock_timestamp`
 * within a transaction) so the dashboard renders them chronologically.
 *
 * Errors are caught and returned as `[]` — a failed audit read must
 * never break the host request. The error is logged at debug.
 */
export async function readAuditRows(
  exec: SqlExecutor,
  correlationId: string,
  /**
   * Snapshot of `MAX(id)` taken at the start of the request. Used as
   * the lower bound for the time-window fallback path that catches
   * rows whose `correlation_id` is NULL — i.e., supabase-js writes
   * that didn't go through SET LOCAL because PostgREST doesn't
   * expose explicit transactions to the client.
   *
   * When null, the reader falls back to correlation-only matching
   * (Phase 5 primary path).
   */
  snapshotMaxId: bigint | null = null,
): Promise<AuditRow[]> {
  try {
    // Two queries logically OR'd:
    //   1. correlation_id = $1     (Phase 5 primary path: SET LOCAL fired)
    //   2. correlation_id IS NULL AND id > $2  (Supabase / no-SET-LOCAL
    //      path: agent attributes context from request scope at emit time)
    //
    // We always emit the correlation-tagged rows. The snapshot arm only
    // engages when the customer has wired audit-snapshot bookkeeping
    // (i.e. `takeAuditSnapshot` ran at request start). Without it,
    // `snapshotMaxId === null` and the second arm is excluded entirely
    // so we don't accidentally pick up unrelated rows.
    const sql =
      snapshotMaxId === null
        ? `SELECT table_name, op, old_row, new_row, resource_id
             FROM ezlogs_audit_log
            WHERE correlation_id = $1
            ORDER BY id ASC`
        : `SELECT table_name, op, old_row, new_row, resource_id
             FROM ezlogs_audit_log
            WHERE correlation_id = $1
               OR (correlation_id IS NULL AND id > $2)
            ORDER BY id ASC`;
    const params =
      snapshotMaxId === null
        ? [correlationId]
        : [correlationId, snapshotMaxId.toString()];

    const result = (await exec(sql, params)) as ExecResult;

    const rows = extractRows(result);
    return rows.map((r) => normalizeAuditRow(r));
  } catch (err) {
    logger.debug(
      `readAuditRows failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Take a snapshot of the current `MAX(id)` from `ezlogs_audit_log` and
 * store it on the per-request scope. Called at the start of each HTTP
 * request when `databaseReader` is configured. The reader's time-window
 * fallback uses this as the lower bound for catching supabase-js writes
 * (rows whose `correlation_id` is NULL because PostgREST didn't run
 * inside our explicit transaction).
 *
 * Errors are swallowed — a failed snapshot just means the time-window
 * fallback degrades to "match correlation_id only" for this request.
 * Never break the host's request over a bookkeeping query.
 */
export async function takeAuditSnapshot(exec: SqlExecutor): Promise<void> {
  try {
    const result = (await exec(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ezlogs_audit_log`,
      [],
    )) as ExecResult;
    const rows = extractRows(result);
    if (rows.length === 0) return;
    const raw = (rows[0] ?? {}) as { max_id?: unknown };
    // pg returns bigint columns as strings by default; Drizzle's
    // `db.execute` shape varies. Coerce defensively.
    const value =
      typeof raw.max_id === "bigint"
        ? raw.max_id
        : typeof raw.max_id === "number"
          ? BigInt(raw.max_id)
          : typeof raw.max_id === "string" && /^\d+$/.test(raw.max_id)
            ? BigInt(raw.max_id)
            : null;
    if (value === null) return;
    setAuditSnapshot(value);
  } catch (err) {
    logger.debug(
      `takeAuditSnapshot failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
 * End-of-request entry point. Reads rows for the current correlation
 * id and emits each one. Skips when no correlation is in scope (no
 * way to match rows back to this request) or no exec is supplied.
 *
 * The HTTP capturers call this after the user's handler returns,
 * before they push the HTTP event itself, so DB events arrive
 * grouped under the same correlation as the HTTP card.
 */
export async function flushAuditLog(exec: SqlExecutor | null | undefined): Promise<void> {
  if (!exec) return;
  const correlationId = currentCorrelation();
  if (!correlationId) return;
  // currentAuditSnapshot() returns null when the customer hasn't wired
  // takeAuditSnapshot at request start (e.g. pure-pg stacks where SET
  // LOCAL does the job). In that case the reader falls back to its
  // correlation-only filter — no behavioral change vs. earlier versions.
  const snapshot = currentAuditSnapshot();
  const rows = await readAuditRows(exec, correlationId, snapshot);
  if (rows.length === 0) return;
  emitAuditRows(rows);
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

function normalizeAuditRow(raw: unknown): AuditRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    table_name: String(r.table_name ?? ""),
    op: r.op as AuditRow["op"],
    old_row: (r.old_row ?? null) as AuditRow["old_row"],
    new_row: (r.new_row ?? null) as AuditRow["new_row"],
    resource_id: r.resource_id == null ? null : String(r.resource_id),
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
