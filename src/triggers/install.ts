// Install command for the trigger-based capture.
//
// Usage:
//
//   npx ezlogs-nextjs install-triggers --tables=users,orders
//   npx ezlogs-nextjs install-triggers --connection=postgres://... --tables=users
//   npx ezlogs-nextjs install-triggers --print              (just print SQL, don't apply)
//
// Detects the database engine from the connection URL. Postgres-only
// in v0.1.x; MySQL is a separate command in a follow-up. PlanetScale
// is detected and emits a soft fallback message — the customer's
// existing per-ORM adapter setup keeps working unchanged.
//
// We deliberately do NOT bundle a Postgres / MySQL driver. The CLI
// expects `pg` to be available as a peer (most Next.js apps already
// install it transitively). Customers with a different driver can
// pipe the printed SQL into their own tool.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { AUTH_SESSION_TABLE_NAMES } from "../configuration.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface ParsedArgs {
  connection: string | null;
  tables: string[];
  /**
   * Auto-detect mode. True when the user passes no `--tables=` flag or
   * explicitly passes `--tables=auto`. The CLI then introspects
   * `information_schema` and tracks every business table in the public
   * schema, minus the skip rules in `skipReason`.
   */
  autoTables: boolean;
  print: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Default to auto-detect when no --tables= is passed. Customers
  // running `npx ezlogs-nextjs install-triggers` with no other flags
  // get every business table tracked in one command — matching the
  // "drop in, capture every write" promise of the rest of the agent.
  const out: ParsedArgs = {
    connection: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null,
    tables: [],
    autoTables: true,
    print: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--print") {
      out.print = true;
    } else if (arg.startsWith("--connection=")) {
      out.connection = arg.slice("--connection=".length);
    } else if (arg.startsWith("--tables=")) {
      const raw = arg.slice("--tables=".length).trim();
      if (raw === "auto" || raw === "") {
        out.autoTables = true;
        out.tables = [];
      } else if (raw === "none") {
        // Explicit opt-out — install infrastructure only, track nothing.
        out.autoTables = false;
        out.tables = [];
      } else {
        out.autoTables = false;
        out.tables = raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }
  return out;
}

const HELP = `\
Install the ezlogs-nextjs row-trigger audit capture for Postgres.

Usage:
  npx ezlogs-nextjs install-triggers [options]

Options:
  --connection=<url>   Database connection string. Defaults to DATABASE_URL
                       or POSTGRES_URL from the environment (.env, .env.local
                       and .env.[mode] are loaded the way Next.js loads them).
  --tables=<a,b,c>     Comma-separated list of tables to attach the audit
                       trigger to. Idempotent — re-runnable.
  --tables=auto        DEFAULT. Introspect information_schema and track every
                       business table in the public schema, minus migrations,
                       internals and auth-session tables (each skipped table
                       is listed with the reason).
  --tables=none        Install infrastructure only; track no tables.
                       Use this when you want full manual control.
  --print              Print the SQL that would be applied; do not run it.
                       Useful for review or piping into another tool.
  --help               Show this message.

The install creates an \`ezlogs_audit_log\` table and the
\`ezlogs_track('table')\` / \`ezlogs_untrack('table')\` helpers. After
install you can call them directly to add or remove tables later.

PlanetScale users: triggers are not supported on PlanetScale. The CLI
will detect that and exit cleanly without making changes; the
per-ORM adapter (Drizzle / Prisma) remains the primary path on
your stack.
`;

export type Detected =
  | { engine: "postgres" }
  | { engine: "mysql" }
  | { engine: "planetscale" }
  | { engine: "unknown" };

// Best-effort engine detection from the URL. We can't probe the
// database here because that would require a driver we don't ship.
// `--print` mode skips this entirely.
export function detectEngine(connection: string | null): Detected {
  if (!connection) return { engine: "unknown" };
  // PlanetScale issues connection strings on `*.psdb.cloud` hosts.
  if (/\.psdb\.cloud(?:[:/?]|$)/.test(connection)) {
    return { engine: "planetscale" };
  }
  if (/^postgres(?:ql)?:\/\//i.test(connection)) {
    return { engine: "postgres" };
  }
  if (/^mysql:\/\//i.test(connection)) {
    return { engine: "mysql" };
  }
  return { engine: "unknown" };
}

export async function loadInstallSql(engine: "postgres" | "mysql"): Promise<string> {
  // SQL files ship in the package under sql/<engine>/. The install
  // file path is resolved relative to the compiled bundle's location.
  // tsup outputs to dist/triggers/install.{js,cjs}, so the SQL files
  // are at ../../sql/<engine>/00_install.sql relative to the bundle.
  const path = join(HERE, "..", "..", "sql", engine, "00_install.sql");
  return readFile(path, "utf8");
}

// Composes the customer's track invocations onto the install SQL.
export function buildTrackingSql(tables: string[], engine: "postgres" | "mysql"): string {
  if (tables.length === 0) return "";
  if (engine === "postgres") {
    return tables.map((t) => `SELECT ezlogs_track('${escapeSqlIdentifier(t)}');`).join("\n");
  }
  // MySQL uses CALL syntax (Phase 5 Step 2).
  return tables.map((t) => `CALL ezlogs_track('${escapeSqlIdentifier(t)}');`).join("\n");
}

// Defense in depth — the SQL itself uses %I quoting in EXECUTE format,
// but we still keep the wrapper string identifier-safe so a malicious
// table name passed via CLI can't break out and execute arbitrary SQL.
function escapeSqlIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid table name "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
  return name;
}

/**
 * Skip rules applied to the `--tables=auto` introspection result, each
 * with the reason the CLI prints. Infrastructure is skipped by name;
 * auth-session / session-store / verification-token tables only when
 * their columns say so (token, expiry, `sess`, `data`, `payload`,
 * `last_activity`: Auth.js, Lucia, Rails, Laravel, connect-pg-simple),
 * because the same names also hold business data (Umami's `session`).
 *
 * Customers can still attach skipped tables manually with
 * `SELECT ezlogs_track('foo')` after the install.
 */
const NAMED_SKIPS: ReadonlyArray<readonly [string | RegExp, string]> = [
  // Our own audit table — trigger on the audit table would be a loop.
  ["ezlogs_audit_log", "EZLogs audit log"],
  ["_prisma_migrations", "migration history"],
  ["schema_migrations", "migration history"],
  ["ar_internal_metadata", "Rails internals"],
  // Postgres internals (won't be in public schema, but defensive).
  [/^pg_/, "database internals"],
  [/^_litestream/, "database internals"],
  // Rails 8 infra tables, in apps that share a database with Rails.
  [/^solid_(queue|cache|cable)/, "Rails infrastructure"],
  [/^active_storage_/, "Rails infrastructure"],
];


/**
 * Why a discovered table is skipped, or null to track it.
 * `hasAuthColumns`: the table has a session-store column (token,
 * expiry, `sess`, `data`, `payload`, `last_activity`; see
 * DISCOVER_TABLES_SQL and `isSessionStoreColumn`); `undefined`
 * (unknown) keeps the name rule.
 */
export function skipReason(tableName: string, hasAuthColumns?: boolean): string | null {
  for (const [pattern, reason] of NAMED_SKIPS) {
    if (typeof pattern === "string" ? tableName === pattern : pattern.test(tableName)) return reason;
  }
  if (AUTH_SESSION_TABLE_NAMES.test(tableName) && (hasAuthColumns !== false || /verif/i.test(tableName))) {
    return "auth / session store (has token, expiry or session-data columns)";
  }
  return null;
}

/**
 * SQL that lists every regular table in the `public` schema, flagging
 * the ones with a session-store column (`isSessionStoreColumn`). Only base tables (`BASE
 * TABLE`) — excludes views, materialized views, foreign tables.
 * Sorted for deterministic output.
 */
export const DISCOVER_TABLES_SQL = `
SELECT t.table_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = t.table_schema
      AND c.table_name = t.table_name
      AND (
        c.column_name ILIKE '%token%'
        OR c.column_name ILIKE '%expir%'
        OR lower(replace(c.column_name, '_', '')) IN ('sess', 'data', 'payload', 'lastactivity')
      )
  ) AS has_auth_columns
FROM information_schema.tables t
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  -- A partition gets its parent's trigger cloned onto it; track the parent only.
  AND NOT EXISTS (
    SELECT 1 FROM pg_class pc
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE pn.nspname = t.table_schema AND pc.relname = t.table_name AND pc.relispartition
  )
ORDER BY t.table_name
`.trim();

type DiscoveredRow = { table_name: string; has_auth_columns?: boolean };

/**
 * Discover business tables for `--tables=auto`. Returns the list of
 * table names that pass the skip rules. The query function must
 * return an object exposing `{ rows: [...] }` — `pg`'s result shape.
 */
export async function discoverTables(
  query: (sql: string) => Promise<{ rows: DiscoveredRow[] }>,
): Promise<string[]> {
  const result = await query(DISCOVER_TABLES_SQL);
  return result.rows.filter((r) => skipReason(r.table_name, r.has_auth_columns) === null).map((r) => r.table_name);
}

interface RunOptions {
  /** Async exec — caller passes a function that runs SQL against their DB. */
  exec?: (sql: string) => Promise<unknown>;
  /**
   * Async query — returns `{ rows: ... }` (matches `pg`'s shape).
   * Required for `--tables=auto` so we can introspect the schema before
   * building the tracking SQL. Tests inject. The CLI shim wires this
   * with `pg.Client.prototype.query`.
   */
  query?: (sql: string) => Promise<{ rows: DiscoveredRow[] }>;
  /** Output sink. Defaults to console.log. Tests inject. */
  out?: (line: string) => void;
}

/**
 * Programmatic entry. Returns 0 on success, non-zero on failure.
 * Tests call this with a stubbed `exec`. The real CLI binary
 * (`bin/install.cjs`) wraps this with a `pg`-backed exec.
 */
export async function runInstall(
  args: ParsedArgs,
  options: RunOptions = {},
): Promise<number> {
  const out = options.out ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
  });

  if (args.help) {
    out(HELP);
    return 0;
  }

  const detected = args.print ? { engine: "postgres" as const } : detectEngine(args.connection);

  if (detected.engine === "planetscale") {
    out(
      "[ezlogs] Triggers are not supported on PlanetScale. The per-ORM " +
        "adapter (Drizzle / Prisma / Supabase) remains the primary capture " +
        "path on your stack — no install needed.",
    );
    return 0;
  }

  if (detected.engine === "unknown" && !args.print) {
    out(
      "[ezlogs] Could not detect the database engine. " +
        "Set --connection=<url> or DATABASE_URL, or run with --print to " +
        "inspect the SQL without applying.",
    );
    return 1;
  }

  if (detected.engine === "mysql") {
    out(
      "[ezlogs] MySQL trigger install not yet shipped (Phase 5 Step 2). " +
        "Postgres install ready today; MySQL ships in a follow-up.",
    );
    return 1;
  }

  const installSql = await loadInstallSql("postgres");

  // --print mode runs entirely offline. Auto-detect needs a live
  // connection — in print mode we emit just the infrastructure SQL
  // and note that tracking is added at run time.
  if (args.print) {
    if (args.autoTables) {
      out(installSql);
      out(
        "\n-- --tables=auto: trigger attachment SQL is generated at " +
          "install time from information_schema. Re-run without --print " +
          "to apply, or pass --tables=<a,b,c> to use an explicit list.",
      );
    } else {
      const trackingSql = buildTrackingSql(args.tables, "postgres");
      const fullSql = trackingSql ? `${installSql}\n${trackingSql}\n` : installSql;
      out(fullSql);
    }
    return 0;
  }

  if (!options.exec) {
    out(
      "[ezlogs] No exec function supplied. Use --print to dump the SQL, " +
        "or run via the bundled CLI which wires `pg` for you.",
    );
    return 1;
  }

  // Resolve the table list. Auto mode introspects information_schema;
  // explicit mode uses whatever the customer passed. When auto is
  // requested but no query function is wired (older test harnesses,
  // programmatic callers using only `exec`), we install the
  // infrastructure SQL alone and surface a notice — the customer can
  // run `SELECT ezlogs_track('foo')` manually afterwards.
  let tablesToTrack: string[];
  const skippedTables: Array<{ table: string; reason: string }> = [];
  if (args.autoTables) {
    tablesToTrack = [];
    if (options.query) {
      try {
        const result = await options.query(DISCOVER_TABLES_SQL);
        for (const row of result.rows) {
          const reason = skipReason(row.table_name, row.has_auth_columns);
          if (reason) skippedTables.push({ table: row.table_name, reason });
          else tablesToTrack.push(row.table_name);
        }
      } catch (error) {
        out(
          `[ezlogs] Could not introspect tables: ${
            error instanceof Error ? error.message : String(error)
          }. Pass --tables=<a,b,c> for explicit tracking.`,
        );
        return 1;
      }
    }
  } else {
    tablesToTrack = args.tables;
  }

  // Validate every name before building the SQL. We surface the bad
  // name explicitly rather than letting the exec fail with a generic
  // syntax error.
  for (const name of tablesToTrack) {
    try {
      escapeSqlIdentifier(name);
    } catch (error) {
      out(
        `[ezlogs] Refusing to track ${JSON.stringify(name)} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  }

  try {
    // Functions + table first, then one statement per table. Separate
    // execs = separate transactions, so attaching a trigger locks only
    // that one table, briefly — never every tracked table at once.
    await options.exec(installSql);
    for (const table of tablesToTrack) {
      await options.exec(buildTrackingSql([table], "postgres"));
    }
    if (tablesToTrack.length === 0) {
      out(
        "[ezlogs] Postgres triggers installed. No tables tracked yet — " +
          "run `SELECT ezlogs_track('foo')` to attach the trigger, or " +
          "re-run with --tables=auto to track every business table.",
      );
    } else {
      out(
        `[ezlogs] Postgres triggers installed. Tracking ${tablesToTrack.length} table(s): ${tablesToTrack.join(", ")}.`,
      );
      out(
        "[ezlogs] Records are named by their name / title / number / label column. " +
          "To name people's records (users, members), set `displayNameFor` in ezlogs.init (README: Name your records).",
      );
    }
    if (skippedTables.length > 0) {
      out(
        `[ezlogs] Skipped ${skippedTables.length} table(s):\n` +
          skippedTables.map((s) => `  - ${s.table}: ${s.reason}`).join("\n") +
          "\n  Track any of them with `SELECT ezlogs_track('table_name')`.",
      );
    }
    return 0;
  } catch (error) {
    logger.error(
      `install-triggers failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
