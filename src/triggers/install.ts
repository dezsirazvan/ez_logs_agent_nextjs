// Install command for the trigger-based capture.
//
// Usage:
//
//   npx @ezlogs/nextjs install-triggers --tables=users,orders
//   npx @ezlogs/nextjs install-triggers --connection=postgres://... --tables=users
//   npx @ezlogs/nextjs install-triggers --print              (just print SQL, don't apply)
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
import { DEFAULT_EXCLUDED_TABLES } from "../configuration.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface ParsedArgs {
  connection: string | null;
  tables: string[];
  /**
   * Auto-detect mode. True when the user passes no `--tables=` flag or
   * explicitly passes `--tables=auto`. The CLI then introspects
   * `information_schema` and tracks every business table in the public
   * schema, minus a built-in infrastructure skip list.
   */
  autoTables: boolean;
  print: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Default to auto-detect when no --tables= is passed. Customers
  // running `npx @ezlogs/nextjs install-triggers` with no other flags
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
Install the @ezlogs/nextjs row-trigger audit capture for Postgres.

Usage:
  npx @ezlogs/nextjs install-triggers [options]

Options:
  --connection=<url>   Database connection string. Defaults to DATABASE_URL
                       or POSTGRES_URL from the environment.
  --tables=<a,b,c>     Comma-separated list of tables to attach the audit
                       trigger to. Idempotent — re-runnable.
  --tables=auto        DEFAULT. Introspect information_schema and track every
                       business table in the public schema, minus a built-in
                       infrastructure skip list (migrations, sessions, etc.).
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
 * Skip list applied to the `--tables=auto` introspection result.
 *
 * Composed from `DEFAULT_EXCLUDED_TABLES` (the runtime skip list — same
 * one the agent already uses to filter trigger emits) plus a small
 * extension of trigger-install-specific tables: things that should
 * never have a trigger attached even though the runtime filter would
 * also skip them (the install itself errors if we try to attach to a
 * non-existent or view-style row).
 *
 * Customers can still attach skipped tables manually with
 * `SELECT ezlogs_track('foo')` after the install.
 */
const TRIGGER_INSTALL_SKIP_PATTERNS: ReadonlyArray<string | RegExp> = [
  ...DEFAULT_EXCLUDED_TABLES,
  // Our own audit table — trigger on the audit table would be a loop.
  "ezlogs_audit_log",
  // Postgres internals (won't be in public schema, but defensive).
  /^pg_/,
  /^_litestream/,
  // Solid Queue / Solid Cache / Solid Cable (Rails 8 default infra
  // tables — show up in apps that share a database with Rails).
  /^solid_(queue|cache|cable)/,
  // ActiveStorage (same).
  /^active_storage_/,
  // ActiveRecord internals.
  "ar_internal_metadata",
  "schema_migrations",
];

function shouldSkipTable(tableName: string): boolean {
  for (const pattern of TRIGGER_INSTALL_SKIP_PATTERNS) {
    if (typeof pattern === "string") {
      if (tableName === pattern) return true;
    } else if (pattern.test(tableName)) {
      return true;
    }
  }
  return false;
}

/**
 * SQL that lists every regular table in the `public` schema. Only
 * base tables (`BASE TABLE`) — excludes views, materialized views,
 * foreign tables. Sorted for deterministic output.
 */
export const DISCOVER_TABLES_SQL = `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name
`.trim();

/**
 * Discover business tables for `--tables=auto`. Returns the list of
 * table names that pass the skip filter. The query function must
 * return an object exposing `{ rows: Array<{ table_name: string }> }`
 * — matches `pg`'s default result shape.
 */
export async function discoverTables(
  query: (sql: string) => Promise<{ rows: Array<{ table_name: string }> }>,
): Promise<string[]> {
  const result = await query(DISCOVER_TABLES_SQL);
  const all = result.rows.map((r) => r.table_name);
  return all.filter((name) => !shouldSkipTable(name));
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
  query?: (sql: string) => Promise<{ rows: Array<{ table_name: string }> }>;
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
  let skippedTables: string[] = [];
  if (args.autoTables) {
    if (!options.query) {
      tablesToTrack = [];
    } else {
      try {
        const result = await options.query(DISCOVER_TABLES_SQL);
        const all = result.rows.map((r) => r.table_name);
        tablesToTrack = all.filter((name) => !shouldSkipTable(name));
        skippedTables = all.filter((name) => shouldSkipTable(name));
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

  const trackingSql = buildTrackingSql(tablesToTrack, "postgres");
  const fullSql = trackingSql ? `${installSql}\n${trackingSql}\n` : installSql;

  try {
    await options.exec(fullSql);
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
      if (skippedTables.length > 0) {
        out(
          `[ezlogs] Skipped ${skippedTables.length} infrastructure table(s) ` +
            `(migrations, sessions, etc.): ${skippedTables.join(", ")}. ` +
            `Track any of them manually with \`SELECT ezlogs_track('foo')\`.`,
        );
      }
    }
    return 0;
  } catch (error) {
    logger.error(
      `install-triggers failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
