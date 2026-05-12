// withDatabaseContext / applyDatabaseContext — propagate the current
// request's actor + correlation id into a Postgres transaction as
// session-local GUCs (`ezlogs.actor_id`, `ezlogs.correlation_id`).
//
// The audit triggers installed by 00_install.sql read these via
// `current_setting(_, true)`. Without this hop, the trigger fires
// but the audit row carries actor=NULL / correlation_id=NULL, which
// makes the agent reader unable to match the row to the HTTP event
// that caused it.
//
// Two shapes ship from this module:
//
//   `applyDatabaseContext(exec)` — primitive. The customer hands us a
//      function that runs a single SQL statement on their *existing*
//      transaction handle (drizzle `tx`, prisma `tx`, pg client, …).
//      We issue two `SELECT set_config(...)` calls. No transaction
//      management — the customer wraps us in their own.
//
//   `withDatabaseContext(opts, callback)` — sugar. Opens an explicit
//      transaction on a `pg`-style client (one that exposes
//      `query(sql, params)` returning a Promise), runs the GUC
//      injection + the customer callback inside it, COMMITs.
//      For customers who don't already have a transaction wrapper.
//
// Both pull actor + correlation from the agent's per-request scope
// (set by the HTTP capturers). When neither is set — e.g. a CLI
// script writing to the DB — both helpers no-op the SET and the
// trigger captures the row with NULL actor/correlation.

import { getCurrentActor } from "../actor.js";
import { current as currentCorrelation } from "../correlation.js";
import { logger } from "../logger.js";

/**
 * Minimal SQL executor shape. Anything that can `await fn(sql, params)`
 * works — we deliberately don't depend on any specific driver type.
 *
 * `params` is positional Postgres-style (`$1`, `$2`, …). The result
 * is ignored (we don't inspect it) so the return type is `unknown`.
 */
export type SqlExecutor = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<unknown>;

/**
 * Snapshot of the values the trigger needs to see on the current
 * transaction. Both fields are nullable — there's no guarantee a
 * given request has either resolved by the time the customer's
 * mutation runs.
 *
 * Returned as a primitive so customers on ORMs whose APIs don't fit
 * the `(sql, params)` shape (Drizzle's tagged-template `sql` builder,
 * Prisma's `$executeRaw`, postgres.js's `sql\`...\``) can compose
 * the SET statement against their own query primitive without going
 * through `applyDatabaseContext`.
 */
export interface DatabaseContextSnapshot {
  actorId: string | null;
  correlationId: string | null;
}

export function getDatabaseContext(): DatabaseContextSnapshot {
  const actor = getCurrentActor();
  return {
    actorId: actor && actor.id ? actor.id : null,
    correlationId: currentCorrelation(),
  };
}

/**
 * Runs `SELECT set_config('ezlogs.actor_id', $1, true)` and the
 * matching correlation id call against `exec`.
 *
 * `is_local = true` scopes the setting to the current transaction —
 * required for PgBouncer-pooled deployments (Supabase, Neon, Vercel
 * Postgres) where the connection is shared between requests.
 *
 * The caller MUST be inside an explicit transaction when calling
 * this. Outside a transaction, `set_config(_, _, true)` is a no-op
 * (Postgres has nothing to scope to) and the trigger reads NULL.
 *
 * No-ops (skips the SQL entirely) when both actor and correlation
 * are absent — saves two round-trips for un-instrumented callers.
 */
export async function applyDatabaseContext(exec: SqlExecutor): Promise<void> {
  const actor = getCurrentActor();
  const correlationId = currentCorrelation();

  // Empty-string and NULL look the same to the trigger (NULLIF in
  // 00_install.sql), but we can avoid the round-trip entirely when
  // there's nothing to set.
  if (!actor && !correlationId) return;

  try {
    if (actor && actor.id) {
      await exec(`SELECT set_config('ezlogs.actor_id', $1, true)`, [actor.id]);
    }
    if (correlationId) {
      await exec(
        `SELECT set_config('ezlogs.correlation_id', $1, true)`,
        [correlationId],
      );
    }
  } catch (err) {
    // Don't break the customer's transaction over our auditing call.
    // The trigger will still fire — just without actor/correlation —
    // and the agent reader will discard the row at correlation match
    // time. Far better than a 500 from the user-facing endpoint.
    logger.debug(
      `applyDatabaseContext: set_config failed, continuing without context: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * `pg`-style client: anything that accepts `client.query(sql)` /
 * `client.query(sql, params)` and returns a Promise. Both
 * `pg.Client` and `pg.PoolClient` match. Drizzle's `db.execute` and
 * Prisma's `tx.$executeRawUnsafe` don't fit this shape directly —
 * those callers should use `applyDatabaseContext` inside their own
 * `db.transaction(...)` callback instead.
 */
export interface PgLikeClient {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
}

/**
 * Convenience wrapper: opens BEGIN on a `pg`-style client, applies
 * the current request's actor/correlation as session-local GUCs,
 * runs `callback`, then COMMIT. ROLLBACK on any thrown error.
 *
 * Use this when your code path doesn't already have a transaction
 * (e.g., a Server Action that does a single mutation). For code
 * already inside `db.transaction(async tx => ...)`, call
 * `applyDatabaseContext(tx-exec-fn)` at the top of the callback
 * instead — wrapping a transaction in another transaction is an
 * error in Postgres.
 *
 * The callback receives the same client back so the customer can
 * issue their reads/writes against the in-flight transaction.
 */
export async function withDatabaseContext<T>(
  client: PgLikeClient,
  callback: (client: PgLikeClient) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await applyDatabaseContext(async (sql, params) => client.query(sql, params));
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK on a connection that's already in a bad state can
      // itself throw. Swallow — the original error is what the
      // customer actually wants to see.
    }
    throw err;
  }
}
