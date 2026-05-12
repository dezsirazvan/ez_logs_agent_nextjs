/**
 * Configuration mirrors EzLogsAgent::Configuration.
 *
 * Defaults match Ruby exactly. User-supplied excluded* arrays are MERGED with
 * the DEFAULT_* constants via the `all*` getters — same semantics as
 * Ruby's `all_excluded_paths`, `all_excluded_tables`, etc.
 *
 * Public surface is intentionally narrow. Anything not in InitOptions is
 * not configurable.
 */

import type { LogLevel } from "./logger.js";

export interface ActorContext {
  /** Stable identifier for the user (e.g. `user.id`). REQUIRED. */
  id: string;
  /** Human-readable label (e.g. `user.email`). Optional. */
  label?: string;
}

/**
 * Minimal request-shape contract for `actorFromRequest`. We don't import
 * Next.js types here to keep the package framework-light; users pass
 * whatever request object they're given by the runtime.
 *
 * The hook may return a value or a Promise — Phase 4 actor extractors
 * (Clerk, NextAuth, Auth.js) are async because they call into the
 * framework's auth helpers, which lazy-import the SDK.
 */
export type ActorFromRequest = (
  request: unknown,
) =>
  | ActorContext
  | null
  | undefined
  | Promise<ActorContext | null | undefined>;

/**
 * Resolver for a display name. Either:
 *   - a column name on the row (e.g. "name"), or
 *   - a function that returns a string from the row (e.g.
 *     `(row) => \`${row.first_name} ${row.last_name}\``).
 *
 * Functions let users compose names from multiple columns when no
 * single field is sufficient. Resolver functions are invoked inside a
 * try/catch — a thrown resolver collapses to "no display name" so a
 * buggy resolver can never crash the host application.
 */
export type DisplayNameResolver =
  | string
  | ((row: Record<string, unknown>) => string | null | undefined);

/**
 * Maps a model class name → resolver used to derive the human-readable
 * display value, mirroring Ruby's `display_name_for`.
 */
export type DisplayNameMap = Record<string, DisplayNameResolver>;

/**
 * Classifier for Server Action failure return values.
 *
 * Many Next.js codebases (next-safe-action templates, the
 * Vercel App Router examples, tRPC) catch errors inside the action and
 * return `{ success: false, error: "..." }` instead of throwing. The
 * HTTP response is 200, so the agent can't tell the action failed
 * without inspecting the return value.
 *
 * If this classifier returns true the event is recorded as a failure
 * with the supplied `errorMessage`. A thrown classifier or one that
 * returns undefined is treated as "no opinion" — the default heuristic
 * (`{ success: false, error: <truthy string> }`) still applies.
 *
 * @param result the value the Server Action returned
 * @returns true / failure descriptor when the result represents a
 *   failure, false / undefined otherwise
 */
export type ServerActionErrorClassifier = (
  result: unknown,
) => boolean | { errorMessage: string } | null | undefined;

export interface InitOptions {
  /** Defaults to `https://app.ezlogs.io` (the hosted EZLogs service). Override for self-hosting. */
  serverUrl?: string;
  projectToken: string;
  captureHttp?: boolean;
  captureDb?: boolean;
  captureJobs?: boolean;
  bufferSize?: number;
  /** Send interval in milliseconds. Ruby uses seconds (3); Node uses ms (3000). */
  sendInterval?: number;
  retryAttempts?: number;
  excludedPaths?: string[];
  excludedTables?: string[];
  excludedJobClasses?: string[];
  excludedGraphqlOperations?: string[];
  excludedGraphqlVariableKeys?: string[];
  actorFromRequest?: ActorFromRequest;
  displayNameFor?: DisplayNameMap;
  /**
   * Detect when a Server Action's return value represents a failure.
   * See {@link ServerActionErrorClassifier}. The default heuristic
   * (`{ success: false, error: <string> }`) runs in addition to any
   * classifier you supply.
   */
  isServerActionError?: ServerActionErrorClassifier;
  /** Patch globalThis.fetch to inject X-Correlation-ID. Default true. */
  patchGlobalFetch?: boolean;
  /**
   * When true (default), the HTTP capturer extracts the current actor
   * from the most-recently-constructed Supabase client by calling
   * `.auth.getUser()` once per request. Use the actorFromRequest hook
   * to override or disable. Set to false to skip the extra auth call
   * when you don't use Supabase or want a custom actor source only.
   */
  actorFromSupabase?: boolean;
  /**
   * Trigger-based DB capture path. When set, the HTTP capturers flush
   * `ezlogs_audit_log` rows tagged with the current correlation_id at
   * the end of each request and emit them as `database_callback`
   * events. Run `npx @ezlogs/nextjs install-triggers` once per
   * database to set up the audit table + trigger function, then
   * either:
   *   - set this option to a function that runs a single SQL
   *     statement (e.g. `(sql, params) => pg.query(sql, params)`),
   *   - or wrap your mutations in `withDatabaseContext(client, cb)`
   *     so the trigger sees the actor + correlation GUCs.
   *
   * `params` is positional Postgres-style (`$1`, `$2`). The result
   * shape can be `{ rows: [...] }` (pg) or a bare array (drizzle's
   * `db.execute`). The agent never inspects the return value.
   */
  databaseReader?: DatabaseReader;
  /**
   * If supplied, the agent monkey-patches `pgModule.Client.prototype.query`
   * at init so every `client.query(...)` (and therefore `pool.query(...)`,
   * which routes through the same Client method) auto-injects
   * `SET LOCAL ezlogs.actor_id` / `ezlogs.correlation_id` for the
   * current request. Without this you'd have to wrap each customer
   * mutation with `getDatabaseContext()` + manual SET statements.
   *
   * Pass the customer's own `pg` import — NOT the agent's — so the
   * patch lands on the same Client class their app code uses (in a
   * monorepo there can be multiple copies of pg).
   *
   *   import * as pg from "pg";
   *   ezlogs.init({ patchDatabaseClient: pg, databaseReader: ... });
   *
   * Idempotent. The shape is `unknown` so we don't import `pg` types
   * in the configuration module — the actual structural check lives
   * in `patchPgClient`.
   */
  patchDatabaseClient?: unknown;
  /**
   * Time-window fallback for stacks where SET LOCAL can't propagate
   * (supabase-js, PostgREST, anything that auto-commits per request
   * and doesn't expose explicit transactions). When true, the agent
   * runs `SELECT MAX(id) FROM ezlogs_audit_log` at the start of every
   * request and remembers the value. At end of request the reader
   * drains rows whose `correlation_id` matches OR (`correlation_id`
   * is NULL and `id` is greater than the snapshot) — i.e. rows the
   * trigger fired during this request even though the customer's
   * client couldn't tag them.
   *
   * Default false. Enable for supabase-js apps. Adds one cheap
   * `SELECT MAX(id)` per request. See AGENT_PARITY_NOTES.md for the
   * concurrency caveat (concurrent same-actor mutations may blur).
   */
  databaseSnapshotMode?: boolean;
  /**
   * One-line install for the trigger-based capture. Pass your Postgres
   * connection string; the agent does the rest:
   *   1. Lazy-imports `pg` and constructs a Pool (4 connections, max).
   *      `pg` must be in your project's dependencies — the agent will
   *      log a debug message and skip the trigger path if it's missing.
   *   2. Wires that Pool as `databaseReader` for the audit-log drain.
   *   3. Patches `pg.Client.prototype.query` so every customer query
   *      auto-injects SET LOCAL. Drizzle (node-postgres) and Prisma
   *      (`@prisma/adapter-pg`) both run on `pg` and inherit zero-touch
   *      capture without any extra wiring on the customer's side.
   *   4. Enables `databaseSnapshotMode` — the time-window fallback
   *      that catches supabase-js / PostgREST writes whose audit row
   *      didn't get our SET LOCAL.
   *
   * Customers who want to override individual pieces can still pass
   * `databaseReader` / `patchDatabaseClient` / `databaseSnapshotMode`
   * directly; explicit values win over the auto-wired pieces.
   */
  databaseUrl?: string;
  logLevel?: LogLevel;
}

/**
 * SQL executor for the trigger-based capture path. See `databaseReader`
 * on {@link InitOptions}.
 */
export type DatabaseReader = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<unknown>;

/**
 * Default-excluded path pattern. Either a plain path glob (excludes
 * all methods on that path) or a `{ path, methods }` object that
 * narrows the exclusion to specific HTTP methods. The narrowed shape
 * exists for endpoints whose READ side is high-frequency noise but
 * whose WRITE side represents real business events worth capturing —
 * NextAuth being the canonical case: `GET /api/auth/session` polls
 * every few seconds, but `POST /api/auth/callback/*` is a sign-in
 * or registration event.
 */
export type ExcludedPathPattern =
  | string
  | { readonly path: string; readonly methods: readonly string[] };

export const DEFAULT_EXCLUDED_PATHS: readonly ExcludedPathPattern[] = Object.freeze([
  // Next.js / Vercel infrastructure noise
  "/_next/*",
  "/_vercel/*",
  "/__nextjs_*",
  // NextAuth.js / Auth.js — skip session-refresh polls and CSRF/provider
  // metadata GETs (high-frequency, no business meaning), but CAPTURE
  // POSTs (callbacks, signin, signout, register). The POSTs are the
  // actual auth events users care about; the GETs are pure plumbing.
  Object.freeze({ path: "/api/auth/*", methods: ["GET", "HEAD"] }),
  // Generic infrastructure
  "/health*",
  "/api/health",
  "/up",
  "/alive",
  "/ready",
  "/metrics",
  "/favicon.ico",
  "/.well-known*",
  "/robots.txt",
  "/sitemap.xml",
  "/*.hot-update.*",
  // Auth routes (common patterns across Clerk, NextAuth, custom auth)
  "*/login*",
  "*/logout*",
  "*/sign-in*",
  "*/sign-out*",
  "*/signin*",
  "*/signout*",
  "/session*",
]);

export const DEFAULT_EXCLUDED_EXTENSIONS: readonly string[] = Object.freeze([
  ".js",
  ".css",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
]);

export const DEFAULT_EXCLUDED_TABLES: readonly string[] = Object.freeze([
  // Prisma migration ledger
  "_prisma_migrations",
  // Auth.js / NextAuth Prisma adapter — session/verification-token churn
  // is auth machinery, not business activity. Account/User stay captured.
  "Session",
  "VerificationToken",
  // Common cross-stack convention names for the same things
  "sessions",
  "session",
  "verification_tokens",
]);

// No Next.js infrastructure jobs reliably emit noise across all three
// runners (BullMQ / Inngest / Trigger.dev). Customers add their own
// health-check job classes via excludedJobClasses.
export const DEFAULT_EXCLUDED_JOB_CLASSES: readonly string[] = Object.freeze([]);

export const DEFAULT_EXCLUDED_GRAPHQL_OPERATIONS: readonly string[] =
  Object.freeze(["IntrospectionQuery", "__*"]);

export const DEFAULT_SERVER_URL = "https://app.ezlogs.io";

export class Configuration {
  serverUrl: string | null = DEFAULT_SERVER_URL;
  projectToken: string | null = null;
  captureHttp = true;
  captureDb = true;
  captureJobs = true;
  bufferSize = 10_000;
  /** Default 3000 ms — equivalent to Ruby's 3 seconds. */
  sendInterval = 3_000;
  retryAttempts = 3;
  logLevel: LogLevel = "warn";
  patchGlobalFetch = true;
  actorFromSupabase = true;

  excludedPaths: string[] = [];
  excludedTables: string[] = [];
  excludedJobClasses: string[] = [];
  excludedGraphqlOperations: string[] = [];
  excludedGraphqlVariableKeys: string[] = [];

  actorFromRequest: ActorFromRequest | null = null;
  displayNameFor: DisplayNameMap = {};
  isServerActionError: ServerActionErrorClassifier | null = null;
  databaseReader: DatabaseReader | null = null;
  databaseSnapshotMode = false;
  databaseUrl: string | null = null;

  /**
   * Tables that have the `ezlogs_audit` trigger attached. Detected once
   * at agent startup by reading `information_schema.triggers`. The
   * supabase / drizzle / prisma adapters use this to decide whether
   * their per-mutation emit is redundant: if the table is trigger-
   * tracked the audit-log reader will surface the same write with full
   * old/new state, so the adapter's emit is suppressed. Tables NOT in
   * this set fall through to the adapter so they're still captured.
   *
   * `null` means "detection hasn't run yet or failed" — in that state
   * `databaseReader`-wired apps suppress every adapter emit (the
   * original Phase 5 behavior). After detection completes the agent
   * gives the more accurate per-table answer.
   */
  triggerTrackedTables: Set<string> | null = null;

  apply(options: InitOptions): void {
    if (options.serverUrl !== undefined) this.serverUrl = options.serverUrl;
    this.projectToken = options.projectToken;
    if (options.captureHttp !== undefined) this.captureHttp = options.captureHttp;
    if (options.captureDb !== undefined) this.captureDb = options.captureDb;
    if (options.captureJobs !== undefined) this.captureJobs = options.captureJobs;
    if (options.bufferSize !== undefined) this.bufferSize = options.bufferSize;
    if (options.sendInterval !== undefined) this.sendInterval = options.sendInterval;
    if (options.retryAttempts !== undefined) this.retryAttempts = options.retryAttempts;
    if (options.excludedPaths) this.excludedPaths = [...options.excludedPaths];
    if (options.excludedTables) this.excludedTables = [...options.excludedTables];
    if (options.excludedJobClasses) {
      this.excludedJobClasses = [...options.excludedJobClasses];
    }
    if (options.excludedGraphqlOperations) {
      this.excludedGraphqlOperations = [...options.excludedGraphqlOperations];
    }
    if (options.excludedGraphqlVariableKeys) {
      this.excludedGraphqlVariableKeys = [...options.excludedGraphqlVariableKeys];
    }
    if (options.actorFromRequest) this.actorFromRequest = options.actorFromRequest;
    if (options.displayNameFor) this.displayNameFor = { ...options.displayNameFor };
    if (options.isServerActionError) this.isServerActionError = options.isServerActionError;
    if (options.patchGlobalFetch !== undefined) {
      this.patchGlobalFetch = options.patchGlobalFetch;
    }
    if (options.actorFromSupabase !== undefined) {
      this.actorFromSupabase = options.actorFromSupabase;
    }
    if (options.databaseReader !== undefined) {
      this.databaseReader = options.databaseReader;
    }
    if (options.databaseSnapshotMode !== undefined) {
      this.databaseSnapshotMode = options.databaseSnapshotMode;
    }
    if (options.databaseUrl !== undefined) {
      this.databaseUrl = options.databaseUrl;
    }
    if (options.logLevel) this.logLevel = options.logLevel;
  }

  allExcludedPaths(): ExcludedPathPattern[] {
    return [...DEFAULT_EXCLUDED_PATHS, ...this.excludedPaths];
  }

  allExcludedTables(): string[] {
    return [...DEFAULT_EXCLUDED_TABLES, ...this.excludedTables];
  }

  allExcludedJobClasses(): string[] {
    return [...DEFAULT_EXCLUDED_JOB_CLASSES, ...this.excludedJobClasses];
  }

  allExcludedGraphqlOperations(): string[] {
    return [...DEFAULT_EXCLUDED_GRAPHQL_OPERATIONS, ...this.excludedGraphqlOperations];
  }
}

// Pinned to globalThis to survive module-graph duplication across
// Next.js / Webpack / Turbopack chunk boundaries. Without this, each
// extracted copy of this module would have its own `instance`,
// `init()` would mutate one of them, and the wrapped routes (running
// in a different chunk) would read from a fresh, never-configured
// copy and bail with "serverUrl not configured".
//
// The Symbol is unique to the package so we don't collide with any
// host code that uses globalThis.
const GLOBAL_CONFIG_KEY = Symbol.for("@ezlogs/nextjs:configuration");

interface GlobalWithConfig {
  [GLOBAL_CONFIG_KEY]?: Configuration;
}

export function configuration(): Configuration {
  const g = globalThis as unknown as GlobalWithConfig;
  if (!g[GLOBAL_CONFIG_KEY]) {
    g[GLOBAL_CONFIG_KEY] = new Configuration();
  }
  return g[GLOBAL_CONFIG_KEY]!;
}

/** Test-only reset. Not exported from the package entry. */
export function resetConfigurationForTests(): void {
  const g = globalThis as unknown as GlobalWithConfig;
  g[GLOBAL_CONFIG_KEY] = new Configuration();
}
