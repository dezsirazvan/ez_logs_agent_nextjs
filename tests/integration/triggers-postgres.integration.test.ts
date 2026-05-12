// End-to-end test of the Postgres trigger install + an actual UPDATE.
// Proves the SQL contract works against a real Postgres — every other
// agent component reads from `ezlogs_audit_log`, so this is the
// foundation we stack on.
//
// Skipped when Postgres on :5436 isn't reachable. To run locally:
//
//   docker run -d --name ezlogs_triggers_test_pg \
//     -p 5436:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=triggers_test \
//     postgres:16
//
// CI provisions the same container before the integration suite.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runInstall, parseArgs } from "../../src/triggers/install.js";

const CONNECTION =
  process.env.EZLOGS_TRIGGERS_TEST_PG_URL ??
  "postgres://postgres:postgres@localhost:5436/triggers_test";

let client: Client | null = null;
let unavailable = false;

beforeAll(async () => {
  // Try to connect with a short timeout. If Postgres isn't running
  // (typical on CI without docker setup), mark the suite as skipped
  // by setting `unavailable` — every test bails early.
  try {
    client = new Client({ connectionString: CONNECTION, statement_timeout: 5000 });
    await client.connect();
  } catch {
    unavailable = true;
    if (client) {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      client = null;
    }
  }
});

afterAll(async () => {
  if (client) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
});

beforeEach(async () => {
  if (unavailable || !client) return;
  // Clean slate per test. DROP CASCADE handles the trigger + table at once.
  // Each test creates its own `test_*` table; drop them all generically
  // so a previous test's leftover doesn't collide on re-run.
  await client.query("DROP TABLE IF EXISTS ezlogs_audit_log CASCADE");
  await client.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND tablename LIKE 'test\\_%'
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
      END LOOP;
    END $$;
  `);
  await client.query("DROP FUNCTION IF EXISTS ezlogs_audit_trigger() CASCADE");
  await client.query("DROP FUNCTION IF EXISTS ezlogs_track(text)");
  await client.query("DROP FUNCTION IF EXISTS ezlogs_untrack(text)");
});

describe("Postgres trigger install — end-to-end", () => {
  it("install + ezlogs_track + INSERT/UPDATE/DELETE produces audit rows", async () => {
    if (unavailable || !client) {
      console.warn(
        "Skipping triggers Postgres integration: " +
          `Postgres at ${CONNECTION} unreachable. ` +
          "Start the test container (see test file header) to run it.",
      );
      return;
    }

    // 1. Run our install via the programmatic entry, executing against
    //    the live Postgres. This is what `npx ezlogs-nextjs install-triggers`
    //    does at runtime.
    const lines: string[] = [];
    const code = await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      out: (l) => lines.push(l),
      exec: async (sql: string) => client!.query(sql),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Postgres triggers installed/);

    // 2. Create a test table that we'll audit, then attach the trigger.
    await client.query(`
      CREATE TABLE test_users (
        id    serial PRIMARY KEY,
        name  text   NOT NULL,
        email text   NOT NULL
      )
    `);
    await client.query(`SELECT ezlogs_track('test_users')`);

    // 3. INSERT — the trigger should write a row with new_row populated
    //    and old_row NULL.
    await client.query(
      `INSERT INTO test_users (name, email) VALUES ($1, $2)`,
      ["alice", "alice@example.com"],
    );

    let res = await client.query(
      `SELECT op, table_name, old_row, new_row, resource_id
         FROM ezlogs_audit_log
        WHERE table_name = 'test_users'
        ORDER BY id`,
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].op).toBe("INSERT");
    expect(res.rows[0].table_name).toBe("test_users");
    expect(res.rows[0].old_row).toBeNull();
    expect(res.rows[0].new_row).toMatchObject({
      name: "alice",
      email: "alice@example.com",
    });
    expect(res.rows[0].resource_id).toBe("1");

    // 4. UPDATE — old_row is the pre-state, new_row is the post-state.
    await client.query(
      `UPDATE test_users SET name = $1 WHERE id = $2`,
      ["alice2", 1],
    );
    res = await client.query(
      `SELECT op, old_row, new_row
         FROM ezlogs_audit_log
        WHERE table_name = 'test_users' AND op = 'UPDATE'`,
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].old_row).toMatchObject({ name: "alice", email: "alice@example.com" });
    expect(res.rows[0].new_row).toMatchObject({ name: "alice2", email: "alice@example.com" });

    // 5. DELETE — old_row carries the deleted row, new_row is NULL.
    await client.query(`DELETE FROM test_users WHERE id = $1`, [1]);
    res = await client.query(
      `SELECT op, old_row, new_row
         FROM ezlogs_audit_log
        WHERE table_name = 'test_users' AND op = 'DELETE'`,
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].old_row).toMatchObject({ name: "alice2" });
    expect(res.rows[0].new_row).toBeNull();
  });

  it("captures ezlogs.actor_id + ezlogs.correlation_id when set via SET LOCAL", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_orders (id serial PRIMARY KEY, status text)
    `);
    await client.query(`SELECT ezlogs_track('test_orders')`);

    // Postgres uses `set_config(name, value, is_local)` for parameter-
    // ized GUC sets — `SET LOCAL name = $1` doesn't accept parameters.
    // is_local = true scopes to the current transaction.
    await client.query("BEGIN");
    await client.query(`SELECT set_config('ezlogs.actor_id',     $1, true)`, ["u-42"]);
    await client.query(`SELECT set_config('ezlogs.correlation_id', $1, true)`, ["ezl_test_abcdef12"]);
    await client.query(`INSERT INTO test_orders (status) VALUES ($1)`, ["pending"]);
    await client.query("COMMIT");

    const res = await client.query(
      `SELECT actor_id, correlation_id FROM ezlogs_audit_log WHERE table_name = 'test_orders'`,
    );
    expect(res.rows[0].actor_id).toBe("u-42");
    expect(res.rows[0].correlation_id).toBe("ezl_test_abcdef12");
  });

  it("still records audit rows when ezlogs.* GUCs are unset", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_carts (id serial PRIMARY KEY, status text)
    `);
    await client.query(`SELECT ezlogs_track('test_carts')`);

    // No SET LOCAL — `current_setting(_, true)` should return NULL,
    // not raise. The trigger should still fire and record the row.
    await client.query(`INSERT INTO test_carts (status) VALUES ($1)`, ["x"]);

    const res = await client.query(
      `SELECT actor_id, correlation_id, op FROM ezlogs_audit_log WHERE table_name = 'test_carts'`,
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].op).toBe("INSERT");
    expect(res.rows[0].actor_id).toBeNull();
    expect(res.rows[0].correlation_id).toBeNull();
  });

  it("ezlogs_track is idempotent (re-runnable without errors)", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`CREATE TABLE test_widgets (id serial PRIMARY KEY)`);

    // First track — creates the trigger.
    await client.query(`SELECT ezlogs_track('test_widgets')`);
    // Second track — DROP TRIGGER IF EXISTS handles the existing one.
    await client.query(`SELECT ezlogs_track('test_widgets')`);

    // Verify exactly one trigger exists.
    const res = await client.query(
      `SELECT count(*) AS n FROM pg_trigger
        WHERE tgrelid = 'test_widgets'::regclass
          AND tgname = 'ezlogs_audit'`,
    );
    expect(Number(res.rows[0].n)).toBe(1);
  });

  it("ezlogs_untrack removes the trigger but leaves the audit table", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`CREATE TABLE test_invites (id serial PRIMARY KEY, email text)`);
    await client.query(`SELECT ezlogs_track('test_invites')`);
    await client.query(`INSERT INTO test_invites (email) VALUES ($1)`, ["a@b"]);

    // Untrack — trigger gone, audit row survives.
    await client.query(`SELECT ezlogs_untrack('test_invites')`);

    // Subsequent inserts produce no new audit rows.
    await client.query(`INSERT INTO test_invites (email) VALUES ($1)`, ["c@d"]);
    const res = await client.query(
      `SELECT count(*) AS n FROM ezlogs_audit_log WHERE table_name = 'test_invites'`,
    );
    expect(Number(res.rows[0].n)).toBe(1); // only the first insert was captured
  });

  it("transaction txid is consistent across statements in one transaction", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`CREATE TABLE test_things (id serial PRIMARY KEY, status text)`);
    await client.query(`SELECT ezlogs_track('test_things')`);

    await client.query("BEGIN");
    await client.query(`INSERT INTO test_things (status) VALUES ('a')`);
    await client.query(`INSERT INTO test_things (status) VALUES ('b')`);
    await client.query(`UPDATE test_things SET status = 'c' WHERE id = 1`);
    await client.query("COMMIT");

    const res = await client.query(
      `SELECT count(DISTINCT txid) AS n
         FROM ezlogs_audit_log
        WHERE table_name = 'test_things'`,
    );
    // One transaction id across all three statements.
    expect(Number(res.rows[0].n)).toBe(1);
  });

  it("ezlogs_track auto-detects non-`id` primary keys", async () => {
    // Tables whose primary key isn't literally named `id` are a
    // normal data-modeling pattern (foreign-keyed children, single-
    // table-inheritance, domain-named slugs/uuids). Without per-table
    // PK detection the trigger reads `to_jsonb(NEW)->>'id'` → NULL →
    // resource_id stays empty → dashboard renders the change card
    // with no Business Entity panel. ezlogs_track now looks the PK
    // up via pg_index + pg_attribute and bakes it into the trigger
    // as a literal CREATE TRIGGER argument.
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    // PK named `asset_id` — exercises the non-`id` case.
    await client.query(`
      CREATE TABLE test_hardware (
        asset_id uuid PRIMARY KEY,
        serial   text
      )
    `);
    await client.query(`SELECT ezlogs_track('test_hardware')`);

    const id = "11111111-2222-3333-4444-555555555555";
    await client.query(
      `INSERT INTO test_hardware (asset_id, serial) VALUES ($1, $2)`,
      [id, "SN-1"],
    );
    await client.query(
      `UPDATE test_hardware SET serial = $1 WHERE asset_id = $2`,
      ["SN-2", id],
    );

    const audit = await client.query(
      `SELECT op, resource_id FROM ezlogs_audit_log
        WHERE table_name = 'test_hardware'
        ORDER BY id ASC`,
    );
    expect(audit.rows.length).toBe(2);
    // Both rows should have the asset_id captured as resource_id.
    expect(audit.rows[0]!.op).toBe("INSERT");
    expect(audit.rows[0]!.resource_id).toBe(id);
    expect(audit.rows[1]!.op).toBe("UPDATE");
    expect(audit.rows[1]!.resource_id).toBe(id);
  });

  it("trigger fires correctly when caller's search_path is empty (Supabase / PostgREST lockdown mode)", async () => {
    // Reproduces a production crash hit by a Supabase-backed customer:
    // Supabase locks PostgREST role search_paths down to an empty string
    // for security.
    // Without `SET search_path = public, pg_temp` on our trigger
    // function, the unqualified `ezlogs_audit_log` reference fails
    // with "relation does not exist" and aborts the customer's
    // mutation. Hard contract: the trigger must work no matter what
    // search_path the caller has.
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_lockdown (id serial PRIMARY KEY, name text)
    `);
    await client.query(`SELECT ezlogs_track('test_lockdown')`);

    // Simulate PostgREST: empty search_path before issuing the
    // mutation. The mutation should still succeed AND the trigger
    // should still fire.
    await client.query("SET search_path = ''");
    await client.query(`INSERT INTO public.test_lockdown (name) VALUES ('alice')`);
    // Reset for the assertion read.
    await client.query("RESET search_path");

    const audit = await client.query(
      `SELECT count(*) AS n FROM ezlogs_audit_log
        WHERE table_name = 'test_lockdown'`,
    );
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  it("trigger errors are swallowed — customer mutation succeeds even if audit fails", async () => {
    // The trigger function has an EXCEPTION WHEN others handler that
    // RAISE WARNING'+ swallows. Even if we drop the audit table out
    // from under the trigger, the customer's UPDATE/INSERT must still
    // commit. Hard contract: agent failure never blocks the user.
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_safe (id serial PRIMARY KEY, name text)
    `);
    await client.query(`SELECT ezlogs_track('test_safe')`);

    // Pull the rug: drop the audit table while the trigger is still
    // attached. Next INSERT triggers an INSERT into a missing table.
    await client.query("DROP TABLE ezlogs_audit_log CASCADE");

    // Customer's mutation MUST still succeed.
    const result = await client.query(
      `INSERT INTO test_safe (name) VALUES ('bob') RETURNING id`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.id).toBeGreaterThan(0);

    // And the row really got committed.
    const verify = await client.query(
      `SELECT count(*) AS n FROM test_safe WHERE name = 'bob'`,
    );
    expect(Number(verify.rows[0].n)).toBe(1);
  });

  it("captured_at is monotonic within a transaction (clock_timestamp)", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`CREATE TABLE test_log (id serial PRIMARY KEY, n int)`);
    await client.query(`SELECT ezlogs_track('test_log')`);

    await client.query("BEGIN");
    for (let i = 0; i < 3; i += 1) {
      await client.query(`INSERT INTO test_log (n) VALUES ($1)`, [i]);
    }
    await client.query("COMMIT");

    const res = await client.query(
      `SELECT id, captured_at FROM ezlogs_audit_log
        WHERE table_name = 'test_log' ORDER BY id`,
    );
    expect(res.rows.length).toBe(3);
    // Each captured_at should be >= the previous (clock_timestamp,
    // not transaction_timestamp, so strictly later within the txn).
    for (let i = 1; i < res.rows.length; i += 1) {
      expect(res.rows[i].captured_at >= res.rows[i - 1].captured_at).toBe(true);
    }
  });
});
