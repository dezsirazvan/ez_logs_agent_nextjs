// Prisma adapter test: simulates the $extends.query callback signature
// without taking a hard dep on @prisma/client. We hand-call the
// extension's $allOperations function with realistic ctx shapes and
// assert the buffered events match the wire contract.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ezlogsPrisma } from "../../src/db/prisma.js";
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

interface Ctx {
  model: string;
  operation: string;
  args: { data?: unknown; where?: unknown; create?: unknown; update?: unknown };
  query: (args: unknown) => Promise<unknown>;
}

// Pull out the $allOperations function from the extension factory.
// The shape returned by ezlogsPrisma() matches Prisma's documented
// extension descriptor.
function allOperationsHook(): (ctx: Ctx) => Promise<unknown> {
  const ext = ezlogsPrisma() as {
    query: { $allModels: { $allOperations: (ctx: Ctx) => Promise<unknown> } };
  };
  return ext.query.$allModels.$allOperations.bind(ext.query.$allModels);
}

describe("ezlogsPrisma — read operations are not captured", () => {
  it.each(["findUnique", "findFirst", "findMany", "count", "aggregate", "groupBy"])(
    "no event for %s",
    async (operation) => {
      const fn = allOperationsHook();
      await fn({
        model: "User",
        operation,
        args: {},
        query: async () => [{ id: 1 }],
      });
      expect(bufferSize()).toBe(0);
    },
  );
});

describe("ezlogsPrisma — create", () => {
  it("emits a create event with initial_attributes from args.data", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "User",
      operation: "create",
      args: {
        data: { email: "alice@example.com", name: "Alice", password: "x" },
      },
      query: async (a) => ({ id: 42, ...(a as { data: object }).data }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "User", operation: "create" });
    expect(event.resource_ids).toEqual([
      { resource_type: "User", resource_id: "42" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.initial_attributes).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
    expect(ctx.display_name).toBe("Alice");
  });

  it("createMany emits a single batch event with no resource_id", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Order",
      operation: "createMany",
      args: { data: [{ status: "pending" }, { status: "pending" }] },
      query: async () => ({ count: 2 }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Order", operation: "create" });
    expect(event.resource_ids).toEqual([]);
  });

  it("createManyAndReturn emits one event per row", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Tag",
      operation: "createManyAndReturn",
      args: { data: [{ name: "alpha" }, { name: "beta" }] },
      query: async () => [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ],
    });

    const events = drainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.resource_ids).toEqual([
      { resource_type: "Tag", resource_id: "1" },
    ]);
    expect(events[1]!.resource_ids).toEqual([
      { resource_type: "Tag", resource_id: "2" },
    ]);
  });
});

describe("ezlogsPrisma — update", () => {
  it("emits an update event with changes from args.data", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Order",
      operation: "update",
      args: {
        where: { id: 1001 },
        data: { status: "shipped", tracking_number: "1Z123" },
      },
      query: async () => ({
        id: 1001,
        status: "shipped",
        tracking_number: "1Z123",
        number: "ORD-1001",
      }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Order", operation: "update" });
    expect(event.resource_ids).toEqual([
      { resource_type: "Order", resource_id: "1001" },
    ]);
    const context = event.context as Record<string, unknown>;
    const changes = context.changes as Array<{ attribute: string; from: unknown; to: unknown }>;
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({
      attribute: "status",
      from: null,
      to: "shipped",
    });
    expect(changes).toContainEqual({
      attribute: "tracking_number",
      from: null,
      to: "1Z123",
    });
    expect(context.display_name).toBe("ORD-1001");
  });

  it("updateMany emits a batch update with column-level changes from args.data", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Order",
      operation: "updateMany",
      args: {
        where: { status: "pending" },
        data: { status: "cancelled" },
      },
      query: async () => ({ count: 12 }),
    });

    const event = drainEvents()[0]!;
    expect(event.resource_ids).toEqual([]);
    expect(event.context).toEqual({
      changes: [{ attribute: "status", from: null, to: "cancelled" }],
    });
  });

  it("upsert that hits the update branch records changes from args.update", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Profile",
      operation: "upsert",
      args: {
        where: { user_id: 1 },
        create: { user_id: 1, bio: "new" },
        update: { bio: "edited" },
      },
      query: async () => ({ id: 7, user_id: 1, bio: "edited" }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Profile", operation: "update" });
    const ctx = event.context as Record<string, unknown>;
    const changes = ctx.changes as Array<{ attribute: string; from: unknown; to: unknown }>;
    expect(changes).toEqual([{ attribute: "bio", from: null, to: "edited" }]);
  });
});

describe("ezlogsPrisma — delete", () => {
  it("emits a destroy event with the deleted row's id and display_name", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Cart",
      operation: "delete",
      args: { where: { id: 777 } },
      query: async () => ({ id: 777, name: "Cart of customer #5" }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Cart", operation: "destroy" });
    expect(event.resource_ids).toEqual([
      { resource_type: "Cart", resource_id: "777" },
    ]);
    const ctx = event.context as Record<string, unknown>;
    expect(ctx.display_name).toBe("Cart of customer #5");
    expect(ctx.changes).toBeUndefined();
    expect(ctx.initial_attributes).toBeUndefined();
  });

  it("deleteMany emits a destroy with no resource_id", async () => {
    const fn = allOperationsHook();
    await fn({
      model: "Notification",
      operation: "deleteMany",
      args: { where: { read_at: { not: null } } },
      query: async () => ({ count: 50 }),
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ model_class: "Notification", operation: "destroy" });
    expect(event.resource_ids).toEqual([]);
  });
});

describe("ezlogsPrisma — defensive", () => {
  it("never throws back into Prisma when the underlying query throws", async () => {
    const fn = allOperationsHook();
    await expect(
      fn({
        model: "User",
        operation: "create",
        args: { data: { email: "x" } },
        query: async () => {
          throw new Error("DB down");
        },
      }),
    ).rejects.toThrow("DB down");
    // We propagate the error to the user (so they see it) but emit no
    // half-baked event.
    expect(bufferSize()).toBe(0);
  });

  it("never throws when a capture-side bug occurs (defensive try/catch)", async () => {
    const fn = allOperationsHook();
    // Pass a result that breaks our isPlainObject heuristic: a class
    // instance with side-effecting getters. The capture must not
    // crash the user's flow.
    class WeirdRow {
      get id() {
        throw new Error("getter blew up");
      }
    }
    await fn({
      model: "Weird",
      operation: "create",
      args: { data: {} },
      query: async () => new WeirdRow(),
    });
    // No event was successfully emitted (or it was emitted with no
    // resource_id), but the user's call returned cleanly either way.
    // This test only asserts that nothing bubbled out.
  });

  it("respects captureDb=false (passes through, emits nothing)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureDb: false,
    });
    const fn = allOperationsHook();
    await fn({
      model: "User",
      operation: "create",
      args: { data: { email: "x" } },
      query: async () => ({ id: 1, email: "x" }),
    });
    expect(bufferSize()).toBe(0);
  });
});
