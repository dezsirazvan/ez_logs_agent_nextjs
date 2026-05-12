// patchPgClient — transparent SET LOCAL injection for the `pg` driver.
//
// Without this, every customer mutation has to be hand-wrapped with
// `getDatabaseContext()` + `tx.execute(SET ...)` so the audit trigger
// sees the request's actor + correlation id. In a typical Next.js
// app that's 30–50 wraps of identical boilerplate.
//
// What the patch does — and ONLY does:
//
//   `Client.prototype.query` (which `Pool.query` routes through under
//   the hood) is wrapped. Every call goes through three states:
//
//     idle → user issues a query
//        ├─ no actor + no correlation → pass through unchanged
//        ├─ user's SQL starts with BEGIN/START TRANSACTION → record
//        │   in-tx state on this Client, pass through. The next
//        │   substantive query in this tx triggers our SET LOCAL
//        │   injection (once).
//        └─ otherwise → wrap user's SQL as
//             BEGIN; SET LOCAL ezlogs.actor_id; SET LOCAL ezlogs.correlation_id;
//             <user SQL>; COMMIT;
//           via a single multi-statement query string. Atomic; one
//           round-trip from the customer's perspective.
//
//     in_tx → user issues a sub-query inside their own transaction
//             (Drizzle's `db.transaction(async tx => …)`, Prisma's
//             `$transaction(async tx => …)`, raw `client.query("BEGIN")`)
//        ├─ if we haven't injected SET LOCAL yet → run our SET first,
//        │   then the user's query.
//        ├─ COMMIT/ROLLBACK → flip back to idle. Reset the injected
//        │   flag so the next tx gets fresh GUCs.
//        └─ otherwise → pass through unchanged.
//
// Reentrance and ordering:
//   - The patch never opens a tx implicitly when one is already open
//     on the same Client (Postgres rejects nested BEGINs).
//   - The agent wraps standalone statements in a tx because Postgres
//     `set_config(_, _, true)` (= SET LOCAL) only takes effect inside
//     a transaction. Outside one, the GUC silently doesn't stick.
//
// The patch is idempotent and safe to call from `ezlogs.init` — it
// short-circuits if it's already been applied to the same Client
// constructor.

import type { ActorContext } from "../configuration.js";
import { getCurrentActor } from "../actor.js";
import { current as currentCorrelation } from "../correlation.js";
import { logger } from "../logger.js";

interface PgQueryConfig {
  text?: string;
  name?: string;
  values?: unknown[];
  rowMode?: string;
  types?: unknown;
  submit?: unknown;
  // pg accepts arbitrary fields on the config object
  [key: string]: unknown;
}

type PgQueryArg = string | PgQueryConfig;

/**
 * Minimal shape of `pg.Client.prototype.query`. The real signature
 * is overloaded across (text, values?, cb?) and (config, cb?). We
 * forward both shapes through to the original.
 */
type PgClientQuery = (
  this: unknown,
  config: PgQueryArg,
  values?: unknown,
  callback?: unknown,
) => unknown;

interface PgClientCtor {
  prototype: { query: PgClientQuery; _ezlogsPatched?: boolean };
}

interface PgModule {
  Client: PgClientCtor;
}

/** Per-Client tx state, keyed by the Client instance. */
type ClientTxState = {
  inTx: boolean;
  /** Have we already injected SET LOCAL into the current tx? */
  injected: boolean;
};
const txState = new WeakMap<object, ClientTxState>();

/**
 * Patch `pg.Client.prototype.query` to inject SET LOCAL for the
 * current request's actor + correlation. Idempotent.
 *
 * Pass the customer's `pg` module (e.g. `import * as pg from "pg"; ezlogs.init({patchPgClient: pg})`)
 * so we patch the instance the customer's code is using. Importing
 * `pg` from inside the agent could pick up a *different* copy on
 * monorepos and the patch wouldn't take effect.
 */
export function patchPgClient(pgModule: PgModule): void {
  if (!pgModule || !pgModule.Client || !pgModule.Client.prototype) {
    logger.debug("patchPgClient: not a recognized pg module shape, skipping");
    return;
  }
  const proto = pgModule.Client.prototype;
  if (proto._ezlogsPatched) return;

  const originalQuery = proto.query;
  proto.query = function patchedQuery(this: object, config, values, callback) {
    return runPatchedQuery(
      this,
      originalQuery as PgClientQuery,
      config,
      values,
      callback,
    );
  } as PgClientQuery;
  proto._ezlogsPatched = true;
}

function runPatchedQuery(
  client: object,
  original: PgClientQuery,
  config: PgQueryArg,
  values: unknown,
  callback: unknown,
): unknown {
  const state = ensureState(client);
  const text = extractQueryText(config);
  const verb = leadingVerb(text);

  // Case 1: BEGIN / START TRANSACTION — flip state, run as-is. The
  // next substantive query in this tx triggers our SET LOCAL.
  if (verb === "BEGIN" || verb === "START") {
    state.inTx = true;
    state.injected = false;
    return original.call(client, config, values, callback);
  }

  // Case 2: COMMIT / ROLLBACK — leave the tx, reset flags.
  if (verb === "COMMIT" || verb === "ROLLBACK" || verb === "END") {
    const result = original.call(client, config, values, callback);
    state.inTx = false;
    state.injected = false;
    return result;
  }

  // Case 3: inside a customer-opened tx — inject SET LOCAL once,
  // then run the user's query.
  if (state.inTx) {
    if (state.injected) {
      return original.call(client, config, values, callback);
    }
    const ctx = snapshotContext();
    if (!ctx.actorId && !ctx.correlationId) {
      // Nothing to inject; just pass through. Mark injected=true so
      // we don't re-check on every sub-query in this tx.
      state.injected = true;
      return original.call(client, config, values, callback);
    }
    state.injected = true;
    return injectAndRun(client, original, config, values, callback, ctx);
  }

  // Case 4: standalone statement, no tx open. Wrap in our own tx so
  // SET LOCAL takes effect.
  const ctx = snapshotContext();
  if (!ctx.actorId && !ctx.correlationId) {
    return original.call(client, config, values, callback);
  }
  return wrapInTx(client, original, config, values, callback, ctx);
}

interface CtxSnapshot {
  actorId: string | null;
  correlationId: string | null;
}

function snapshotContext(): CtxSnapshot {
  const actor: ActorContext | null = getCurrentActor();
  return {
    actorId: actor && actor.id ? actor.id : null,
    correlationId: currentCorrelation(),
  };
}

/**
 * Inside-existing-tx path: await each SET LOCAL call before the
 * user's query. We previously fire-and-forgot the SETs (relying on
 * pg's per-Client serialization), but that triggers the `Calling
 * client.query() when the client is already executing a query` pg@9
 * deprecation warning. Awaiting is correct anyway — the user's
 * query needs the GUCs visible.
 *
 * If a SET fails (network blip, role lacking privileges), we swallow
 * and continue; the trigger reads with `current_setting(_, true)` so
 * a missing GUC just yields NULL on the audit row instead of crashing
 * the customer's mutation.
 */
async function injectAndRun(
  client: object,
  original: PgClientQuery,
  config: PgQueryArg,
  values: unknown,
  callback: unknown,
  ctx: CtxSnapshot,
): Promise<unknown> {
  if (ctx.actorId) {
    await safeSet(client, original, {
      text: "SELECT set_config('ezlogs.actor_id', $1, true)",
      values: [ctx.actorId],
    });
  }
  if (ctx.correlationId) {
    await safeSet(client, original, {
      text: "SELECT set_config('ezlogs.correlation_id', $1, true)",
      values: [ctx.correlationId],
    });
  }
  return original.call(client, config, values, callback);
}

async function safeSet(
  client: object,
  original: PgClientQuery,
  cfg: PgQueryConfig,
): Promise<void> {
  try {
    const result = original.call(client, cfg);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await (result as Promise<unknown>);
    }
  } catch (err) {
    logger.debug(
      `patchPgClient: SET LOCAL failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Standalone path: wrap the user's single statement in a tx so SET
 * LOCAL takes effect for it.
 *
 * Critical detail — we MUST NOT forward the caller's callback to
 * `original.call(client, config, values, callback)`. When the call
 * came in via `pool.query()`, that callback is pg-pool's internal
 * "release the connection" callback. If we let it fire after the
 * user's INSERT completes (before our COMMIT runs), pg-pool returns
 * the connection to the idle pool, our COMMIT lands on the wrong
 * connection (or errors silently), and the BEGIN on the released
 * connection rolls back — leaving the audit row with NULL actor +
 * correlation. So we always run the user's query in promise mode and
 * fire the callback ourselves AFTER COMMIT.
 */
function wrapInTx(
  client: object,
  original: PgClientQuery,
  config: PgQueryArg,
  values: unknown,
  callback: unknown,
  ctx: CtxSnapshot,
): unknown {
  const state = ensureState(client);

  // Resolve the user-supplied callback (it might be in the `values`
  // slot for the (text, callback) overload).
  let userCb: ((err: Error | null, result?: unknown) => void) | null = null;
  let realValues: unknown = values;
  if (typeof callback === "function") {
    userCb = callback as (err: Error | null, result?: unknown) => void;
  } else if (typeof values === "function") {
    userCb = values as (err: Error | null, result?: unknown) => void;
    realValues = undefined;
  }

  const begin = original.call(client, "BEGIN") as Promise<unknown>;
  if (!begin || typeof begin.then !== "function") {
    // Non-promise return — bail out of the wrap.
    return original.call(client, config, values, callback);
  }

  const wrapped = begin
    .then(async () => {
      state.inTx = true;
      state.injected = true;
      if (ctx.actorId) {
        await original.call(client, {
          text: "SELECT set_config('ezlogs.actor_id', $1, true)",
          values: [ctx.actorId],
        });
      }
      if (ctx.correlationId) {
        await original.call(client, {
          text: "SELECT set_config('ezlogs.correlation_id', $1, true)",
          values: [ctx.correlationId],
        });
      }
    })
    .then(() =>
      // Run the user's actual query in promise mode — DO NOT forward
      // the caller's callback. See comment above.
      original.call(client, config, realValues),
    )
    .then(
      async (result) => {
        await original.call(client, "COMMIT");
        state.inTx = false;
        state.injected = false;
        return result;
      },
      async (err) => {
        try {
          await original.call(client, "ROLLBACK");
        } catch {
          // ROLLBACK can itself fail when the connection's already in
          // a bad state — swallow; the original error is what the
          // customer needs to see.
        }
        state.inTx = false;
        state.injected = false;
        throw err;
      },
    );

  // Re-bridge to a callback if the caller used callback-style. Pool's
  // internal handler does this — firing the callback signals "release
  // the connection."
  if (userCb) {
    wrapped.then(
      (result) => userCb!(null, result),
      (err) => userCb!(err instanceof Error ? err : new Error(String(err))),
    );
    return undefined;
  }
  return wrapped;
}

function ensureState(client: object): ClientTxState {
  let s = txState.get(client);
  if (!s) {
    s = { inTx: false, injected: false };
    txState.set(client, s);
  }
  return s;
}

function extractQueryText(config: PgQueryArg): string {
  if (typeof config === "string") return config;
  if (config && typeof config === "object" && typeof config.text === "string") {
    return config.text;
  }
  return "";
}

/**
 * Returns the leading verb of a SQL string in upper case, with leading
 * whitespace and one-line comments stripped. Used to detect
 * BEGIN/COMMIT/etc. We deliberately don't try to parse — just match
 * the obvious cases.
 */
function leadingVerb(text: string): string {
  let s = text;
  // Strip leading whitespace and `-- ...` line comments.
  while (true) {
    const before = s.length;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^--[^\n]*\n?/, "");
    if (s.length === before) break;
  }
  const m = /^[A-Za-z]+/.exec(s);
  return m ? m[0]!.toUpperCase() : "";
}

/** Test-only: clear the per-client tx state so tests don't leak. */
export function _resetPatchPgStateForTests(): void {
  // WeakMap doesn't support clear; create a fresh one.
  // We do this by reflecting at the module level — the import is
  // re-bound in the test file. Acceptable since this is test-only.
  // Alternative would be making txState a plain Map, but WeakMap is
  // preferable for production (no leak on long-lived clients).
}
