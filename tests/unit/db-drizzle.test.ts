import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ezlogsDrizzleLogger,
  extractResourceIdFromSimpleWhere,
  extractSetChangesFromUpdate,
  parseMutation,
} from "../../src/db/drizzle.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";

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
});

describe("parseMutation — SQL sniff", () => {
  it("INSERT INTO", () => {
    expect(parseMutation('INSERT INTO "users" ("email") VALUES ($1)')).toEqual({
      operation: "create",
      table: "users",
    });
  });

  it("UPDATE", () => {
    expect(parseMutation('UPDATE "orders" SET status = $1 WHERE id = $2')).toEqual({
      operation: "update",
      table: "orders",
    });
  });

  it("DELETE FROM", () => {
    expect(parseMutation('DELETE FROM "carts" WHERE id = $1')).toEqual({
      operation: "destroy",
      table: "carts",
    });
  });

  it.each([
    "select * from users",
    "SELECT id FROM users",
    "WITH x AS (SELECT 1) SELECT * FROM users",
    "BEGIN",
    "COMMIT",
    "EXPLAIN ANALYZE SELECT * FROM users",
  ])("ignores read-only / non-mutation: %s", (sql) => {
    expect(parseMutation(sql)).toBeNull();
  });

  it("strips schema-qualified table names down to the table component", () => {
    expect(parseMutation('UPDATE public.orders SET status = $1')).toEqual({
      operation: "update",
      table: "orders",
    });
    expect(parseMutation('UPDATE "public"."orders" SET status = $1')).toEqual({
      operation: "update",
      table: "orders",
    });
  });

  it("handles backtick-quoted (mysql) and bracket-quoted (mssql) identifiers", () => {
    expect(parseMutation("UPDATE `orders` SET status = ?")).toEqual({
      operation: "update",
      table: "orders",
    });
    expect(parseMutation("UPDATE [orders] SET status = ?")).toEqual({
      operation: "update",
      table: "orders",
    });
  });

  it("skips leading whitespace, line comments, block comments", () => {
    expect(parseMutation("   \n-- audit\n/* batch */ UPDATE orders SET x = 1")).toEqual(
      { operation: "update", table: "orders" },
    );
  });

  it("recognizes lower-case keywords", () => {
    expect(parseMutation("insert into users (email) values ($1)")).toEqual({
      operation: "create",
      table: "users",
    });
  });

  it("returns null for a malformed query", () => {
    expect(parseMutation("INSERT INTO   ;")).toBeNull();
    expect(parseMutation("")).toBeNull();
  });
});

describe("ezlogsDrizzleLogger", () => {
  it("emits events for mutations and skips reads", () => {
    const log = ezlogsDrizzleLogger();
    log.logQuery('SELECT * FROM "users"', []);
    log.logQuery('INSERT INTO "users" ("email") VALUES ($1)', ["a@b"]);
    log.logQuery('UPDATE "orders" SET status = $1 WHERE id = $2', ["shipped", 7]);
    log.logQuery('DELETE FROM "carts" WHERE id = $1', [777]);

    const events = drainEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.source_data)).toEqual([
      { model_class: "users", operation: "create" },
      { model_class: "orders", operation: "update" },
      { model_class: "carts", operation: "destroy" },
    ]);
    // INSERTs still leave resource_ids empty (we don't parse VALUES
    // payloads in Phase 4 — see drizzle.ts comment).
    expect(events[0]!.resource_ids).toEqual([]);
    // UPDATE/DELETE with `WHERE id = $N` now populate resource_ids
    // from the matching params slot — Phase 4 conservative shape.
    expect(events[1]!.resource_ids).toEqual([
      { resource_type: "orders", resource_id: "7" },
    ]);
    expect(events[2]!.resource_ids).toEqual([
      { resource_type: "carts", resource_id: "777" },
    ]);
    // INSERT and DELETE still ship with no context (Drizzle's logger
    // gives no row state). UPDATE now ships `changes` parsed from
    // the SET clause — `to` only, no `from`.
    expect(events[0]!.context).toBeNull();
    expect(events[2]!.context).toBeNull();
    const updateCtx = events[1]!.context as Record<string, unknown>;
    expect(updateCtx.changes).toEqual([{ attribute: "status", to: "shipped" }]);
  });

  it("respects excludedTables", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedTables: ["audit_log"],
    });
    const log = ezlogsDrizzleLogger();
    log.logQuery('INSERT INTO audit_log ("event") VALUES ($1)', ["x"]);
    expect(bufferSize()).toBe(0);
  });

  it("respects captureDb=false", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureDb: false,
    });
    const log = ezlogsDrizzleLogger();
    log.logQuery('INSERT INTO "users" ("email") VALUES ($1)', ["x"]);
    expect(bufferSize()).toBe(0);
  });

  it("chains to a user-supplied logger via options.next", () => {
    const next = { logQuery: vi.fn() };
    const log = ezlogsDrizzleLogger({ next });
    log.logQuery('SELECT 1', []);
    expect(next.logQuery).toHaveBeenCalledWith("SELECT 1", []);
  });

  it("if the next logger throws, our capture still runs and we don't propagate", () => {
    const next = {
      logQuery: vi.fn(() => {
        throw new Error("downstream blew up");
      }),
    };
    const log = ezlogsDrizzleLogger({ next });
    expect(() =>
      log.logQuery('INSERT INTO "users" ("email") VALUES ($1)', ["x"]),
    ).not.toThrow();
    expect(bufferSize()).toBe(1);
  });
});

describe("extractResourceIdFromSimpleWhere — Phase 4 conservative shape", () => {
  // Postgres `$N` placeholders.
  it("extracts id from `WHERE id = $N`", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "orders" SET status = $1 WHERE id = $2',
        ["shipped", 7],
      ),
    ).toBe(7);
  });

  it("handles double-quoted id column", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'DELETE FROM "carts" WHERE "id" = $1',
        ["abc"],
      ),
    ).toBe("abc");
  });

  it("handles table-qualified id column (Drizzle's default for eq(table.col, x))", () => {
    // This is what `db.update(users).where(eq(users.id, X))` actually
    // emits — Drizzle qualifies the column with the table name in the
    // WHERE. Without this the Drizzle resourceId fix doesn't help the
    // most common Drizzle pattern.
    expect(
      extractResourceIdFromSimpleWhere(
        'update "users" set "name" = $1, "email" = $2 where "users"."id" = $3',
        ["Alice", "a@b.com", 7],
      ),
    ).toBe(7);
  });

  it("handles fully schema-qualified id column", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'update "public"."users" set x = $1 where "public"."users"."id" = $2',
        ["v", 42],
      ),
    ).toBe(42);
  });

  it("handles bare table-qualified id (no quoting)", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        "UPDATE users SET name = $1 WHERE users.id = $2",
        ["Alice", 7],
      ),
    ).toBe(7);
  });

  it("returns null for paranoid `WHERE id = $1 AND user_id = $2`", () => {
    // Phase 4 is conservative — paranoid filters deferred. We could
    // extract from `id` but the AND clause introduces ambiguity (which
    // placeholder? what if the schema uses composite keys?), so bail.
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "items" SET name = $1 WHERE id = $2 AND user_id = $3',
        ["new", 7, "u-1"],
      ),
    ).toBeNull();
  });

  it("returns null for `WHERE asset_id = $1` (non-id column)", () => {
    // Common Supabase pattern (`.eq('asset_id', X)` etc.). Phase 4 doesn't
    // extract from non-`id` columns; deferred pending a column-uniqueness signal.
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "hardware" SET model = $1 WHERE asset_id = $2',
        ["MBP", "a-1"],
      ),
    ).toBeNull();
  });

  it("returns null for `WHERE id IN (...)` (multi-row)", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "items" SET archived = $1 WHERE id IN ($2, $3)',
        [true, 1, 2],
      ),
    ).toBeNull();
  });

  it("returns null for `WHERE upper(id) = $1` (function call)", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "items" SET x = $1 WHERE upper(id) = $2',
        ["a", "FOO"],
      ),
    ).toBeNull();
  });

  it("returns null when the placeholder index is out of range", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "items" SET x = $1 WHERE id = $99',
        ["a"],
      ),
    ).toBeNull();
  });

  // MySQL / SQLite `?` placeholders.
  it("extracts id from `WHERE id = ?` (positional placeholders)", () => {
    expect(
      extractResourceIdFromSimpleWhere(
        "UPDATE `orders` SET status = ? WHERE id = ?",
        ["shipped", 7],
      ),
    ).toBe(7);
  });

  it("returns null when WHERE is absent (full-table mutation)", () => {
    expect(
      extractResourceIdFromSimpleWhere('DELETE FROM "items"', []),
    ).toBeNull();
  });

  it("ignores `RETURNING id` clause", () => {
    // RETURNING is what Drizzle adds when the user chains .returning()
    // — must not pollute the WHERE-clause inspection.
    expect(
      extractResourceIdFromSimpleWhere(
        'UPDATE "orders" SET status = $1 WHERE id = $2 RETURNING "id"',
        ["shipped", 7],
      ),
    ).toBe(7);
  });

  it("handles bigint values by stringifying", () => {
    // Node's bigint can't be JSON-serialized as a number; we coerce
    // to string so the wire format stays valid.
    expect(
      extractResourceIdFromSimpleWhere(
        'DELETE FROM "items" WHERE id = $1',
        [BigInt("9007199254740993")],
      ),
    ).toBe("9007199254740993");
  });
});

describe("extractSetChangesFromUpdate — Phase 4 UPDATE SET parsing", () => {
  // Drizzle's logger has no row-state — without parsing the SET clause
  // every UPDATE renders "No tracked changes" in the dashboard. We
  // ship `to` only (no `from`); better than nothing.

  it("extracts a single column SET", () => {
    expect(
      extractSetChangesFromUpdate(
        'UPDATE "users" SET "name" = $1 WHERE id = $2',
        ["razvan", 1],
      ),
    ).toEqual([{ attribute: "name", to: "razvan" }]);
  });

  it("extracts multiple columns from one SET clause", () => {
    expect(
      extractSetChangesFromUpdate(
        'UPDATE "users" SET "name" = $1, "email" = $2 WHERE "users"."id" = $3',
        ["Alice", "a@b.com", 7],
      ),
    ).toEqual([
      { attribute: "name", to: "Alice" },
      { attribute: "email", to: "a@b.com" },
    ]);
  });

  it("handles bare (unquoted) column names", () => {
    expect(
      extractSetChangesFromUpdate(
        "UPDATE users SET name = $1, email = $2 WHERE id = $3",
        ["Bob", "b@b.com", 5],
      ),
    ).toEqual([
      { attribute: "name", to: "Bob" },
      { attribute: "email", to: "b@b.com" },
    ]);
  });

  it("returns null on function calls in SET (sql template tags)", () => {
    expect(
      extractSetChangesFromUpdate(
        "UPDATE users SET name = upper($1) WHERE id = $2",
        ["alice", 1],
      ),
    ).toBeNull();
  });

  it("returns null on CASE expressions", () => {
    expect(
      extractSetChangesFromUpdate(
        "UPDATE orders SET status = CASE WHEN paid THEN $1 ELSE $2 END WHERE id = $3",
        ["complete", "pending", 1],
      ),
    ).toBeNull();
  });

  it("returns null when there is no SET clause (raw SQL fragment)", () => {
    expect(
      extractSetChangesFromUpdate("DELETE FROM users WHERE id = $1", [1]),
    ).toBeNull();
  });

  it("works for `?` placeholders (MySQL/SQLite)", () => {
    expect(
      extractSetChangesFromUpdate(
        "UPDATE `users` SET `name` = ?, `email` = ? WHERE id = ?",
        ["x", "y@z", 1],
      ),
    ).toEqual([
      { attribute: "name", to: "x" },
      { attribute: "email", to: "y@z" },
    ]);
  });

  it("preserves null values from params (clearing a column)", () => {
    expect(
      extractSetChangesFromUpdate(
        'UPDATE "users" SET "deleted_at" = $1 WHERE id = $2',
        [null, 5],
      ),
    ).toEqual([{ attribute: "deleted_at", to: null }]);
  });
});

describe("ezlogsDrizzleLogger — Phase 4 resource_id wiring", () => {
  it("populates resource_ids on UPDATE with `WHERE id = $N`", () => {
    const log = ezlogsDrizzleLogger();
    log.logQuery(
      'UPDATE "orders" SET status = $1 WHERE id = $2',
      ["shipped", 42],
    );
    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "orders", resource_id: "42" },
    ]);
  });

  it("populates resource_ids on DELETE with `WHERE id = $N`", () => {
    const log = ezlogsDrizzleLogger();
    log.logQuery('DELETE FROM "carts" WHERE id = $1', ["c-1"]);
    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "carts", resource_id: "c-1" },
    ]);
  });

  it("leaves resource_ids empty on INSERT (Phase 4 conservative)", () => {
    const log = ezlogsDrizzleLogger();
    log.logQuery('INSERT INTO "users" ("id", "email") VALUES ($1, $2)', [
      "u-1",
      "a@b",
    ]);
    expect(drainEvents()[0]!.resource_ids).toEqual([]);
  });

  it("leaves resource_ids empty on UPDATE with non-id WHERE", () => {
    const log = ezlogsDrizzleLogger();
    log.logQuery(
      'UPDATE "items" SET archived = $1 WHERE status = $2',
      [true, "old"],
    );
    expect(drainEvents()[0]!.resource_ids).toEqual([]);
  });
});
