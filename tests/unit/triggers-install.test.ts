import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  detectEngine,
  buildTrackingSql,
  runInstall,
  loadInstallSql,
} from "../../src/triggers/install.js";

describe("triggers install — argument parsing", () => {
  it("parses --tables comma-separated", () => {
    const a = parseArgs(["--tables=users,orders,products"]);
    expect(a.tables).toEqual(["users", "orders", "products"]);
  });

  it("trims whitespace and drops empty entries", () => {
    const a = parseArgs(["--tables=users, orders,, "]);
    expect(a.tables).toEqual(["users", "orders"]);
  });

  it("reads --connection explicitly", () => {
    const a = parseArgs(["--connection=postgres://user:pwd@host/db"]);
    expect(a.connection).toBe("postgres://user:pwd@host/db");
  });

  it("falls back to DATABASE_URL", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://from-env/db";
    try {
      const a = parseArgs([]);
      expect(a.connection).toBe("postgres://from-env/db");
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("recognizes --print", () => {
    expect(parseArgs(["--print"]).print).toBe(true);
    expect(parseArgs([]).print).toBe(false);
  });

  it("recognizes --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("defaults to autoTables=true when no --tables= flag is passed", () => {
    expect(parseArgs([]).autoTables).toBe(true);
    expect(parseArgs([]).tables).toEqual([]);
  });

  it("--tables=auto explicitly enables autoTables", () => {
    const a = parseArgs(["--tables=auto"]);
    expect(a.autoTables).toBe(true);
    expect(a.tables).toEqual([]);
  });

  it("--tables=<list> disables autoTables and uses the explicit list", () => {
    const a = parseArgs(["--tables=users,orders"]);
    expect(a.autoTables).toBe(false);
    expect(a.tables).toEqual(["users", "orders"]);
  });

  it("--tables=none disables autoTables and tracks nothing", () => {
    const a = parseArgs(["--tables=none"]);
    expect(a.autoTables).toBe(false);
    expect(a.tables).toEqual([]);
  });
});

describe("triggers install — engine detection", () => {
  it("detects Postgres via postgres:// scheme", () => {
    expect(detectEngine("postgres://u:p@h/db")).toEqual({ engine: "postgres" });
    expect(detectEngine("postgresql://u:p@h/db")).toEqual({ engine: "postgres" });
    expect(detectEngine("POSTGRES://u:p@h/db")).toEqual({ engine: "postgres" });
  });

  it("detects MySQL via mysql:// scheme", () => {
    expect(detectEngine("mysql://u:p@h/db")).toEqual({ engine: "mysql" });
  });

  it("detects PlanetScale by hostname", () => {
    // PlanetScale issues *.psdb.cloud connection strings.
    expect(detectEngine("mysql://u:p@aws.connect.psdb.cloud/db")).toEqual({
      engine: "planetscale",
    });
    // Even without scheme, PlanetScale-shaped host wins over MySQL.
    expect(detectEngine("mysql://u:p@aws.connect.psdb.cloud:3306/db")).toEqual({
      engine: "planetscale",
    });
  });

  it("returns unknown for unrecognized URLs", () => {
    expect(detectEngine(null)).toEqual({ engine: "unknown" });
    expect(detectEngine("sqlite://./local.db")).toEqual({ engine: "unknown" });
    expect(detectEngine("redis://localhost")).toEqual({ engine: "unknown" });
  });
});

describe("triggers install — track SQL builder", () => {
  it("builds Postgres SELECT ezlogs_track(...) per table", () => {
    expect(buildTrackingSql(["users", "orders"], "postgres")).toBe(
      "SELECT ezlogs_track('users');\nSELECT ezlogs_track('orders');",
    );
  });

  it("builds MySQL CALL ezlogs_track(...) per table", () => {
    expect(buildTrackingSql(["users"], "mysql")).toBe(
      "CALL ezlogs_track('users');",
    );
  });

  it("returns empty string when no tables given", () => {
    expect(buildTrackingSql([], "postgres")).toBe("");
  });

  it("rejects unsafe table names", () => {
    expect(() => buildTrackingSql(["users; DROP TABLE foo"], "postgres")).toThrow(
      /Invalid table name/,
    );
    expect(() => buildTrackingSql(["1starts_with_number"], "postgres")).toThrow();
    expect(() => buildTrackingSql([""], "postgres")).toThrow();
    expect(() => buildTrackingSql([" leading-space"], "postgres")).toThrow();
  });

  it("accepts conventional table names", () => {
    expect(() => buildTrackingSql(["UsersV2", "_internal", "snake_case"], "postgres"))
      .not.toThrow();
  });
});

describe("triggers install — run paths", () => {
  it("--help just prints help and returns 0", async () => {
    const lines: string[] = [];
    const code = await runInstall(parseArgs(["--help"]), {
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Install the @ezlogs\/nextjs/);
  });

  it("PlanetScale connection prints fallback message and returns 0", async () => {
    const lines: string[] = [];
    const code = await runInstall(
      parseArgs(["--connection=mysql://u:p@aws.connect.psdb.cloud/db"]),
      { out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/not supported on PlanetScale/);
    expect(lines.join("\n")).toMatch(/per-ORM adapter/);
  });

  it("MySQL connection (non-PlanetScale) emits 'not yet shipped'", async () => {
    const lines: string[] = [];
    const code = await runInstall(
      parseArgs(["--connection=mysql://u:p@rds-mysql.amazonaws.com/db"]),
      { out: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/MySQL.*not yet shipped/);
  });

  it("Unknown engine without --print returns 1", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const lines: string[] = [];
      const code = await runInstall(parseArgs([]), {
        out: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/Could not detect/);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });

  it("--print returns the install SQL even without a connection", async () => {
    const lines: string[] = [];
    const code = await runInstall(parseArgs(["--print"]), {
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const sql = lines.join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ezlogs_audit_trigger/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ezlogs_track/);
  });

  it("--print + --tables appends SELECT ezlogs_track(...) per table", async () => {
    const lines: string[] = [];
    await runInstall(parseArgs(["--print", "--tables=users,orders"]), {
      out: (l) => lines.push(l),
    });
    const sql = lines.join("\n");
    expect(sql).toMatch(/SELECT ezlogs_track\('users'\);/);
    expect(sql).toMatch(/SELECT ezlogs_track\('orders'\);/);
  });

  it("Postgres without --print and without exec returns 1 with guidance", async () => {
    const lines: string[] = [];
    const code = await runInstall(
      parseArgs(["--connection=postgres://u:p@h/db", "--tables=users"]),
      { out: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/No exec function supplied/);
  });

  it("Postgres with stubbed exec runs install + tracking and returns 0", async () => {
    const lines: string[] = [];
    const exec = vi.fn().mockResolvedValue(undefined);
    const code = await runInstall(
      parseArgs(["--connection=postgres://u:p@h/db", "--tables=users,orders"]),
      { out: (l) => lines.push(l), exec },
    );
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    const calledWith = exec.mock.calls[0]![0] as string;
    expect(calledWith).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    expect(calledWith).toMatch(/SELECT ezlogs_track\('users'\);/);
    expect(calledWith).toMatch(/SELECT ezlogs_track\('orders'\);/);
    expect(lines.join("\n")).toMatch(/Postgres triggers installed/);
    expect(lines.join("\n")).toMatch(/Tracking 2 table\(s\): users, orders/);
  });

  it("Postgres exec failure returns 1", async () => {
    const lines: string[] = [];
    const exec = vi.fn().mockRejectedValue(new Error("connection refused"));
    const code = await runInstall(
      parseArgs(["--connection=postgres://u:p@h/db"]),
      { out: (l) => lines.push(l), exec },
    );
    expect(code).toBe(1);
  });
});

describe("triggers install — auto-detect (--tables=auto / default)", () => {
  // Fake `query` returning an introspection row set. Used by --tables=auto
  // to discover which tables to attach the trigger to.
  function fakeQuery(rows: string[]) {
    return async () => ({ rows: rows.map((table_name) => ({ table_name })) });
  }

  it("introspects the schema and tracks all business tables by default", async () => {
    const execSqls: string[] = [];
    const lines: string[] = [];
    const code = await runInstall(
      { connection: "postgres://x/y", tables: [], autoTables: true, print: false, help: false },
      {
        out: (l) => lines.push(l),
        exec: async (sql) => {
          execSqls.push(sql);
        },
        query: fakeQuery(["users", "orders", "products"]),
      },
    );
    expect(code).toBe(0);
    const sql = execSqls.join("\n");
    expect(sql).toContain("SELECT ezlogs_track('users')");
    expect(sql).toContain("SELECT ezlogs_track('orders')");
    expect(sql).toContain("SELECT ezlogs_track('products')");
    expect(lines.join("\n")).toMatch(/Tracking 3 table\(s\).*users.*orders.*products/);
  });

  it("skips infrastructure tables (migrations, sessions, ezlogs_audit_log)", async () => {
    const execSqls: string[] = [];
    const lines: string[] = [];
    const code = await runInstall(
      { connection: "postgres://x/y", tables: [], autoTables: true, print: false, help: false },
      {
        out: (l) => lines.push(l),
        exec: async (sql) => {
          execSqls.push(sql);
        },
        query: fakeQuery([
          "users",
          "_prisma_migrations",
          "Session",
          "schema_migrations",
          "ezlogs_audit_log",
          "ar_internal_metadata",
          "orders",
          "active_storage_blobs",
          "solid_queue_jobs",
        ]),
      },
    );
    expect(code).toBe(0);
    const sql = execSqls.join("\n");
    // Business tables tracked.
    expect(sql).toContain("SELECT ezlogs_track('users')");
    expect(sql).toContain("SELECT ezlogs_track('orders')");
    // Infrastructure tables NOT tracked.
    expect(sql).not.toContain("ezlogs_track('_prisma_migrations')");
    expect(sql).not.toContain("ezlogs_track('Session')");
    expect(sql).not.toContain("ezlogs_track('schema_migrations')");
    expect(sql).not.toContain("ezlogs_track('ezlogs_audit_log')");
    expect(sql).not.toContain("ezlogs_track('ar_internal_metadata')");
    expect(sql).not.toContain("ezlogs_track('active_storage_blobs')");
    expect(sql).not.toContain("ezlogs_track('solid_queue_jobs')");
    // Output mentions the skipped count.
    expect(lines.join("\n")).toMatch(/Skipped 7 infrastructure table\(s\)/);
  });

  it("falls back gracefully when --tables=auto but no query function is wired", async () => {
    // Older test harnesses + programmatic callers may not pass `query`.
    // In that case we install infrastructure-only and surface a notice.
    const execSqls: string[] = [];
    const lines: string[] = [];
    const code = await runInstall(
      { connection: "postgres://x/y", tables: [], autoTables: true, print: false, help: false },
      {
        out: (l) => lines.push(l),
        exec: async (sql) => {
          execSqls.push(sql);
        },
        // No `query` passed.
      },
    );
    expect(code).toBe(0);
    const sql = execSqls.join("\n");
    // Infrastructure installed.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    // No tracking statements (no tables discovered).
    // The install SQL contains comments showing usage examples
    // (`--   SELECT ezlogs_track('users');`). What we really want to
    // check is that NO uncommented track statement is appended.
    expect(sql).not.toMatch(/^SELECT ezlogs_track\(/m);
    // Output explains the next step.
    expect(lines.join("\n")).toMatch(/No tables tracked yet/);
  });

  it("surfaces a clear error when the query function throws", async () => {
    const lines: string[] = [];
    const code = await runInstall(
      { connection: "postgres://x/y", tables: [], autoTables: true, print: false, help: false },
      {
        out: (l) => lines.push(l),
        exec: async () => {},
        query: async () => {
          throw new Error("permission denied for relation information_schema.tables");
        },
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/Could not introspect tables.*permission denied/);
  });

  it("--tables=none installs infrastructure only, no tracking SQL", async () => {
    const execSqls: string[] = [];
    const lines: string[] = [];
    const code = await runInstall(
      { connection: "postgres://x/y", tables: [], autoTables: false, print: false, help: false },
      {
        out: (l) => lines.push(l),
        exec: async (sql) => {
          execSqls.push(sql);
        },
        query: fakeQuery(["users", "orders"]),
      },
    );
    expect(code).toBe(0);
    const sql = execSqls.join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    // The install SQL contains comments showing usage examples
    // (`--   SELECT ezlogs_track('users');`). What we really want to
    // check is that NO uncommented track statement is appended.
    expect(sql).not.toMatch(/^SELECT ezlogs_track\(/m);
    expect(lines.join("\n")).toMatch(/No tables tracked yet/);
  });

  it("--print with --tables=auto emits install SQL + a note about runtime discovery", async () => {
    const lines: string[] = [];
    const code = await runInstall(
      { connection: null, tables: [], autoTables: true, print: true, help: false },
      { out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    expect(output).toMatch(/--tables=auto: trigger attachment SQL is generated/);
  });
});

describe("triggers install — SQL contents", () => {
  it("loads the Postgres install SQL from the package", async () => {
    const sql = await loadInstallSql("postgres");
    // Spot-check the contract that downstream tooling depends on.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ezlogs_audit_log/);
    // Schema columns we care about for the agent reader.
    expect(sql).toMatch(/old_row\s+jsonb/);
    expect(sql).toMatch(/new_row\s+jsonb/);
    expect(sql).toMatch(/correlation_id\s+text/);
    expect(sql).toMatch(/actor_id\s+text/);
    // Hot-path index.
    expect(sql).toMatch(/ezlogs_audit_log_correlation_idx/);
    // Generic trigger function.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ezlogs_audit_trigger/);
    // Idempotent track helper.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ezlogs_track/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS ezlogs_audit/);
    // GUC reads use missing_ok = true so unsignaled requests don't fail.
    expect(sql).toMatch(/current_setting\('ezlogs\.actor_id',\s*true\)/);
    expect(sql).toMatch(/current_setting\('ezlogs\.correlation_id',\s*true\)/);
    // Untrack helper for retiring tables.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ezlogs_untrack/);
  });
});
