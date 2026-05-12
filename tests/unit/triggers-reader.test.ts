import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAuditRows,
  emitAuditRows,
  flushAuditLog,
  detectTriggerTrackedTables,
  type AuditRow,
} from "../../src/triggers/reader.js";
import {
  clearBuffer,
  drainEvents,
} from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import {
  runWithCorrelation,
  _resetCorrelationForTests,
} from "../../src/correlation.js";

beforeEach(() => {
  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
  clearBuffer();
});

afterEach(() => {
  clearBuffer();
  _resetCorrelationForTests();
});

// Helper to build a fake `pg`-style result for the executor.
function pgResult(rows: ReadonlyArray<unknown>) {
  return { rows };
}

describe("readAuditRows", () => {
  it("queries scoped by correlation_id and returns rows oldest-first", async () => {
    const exec = vi.fn().mockResolvedValue(
      pgResult([
        {
          table_name: "users",
          op: "INSERT",
          old_row: null,
          new_row: { id: 1, name: "alice" },
          resource_id: "1",
        },
      ]),
    );
    const rows = await readAuditRows(exec, "ezl_xyz");
    expect(rows.length).toBe(1);
    expect(rows[0]!.table_name).toBe("users");
    // The query must filter by correlation_id and order by id ASC.
    expect(exec.mock.calls[0]![0]).toMatch(/WHERE correlation_id = \$1/);
    expect(exec.mock.calls[0]![0]).toMatch(/ORDER BY id ASC/);
    expect(exec.mock.calls[0]![1]).toEqual(["ezl_xyz"]);
  });

  it("accepts a bare-array result (drizzle's db.execute shape)", async () => {
    const exec = vi.fn().mockResolvedValue([
      {
        table_name: "users",
        op: "INSERT",
        old_row: null,
        new_row: { id: 1 },
        resource_id: "1",
      },
    ]);
    const rows = await readAuditRows(exec, "ezl_xyz");
    expect(rows.length).toBe(1);
  });

  it("returns [] when exec throws (never breaks the host request)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("connection refused"));
    const rows = await readAuditRows(exec, "ezl_xyz");
    expect(rows).toEqual([]);
  });

  it("returns [] on unrecognized result shape", async () => {
    const exec = vi.fn().mockResolvedValue(42);
    const rows = await readAuditRows(exec, "ezl_xyz");
    expect(rows).toEqual([]);
  });
});

describe("detectTriggerTrackedTables", () => {
  it("returns the set of tables with the ezlogs_audit trigger", async () => {
    const exec = vi.fn().mockResolvedValue(
      pgResult([
        { table_name: "employees" },
        { table_name: "assets" },
        { table_name: "hardware" },
      ]),
    );
    const tables = await detectTriggerTrackedTables(exec);
    expect(tables).toEqual(new Set(["employees", "assets", "hardware"]));
    expect(exec.mock.calls[0]![0]).toMatch(/information_schema\.triggers/);
    expect(exec.mock.calls[0]![0]).toMatch(/ezlogs_audit/);
  });

  it("returns an empty set when no tables are tracked yet", async () => {
    const exec = vi.fn().mockResolvedValue(pgResult([]));
    const tables = await detectTriggerTrackedTables(exec);
    expect(tables).toEqual(new Set());
  });

  it("returns null when exec throws (audit infra not installed yet)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("relation does not exist"));
    const tables = await detectTriggerTrackedTables(exec);
    expect(tables).toBeNull();
  });
});

describe("emitAuditRows", () => {
  it("INSERT emits a create event with initial_attributes", () => {
    const rows: AuditRow[] = [
      {
        table_name: "users",
        op: "INSERT",
        old_row: null,
        new_row: { id: 7, name: "alice", email: "alice@example.com" },
        resource_id: "7",
      },
    ];
    emitAuditRows(rows);
    const events = drainEvents();
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.source_type).toBe("database_callback");
    expect(e.source_data).toMatchObject({ model_class: "users", operation: "create" });
    expect(e.resource_ids).toEqual([{ resource_type: "users", resource_id: "7" }]);
    expect(e.context).toMatchObject({
      initial_attributes: { name: "alice", email: "alice@example.com" },
      // shared.ts resolves display_name from `name` field automatically
      display_name: "alice",
    });
  });

  it("UPDATE emits an update event with from/to changes only for changed columns", () => {
    const rows: AuditRow[] = [
      {
        table_name: "users",
        op: "UPDATE",
        old_row: { id: 7, name: "alice", email: "a@b.com" },
        new_row: { id: 7, name: "alice2", email: "a@b.com" },
        resource_id: "7",
      },
    ];
    emitAuditRows(rows);
    const events = drainEvents();
    expect(events.length).toBe(1);
    const ctx = events[0]!.context as { changes: unknown[] };
    expect(ctx.changes).toEqual([
      { attribute: "name", from: "alice", to: "alice2" },
    ]);
  });

  it("UPDATE with no business-meaningful changes (only updated_at) emits nothing", () => {
    const rows: AuditRow[] = [
      {
        table_name: "users",
        op: "UPDATE",
        old_row: { id: 7, name: "alice", updated_at: "2026-01-01T00:00:00Z" },
        new_row: { id: 7, name: "alice", updated_at: "2026-01-02T00:00:00Z" },
        resource_id: "7",
      },
    ];
    emitAuditRows(rows);
    expect(drainEvents().length).toBe(0);
  });

  it("DELETE emits a destroy event with the pre-state as initial_attributes", () => {
    const rows: AuditRow[] = [
      {
        table_name: "carts",
        op: "DELETE",
        old_row: { id: 9, status: "open" },
        new_row: null,
        resource_id: "9",
      },
    ];
    emitAuditRows(rows);
    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.source_data).toMatchObject({
      model_class: "carts",
      operation: "destroy",
    });
    expect(events[0]!.context).toMatchObject({
      initial_attributes: { status: "open" },
    });
  });

  it("parses jsonb that arrives as a JSON string (Neon HTTP / older postgres.js)", () => {
    const rows: AuditRow[] = [
      {
        table_name: "users",
        op: "INSERT",
        old_row: null,
        new_row: '{"id": 7, "name": "alice"}',
        resource_id: "7",
      },
    ];
    emitAuditRows(rows);
    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.context).toMatchObject({
      initial_attributes: { name: "alice" },
    });
  });

  it("respects allExcludedTables — skips rows from excluded tables", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedTables: ["audit_internal"],
    });
    const rows: AuditRow[] = [
      {
        table_name: "audit_internal",
        op: "INSERT",
        old_row: null,
        new_row: { id: 1, payload: "x" },
        resource_id: "1",
      },
    ];
    emitAuditRows(rows);
    expect(drainEvents().length).toBe(0);
  });

  it("equal-but-reordered nested objects produce no spurious change", () => {
    const rows: AuditRow[] = [
      {
        table_name: "rules",
        op: "UPDATE",
        old_row: { id: 1, config: { a: 1, b: 2 } },
        new_row: { id: 1, config: { b: 2, a: 1 } },
        resource_id: "1",
      },
    ];
    emitAuditRows(rows);
    expect(drainEvents().length).toBe(0);
  });
});

describe("flushAuditLog", () => {
  it("no-ops when no correlation is in scope", async () => {
    const exec = vi.fn();
    await flushAuditLog(exec);
    expect(exec).not.toHaveBeenCalled();
  });

  it("no-ops when exec is null/undefined", async () => {
    await runWithCorrelation("ezl_x", async () => {
      await flushAuditLog(null);
      await flushAuditLog(undefined);
    });
    // No throw; events buffer empty.
    expect(drainEvents().length).toBe(0);
  });

  it("pulls rows for current correlation and emits each", async () => {
    const exec = vi.fn().mockResolvedValue(
      pgResult([
        {
          table_name: "orders",
          op: "INSERT",
          old_row: null,
          new_row: { id: 1, status: "pending" },
          resource_id: "1",
        },
        {
          table_name: "orders",
          op: "UPDATE",
          old_row: { id: 1, status: "pending" },
          new_row: { id: 1, status: "shipped" },
          resource_id: "1",
        },
      ]),
    );

    await runWithCorrelation("ezl_request_42", async () => {
      await flushAuditLog(exec);
    });

    expect(exec.mock.calls[0]![1]).toEqual(["ezl_request_42"]);
    const events = drainEvents();
    expect(events.length).toBe(2);
    expect(events[0]!.source_data).toMatchObject({ operation: "create" });
    expect(events[1]!.source_data).toMatchObject({ operation: "update" });
    const updateCtx = events[1]!.context as { changes: unknown[] };
    expect(updateCtx.changes).toEqual([
      { attribute: "status", from: "pending", to: "shipped" },
    ]);
  });
});

describe("trigger reader vs. per-ORM adapters", () => {
  it("trigger emits fire even when databaseReader is configured (gate bypass)", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      // Setting databaseReader is what activates the gate that
      // suppresses per-ORM adapter emits. Trigger emits must still
      // pass through.
      databaseReader: async () => ({ rows: [] }),
    });
    const rows: AuditRow[] = [
      {
        table_name: "users",
        op: "INSERT",
        old_row: null,
        new_row: { id: 7, name: "alice" },
        resource_id: "7",
      },
    ];
    emitAuditRows(rows);
    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.source_type).toBe("database_callback");
  });
});
