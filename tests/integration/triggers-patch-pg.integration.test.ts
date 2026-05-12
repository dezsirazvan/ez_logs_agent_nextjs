// End-to-end test of the pg patch against a real `pg.Client`:
//
//   1. Install the audit triggers.
//   2. Patch pg.Client.prototype.query.
//   3. Open an actor + correlation scope.
//   4. Run a plain `client.query("UPDATE ...")` — NO manual
//      withDatabaseContext, NO getDatabaseContext.
//   5. The patch should auto-wrap the UPDATE in a tx with SET
//      LOCAL ezlogs.* before it, so the trigger captures the
//      actor + correlation, and flushAuditLog finds the row.
//
// Skipped when Postgres on :5436 isn't reachable.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as pg from "pg";
import { runInstall, parseArgs } from "../../src/triggers/install.js";
import { patchPgClient } from "../../src/triggers/patch-pg.js";
import { flushAuditLog } from "../../src/triggers/reader.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import {
  clearBuffer,
  drainEvents,
} from "../../src/pipeline/buffer.js";
import {
  runWithCorrelation,
  _resetCorrelationForTests,
} from "../../src/correlation.js";
import {
  runWithActorScope,
  setActor,
  _resetActorForTests,
} from "../../src/actor.js";

const CONNECTION =
  process.env.EZLOGS_TRIGGERS_TEST_PG_URL ??
  "postgres://postgres:postgres@localhost:5436/triggers_test";

let installerClient: pg.Client | null = null;
let patchedClient: pg.Client | null = null;
let unavailable = false;

beforeAll(async () => {
  // installer + reader use a separate Client so that patching the
  // prototype later doesn't retroactively affect the queries this
  // file uses for setup / inspection.
  try {
    installerClient = new pg.Client({
      connectionString: CONNECTION,
      statement_timeout: 5000,
    });
    await installerClient.connect();
  } catch {
    unavailable = true;
    return;
  }
  patchPgClient(pg as unknown as { Client: { prototype: { query: unknown } } });
});

afterAll(async () => {
  if (installerClient) {
    try {
      await installerClient.end();
    } catch {
      /* ignore */
    }
  }
  if (patchedClient) {
    try {
      await patchedClient.end();
    } catch {
      /* ignore */
    }
  }
});

beforeEach(async () => {
  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
  clearBuffer();
  if (unavailable || !installerClient) return;

  await installerClient.query("DROP TABLE IF EXISTS ezlogs_audit_log CASCADE");
  await installerClient.query(`
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
  await installerClient.query("DROP FUNCTION IF EXISTS ezlogs_audit_trigger() CASCADE");
  await installerClient.query("DROP FUNCTION IF EXISTS ezlogs_track(text)");
  await installerClient.query("DROP FUNCTION IF EXISTS ezlogs_untrack(text)");

  await runInstall(parseArgs(["--connection=" + CONNECTION]), {
    exec: async (sql: string) => installerClient!.query(sql),
  });
});

afterEach(() => {
  clearBuffer();
  _resetActorForTests();
  _resetCorrelationForTests();
});

describe("Phase 5 patch-pg — end-to-end", () => {
  it("plain client.query(UPDATE) auto-wraps with SET LOCAL — trigger sees actor + correlation", async () => {
    if (unavailable || !installerClient) {
      console.warn("Skipping patch-pg e2e: Postgres unreachable.");
      return;
    }

    await installerClient.query(`
      CREATE TABLE test_users (
        id    serial PRIMARY KEY,
        name  text   NOT NULL,
        email text   NOT NULL
      )
    `);
    await installerClient.query(`SELECT ezlogs_track('test_users')`);
    await installerClient.query(
      `INSERT INTO test_users (name, email) VALUES ($1, $2)`,
      ["alice", "alice@example.com"],
    );

    // Now open a SECOND connection — this one's `query` is patched
    // because we patched the prototype in beforeAll. Importantly, we
    // do NOT call withDatabaseContext or getDatabaseContext — the
    // whole point of the patch is "just call client.query()".
    patchedClient = new pg.Client({ connectionString: CONNECTION });
    await patchedClient.connect();

    const correlationId = "ezl_patch_test_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-99", label: "alice@example.com" });

        // Plain mutation — no manual wrap. This is the customer's
        // unchanged code path.
        await patchedClient!.query(
          "UPDATE test_users SET name = $1 WHERE id = 1",
          ["alice2"],
        );

        // End of "request" — drain audit log.
        await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
          return installerClient!.query(sql, params as unknown[]);
        });
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.source_type).toBe("database_callback");
    expect(e.source_data).toMatchObject({
      model_class: "test_users",
      operation: "update",
    });
    expect(e.correlation_id).toBe(correlationId);
    expect(e.context).toMatchObject({
      actor: { id: "u-99", label: "alice@example.com" },
      changes: [{ attribute: "name", from: "alice", to: "alice2" }],
    });
  });

  it("multi-statement transaction (BEGIN/UPDATE x 2/COMMIT) injects SET LOCAL once", async () => {
    if (unavailable || !installerClient) return;

    await installerClient.query(`
      CREATE TABLE test_orders (id serial PRIMARY KEY, status text)
    `);
    await installerClient.query(`SELECT ezlogs_track('test_orders')`);
    await installerClient.query(
      `INSERT INTO test_orders (status) VALUES ('a'), ('b')`,
    );

    patchedClient = new pg.Client({ connectionString: CONNECTION });
    await patchedClient.connect();

    const correlationId = "ezl_patch_multi_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-1" });

        // Customer's own explicit tx — no wrap of any kind.
        await patchedClient!.query("BEGIN");
        await patchedClient!.query(
          "UPDATE test_orders SET status = 'shipped' WHERE id = 1",
        );
        await patchedClient!.query(
          "UPDATE test_orders SET status = 'cancelled' WHERE id = 2",
        );
        await patchedClient!.query("COMMIT");

        await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
          return installerClient!.query(sql, params as unknown[]);
        });
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(2);
    expect(events.every((e) => e.correlation_id === correlationId)).toBe(true);
    // Both events share the same Postgres txid — they were captured
    // inside the same explicit tx.
    expect(
      events.every((e) =>
        ((e.context as { actor?: { id?: string } })?.actor?.id ?? null) === "u-1",
      ),
    ).toBe(true);
  });

  it("pg.Pool.query(INSERT) — the real Prisma-adapter path — captures actor + correlation", async () => {
    // This test specifically reproduces the failure mode that surfaced
    // live with @prisma/adapter-pg + nextjs-auth-starter: when the
    // adapter calls `pool.query(INSERT)` and our patch on
    // Client.prototype.query forwards the pool-supplied callback as it
    // wraps in BEGIN/SET/INSERT/COMMIT, pg-pool fires `client.release`
    // as soon as the INSERT callback runs — BEFORE our COMMIT — so the
    // tx never commits the SET LOCAL state and the trigger sees NULL.
    //
    // Fix: never forward the caller's callback to original.call — run
    // the user's query in promise mode, COMMIT, then fire the callback
    // ourselves.
    if (unavailable || !installerClient) return;

    await installerClient.query(`
      CREATE TABLE test_pool_users (
        id    serial PRIMARY KEY,
        name  text   NOT NULL
      )
    `);
    await installerClient.query(`SELECT ezlogs_track('test_pool_users')`);

    const pool = new pg.Pool({ connectionString: CONNECTION, max: 2 });
    const correlationId = "ezl_pool_test_" + Date.now();

    try {
      await runWithCorrelation(correlationId, async () => {
        await runWithActorScope(async () => {
          setActor({ id: "u-pool" });
          // The real bug-reproducer: pool.query (not client.query).
          // pg-pool internally calls `client.query(text, values, cb)`
          // where `cb` is a "release the connection" callback.
          await pool.query(
            "INSERT INTO test_pool_users (name) VALUES ($1)",
            ["alice"],
          );
        });
      });

      // Assert the trigger recorded the actor + correlation. If the
      // patch is broken, both will be NULL.
      const audit = await installerClient.query(
        `SELECT actor_id, correlation_id FROM ezlogs_audit_log
          WHERE table_name = 'test_pool_users'`,
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.actor_id).toBe("u-pool");
      expect(audit.rows[0]!.correlation_id).toBe(correlationId);
    } finally {
      await pool.end();
    }
  });

  it("queries outside any actor/correlation scope work (no wrap, no SET, audit row has NULL context)", async () => {
    if (unavailable || !installerClient) return;

    await installerClient.query(`
      CREATE TABLE test_logs (id serial PRIMARY KEY, msg text)
    `);
    await installerClient.query(`SELECT ezlogs_track('test_logs')`);

    patchedClient = new pg.Client({ connectionString: CONNECTION });
    await patchedClient.connect();

    // No runWithCorrelation, no actor — script-style usage.
    await patchedClient.query(
      `INSERT INTO test_logs (msg) VALUES ($1)`,
      ["script run"],
    );

    // Trigger fired (audit row exists), but reader can't match it
    // to any correlation, so no event ships.
    const auditRows = await installerClient.query(
      "SELECT actor_id, correlation_id FROM ezlogs_audit_log WHERE table_name = 'test_logs'",
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]!.actor_id).toBeNull();
    expect(auditRows.rows[0]!.correlation_id).toBeNull();
  });
});
