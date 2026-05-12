/**
 * ezlogs-nextjs — public entry point.
 *
 * `ezlogs.init()` configures the agent and starts the periodic flush
 * scheduler. `ezlogs.flush()` drains the in-memory buffer and ships
 * synchronously — call this before serverless handlers return.
 *
 * Capture surfaces (HTTP, DB, jobs) attach themselves via subpath
 * imports (`ezlogs-nextjs/prisma`, etc.). The core entry point only
 * runs the pipeline.
 */

import { configuration, type InitOptions } from "./configuration.js";
import { setLogLevel } from "./logger.js";
import * as bufferOps from "./pipeline/buffer.js";
import { flushScheduler } from "./pipeline/flush-scheduler.js";
import {
  patchGlobalFetch,
  unpatchGlobalFetch,
} from "./http/outgoing-fetch.js";
import { patchPgClient } from "./triggers/patch-pg.js";
import { detectTriggerTrackedTables } from "./triggers/reader.js";
import { logger } from "./logger.js";

export type {
  ActorContext,
  ActorFromRequest,
  DisplayNameMap,
  InitOptions,
} from "./configuration.js";
export type {
  BuildInput,
  Event,
  Outcome,
  ResourceId,
  SourceType,
} from "./event-builder.js";
export { build as buildEvent, ArgError } from "./event-builder.js";

// HTTP capture entry points
export {
  captureRoute,
  capturePagesApi,
  captureServerAction,
  captureServerActionExport,
  __ezlogs_run_inline_server_action,
  withMiddlewareCapture,
  captureHttpEvent,
} from "./http/capture.js";

let initialized = false;
let beforeExitInstalled = false;

export const ezlogs = {
  init(options: InitOptions): void {
    const config = configuration();
    config.apply(options);
    if (options.logLevel) setLogLevel(options.logLevel);

    flushScheduler.start();
    if (config.patchGlobalFetch) patchGlobalFetch();

    // Auto-wire the trigger path. Detection cascade:
    //   1. `options.databaseUrl` (explicit)
    //   2. Conventional environment variables (`DATABASE_URL`,
    //      `POSTGRES_URL`, `SUPABASE_DB_URL`, etc.)
    //   3. Nothing — Phase 4 adapters remain the active capture path.
    // Each step also respects explicit `databaseReader` /
    // `patchDatabaseClient` / `databaseSnapshotMode` overrides.
    const resolvedDbUrl =
      options.databaseUrl ?? detectDatabaseUrlFromEnv();
    if (resolvedDbUrl && !options.databaseReader) {
      autoWireTriggerPathFromDatabaseUrl(
        { ...options, databaseUrl: resolvedDbUrl },
      ).catch((err: unknown) => {
        // Never throw out of init — degrade silently to "no trigger
        // path." The Phase 4 adapters keep working as a fallback.
        // Logged at debug for diagnosability.
        // eslint-disable-next-line no-console
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[ezlogs] auto-wire from databaseUrl failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    } else if (options.patchDatabaseClient) {
      // Customer chose the manual route — pass them through to the
      // patcher with their own pg module reference.
      patchPgClient(
        options.patchDatabaseClient as Parameters<typeof patchPgClient>[0],
      );
    }

    // Apply post-`databaseReader` defaults for the synchronous path
    // (manual `databaseReader: …` users). The async auto-wire path
    // calls `applyDatabaseReaderDefaults` itself once it has the pool
    // wired, since at this point `config.databaseReader` is still null
    // for those users.
    applyDatabaseReaderDefaults(options);

    installBeforeExitHook();
    initialized = true;
  },

  /**
   * Drain the buffer and ship its contents now. Always call this before
   * a serverless handler returns — Vercel/Lambda will freeze the
   * process and the periodic flush timer will never fire.
   */
  async flush(): Promise<void> {
    if (!initialized) return;
    await flushScheduler.flushNow();
  },

  /** Stop the periodic scheduler and flush remaining events. */
  async shutdown(): Promise<void> {
    if (!initialized) return;
    await flushScheduler.stop();
    unpatchGlobalFetch();
    initialized = false;
  },
};

/**
 * Conventional Postgres connection-string env vars used across the
 * Next.js ecosystem. Order matters — the first match wins:
 *
 *   - `DATABASE_URL`             — Prisma's documented default,
 *                                  Drizzle starter convention,
 *                                  generic Node convention
 *   - `POSTGRES_URL`             — Vercel Postgres / Neon (legacy),
 *                                  next-saas-starter convention
 *   - `POSTGRES_PRISMA_URL`      — Vercel + Prisma's pooled URL
 *   - `POSTGRES_URL_NON_POOLING` — Vercel + Prisma's direct URL
 *   - `DIRECT_URL`               — Supabase + Prisma direct URL
 *   - `SUPABASE_DB_URL`          — explicit Supabase Postgres URL
 *
 * The agent uses the first non-empty value. Customers who run on
 * something exotic can still pass `databaseUrl` explicitly.
 *
 * Validates the shape with a `postgres://`/`postgresql://` prefix so
 * we don't accidentally use a non-Postgres URL stashed in one of
 * these names.
 */
export function _detectDatabaseUrlFromEnvForTests(): string | null {
  return detectDatabaseUrlFromEnv();
}

function detectDatabaseUrlFromEnv(): string | null {
  if (typeof process === "undefined" || !process.env) return null;
  // Conventional connection-string env var names used across the
  // Next.js + Postgres ecosystem. Every framework (Prisma, Drizzle,
  // Vercel Postgres, Supabase, Neon) documents at least one of these.
  // Customers on something exotic pass `databaseUrl` to init()
  // explicitly. We deliberately don't try to synthesize URLs from
  // partial signals (host + assumed-default password etc.) — that
  // road leads to vendor-specific magic that only works for one
  // product's defaults, which violates the "generic" contract.
  const candidates = [
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "DIRECT_URL",
    "SUPABASE_DB_URL",
  ];
  for (const name of candidates) {
    const value = process.env[name];
    if (typeof value === "string" && /^postgres(?:ql)?:\/\//i.test(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Lazy-import `pg`, construct a Pool, wire it as the audit reader,
 * patch `pg.Client.prototype.query`, and enable snapshot mode — all
 * from a single `databaseUrl`. Customer's instrumentation.ts becomes:
 *
 *     ezlogs.init({ serverUrl, projectToken, databaseUrl });
 *
 * No `pg` import in the customer's code. No Pool construction. No
 * pool/client wiring. No per-action wrap. This is the v1 install
 * promise: API key + URL + DB URL, agent does the rest.
 *
 * `pg` must be installed in the customer's project. Drizzle (node-pg)
 * and Prisma w/ adapter-pg both pull it in transitively. For projects
 * without it, this auto-wire silently no-ops and the per-ORM Phase 4
 * adapters keep handling capture.
 */
async function autoWireTriggerPathFromDatabaseUrl(
  options: InitOptions,
): Promise<void> {
  const config = configuration();
  let pg: { Pool: new (cfg: { connectionString: string; max?: number }) => unknown; Client: { prototype: { query: unknown } } };
  try {
    // `pg` is an optional peer dep — must not appear as a static
    // import in the agent's compiled bundle, or Next/Turbopack would
    // try to resolve it at build time and fail when the customer
    // doesn't use Postgres. The Function() wrapper hides the import
    // from static analysis; Node resolves it at runtime via the
    // customer's own module graph.
    const dynImport = new Function(
      "s",
      "return import(s)",
    ) as (s: string) => Promise<unknown>;
    pg = (await dynImport("pg")) as unknown as typeof pg;
  } catch (err) {
    // No pg installed (or import failed) — nothing to wire.
    // Per-ORM adapters remain the active capture path.
    return;
  }

  // Build a Pool the agent owns; one per process is plenty for
  // end-of-request audit-log drains.
  const pool = new pg.Pool({
    connectionString: options.databaseUrl as string,
    max: 4,
  }) as { query: (sql: string, params: unknown[]) => Promise<unknown> };

  // Wire the reader unless the customer explicitly opted out / overrode.
  if (config.databaseReader === null) {
    config.databaseReader = (sql, params) => pool.query(sql, params as unknown[]);
  }

  // Patch the same `pg` module the customer's app uses (Node CJS
  // module cache resolves both to the same instance via require).
  patchPgClient(pg as unknown as Parameters<typeof patchPgClient>[0]);

  // Now that `databaseReader` is set, apply the same defaults the
  // synchronous (manual-reader) path applies in `init()`.
  applyDatabaseReaderDefaults(options);
}

/**
 * Defaults that depend on `databaseReader` being set. Called from
 * both the synchronous manual-reader path (in `init()`) and the
 * async auto-wire path (`autoWireTriggerPathFromDatabaseUrl`) once
 * each respectively has populated `config.databaseReader`.
 *
 * Two rules:
 *
 *   1. Snapshot mode (default `true` when `databaseReader` is wired).
 *      Catches audit rows with NULL `correlation_id` — i.e. writes
 *      from drivers we can't `SET LOCAL`-patch (postgres.js, neon
 *      serverless, planetscale-serverless, supabase-js / PostgREST).
 *      Without it, those rows sit in `ezlogs_audit_log` forever
 *      because the reader's WHERE clause is `correlation_id = $1`.
 *      Cost: one cheap `SELECT MAX(id)` per request. Customers on
 *      pure `pg` can opt out with `databaseSnapshotMode: false`.
 *
 *   2. Trigger-tracked-table detection. Populates the Set the per-ORM
 *      adapter gate consults to decide if its emit is redundant
 *      (trigger reader will surface it) or needed (table not tracked
 *      → adapter is the only path).
 *
 * Idempotent: re-callable, defaults only applied when not already set.
 */
function applyDatabaseReaderDefaults(options: InitOptions): void {
  const config = configuration();
  if (!config.databaseReader) return;
  if (options.databaseSnapshotMode === undefined) {
    config.databaseSnapshotMode = true;
  }
  runTriggerTrackedTablesDetection();
}

/**
 * One-time detection of which tables `ezlogs_track('...')` has been
 * run on. Populates `config.triggerTrackedTables` so the per-ORM
 * adapter gate in `emitDbEvent` can decide per-write whether its emit
 * is redundant (table is trigger-tracked, audit reader will surface
 * it) or needed (table is not tracked — adapter is the only path).
 *
 * Without this lookup, a `databaseReader`-wired app silently drops
 * writes to any table the customer hasn't tracked yet — a sharp edge
 * for the "agent captures every write" promise.
 *
 * Fires regardless of how `databaseReader` got set (auto-wire from
 * `databaseUrl`, explicit `databaseReader: …`, etc.). No-ops when
 * `databaseReader` is unset (per-ORM adapters are the active path
 * with no gate to apply) or when detection has already run.
 */
function runTriggerTrackedTablesDetection(): void {
  const config = configuration();
  if (!config.databaseReader) return;
  if (config.triggerTrackedTables !== null) return;

  detectTriggerTrackedTables(config.databaseReader)
    .then((tables) => {
      if (tables === null) {
        logger.debug(
          "[ezlogs] trigger-tracked-table detection failed; falling back " +
            "to suppress-all on `databaseReader` paths. Untracked tables " +
            "will not appear in the dashboard until detection succeeds " +
            "or the table is added with `SELECT ezlogs_track('table_name')`.",
        );
        return;
      }
      config.triggerTrackedTables = tables;
      logger.debug(
        `[ezlogs] trigger-tracked tables: ${
          tables.size === 0 ? "(none)" : Array.from(tables).sort().join(", ")
        }`,
      );
    })
    .catch(() => {
      // Already swallowed inside detect…; this catch is just to
      // satisfy promise-rejection rules in the calling scope.
    });
}

function installBeforeExitHook(): void {
  if (beforeExitInstalled) return;
  if (typeof process === "undefined" || !process.on) return;
  process.on("beforeExit", () => {
    // beforeExit can run async work; we kick off a flush and let the
    // event loop close once it resolves. Errors are already swallowed
    // inside FlushScheduler.
    void flushScheduler.flushNow();
  });
  beforeExitInstalled = true;
}

/** Test-only. Not exported from package entry. */
export function _internalsForTests() {
  return { buffer: bufferOps, flushScheduler };
}
