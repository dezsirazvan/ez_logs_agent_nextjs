import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDbEvent,
  filterMeaningfulAttributes,
  filterMeaningfulChanges,
  formatForJson,
  IGNORED_ATTRIBUTES,
  isDbSensitive,
  isMeaningfulAttribute,
  isScalar,
  resolveDisplayName,
  valuesActuallyChanged,
} from "../../src/db/shared.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import { runWithCorrelation } from "../../src/correlation.js";
import { runWithActorScope, setActor } from "../../src/actor.js";

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

describe("isMeaningfulAttribute", () => {
  it("rejects all IGNORED_ATTRIBUTES", () => {
    for (const attr of IGNORED_ATTRIBUTES) {
      expect(isMeaningfulAttribute(attr)).toBe(false);
    }
  });

  it("rejects sensitive substrings", () => {
    expect(isMeaningfulAttribute("user_password")).toBe(false);
    expect(isMeaningfulAttribute("api_token")).toBe(false);
    expect(isMeaningfulAttribute("ssn")).toBe(false);
    expect(isMeaningfulAttribute("credit_card")).toBe(false);
  });

  it("accepts ordinary business attributes", () => {
    expect(isMeaningfulAttribute("status")).toBe(true);
    expect(isMeaningfulAttribute("email")).toBe(true);
    expect(isMeaningfulAttribute("user_id")).toBe(true); // foreign keys ARE meaningful
    expect(isMeaningfulAttribute("phone_number")).toBe(true);
  });

  it("excludes Auth.js NextAuth standard columns by default (Node-specific)", () => {
    expect(isMeaningfulAttribute("emailVerified")).toBe(false);
    expect(isMeaningfulAttribute("expires")).toBe(false);
  });

  it("excludes both camelCase and snake_case timestamp conventions", () => {
    expect(isMeaningfulAttribute("createdAt")).toBe(false);
    expect(isMeaningfulAttribute("created_at")).toBe(false);
    expect(isMeaningfulAttribute("updatedAt")).toBe(false);
    expect(isMeaningfulAttribute("updated_at")).toBe(false);
    expect(isMeaningfulAttribute("deletedAt")).toBe(false);
    expect(isMeaningfulAttribute("deleted_at")).toBe(false);
  });
});

describe("isDbSensitive", () => {
  it.each([
    ["password", true],
    ["user_password", true],
    ["PASSWORD", true],
    ["api_token", true],
    ["ssn", true],
    ["social_security", true],
    ["credit_card", true],
    ["encrypted_data", true],
    ["email", false],
    ["status", false],
  ])("%s -> %s", (key, expected) => {
    expect(isDbSensitive(key)).toBe(expected);
  });
});

describe("isScalar", () => {
  it("accepts primitives + Date + arrays-of-scalars", () => {
    expect(isScalar(null)).toBe(true);
    expect(isScalar("hello")).toBe(true);
    expect(isScalar(42)).toBe(true);
    expect(isScalar(true)).toBe(true);
    expect(isScalar(false)).toBe(true);
    expect(isScalar(new Date())).toBe(true);
    expect(isScalar(BigInt(99))).toBe(true);
    expect(isScalar([1, 2, 3])).toBe(true);
    expect(isScalar(["a", "b", null])).toBe(true);
  });

  it("rejects nested objects and Buffers", () => {
    expect(isScalar({ id: "1" })).toBe(false);
    expect(isScalar([{ id: "1" }])).toBe(false);
    expect(isScalar(Buffer.from("x"))).toBe(false);
  });
});

describe("formatForJson", () => {
  it("formats Date as ISO 8601", () => {
    const d = new Date("2026-01-15T12:00:00.000Z");
    expect(formatForJson(d)).toBe("2026-01-15T12:00:00.000Z");
  });

  it("formats BigInt as string (JSON-incompatible otherwise)", () => {
    expect(formatForJson(BigInt(99))).toBe("99");
  });

  it("recursively formats arrays", () => {
    expect(formatForJson([new Date("2026-01-15T12:00:00.000Z"), 1])).toEqual([
      "2026-01-15T12:00:00.000Z",
      1,
    ]);
  });

  it("passes through primitives", () => {
    expect(formatForJson("hello")).toBe("hello");
    expect(formatForJson(42)).toBe(42);
    expect(formatForJson(null)).toBeNull();
  });
});

describe("valuesActuallyChanged", () => {
  it("both null = no change", () => {
    expect(valuesActuallyChanged(null, null)).toBe(false);
  });

  it("null -> value = changed", () => {
    expect(valuesActuallyChanged(null, "shipped")).toBe(true);
  });

  it("Date comparison uses getTime() not identity", () => {
    const a = new Date("2026-01-15T12:00:00.000Z");
    const b = new Date("2026-01-15T12:00:00.000Z");
    expect(valuesActuallyChanged(a, b)).toBe(false); // same instant, diff objects
    expect(valuesActuallyChanged(a, new Date("2026-02-01"))).toBe(true);
  });
});

describe("filterMeaningfulAttributes", () => {
  it("strips ignored, sensitive, null values; keeps business attrs", () => {
    expect(
      filterMeaningfulAttributes({
        id: 42,
        createdAt: new Date("2026-01-15T12:00:00.000Z"),
        password: "x",
        api_token: "y",
        email: "alice@example.com",
        role: "customer",
        notes: null,
      }),
    ).toEqual({
      email: "alice@example.com",
      role: "customer",
    });
  });

  it("returns null when all attributes are filtered out", () => {
    expect(filterMeaningfulAttributes({ id: 1, password: "x" })).toBeNull();
  });

  it("formats Date values via toISOString()", () => {
    expect(
      filterMeaningfulAttributes({
        published_at: new Date("2026-01-15T12:00:00.000Z"),
      }),
    ).toEqual({ published_at: "2026-01-15T12:00:00.000Z" });
  });
});

describe("filterMeaningfulChanges", () => {
  it("drops changes on ignored attributes", () => {
    const filtered = filterMeaningfulChanges([
      { attribute: "id", from: 1, to: 1 },
      { attribute: "createdAt", from: new Date("2026-01-15"), to: new Date("2026-01-15") },
      { attribute: "status", from: "pending", to: "shipped" },
    ]);
    expect(filtered).toEqual([{ attribute: "status", from: "pending", to: "shipped" }]);
  });

  it("drops changes that didn't actually change", () => {
    const filtered = filterMeaningfulChanges([
      { attribute: "status", from: "pending", to: "pending" },
      { attribute: "tracking_number", from: null, to: "1Z123" },
    ]);
    expect(filtered).toEqual([
      { attribute: "tracking_number", from: null, to: "1Z123" },
    ]);
  });

  it("drops changes with non-scalar values", () => {
    const filtered = filterMeaningfulChanges([
      { attribute: "metadata", from: null, to: { nested: "object" } },
      { attribute: "tags", from: ["a"], to: ["a", "b"] },
    ]);
    expect(filtered).toEqual([
      { attribute: "tags", from: ["a"], to: ["a", "b"] },
    ]);
  });
});

describe("resolveDisplayName — fallback chain", () => {
  it("uses configured displayNameFor mapping when present", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      displayNameFor: { Order: "number" },
    });
    expect(
      resolveDisplayName("Order", { id: "1", number: "ORD-1001", name: "ignored" }),
    ).toBe("ORD-1001");
  });

  it("falls back through name -> title -> number", () => {
    expect(resolveDisplayName("User", { name: "Alice" })).toBe("Alice");
    expect(resolveDisplayName("Post", { title: "Hello" })).toBe("Hello");
    expect(resolveDisplayName("Order", { number: "ORD-7" })).toBe("ORD-7");
  });

  it("returns null when no field is found", () => {
    expect(resolveDisplayName("Mystery", { id: "x" })).toBeNull();
  });

  it("respects custom field, then falls back if custom is empty", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      displayNameFor: { User: "email" },
    });
    expect(resolveDisplayName("User", { email: "a@b" })).toBe("a@b");
    expect(resolveDisplayName("User", { email: null, name: "Alice" })).toBe("Alice");
  });

  it("supports function resolvers that compose multiple columns", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      displayNameFor: {
        Employee: (row) => `${row.first_name} ${row.last_name}`,
      },
    });
    expect(
      resolveDisplayName("Employee", { first_name: "Abelardo", last_name: "Kreiger" }),
    ).toBe("Abelardo Kreiger");
  });

  it("falls back to default chain when function resolver returns empty", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      displayNameFor: { Employee: () => "" },
    });
    expect(resolveDisplayName("Employee", { name: "Anon" })).toBe("Anon");
  });

  it("falls back to default chain when function resolver throws", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      displayNameFor: {
        Employee: () => {
          throw new Error("boom");
        },
      },
    });
    // Resolver throwing must NEVER crash the host. Falls through to
    // the name/title/number chain.
    expect(resolveDisplayName("Employee", { name: "Anon" })).toBe("Anon");
  });
});

describe("emitDbEvent — wire shape", () => {
  it("emits a create event with initial_attributes + display_name", () => {
    runWithCorrelation("ezl_1_aaaaaaaa", () => {
      emitDbEvent({
        modelClass: "User",
        operation: "create",
        resourceId: 42,
        initialAttributes: {
          id: 42,
          email: "alice@example.com",
          name: "Alice",
          password: "x",
        },
        displayName: "alice@example.com",
      });
    });
    const events = drainEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.source_type).toBe("database_callback");
    expect(event.source_data).toEqual({ model_class: "User", operation: "create" });
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_1_aaaaaaaa");
    expect(event.resource_ids).toEqual([
      { resource_type: "User", resource_id: "42" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.initial_attributes).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
    expect(ctx.display_name).toBe("alice@example.com");
  });

  // Phase 4 Step 6 finding: HTTP events carried the actor but DB
  // events emitted from inside the same handler shipped with
  // `actor: null` — so the dashboard's per-event "Triggered by"
  // panel rendered "Unknown" on the DB rows. The actor should ride
  // along whenever it's set in the request scope.
  it("includes the request-scoped actor on DB events", () => {
    runWithActorScope(() => {
      setActor({ id: "u-42", label: "alice@example.com" });
      emitDbEvent({
        modelClass: "User",
        operation: "create",
        resourceId: 42,
        initialAttributes: { id: 42, email: "a@b" },
      });
    });
    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.actor).toEqual({ id: "u-42", label: "alice@example.com" });
  });

  it("does NOT inject an actor when none is set in scope", () => {
    // No runWithActorScope -> getCurrentActor() returns null.
    emitDbEvent({
      modelClass: "User",
      operation: "destroy",
      resourceId: 1,
      displayName: "Alice",
    });
    const event = drainEvents()[0]!;
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.actor).toBeUndefined();
  });

  it("emits an update event with changes only (no initial_attributes)", () => {
    emitDbEvent({
      modelClass: "Order",
      operation: "update",
      resourceId: 1001,
      changes: [
        { attribute: "status", from: "pending", to: "shipped" },
        { attribute: "id", from: 1001, to: 1001 }, // ignored
      ],
      displayName: "ORD-1001",
    });
    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Order", operation: "update" });
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.changes).toEqual([
      { attribute: "status", from: "pending", to: "shipped" },
    ]);
    expect(ctx.initial_attributes).toBeUndefined();
  });

  it("emits a destroy event with display_name only", () => {
    emitDbEvent({
      modelClass: "Cart",
      operation: "destroy",
      resourceId: 777,
      displayName: "Cart #777",
    });
    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Cart", operation: "destroy" });
    expect(event.context).toEqual({ display_name: "Cart #777" });
  });

  it("respects excludedTables — no event emitted for matched tables", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedTables: ["AuditLog"],
    });
    emitDbEvent({
      modelClass: "AuditLog",
      operation: "create",
      resourceId: 1,
      initialAttributes: { event: "x" },
    });
    expect(bufferSize()).toBe(0);
  });

  it("respects captureDb=false — no event emitted", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureDb: false,
    });
    emitDbEvent({
      modelClass: "User",
      operation: "create",
      resourceId: 1,
      initialAttributes: { email: "x" },
    });
    expect(bufferSize()).toBe(0);
  });

  it("emits with empty resource_ids when resourceId is null (batch update)", () => {
    emitDbEvent({
      modelClass: "Order",
      operation: "update",
      resourceId: null,
      changes: [{ attribute: "status", from: null, to: "shipped" }],
    });
    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([]);
  });

  it("suppresses adapter emits while triggerTrackedTables is unknown (detection in flight or failed)", () => {
    // Until detection completes (or if it fails), the agent doesn't
    // know which tables the trigger covers. We conservatively keep
    // the original suppress-all behavior so trigger-tracked tables
    // never get a duplicate card. Untracked-table writes remain
    // missing in this window — acceptable for the detection window
    // (one query at boot) and recoverable if detection later fails
    // (logged, customer can opt the table in via ezlogs_track or
    // remove databaseReader).
    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = null;
    emitDbEvent({
      modelClass: "Order",
      operation: "update",
      resourceId: 1,
      changes: [{ attribute: "status", from: "pending", to: "shipped" }],
    });
    expect(drainEvents().length).toBe(0);
  });

  it("suppresses adapter emits for trigger-tracked tables", () => {
    // The trigger reader is authoritative on tables it covers — the
    // adapter would emit a thinner duplicate of the same write.
    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = new Set(["Order"]);
    emitDbEvent({
      modelClass: "Order",
      operation: "update",
      resourceId: 1,
      changes: [{ attribute: "status", from: "pending", to: "shipped" }],
    });
    expect(drainEvents().length).toBe(0);
  });

  it("lets adapter emits THROUGH for tables NOT in the trigger-tracked set", () => {
    // Customer ran `ezlogs_track('orders')` but the new `spaces`
    // table they just added has no trigger. Without this passthrough
    // the create would vanish — captured nowhere. The adapter is the
    // only path for these, so it must fire.
    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = new Set(["Order"]);
    emitDbEvent({
      modelClass: "spaces",
      operation: "create",
      resourceId: "s-1",
      initialAttributes: { name: "Office" },
    });
    expect(drainEvents().length).toBe(1);
  });

  it("trigger-reader emits (with _fromTrigger) bypass the gate", () => {
    configuration().databaseReader = async () => ({ rows: [] });
    configuration().triggerTrackedTables = new Set(["Order"]);
    emitDbEvent({
      modelClass: "Order",
      operation: "update",
      resourceId: 1,
      changes: [{ attribute: "status", from: "pending", to: "shipped" }],
      _fromTrigger: true,
    });
    expect(drainEvents().length).toBe(1);
  });
});
