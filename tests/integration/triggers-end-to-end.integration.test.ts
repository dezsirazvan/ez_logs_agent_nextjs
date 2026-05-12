// Full Phase 5 stack end-to-end test:
//
//   install SQL  ->  ezlogs_track('test_users')
//          ↓
//   withDatabaseContext(client, async tx => INSERT/UPDATE/DELETE)
//          ↓
//   trigger fires inside the tx, writes ezlogs_audit_log row with the
//   actor_id + correlation_id GUCs we set at the top of the tx
//          ↓
//   flushAuditLog(exec) at end of "request" reads rows for current
//   correlation, emits database_callback events through the agent
//   pipeline → drainEvents() yields them.
//
// This is the "would it actually work in production" test. The
// per-component tests (triggers-postgres, triggers-context,
// triggers-reader) cover the seams; this covers the full pipe.
//
// Skipped when Postgres on :5436 isn't reachable. See
// triggers-postgres.integration.test.ts for the docker setup.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Client } from "pg";
import { runInstall, parseArgs } from "../../src/triggers/install.js";
import { withDatabaseContext } from "../../src/triggers/context.js";
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

let client: Client | null = null;
let unavailable = false;

beforeAll(async () => {
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
  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
  clearBuffer();
  if (unavailable || !client) return;
  // Drop test tables + the agent's audit infrastructure so each test
  // installs fresh.
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

afterEach(() => {
  clearBuffer();
  _resetActorForTests();
  _resetCorrelationForTests();
});

describe("Phase 5 — full pipeline end-to-end", () => {
  it("INSERT inside withDatabaseContext yields a create event with actor + correlation", async () => {
    if (unavailable || !client) {
      console.warn(
        "Skipping triggers end-to-end: Postgres unreachable. Start the test container.",
      );
      return;
    }

    // Install + track a table.
    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_users (
        id    serial PRIMARY KEY,
        name  text   NOT NULL,
        email text   NOT NULL
      )
    `);
    await client.query(`SELECT ezlogs_track('test_users')`);

    // Simulate a request: open correlation + actor, run a tx that
    // INSERTs, then flush the audit log (what the HTTP capturer
    // would do at end of request).
    const correlationId = "ezl_e2e_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-99", label: "alice@example.com" });

        // The customer's mutation, wrapped so the trigger sees the
        // actor + correlation.
        await withDatabaseContext(
          {
            query: (sql: string, params?: ReadonlyArray<unknown>) =>
              client!.query(sql, params as unknown[] | undefined),
          },
          async (c) => {
            await c.query(
              "INSERT INTO test_users (name, email) VALUES ($1, $2)",
              ["alice", "alice@example.com"],
            );
          },
        );

        // End-of-request: drain the audit log into the agent buffer.
        await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
          return client!.query(sql, params as unknown[]);
        });
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.source_type).toBe("database_callback");
    expect(e.source_data).toMatchObject({
      model_class: "test_users",
      operation: "create",
    });
    expect(e.correlation_id).toBe(correlationId);
    expect(e.resource_ids).toEqual([
      { resource_type: "test_users", resource_id: "1" },
    ]);
    expect(e.context).toMatchObject({
      actor: { id: "u-99", label: "alice@example.com" },
      initial_attributes: { name: "alice", email: "alice@example.com" },
      display_name: "alice",
    });
  });

  it("UPDATE produces a from/to change diff for changed columns only", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_orders (
        id     serial PRIMARY KEY,
        status text   NOT NULL,
        note   text
      )
    `);
    await client.query(`SELECT ezlogs_track('test_orders')`);

    // Pre-seed a row OUTSIDE the request scope so it doesn't create
    // an audit row tagged with our test correlation.
    await client.query(
      `INSERT INTO test_orders (status, note) VALUES ($1, $2)`,
      ["pending", "first"],
    );

    const correlationId = "ezl_e2e_update_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-1" });
        await withDatabaseContext(
          {
            query: (sql: string, params?: ReadonlyArray<unknown>) =>
              client!.query(sql, params as unknown[] | undefined),
          },
          async (c) => {
            // Touch only `status`; `note` stays the same.
            await c.query(
              "UPDATE test_orders SET status = $1, note = $2 WHERE id = 1",
              ["shipped", "first"],
            );
          },
        );
        await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
          return client!.query(sql, params as unknown[]);
        });
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    const ctx = events[0]!.context as { changes: Array<Record<string, unknown>> };
    // Only `status` shows up — `note` was touched but unchanged.
    expect(ctx.changes).toEqual([
      { attribute: "status", from: "pending", to: "shipped" },
    ]);
  });

  it("DELETE produces a destroy event with the pre-state preserved", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_invites (
        id    serial PRIMARY KEY,
        email text   NOT NULL
      )
    `);
    await client.query(`SELECT ezlogs_track('test_invites')`);
    await client.query(
      `INSERT INTO test_invites (email) VALUES ($1)`,
      ["pending@example.com"],
    );

    const correlationId = "ezl_e2e_delete_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await withDatabaseContext(
        {
          query: (sql: string, params?: ReadonlyArray<unknown>) =>
            client!.query(sql, params as unknown[] | undefined),
        },
        async (c) => {
          await c.query("DELETE FROM test_invites WHERE id = 1");
        },
      );
      await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
        return client!.query(sql, params as unknown[]);
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.source_data).toMatchObject({ operation: "destroy" });
    expect(events[0]!.context).toMatchObject({
      initial_attributes: { email: "pending@example.com" },
    });
  });

  it("time-window fallback: drains rows the trigger fired with NULL correlation (supabase-js path)", async () => {
    // Simulates the supabase-js scenario: customer's mutation goes
    // through PostgREST which auto-commits each request, so there's
    // no place for our SET LOCAL to run. The audit row lands with
    // NULL actor_id + NULL correlation_id. The reader's time-window
    // fallback should still catch it via the snapshot bound, and
    // emitDbEvent attaches the agent's known actor + correlation.
    if (unavailable || !client) return;

    const { takeAuditSnapshot, flushAuditLog } = await import(
      "../../src/triggers/reader.js"
    );
    const { runWithAuditSnapshotScope } = await import(
      "../../src/triggers/audit-snapshot.js"
    );

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_supabase (
        id    serial PRIMARY KEY,
        name  text   NOT NULL
      )
    `);
    await client.query(`SELECT ezlogs_track('test_supabase')`);

    const correlationId = "ezl_e2e_window_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-window", label: "alice@example.com" });
        await runWithAuditSnapshotScope(async () => {
          // Simulates the agent taking the snapshot before the user's
          // handler runs.
          await takeAuditSnapshot(async (sql, params) =>
            client!.query(sql, params as unknown[]),
          );

          // The "supabase-js" mutation: a plain INSERT with no SET
          // LOCAL anywhere. The trigger fires; the audit row lands
          // with NULL correlation_id.
          await client!.query(
            `INSERT INTO test_supabase (name) VALUES ($1)`,
            ["alice"],
          );

          // End of "request" — drain.
          await flushAuditLog(async (sql, params) =>
            client!.query(sql, params as unknown[]),
          );
        });
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.source_type).toBe("database_callback");
    expect(e.source_data).toMatchObject({
      model_class: "test_supabase",
      operation: "create",
    });
    // Even though the audit row had NULL correlation_id, the agent's
    // request scope provided it at emit time.
    expect(e.correlation_id).toBe(correlationId);
    expect(e.context).toMatchObject({
      actor: { id: "u-window", label: "alice@example.com" },
      initial_attributes: { name: "alice" },
    });

    // Spot-check the audit row itself: trigger fired, but with NULL
    // context — confirming the row was drained via the time-window
    // arm, not the correlation-tagged arm.
    const audit = await client.query(
      `SELECT actor_id, correlation_id FROM ezlogs_audit_log
        WHERE table_name = 'test_supabase'`,
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.actor_id).toBeNull();
    expect(audit.rows[0]!.correlation_id).toBeNull();
  });

  it("time-window fallback: ignores rows that PRE-DATE the request snapshot", async () => {
    // The snapshot bound prevents picking up unrelated rows from
    // earlier requests. We pre-seed a row, take the snapshot, then
    // confirm the seed isn't drained.
    if (unavailable || !client) return;

    const { takeAuditSnapshot, flushAuditLog } = await import(
      "../../src/triggers/reader.js"
    );
    const { runWithAuditSnapshotScope } = await import(
      "../../src/triggers/audit-snapshot.js"
    );

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_seed (id serial PRIMARY KEY, name text NOT NULL)
    `);
    await client.query(`SELECT ezlogs_track('test_seed')`);

    // Pre-seed a row OUTSIDE any request scope — its audit row will
    // have NULL correlation_id and a low id.
    await client.query(`INSERT INTO test_seed (name) VALUES ('old')`);

    const correlationId = "ezl_e2e_seed_" + Date.now();

    await runWithCorrelation(correlationId, async () => {
      await runWithAuditSnapshotScope(async () => {
        // Snapshot taken AFTER the seed → seed.id <= snapshot bound.
        await takeAuditSnapshot(async (sql, params) =>
          client!.query(sql, params as unknown[]),
        );
        // Now run a "current request" mutation.
        await client!.query(`INSERT INTO test_seed (name) VALUES ('new')`);
        await flushAuditLog(async (sql, params) =>
          client!.query(sql, params as unknown[]),
        );
      });
    });

    const events = drainEvents();
    expect(events.length).toBe(1);
    const ctx = events[0]!.context as { initial_attributes: { name: string } };
    expect(ctx.initial_attributes.name).toBe("new");
  });

  it("touch-only UPDATE (only updated_at changed) emits no event", async () => {
    if (unavailable || !client) return;

    await runInstall(parseArgs(["--connection=" + CONNECTION]), {
      exec: async (sql: string) => client!.query(sql),
    });
    await client.query(`
      CREATE TABLE test_widgets (
        id         serial PRIMARY KEY,
        name       text   NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`SELECT ezlogs_track('test_widgets')`);
    await client.query(`INSERT INTO test_widgets (name) VALUES ('a')`);

    const correlationId = "ezl_e2e_touch_" + Date.now();
    await runWithCorrelation(correlationId, async () => {
      await withDatabaseContext(
        {
          query: (sql: string, params?: ReadonlyArray<unknown>) =>
            client!.query(sql, params as unknown[] | undefined),
        },
        async (c) => {
          // Re-set name to itself; bump updated_at.
          await c.query(
            "UPDATE test_widgets SET name = name, updated_at = now() WHERE id = 1",
          );
        },
      );
      await flushAuditLog(async (sql: string, params: ReadonlyArray<unknown>) => {
        return client!.query(sql, params as unknown[]);
      });
    });

    expect(drainEvents().length).toBe(0);
  });
});
