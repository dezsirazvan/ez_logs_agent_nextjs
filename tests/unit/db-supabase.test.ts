// supabase-js adapter tests.
//
// We construct a minimal stand-in for the supabase-js client — just
// enough surface area for the wrapSupabase() implementation to hook
// into. The real client's PostgrestFilterBuilder is a thenable that
// resolves to { data, error, status }; we synthesize that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapSupabase } from "../../src/db/supabase.js";
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

interface PostgrestResult {
  data: unknown;
  error: unknown;
  status: number;
}

// Build a minimal supabase-like client. Each call to from(table)
// returns a fresh QueryBuilder; each insert/update/upsert/delete
// returns a thenable resolving to the configured result.
//
// `prereadResult`, if set, is served for the SELECT chains the agent
// issues to capture a row's pre-state on `.update().eq('id', X)`. We
// can't tell SELECT chains from mutation result reads from inside the
// fake, so we differentiate: select() on the QUERY builder (no prior
// mutation) serves the pre-read result; select() on the FILTER builder
// (post-mutation) serves the mutation result.
function makeFakeClient(
  programmedResult: PostgrestResult = { data: null, error: null, status: 204 },
  prereadResult: PostgrestResult | null = null,
): {
  client: { from: (table: string) => unknown };
  setResult: (r: PostgrestResult) => void;
  setPrereadResult: (r: PostgrestResult | null) => void;
  lastCall: { table?: string; method?: string; values?: unknown };
} {
  let result = programmedResult;
  let preread = prereadResult;
  const lastCall: { table?: string; method?: string; values?: unknown } = {};

  function buildQueryBuilder(table: string): unknown {
    function makeFilter(method: string, values?: unknown): unknown {
      lastCall.table = table;
      lastCall.method = method;
      lastCall.values = values;
      const filter: Record<string, unknown> = {
        then(
          onfulfilled?: (value: PostgrestResult) => unknown,
          onrejected?: (reason: unknown) => unknown,
        ): Promise<unknown> {
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
        // a no-op .select() so we can chain .insert(...).select() in tests
        select() {
          return filter;
        },
        // postgrest filter chain helpers — return self so any further
        // .eq()/.in()/.match() call is also chainable
        eq() {
          return filter;
        },
        in() {
          return filter;
        },
        match() {
          return filter;
        },
      };
      return filter;
    }
    return {
      insert(values: unknown) {
        return makeFilter("insert", values);
      },
      upsert(values: unknown) {
        return makeFilter("upsert", values);
      },
      update(values: unknown) {
        return makeFilter("update", values);
      },
      delete() {
        return makeFilter("delete");
      },
      // Top-level select on the query builder — used by the agent's
      // pre-read path (`from(table).select('*').eq(...).maybeSingle()`).
      // This builds a SELECT-only filter that resolves to `preread` when
      // configured, falling back to `result`.
      select(): unknown {
        const selectFilter: Record<string, unknown> = {
          then(
            onfulfilled?: (value: PostgrestResult) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ): Promise<unknown> {
            const served = preread ?? result;
            return Promise.resolve(served).then(onfulfilled, onrejected);
          },
          eq() { return selectFilter; },
          in() { return selectFilter; },
          match() { return selectFilter; },
          limit() { return selectFilter; },
          maybeSingle() { return selectFilter; },
          single() { return selectFilter; },
        };
        return selectFilter;
      },
    };
  }

  return {
    client: { from: buildQueryBuilder },
    setResult(r: PostgrestResult): void {
      result = r;
    },
    setPrereadResult(r: PostgrestResult | null): void {
      preread = r;
    },
    lastCall,
  };
}

describe("wrapSupabase — insert", () => {
  it("emits a create event with initial_attributes from the values", async () => {
    const fake = makeFakeClient({
      data: [{ id: 42, email: "alice@example.com", name: "Alice" }],
      error: null,
      status: 201,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("users") as { insert: (v: unknown) => unknown }).insert({
      email: "alice@example.com",
      name: "Alice",
      password: "x",
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "users",
      operation: "create",
    });
    expect(event.resource_ids).toEqual([
      { resource_type: "users", resource_id: "42" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.initial_attributes).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
    expect(ctx.display_name).toBe("Alice");
  });

  it("emits one event per row when values is an array of rows", async () => {
    const fake = makeFakeClient({
      data: [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ],
      error: null,
      status: 201,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("tags") as { insert: (v: unknown) => unknown }).insert([
      { name: "alpha" },
      { name: "beta" },
    ]);

    const events = drainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.resource_ids).toEqual([
      { resource_type: "tags", resource_id: "1" },
    ]);
    expect(events[1]!.resource_ids).toEqual([
      { resource_type: "tags", resource_id: "2" },
    ]);
  });

  it("uses values.id when result.data is null (no .select() chained)", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("audit") as { insert: (v: unknown) => unknown }).insert({
      id: "audit-7",
      event: "x",
    });

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "audit", resource_id: "audit-7" },
    ]);
  });
});

describe("wrapSupabase — update / upsert", () => {
  it("emits an update event with changes derived from the values", async () => {
    const fake = makeFakeClient({
      data: [{ id: 1001, status: "shipped", number: "ORD-1001" }],
      error: null,
      status: 200,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("orders") as { update: (v: unknown) => unknown }).update({
      status: "shipped",
      tracking_number: "1Z123",
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "orders",
      operation: "update",
    });
    expect(event.resource_ids).toEqual([
      { resource_type: "orders", resource_id: "1001" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    // No pre-read happened (the test fake's .select() returns the same
    // builder, which resolves to the configured `data: null`), so we
    // ship `to`-only entries. We deliberately do NOT include `from`
    // when we don't know it — `from: null` would be a false claim.
    expect(changes).toEqual([
      { attribute: "status", to: "shipped" },
      { attribute: "tracking_number", to: "1Z123" },
    ]);
    expect(changes[0]).not.toHaveProperty("from");
    expect(changes[1]).not.toHaveProperty("from");
  });

  it("upsert lands as an update event (parity with the supabase mental model)", async () => {
    const fake = makeFakeClient({
      data: [{ id: 7, bio: "edited" }],
      error: null,
      status: 200,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("profiles") as { upsert: (v: unknown) => unknown }).upsert({
      user_id: 1,
      bio: "edited",
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "profiles",
      operation: "update",
    });
  });
});

describe("wrapSupabase — filter-chain id extraction", () => {
  it("extracts resource_id from `.update().eq('id', X)` when no .select() chained", async () => {
    // No data on the result — the common pattern of update-without-select.
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("hardware") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ name: "Renamed" })
      .eq("id", "a0000015-0000-4000-8000-000000000015");

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "hardware",
      operation: "update",
    });
    expect(event.resource_ids).toEqual([
      {
        resource_type: "hardware",
        resource_id: "a0000015-0000-4000-8000-000000000015",
      },
    ]);
  });

  it("extracts resource_id from `.update().match({id: X})`", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("orders") as {
      update: (v: unknown) => { match: (q: Record<string, unknown>) => unknown };
    })
      .update({ status: "shipped" })
      .match({ id: 42 });

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "orders", resource_id: "42" },
    ]);
  });

  it("extracts resource_id from `.delete().eq('id', X)`", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("comments") as {
      delete: () => { eq: (col: string, val: unknown) => unknown };
    })
      .delete()
      .eq("id", "comment-abc");

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "comments",
      operation: "destroy",
    });
    expect(event.resource_ids).toEqual([
      { resource_type: "comments", resource_id: "comment-abc" },
    ]);
  });

  it("prefers the result row's id over the filter id when .select() was chained", async () => {
    // beforeRow (served as the preread response) has `name: "old"` so
    // the diff is non-empty and emitDbEvent's "skip touch-only updates"
    // gate doesn't fire.
    const fake = makeFakeClient(
      {
        data: [{ id: "from-result", name: "new" }],
        error: null,
        status: 200,
      },
      { data: [{ id: "from-result", name: "old" }], error: null, status: 200 },
    );
    const sb = wrapSupabase(fake.client);

    await (sb.from("widgets") as {
      update: (v: unknown) => {
        eq: (col: string, val: unknown) => { select: () => unknown };
      };
    })
      .update({ name: "new" })
      .eq("id", "from-filter")
      .select();

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "widgets", resource_id: "from-result" },
    ]);
  });

  it("ignores filter on non-id columns (does not invent a resource_id)", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("widgets") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ note: "x" })
      .eq("status", "open");

    const event = drainEvents()[0]!;
    // No id known; resource_ids should be empty (filter on `status`
    // identifies the wrong logical scope — could be many rows).
    expect(event.resource_ids).toEqual([]);
  });

  it("ignores `.in('id', [..])` (multi-row scope, no single resource_id)", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("widgets") as {
      update: (v: unknown) => { in: (col: string, val: unknown[]) => unknown };
    })
      .update({ archived: true })
      .in("id", ["a", "b", "c"]);

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([]);
  });
});

describe("wrapSupabase — pre-read for real before/after diffs", () => {
  it("populates `from` from the pre-read row on `.update().eq('id', X)`", async () => {
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      // Pre-read serves the row's CURRENT state before the update.
      {
        data: {
          id: "h-1",
          name: "Old name",
          manufacturer: null,
          model: "Latitude 5540",
        },
        error: null,
        status: 200,
      },
    );
    const sb = wrapSupabase(fake.client);

    await (sb.from("hardware") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ name: "New name", manufacturer: "Dell" })
      .eq("id", "h-1");

    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    expect(changes).toEqual([
      { attribute: "name", from: "Old name", to: "New name" },
      // manufacturer was null in the pre-read → real null `from`,
      // not omitted. The dashboard can render "empty → Dell" honestly
      // because we actually KNOW the previous value was null.
      { attribute: "manufacturer", from: null, to: "Dell" },
    ]);
  });

  it("omits `from` when pre-read returns no row (e.g. RLS denied)", async () => {
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      // Pre-read returns no data — could be RLS, could be the row was
      // just inserted and the index hasn't caught up. Either way, we
      // honestly don't know the previous value.
      { data: null, error: null, status: 200 },
    );
    const sb = wrapSupabase(fake.client);

    await (sb.from("hardware") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ name: "Whatever" })
      .eq("id", "h-1");

    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    expect(changes).toEqual([{ attribute: "name", to: "Whatever" }]);
    expect(changes[0]).not.toHaveProperty("from");
  });

  it("pre-reads with composite `.eq('id', X).eq(scope, Y)` filter chain", async () => {
    // Regression: a real-world hardware-update pattern fires
    //   supabase.from('assets').update(...).eq('id', X).eq('asset_type', 'hardware')
    // Older code bailed when the chain had >1 equality filter, which
    // collapsed both the pre-read AND the resource_id extraction. With
    // composite-filter pre-read we keep both: id-keyed resource attribution
    // plus a real before/after on every changed column.
    const captured: Array<{ column: string; value: unknown }> = [];
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      {
        data: {
          id: "asset-1",
          asset_type: "hardware",
          name: "Old name",
          description: null,
        },
        error: null,
        status: 200,
      },
    );
    // Spy: record every .eq() call made on the SELECT (pre-read) chain.
    const originalFrom = fake.client.from;
    (fake.client as { from: typeof originalFrom }).from = (table: string) => {
      const builder = originalFrom.call(fake.client, table) as {
        select?: () => Record<string, unknown>;
      };
      const origSelect = builder.select;
      if (origSelect) {
        builder.select = ((...args: unknown[]) => {
          const selectFilter = (origSelect as (...a: unknown[]) => Record<string, unknown>).call(
            builder,
            ...args,
          );
          const origEq = selectFilter.eq as (c: string, v: unknown) => Record<string, unknown>;
          selectFilter.eq = (column: string, value: unknown) => {
            captured.push({ column, value });
            return origEq.call(selectFilter, column, value);
          };
          return selectFilter;
        }) as typeof builder.select;
      }
      return builder;
    };

    const sb = wrapSupabase(fake.client);
    await (sb.from("assets") as {
      update: (v: unknown) => {
        eq: (
          col: string,
          val: unknown,
        ) => { eq: (col: string, val: unknown) => unknown };
      };
    })
      .update({ name: "New name", description: "A laptop" })
      .eq("id", "asset-1")
      .eq("asset_type", "hardware");

    expect(captured).toEqual([
      { column: "id", value: "asset-1" },
      { column: "asset_type", value: "hardware" },
    ]);

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([
      { resource_type: "assets", resource_id: "asset-1" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    expect(changes).toEqual([
      { attribute: "name", from: "Old name", to: "New name" },
      { attribute: "description", from: null, to: "A laptop" },
    ]);
  });

  it("does NOT pre-read when no id filter is present (multi-row scope)", async () => {
    let prereadInvoked = false;
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      // If the agent calls preread, this is the response. We assert
      // it was NOT called by checking the fake's filter chain didn't
      // serve a select for a non-mutation context.
      null,
    );
    // Wrap the fake's `from` to flag any select() call we don't want.
    const originalFrom = fake.client.from;
    (fake.client as { from: typeof originalFrom }).from = (table: string) => {
      const builder = originalFrom.call(fake.client, table) as {
        select?: () => unknown;
      };
      const origSelect = builder.select;
      if (origSelect) {
        builder.select = (...args: unknown[]) => {
          prereadInvoked = true;
          return (origSelect as (...a: unknown[]) => unknown).call(
            builder,
            ...args,
          );
        };
      }
      return builder;
    };

    const sb = wrapSupabase(fake.client);
    await (sb.from("hardware") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ archived: true })
      .eq("status", "open"); // NOT an id filter — multi-row scope

    expect(prereadInvoked).toBe(false);
    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    expect(changes).toEqual([{ attribute: "archived", to: true }]);
  });

  it("does NOT pre-read when the trigger path will capture the table", async () => {
    // When `databaseReader` is wired AND the table is in the
    // trigger-tracked set, the audit-log reader will surface the same
    // write with full OLD/NEW state. The supabase adapter's emit is
    // gated off (in emitDbEvent), so any pre-read we do here is wasted.
    let prereadInvoked = false;
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      { data: { id: "h-1", name: "Old" }, error: null, status: 200 },
    );
    const originalFrom = fake.client.from;
    (fake.client as { from: typeof originalFrom }).from = (table: string) => {
      const builder = originalFrom.call(fake.client, table) as {
        select?: () => unknown;
      };
      const origSelect = builder.select;
      if (origSelect) {
        builder.select = (...args: unknown[]) => {
          prereadInvoked = true;
          return (origSelect as (...a: unknown[]) => unknown).call(
            builder,
            ...args,
          );
        };
      }
      return builder;
    };

    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = new Set(["hardware"]);

    const sb = wrapSupabase(fake.client);
    await (sb.from("hardware") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ name: "New" })
      .eq("id", "h-1");

    expect(prereadInvoked).toBe(false);
    // Adapter emit is suppressed by the gate (table is trigger-tracked),
    // so no event should land in the buffer here. The audit reader emits
    // separately and is exercised by triggers-reader.test.ts.
    expect(drainEvents().length).toBe(0);
  });

  it("DOES pre-read when the trigger path is wired but the table is NOT tracked", async () => {
    // Customer wired `databaseReader` but only ran `ezlogs_track` for
    // some tables. Untracked tables fall through to the adapter — and
    // the adapter NEEDS the pre-read to ship a meaningful `from` value.
    let prereadInvoked = false;
    const fake = makeFakeClient(
      { data: null, error: null, status: 204 },
      { data: { id: "s-1", name: "Old space" }, error: null, status: 200 },
    );
    const originalFrom = fake.client.from;
    (fake.client as { from: typeof originalFrom }).from = (table: string) => {
      const builder = originalFrom.call(fake.client, table) as {
        select?: () => unknown;
      };
      const origSelect = builder.select;
      if (origSelect) {
        builder.select = (...args: unknown[]) => {
          prereadInvoked = true;
          return (origSelect as (...a: unknown[]) => unknown).call(
            builder,
            ...args,
          );
        };
      }
      return builder;
    };

    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = new Set(["hardware"]); // spaces NOT tracked

    const sb = wrapSupabase(fake.client);
    await (sb.from("spaces") as {
      update: (v: unknown) => { eq: (col: string, val: unknown) => unknown };
    })
      .update({ name: "New space" })
      .eq("id", "s-1");

    expect(prereadInvoked).toBe(true);
    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from?: unknown; to: unknown }>;
    expect(changes).toEqual([
      { attribute: "name", from: "Old space", to: "New space" },
    ]);
  });
});

describe("wrapSupabase — delete", () => {
  it("emits a destroy event with the deleted row's id when .select() was chained", async () => {
    const fake = makeFakeClient({
      data: [{ id: 777, name: "Cart of customer #5" }],
      error: null,
      status: 200,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("carts") as { delete: () => unknown }).delete();

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      model_class: "carts",
      operation: "destroy",
    });
    expect(event.resource_ids).toEqual([
      { resource_type: "carts", resource_id: "777" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.display_name).toBe("Cart of customer #5");
  });

  it("emits a destroy with no resource_id when no .select() result available", async () => {
    const fake = makeFakeClient({ data: null, error: null, status: 204 });
    const sb = wrapSupabase(fake.client);

    await (sb.from("notifications") as { delete: () => unknown }).delete();

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([]);
  });
});

describe("wrapSupabase — error path", () => {
  it("does NOT emit when Postgrest returns an error", async () => {
    const fake = makeFakeClient({
      data: null,
      error: { code: "23505", message: "duplicate key value" },
      status: 409,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("users") as { insert: (v: unknown) => unknown }).insert({
      email: "dup@example.com",
    });

    expect(bufferSize()).toBe(0);
  });
});

describe("wrapSupabase — config and idempotency", () => {
  it("respects captureDb=false (no events emitted)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureDb: false,
    });
    const fake = makeFakeClient({
      data: [{ id: 1 }],
      error: null,
      status: 201,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("users") as { insert: (v: unknown) => unknown }).insert({
      email: "x",
    });

    expect(bufferSize()).toBe(0);
  });

  it("respects excludedTables", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedTables: ["audit_log"],
    });
    const fake = makeFakeClient({
      data: [{ id: 1 }],
      error: null,
      status: 201,
    });
    const sb = wrapSupabase(fake.client);

    await (sb.from("audit_log") as { insert: (v: unknown) => unknown }).insert({
      event: "x",
    });

    expect(bufferSize()).toBe(0);
  });

  it("wrapSupabase is idempotent — calling twice on the same client is a no-op", async () => {
    const fake = makeFakeClient({
      data: [{ id: 1, name: "A" }],
      error: null,
      status: 201,
    });
    const sb1 = wrapSupabase(fake.client);
    const sb2 = wrapSupabase(sb1); // second wrap should be a no-op

    await (sb2.from("tags") as { insert: (v: unknown) => unknown }).insert({
      name: "A",
    });

    // Exactly one event — not two.
    expect(bufferSize()).toBe(1);
  });

  it("does not interfere with .select() reads (no event for selects)", async () => {
    // A select chain doesn't go through .insert/.update/.upsert/.delete,
    // so no instrumentation runs. We don't need to test the read path
    // explicitly other than to confirm we don't emit on select-only.
    const fake = makeFakeClient({
      data: [{ id: 1 }],
      error: null,
      status: 200,
    });
    const sb = wrapSupabase(fake.client);
    const builder = sb.from("users") as { select: () => { then: PromiseLike<unknown>["then"] } };
    if (typeof builder.select === "function") {
      await Promise.resolve(builder.select() as unknown as PromiseLike<unknown>);
    }
    expect(bufferSize()).toBe(0);
  });
});
