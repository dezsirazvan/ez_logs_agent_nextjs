// Prisma DB capture.
//
// Returns a Prisma client extension that hooks every model operation.
// Usage:
//
//   import { PrismaClient } from "@prisma/client"
//   import { ezlogsPrisma } from "@ezlogs/nextjs/prisma"
//
//   const prisma = new PrismaClient().$extends(ezlogsPrisma())
//
// We capture only mutations: create, createMany, upsert, update,
// updateMany, delete, deleteMany. Reads pass through unchanged.
// Parity with Ruby's database_capturer.rb, which only fires on
// after_create / after_update / after_destroy.
//
// Known gap: for update operations Prisma's $extends.query gives us
// the post-update row but NOT the pre-update row. We populate
// `changes[].to` from the user's `args.data` payload and leave
// `from: null`. ActiveRecord's `saved_changes` gives both for free;
// Prisma does not. See AGENT_PARITY_NOTES.md.

import { logger } from "../logger.js";
import {
  emitDbEvent,
  resolveDisplayName,
  type DbAttributeChange,
  type DbOperation,
} from "./shared.js";

type PrismaOperation =
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

const CAPTURED_OPERATIONS: ReadonlySet<PrismaOperation> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

const OPERATION_TO_DB_OPERATION: Record<PrismaOperation, DbOperation> = {
  create: "create",
  createMany: "create",
  createManyAndReturn: "create",
  update: "update",
  updateMany: "update",
  upsert: "update",
  delete: "destroy",
  deleteMany: "destroy",
};

// The shape the Prisma client extension callback receives. We type this
// loosely so we don't take a hard dep on @prisma/client types — the
// peer dep is optional, and users on different Prisma majors will
// have differently-shaped types anyway.
interface QueryExtensionContext {
  model: string;
  operation: string;
  args: { data?: unknown; where?: unknown; create?: unknown; update?: unknown };
  query: (args: unknown) => Promise<unknown>;
}

// Public factory. Returns the object literal that Prisma's
// `client.$extends({...})` accepts. Typed as `unknown` because the
// Prisma `Extension` shape is generic over the client and we don't
// want to take a hard type dep.
export function ezlogsPrisma(): unknown {
  return {
    name: "ezlogs",
    query: {
      $allModels: {
        async $allOperations(ctx: QueryExtensionContext) {
          if (!CAPTURED_OPERATIONS.has(ctx.operation as PrismaOperation)) {
            return ctx.query(ctx.args);
          }

          const result = await ctx.query(ctx.args);
          try {
            recordPrismaOperation(ctx, result);
          } catch (error) {
            logger.debug(`prisma capture failed: ${describeError(error)}`);
          }
          return result;
        },
      },
    },
  };
}

function recordPrismaOperation(
  ctx: QueryExtensionContext,
  result: unknown,
): void {
  const dbOperation = OPERATION_TO_DB_OPERATION[ctx.operation as PrismaOperation];
  if (!dbOperation) return;

  // Each Prisma operation returns differently-shaped results. We
  // normalize: single-row ops return one row (we emit one event),
  // batch ops return { count } — we emit nothing per row but a single
  // batch-shaped event with no resourceId.
  if (isBatchResult(result)) {
    emitDbEvent({
      modelClass: ctx.model,
      operation: dbOperation,
      resourceId: null,
      // For batch updates we still capture the `args.data` shape so
      // downstream sees what columns were touched even if we can't
      // identify a specific row.
      ...(dbOperation === "update" && isPlainObject(ctx.args.data)
        ? {
            changes: extractChangesFromUpdateData(ctx.args.data as Record<string, unknown>),
          }
        : {}),
      ...(dbOperation === "create" && isPlainObject(ctx.args.data)
        ? {
            initialAttributes: ctx.args.data as Record<string, unknown>,
          }
        : {}),
    });
    return;
  }

  // Single-row result. Prisma's `delete` returns the deleted row, so
  // we have a usable id even on destroy.
  if (Array.isArray(result)) {
    // createManyAndReturn emits an array of created rows. Emit one
    // event per row so each gets its own resource_id.
    for (const row of result) {
      emitSingleRowEvent(ctx, dbOperation, row);
    }
    return;
  }

  emitSingleRowEvent(ctx, dbOperation, result);
}

function emitSingleRowEvent(
  ctx: QueryExtensionContext,
  dbOperation: DbOperation,
  row: unknown,
): void {
  if (!isPlainObject(row)) {
    emitDbEvent({
      modelClass: ctx.model,
      operation: dbOperation,
      resourceId: null,
    });
    return;
  }

  const rowObj = row as Record<string, unknown>;
  const resourceId = (rowObj.id ?? null) as string | number | bigint | null;
  const displayName = resolveDisplayName(ctx.model, rowObj);

  if (dbOperation === "create") {
    emitDbEvent({
      modelClass: ctx.model,
      operation: "create",
      resourceId,
      initialAttributes: extractCreateAttributes(ctx, rowObj),
      displayName,
      modelInstance: rowObj,
    });
    return;
  }

  if (dbOperation === "update") {
    emitDbEvent({
      modelClass: ctx.model,
      operation: "update",
      resourceId,
      changes: extractUpdateChangesFromArgs(ctx, rowObj),
      displayName,
      modelInstance: rowObj,
    });
    return;
  }

  // destroy: no attribute snapshot, just display name.
  emitDbEvent({
    modelClass: ctx.model,
    operation: "destroy",
    resourceId,
    displayName,
    modelInstance: rowObj,
  });
}

// For create: prefer the user-provided `args.data` (so we capture
// what they intended to set), fall back to the returned row (so we
// pick up DB-generated defaults like timestamps).
function extractCreateAttributes(
  ctx: QueryExtensionContext,
  resultRow: Record<string, unknown>,
): Record<string, unknown> {
  if (isPlainObject(ctx.args.data)) {
    return ctx.args.data as Record<string, unknown>;
  }
  if (ctx.operation === "upsert" && isPlainObject(ctx.args.create)) {
    return ctx.args.create as Record<string, unknown>;
  }
  return resultRow;
}

// For update: we don't know the "from" values without a pre-SELECT,
// so we populate `to` from the result row (which is post-update) for
// every column the user touched in `args.data`, and leave `from` null.
function extractUpdateChangesFromArgs(
  ctx: QueryExtensionContext,
  resultRow: Record<string, unknown>,
): DbAttributeChange[] {
  const data =
    isPlainObject(ctx.args.data)
      ? (ctx.args.data as Record<string, unknown>)
      : ctx.operation === "upsert" && isPlainObject(ctx.args.update)
        ? (ctx.args.update as Record<string, unknown>)
        : null;
  if (!data) return [];

  return Object.keys(data).map((attribute) => ({
    attribute,
    from: null,
    to: resultRow[attribute] ?? data[attribute],
  }));
}

// updateMany without a row to point at — still record the touched
// columns. `from: null`, `to: <value from data>`.
function extractChangesFromUpdateData(
  data: Record<string, unknown>,
): DbAttributeChange[] {
  return Object.keys(data).map((attribute) => ({
    attribute,
    from: null,
    to: data[attribute],
  }));
}

function isBatchResult(value: unknown): value is { count: number } {
  return (
    isPlainObject(value) &&
    typeof (value as Record<string, unknown>).count === "number" &&
    Object.keys(value as Record<string, unknown>).length === 1
  );
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  return true;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
