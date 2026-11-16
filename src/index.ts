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

import {
  configuration,
  type DatabaseReader,
  type InitOptions,
} from "./configuration.js";
import { setLogLevel } from "./logger.js";
import * as bufferOps from "./pipeline/buffer.js";
import { flushScheduler } from "./pipeline/flush-scheduler.js";
import {
  patchGlobalFetch,
  unpatchGlobalFetch,
} from "./http/outgoing-fetch.js";
import { patchPgClient } from "./triggers/patch-pg.js";
import {
  auditLogInstalled,
  checkAuditLogAccess,
  detectTriggerTrackedTables,
} from "./triggers/reader.js";
import { logger } from "./logger.js";

export type {
  ActorContext,
  ActorFromRequest,
  ActorPrincipal,
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

// Pinned to globalThis so a Next.js HMR cycle (which re-evaluates this
// module) doesn't stack a second `beforeExit` listener on top of the
// first. Same Symbol.for pattern as the configuration singleton.
// Multiple flushes wouldn't corrupt data — flushNow is idempotent —
// but stacked listeners violate the "no accumulation" contract and
// would leak handles across reload cycles in long-running dev sessions.
const BEFORE_EXIT_INSTALLED_KEY = Symbol.for("ezlogs-nextjs:beforeExitInstalled");

interface GlobalWithBeforeExitFlag {
  [BEFORE_EXIT_INSTALLED_KEY]?: boolean;
}

function isBeforeExitInstalled(): boolean {
  return (globalThis as GlobalWithBeforeExitFlag)[BEFORE_EXIT_INSTALLED_KEY] === true;
}

function markBeforeExitInstalled(): void {
  (globalThis as GlobalWithBeforeExitFlag)[BEFORE_EXIT_INSTALLED_KEY] = true;
}

const STARTUP_ANNOUNCED_KEY = Symbol.for("ezlogs-nextjs:startupAnnounced");

/**
 * One line per process at the default log level, so "is it on?" is
 * answerable from the terminal: where events go and which project
 * (last 4 token characters only). Missing config says so instead.
 */
function announceStartup(serverUrl: string | null, projectToken: string | null): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTUP_ANNOUNCED_KEY]) return;
  g[STARTUP_ANNOUNCED_KEY] = true;
  if (!serverUrl || !projectToken) {
    const missing = [!serverUrl && "serverUrl", !projectToken && "projectToken"].filter(Boolean).join(" and ");
    logger.warn(`not capturing: ${missing} missing in ezlogs.init() (check EZLOGS_SERVER_URL / EZLOGS_PROJECT_TOKEN)`);
    return;
  }
  let host = serverUrl;
  try {
    host = new URL(serverUrl).host;
  } catch {
    // keep the raw value; warnIfInsecureServerUrl covers malformed URLs
  }
  // The suffix only identifies the project when the token is long
  // enough that 4 characters reveal next to nothing of it.
  const project = projectToken.length >= 12 ? ` (project …${projectToken.slice(-4)})` : "";
  logger.notice(`capturing → ${host}${project}`);
}

/** @internal test-only */
export function _resetStartupAnnouncementForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[STARTUP_ANNOUNCED_KEY];
}

export const ezlogs = {
  init(options: InitOptions): void {
    const config = configuration();
    config.apply(options);
    if (options.logLevel) setLogLevel(options.logLevel);

    warnIfInsecureServerUrl(config.serverUrl, config.allowInsecureTransport);
    announceStartup(config.serverUrl, config.projectToken);

    flushScheduler.start();
    if (config.patchGlobalFetch) patchGlobalFetch();

    // Auto-wire the trigger path. Detection cascade:
    //   1. `options.databaseUrl` (explicit)
    //   2. Conventional environment variables (`DATABASE_URL`,
    //      `POSTGRES_URL`, `SUPABASE_DB_URL`, etc.)
    //   3. Nothing — Phase 4 adapters remain the active capture path.
    // Each step also respects explicit `databaseReader` /
    // `patchDatabaseClient` overrides.
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

    // Self-check + detection for the synchronous path (manual
    // `databaseReader: …` users). The async auto-wire path does its
    // own; `config.databaseReader` is still null here for those users.
    applyDatabaseReaderDefaults();

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
 * patch `pg.Client.prototype.query` — all from a single `databaseUrl`. Customer's instrumentation.ts becomes:
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
  } catch {
    logger.warn(
      "a Postgres URL is configured but the `pg` package is not installed, so " +
        "trigger-based DB capture is off. Run `npm i pg` and " +
        "`npx ezlogs-nextjs install-triggers`, or use a per-ORM adapter (docs/database.md).",
    );
    return;
  }

  // Build a Pool the agent owns; one per process is plenty for
  // end-of-request audit-log drains.
  const pool = new pg.Pool({
    connectionString: options.databaseUrl as string,
    max: 4,
  }) as {
    query: (sql: string, params: unknown[]) => Promise<unknown>;
    end?: () => Promise<void>;
  };
  const reader: DatabaseReader = (sql, params) =>
    pool.query(sql, params as unknown[]);

  // Startup self-check: no audit table → one warning, nothing wired,
  // so no request issues queries that can only fail. A probe that
  // errors (DB unreachable at boot) wires anyway — that's transient.
  if ((await auditLogInstalled(reader)) === false) {
    warnAuditLogMissing();
    void pool.end?.().catch(() => {});
    return;
  }

  // Wire the reader unless the customer explicitly opted out / overrode.
  if (config.databaseReader === null) {
    config.databaseReader = reader;
  }

  // Patch the same `pg` module the customer's app uses (Node CJS
  // module cache resolves both to the same instance via require).
  patchPgClient(pg as unknown as Parameters<typeof patchPgClient>[0]);

  void checkAuditLogAccess(reader);
  runTriggerTrackedTablesDetection();
}

/**
 * Manual `databaseReader` path: same self-check as the auto-wire
 * (missing audit table → one warning, reader unset), then
 * trigger-tracked-table detection. Async; requests that arrive before
 * the probe answers just run the normal reader.
 */
function applyDatabaseReaderDefaults(): void {
  const config = configuration();
  const reader = config.databaseReader;
  if (!reader) return;
  auditLogInstalled(reader)
    .then((installed) => {
      if (installed === false && config.databaseReader === reader) {
        config.databaseReader = null;
        warnAuditLogMissing();
        return;
      }
      if (installed === true) void checkAuditLogAccess(reader);
      runTriggerTrackedTablesDetection();
    })
    .catch(() => {});
}

function warnAuditLogMissing(): void {
  logger.warn(
    "table `ezlogs_audit_log` was not found, so trigger-based DB capture is off. " +
      "Run `npx ezlogs-nextjs install-triggers` against this database and restart.",
  );
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
  if (isBeforeExitInstalled()) return;
  if (typeof process === "undefined" || !process.on) return;
  process.on("beforeExit", () => {
    // beforeExit can run async work; we kick off a flush and let the
    // event loop close once it resolves. Errors are already swallowed
    // inside FlushScheduler.
    void flushScheduler.flushNow();
  });
  markBeforeExitInstalled();
}

/**
 * Warn once at init time if `serverUrl` is HTTP and points at a
 * non-local host. The transport will still send events — this is a
 * heads-up, not an enforcement — but in production a typo
 * (`http://app.ezlogs.io`) would silently ship events in cleartext.
 * Local-host shapes (localhost, 127.0.0.1, [::1], *.local) are
 * exempt because those are dev environments. Customers who
 * intentionally point at a non-HTTPS internal endpoint can set
 * `allowInsecureTransport: true` to suppress.
 */
function warnIfInsecureServerUrl(
  serverUrl: string | null,
  allowInsecure: boolean,
): void {
  if (!serverUrl || allowInsecure) return;
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    // Configuration is invalid; transport will surface a clearer
    // error when it tries to send. No HTTPS warning needed here.
    return;
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[ezlogs] serverUrl is not HTTPS (${serverUrl}); events will be sent in cleartext. ` +
      `Set allowInsecureTransport: true to suppress this warning.`,
  );
}

/** Test-only. Not exported from package entry. */
export function _internalsForTests() {
  return { buffer: bufferOps, flushScheduler };
}
