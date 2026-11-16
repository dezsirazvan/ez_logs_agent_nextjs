// wrapPostgresJs — link postgres.js writes to the request that made them.
//
// postgres.js has no driver hook the agent can patch (unlike `pg`), so
// without this its writes reach `ezlogs_audit_log` with no correlation
// id and show up as their own actions with no actor (Drizzle on
// postgres-js, Vercel Postgres templates). Wrapping the `sql` instance
// tags each write the way the `pg` patch does: inside a transaction,
// after `set_config('ezlogs.correlation_id', …, true)` (and the actor
// id), which the audit trigger reads.
//
//   import postgres from "postgres"
//   import { wrapPostgresJs } from "ezlogs-nextjs/postgres"
//
//   export const sql = wrapPostgresJs(postgres(process.env.DATABASE_URL!))
//   export const db = drizzle(sql, { schema })   // Drizzle postgres-js
//
// Tagged (only inside a captured request / job, with the trigger reader
// wired):
//   - a standalone write (`sql\`insert …\``, `sql.unsafe("update …")`,
//     Drizzle inserts / updates / deletes) runs as BEGIN; set_config;
//     <write>; COMMIT on one pooled connection. The query object the
//     caller holds settles after COMMIT (a COMMIT error rejects it, as
//     autocommit would have).
//   - `sql.begin(fn)` (Drizzle's `db.transaction`) runs set_config first
//     inside the transaction, then `fn`.
// Left untagged (rows still ship, as their own actions, never on another
// request): reads, cursors / forEach / COPY streams, `sql.file`,
// `sql.reserve()` connections (the caller may hold its own BEGIN there),
// and writes hidden in a function call (`select my_fn()`).

import { configuration } from "../configuration.js";
import { getDatabaseContext, type DatabaseContextSnapshot } from "../triggers/context.js";

/** The parts of a postgres.js `Query` (a lazy Promise subclass) we use. */
interface PgJsQuery extends Promise<unknown> {
  strings: ReadonlyArray<string>;
  args: unknown[];
  tagged: boolean;
  options: Record<string, unknown>;
  handler: ((query: PgJsQuery) => void) & { debug?: unknown };
  canceller: ((query: PgJsQuery) => unknown) | null;
  cancel(): unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  isRaw?: unknown;
  cancelled?: unknown;
  cursorFn?: unknown;
  forEachFn?: unknown;
  onlyDescribe?: unknown;
  streaming?: unknown;
}

interface PgJsSql {
  (...args: unknown[]): unknown;
  unsafe(...args: unknown[]): unknown;
  begin(...args: unknown[]): Promise<unknown>;
}

const SET_CONTEXT_SQL =
  "select set_config('ezlogs.actor_id', $1, true), set_config('ezlogs.correlation_id', $2, true)";

const wrappedInstances = new WeakSet<object>();

/**
 * Wrap a postgres.js `sql` instance so writes made inside a captured
 * request carry its correlation id and actor. Returns the same API (a
 * Proxy); pass the result to `drizzle()` for Drizzle on postgres-js.
 * Anything that isn't a postgres.js instance is returned unchanged.
 */
export function wrapPostgresJs<T>(sql: T): T {
  if (typeof sql !== "function" || wrappedInstances.has(sql)) return sql;
  const base = sql as unknown as PgJsSql;
  if (typeof base.unsafe !== "function" || typeof base.begin !== "function") return sql;

  const unsafe = (...args: unknown[]) => tagIfWrite(base, base.unsafe(...args));
  const begin = (...args: unknown[]) => beginWithContext(base, args);
  const proxy = new Proxy(base, {
    apply: (target, thisArg, args) => tagIfWrite(base, Reflect.apply(target, thisArg, args)),
    get: (target, prop) =>
      prop === "unsafe" ? unsafe : prop === "begin" ? begin : Reflect.get(target, prop),
  });
  wrappedInstances.add(proxy);
  return proxy as unknown as T;
}

/** Context to tag with, or null when tagging can't matter (no reader / no request). */
function tagContext(): DatabaseContextSnapshot | null {
  if (configuration().databaseReader == null) return null;
  const ctx = getDatabaseContext();
  return ctx.correlationId ? ctx : null;
}

function setContext(tx: PgJsSql, ctx: DatabaseContextSnapshot): unknown {
  return tx.unsafe(SET_CONTEXT_SQL, [ctx.actorId ?? "", ctx.correlationId]);
}

// The query is lazy: it runs when awaited. Swap its dispatch so the
// decision (and the context read) happens at that moment, in the
// awaiting request's async context.
function tagIfWrite(base: PgJsSql, value: unknown): unknown {
  if (!isQuery(value) || !isWrite(value.strings)) return value;
  const original = value.handler;
  value.handler = Object.assign((query: PgJsQuery) => dispatch(base, query, original), {
    debug: original.debug,
  });
  return value;
}

function dispatch(base: PgJsSql, query: PgJsQuery, original: PgJsQuery["handler"]): void {
  const ctx = tagContext();
  // Already cancelled: postgres.js's own dispatch skips it.
  if (!ctx || query.cancelled || query.cursorFn || query.forEachFn || query.onlyDescribe || query.streaming) {
    original(query);
    return;
  }
  let tagged = false;
  // `query.cancel()` must reach the statement that actually runs.
  let copy: PgJsQuery | null = null;
  let cancelled = false;
  query.canceller = () => {
    cancelled = true;
    copy?.cancel();
  };
  base
    .begin(async (tx: PgJsSql) => {
      await setContext(tx, ctx);
      // Cancelled during BEGIN / set_config: never run it. (Cancelling a
      // not-yet-sent postgres.js query inside a transaction stalls it.)
      if (cancelled) {
        throw Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
      }
      // Same statement, same modifiers (`.values()`, `.raw()`, simple
      // mode), on the transaction's connection. Built before `tagged` is
      // set: if postgres.js internals ever differ, the write runs untagged.
      const built = (
        query.tagged
          ? tx(query.strings, ...query.args)
          : tx.unsafe(query.strings[0], query.args, query.options)
      ) as PgJsQuery;
      Object.assign(built.options, query.options);
      built.isRaw = query.isRaw;
      copy = built;
      tagged = true;
      return await built;
    })
    .then(
      (result) => query.resolve(result),
      // BEGIN / set_config / the copy failed before the write ran: run it
      // untagged (unless the caller cancelled it).
      (error) => (tagged || cancelled ? query.reject(error) : original(query)),
    );
}

function beginWithContext(base: PgJsSql, args: unknown[]): Promise<unknown> {
  const last = args.length - 1;
  const fn = args[last];
  const ctx = tagContext();
  if (typeof fn !== "function" || !ctx) return base.begin(...args);
  const withContext = async (tx: PgJsSql) => {
    await setContext(tx, ctx);
    const result = fn(tx);
    // postgres.js runs an array of queries returned from the callback.
    return Array.isArray(result) ? Promise.all(result) : result;
  };
  return base.begin(...args.slice(0, last), withContext);
}

function isQuery(value: unknown): value is PgJsQuery {
  const q = value as PgJsQuery | null;
  return (
    value instanceof Promise &&
    typeof q!.handler === "function" &&
    Array.isArray(q!.strings) &&
    typeof q!.resolve === "function"
  );
}

const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()+/;
const WRITE_VERB = /^(?:insert|update|delete|merge)\b/i;
const WRITE_WORD = /\b(?:insert|update|delete|merge)\b/i;

/** INSERT / UPDATE / DELETE / MERGE, or a WITH whose body writes. @internal */
export function isWrite(strings: ReadonlyArray<string>): boolean {
  const text = strings.join(" ");
  const head = text.replace(LEADING_NOISE, "");
  if (WRITE_VERB.test(head)) return true;
  return /^with\b/i.test(head) && WRITE_WORD.test(text);
}
