// Prisma DB capture.
//
// Returns a Prisma client extension that hooks every model operation.
// Usage:
//
//   import { PrismaClient } from "@prisma/client"
//   import { ezlogsPrisma } from "ezlogs-nextjs/prisma"
//
//   const prisma = new PrismaClient().$extends(ezlogsPrisma())
//
// We capture only mutations: create, createMany, upsert, update,
// updateMany, delete, deleteMany. Reads pass through unchanged.
// Parity with Ruby's database_capturer.rb, which only fires on
// after_create / after_update / after_destroy.
//
// Known gap: for update operations Prisma's $extends.query gives us
// the post-update row but NOT the pre-update row. We send `changes[].to`
// for the columns in `args.data` and OMIT `from` (unknown, not empty).
// ActiveRecord's `saved_changes` gives both for free; Prisma does not.
// With the trigger path installed this extension emits nothing for
// trigger-tracked tables (the trigger sees real before-values); it only
// tags writes with the request's correlation id. See
// AGENT_PARITY_NOTES.md.

import { logger } from "../logger.js";
import { makeAsyncContextCapture } from "../edge-fallback.js";
import { current as currentCorrelation } from "../correlation.js";
import { configuration } from "../configuration.js";
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
  /** Prisma internal; `.transaction` is set inside a user transaction. */
  __internalParams?: { transaction?: unknown };
}

/** The parts of a PrismaClient the correlation tagging needs. */
interface TaggingClient {
  $extends: (ext: unknown) => unknown;
  $transaction: (queries: unknown[]) => Promise<unknown[]>;
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => unknown;
}

/**
 * Public factory for `prisma.$extends(ezlogsPrisma())`.
 *
 * Returns Prisma's callback-form extension (what
 * `Prisma.defineExtension((client) => …)` returns) so the hook can
 * reach the client for correlation tagging: every write made inside a
 * captured request runs as
 *
 *   client.$transaction([
 *     client.$executeRawUnsafe("SELECT set_config('ezlogs.correlation_id', $1, TRUE)", id),
 *     query(args),
 *   ])
 *
 * — Prisma's documented RLS client-extension pattern. The audit
 * trigger reads that setting, so rows from a plain `PrismaClient`
 * (default engine, no driver adapter) join the right request. Reads
 * pass through with no extra query.
 *
 * Not tagged (rows ship as their own actions, never misattributed):
 * writes inside a user `$transaction` (batch or interactive) — Prisma
 * can't nest a transaction there.
 */
export function ezlogsPrisma(): EzlogsPrismaExtension {
  return ((client: TaggingClient) =>
    client.$extends(buildPrismaExtension(client))) as EzlogsPrismaExtension;
}

/**
 * The type `Prisma.defineExtension((client) => …)` gives a query-only
 * extension (no added result / model / client members), spelled out so
 * `$extends(ezlogsPrisma())` type-checks on Prisma 5, 6 and 7 without
 * importing `@prisma/client` types, and the extended client keeps
 * every model type unchanged.
 */
export type EzlogsPrismaExtension = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
) => {
  // eslint-disable-next-line @typescript-eslint/ban-types
  $extends: { extArgs: { result: {}; model: {}; query: {}; client: {} } };
};

/**
 * The extension descriptor. `client` null = capture only, no tagging
 * (the adapter-pg path tags via the patched `pg` driver instead).
 * `schemaClient` (defaults to `client`) is read for each model's table
 * name (`@@map`).
 * @internal exported for tests.
 */
export function buildPrismaExtension(
  client: TaggingClient | null,
  schemaClient: object | null = client,
): unknown {
  return {
    name: "ezlogs",
    query: {
      $allModels: {
        async $allOperations(ctx: QueryExtensionContext) {
          if (!CAPTURED_OPERATIONS.has(ctx.operation as PrismaOperation)) {
            return ctx.query(ctx.args);
          }

          const result = await runTagged(client, ctx);
          try {
            recordPrismaOperation(ctx, result, tableNameFor(schemaClient, ctx.model));
          } catch (error) {
            logger.debug(`prisma capture failed: ${describeError(error)}`);
          }
          return result;
        },
      },
      // Raw writes (`$executeRaw\`UPDATE …\``) aren't model operations.
      async $allOperations(ctx: QueryExtensionContext) {
        if (ctx.operation !== "$executeRaw" && ctx.operation !== "$executeRawUnsafe") {
          return ctx.query(ctx.args);
        }
        return runTagged(client, ctx);
      },
    },
  };
}

const SET_CORRELATION_SQL = "SELECT set_config('ezlogs.correlation_id', $1, TRUE)";

async function runTagged(
  client: TaggingClient | null,
  ctx: QueryExtensionContext,
): Promise<unknown> {
  if (!shouldTag(client, ctx)) return ctx.query(ctx.args);
  try {
    const results = await client!.$transaction([
      client!.$executeRawUnsafe(SET_CORRELATION_SQL, currentCorrelation()),
      ctx.query(ctx.args),
    ]);
    return results[1];
  } catch (error) {
    // e.g. Neon's HTTP adapter: no transactions. Nothing ran (the batch
    // is rejected up front, or rolled back), so run the write untagged
    // and stop tagging for this client (other clients are unaffected).
    if (!isTransactionUnsupported(error)) throw error;
    taggingDisabled.add(client!);
    logger.warn(
      "this Prisma client can't run transactions, so DB writes won't be linked to " +
        `their request (they still show up as their own actions): ${describeError(error)}`,
    );
    return ctx.query(ctx.args);
  }
}

// Keyed by the base client the extension was built for.
let taggingDisabled = new WeakSet<object>();

/** @internal test-only */
export function _resetPrismaTaggingForTests(): void {
  taggingDisabled = new WeakSet<object>();
}

/**
 * Tag only when it can matter and can't hurt:
 *   - the trigger reader is wired (auto-wire sets it only for Postgres
 *     URLs) — otherwise nobody reads the setting;
 *   - the client is Postgres (`set_config` is Postgres-only; MySQL /
 *     SQLite / SQL Server / MongoDB clients are left untouched);
 *   - a request correlation id exists;
 *   - not inside a user $transaction. The only signal is Prisma's
 *     internal `__internalParams.transaction` (same on 5.22 / 6.19 /
 *     7.10); if a future Prisma drops `__internalParams`, we stop
 *     tagging rather than risk a nested transaction.
 */
function shouldTag(client: TaggingClient | null, ctx: QueryExtensionContext): boolean {
  if (!client || taggingDisabled.has(client)) return false;
  if (configuration().databaseReader == null) return false;
  if (!isPostgresClient(client)) return false;
  if (typeof client.$transaction !== "function" || typeof client.$executeRawUnsafe !== "function") {
    return false;
  }
  if (!currentCorrelation()) return false;
  const params = ctx.__internalParams;
  return params != null && !params.transaction;
}

function isPostgresClient(client: TaggingClient): boolean {
  const c = client as {
    _activeProvider?: unknown;
    _engineConfig?: { activeProvider?: unknown };
  };
  const provider = c._activeProvider ?? c._engineConfig?.activeProvider;
  // Unknown (future internals): rely on the reader being wired, which
  // only happens for Postgres.
  if (typeof provider !== "string") return true;
  return provider === "postgresql" || provider === "postgres";
}

function isTransactionUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /transaction/i.test(message) && /not (?:be )?supported|unsupported|not available/i.test(message);
}

/**
 * The model's database table (`@@map("projects")` -> `projects`), from
 * the client's runtime data model (DMMF). Falls back to the model name.
 */
function tableNameFor(schemaClient: object | null, model: string): string {
  try {
    const dbName = (
      schemaClient as { _runtimeDataModel?: { models?: Record<string, { dbName?: unknown }> } } | null
    )?._runtimeDataModel?.models?.[model]?.dbName;
    return typeof dbName === "string" && dbName.length > 0 ? dbName : model;
  } catch {
    return model;
  }
}

function recordPrismaOperation(
  ctx: QueryExtensionContext,
  result: unknown,
  table: string,
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
      table,
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
      emitSingleRowEvent(ctx, dbOperation, row, table);
    }
    return;
  }

  emitSingleRowEvent(ctx, dbOperation, result, table);
}

function emitSingleRowEvent(
  ctx: QueryExtensionContext,
  dbOperation: DbOperation,
  row: unknown,
  table: string,
): void {
  if (!isPlainObject(row)) {
    emitDbEvent({
      modelClass: ctx.model,
      table,
      operation: dbOperation,
      resourceId: null,
    });
    return;
  }

  const rowObj = row as Record<string, unknown>;
  const resourceId = (rowObj.id ?? null) as string | number | bigint | null;
  const displayName = resolveDisplayName(ctx.model, rowObj);

  if (dbOperation === "create") {
    // The returned row over `args.data`: the row carries DB defaults
    // (`status: "draft"`) and generated values; `args.data` fills the
    // columns a `select` left out. Relation writes in `args.data`
    // (`{ connect: … }`) are non-scalar and get filtered.
    emitDbEvent({
      modelClass: ctx.model,
      table,
      operation: "create",
      resourceId,
      initialAttributes: {
        ...(isPlainObject(ctx.args.data) ? (ctx.args.data as Record<string, unknown>) : {}),
        ...rowObj,
      },
      displayName,
      modelInstance: rowObj,
    });
    return;
  }

  if (dbOperation === "update") {
    emitDbEvent({
      modelClass: ctx.model,
      table,
      operation: "update",
      resourceId,
      changes: extractUpdateChangesFromArgs(ctx, rowObj),
      displayName,
      modelInstance: rowObj,
    });
    return;
  }

  // destroy: Prisma returns the deleted row — ship it as the pre-state.
  emitDbEvent({
    modelClass: ctx.model,
    table,
    operation: "destroy",
    resourceId,
    initialAttributes: rowObj,
    displayName,
    modelInstance: rowObj,
  });
}

// For update: we don't know the "from" values without a pre-SELECT,
// so we populate `to` from the result row (which is post-update) for
// every column the user touched in `args.data`, and omit `from`.
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
    to: resultRow[attribute] ?? data[attribute],
  }));
}

// updateMany without a row to point at — still record the touched
// columns. `from` omitted, `to: <value from data>`.
function extractChangesFromUpdateData(
  data: Record<string, unknown>,
): DbAttributeChange[] {
  return Object.keys(data).map((attribute) => ({
    attribute,
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

// ---------------------------------------------------------------------
// patchPrismaClient + patchPrismaPgAdapter — correlation-preserving
// wrappers around PrismaClient + adapter-pg.
// ---------------------------------------------------------------------
//
// Customer wires both at startup:
//
//   import { patchPrismaClient, patchPrismaPgAdapter } from "ezlogs-nextjs/prisma";
//   import { PrismaClient } from "@prisma/client";
//   import { PrismaPg } from "@prisma/adapter-pg";
//
//   const adapter = patchPrismaPgAdapter(new PrismaPg(pool));
//   export const prisma = patchPrismaClient(new PrismaClient({ adapter }), adapter);
//
// Why two wrappers (instead of just one around PrismaClient): empirical
// testing against real @prisma/adapter-pg proved that capturing
// `AsyncLocalStorage.snapshot()` at the customer's Prisma method call
// does NOT survive Prisma's NAPI engine boundary. The engine's
// reply-to-adapter callback fires in a context where async_hooks has
// no record of the caller — so a snapshot captured at the JS call
// site never reaches the adapter's `pool.query`. Audit rows land
// with NULL correlation_id, same as the original bug.
//
// The fix has to inject the snapshot AT the adapter boundary, on the
// JS side of the engine's roundtrip. So we wrap:
//
//   1. `patchPrismaPgAdapter` — replaces `queryRaw`, `executeRaw`,
//      `transactionContext` on the adapter so each one runs the
//      original method inside a snapshot the adapter has stored
//      synchronously. The snapshot lives on the adapter instance.
//
//   2. `patchPrismaClient` — Proxy on the PrismaClient that, before
//      delegating to the original method, enters a per-adapter
//      serialization mutex, sets `adapter._ezlogsCurrentSnapshot`,
//      awaits the method, then clears. Serialization is necessary
//      because a single mutable field on the adapter can't carry
//      per-call state under concurrency. The mutex serializes
//      Prisma method calls at the adapter level — a real perf cost
//      we trade for correctness while v0.1.x.
//
// Why we don't auto-detect or auto-patch from `ezlogs.init`: the
// agent doesn't own the adapter or PrismaClient construction.
// Explicit wiring matches Sentry / Datadog / OTel patterns for
// Prisma and surfaces the perf trade-off to the customer.
//
// Why a Proxy (not method enumeration) on the client: we'd otherwise
// have to statically list every dynamically-generated model property
// (`prisma.user`, `prisma.order`, …) at wrap time.

/** Brand we attach to wrapped clients so a double-wrap is a no-op. */
const EZLOGS_PRISMA_BRAND = Symbol.for("ezlogs-nextjs:prismaPatched");

/** Brand we attach to wrapped adapters so a double-wrap is a no-op. */
const EZLOGS_ADAPTER_BRAND = Symbol.for("ezlogs-nextjs:prismaPgAdapterPatched");

/**
 * Field name on the adapter where `patchPrismaClient` deposits the
 * snapshot for `patchPrismaPgAdapter`'s wrappers to pick up.
 *
 * Symbol-keyed so it can't collide with adapter-pg's own fields.
 */
const ADAPTER_SNAPSHOT_KEY = Symbol.for("ezlogs-nextjs:prismaPgSnapshot");

/**
 * Field name on the adapter holding the serialization mutex tail.
 *
 * Patched clients append to this chain so adapter callbacks always
 * see the snapshot for their own call, never one set by a later
 * concurrent call.
 */
const ADAPTER_MUTEX_KEY = Symbol.for("ezlogs-nextjs:prismaPgMutex");

interface PatchedAdapter {
  [ADAPTER_SNAPSHOT_KEY]?: (<R>(fn: () => R) => R) | null;
  [ADAPTER_MUTEX_KEY]?: Promise<void>;
  [EZLOGS_ADAPTER_BRAND]?: true;
}

/**
 * Top-level PrismaClient methods we know are async or return
 * thenables that the engine schedules continuations off of. Wrapping
 * these in the ALS snapshot is what restores correlation across the
 * engine boundary. Other top-level properties (`$on`, `$use`,
 * `$disconnect`, `$connect`, …) pass through unwrapped.
 *
 * `$extends` returns a wrapped client; we leave it un-snapshotted at
 * the top level because the customer calling `prisma.$extends(...)` is
 * happening at app-init time, outside any request scope. The result
 * goes through the Proxy on subsequent calls.
 */
const RAW_METHODS: ReadonlySet<string> = new Set([
  "$transaction",
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
  "$runCommandRaw",
]);

/**
 * PrismaClient model delegate methods that we wrap. Static list rather
 * than "wrap every function value" because the delegate also exposes
 * `fields` (a non-function metadata accessor in Prisma 5+) that we
 * shouldn't touch. The list mirrors the Prisma docs' CRUD surface.
 */
const MODEL_METHODS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Wrap a `PrismaPg` adapter so its queryRaw/executeRaw/transactionContext
 * methods run inside a snapshot the partnered `patchPrismaClient` deposits.
 * Idempotent — passing a previously-wrapped adapter returns it unchanged.
 *
 * Customer wires this BEFORE constructing the PrismaClient:
 *
 *   const adapter = patchPrismaPgAdapter(new PrismaPg(pool));
 *   const prisma = patchPrismaClient(new PrismaClient({ adapter }), adapter);
 *
 * Without this wrap, the snapshot we capture at the Prisma call site
 * dies at the engine's NAPI boundary before adapter-pg's pool.query
 * runs — the production bug. With it, the wrap reads the synchronously-
 * deposited snapshot off the adapter and re-enters it just before
 * the wrapped method delegates to the real adapter, restoring the
 * agent's correlation/actor frames for the eventual SET LOCAL.
 */
export function patchPrismaPgAdapter<A extends object>(adapter: A): A {
  if (!adapter || typeof adapter !== "object") return adapter;
  const adapterRec = adapter as PatchedAdapter & Record<string, unknown>;
  if (adapterRec[EZLOGS_ADAPTER_BRAND] === true) return adapter;

  for (const method of ["queryRaw", "executeRaw", "transactionContext"] as const) {
    const original = adapterRec[method];
    if (typeof original !== "function") continue;
    adapterRec[method] = function ezlogsPatchedAdapterMethod(
      this: object,
      ...args: unknown[]
    ): unknown {
      const snapshot = adapterRec[ADAPTER_SNAPSHOT_KEY];
      const invoke = () =>
        (original as (...a: unknown[]) => unknown).apply(this, args);
      if (snapshot) return snapshot(invoke);
      return invoke();
    };
  }

  adapterRec[EZLOGS_ADAPTER_BRAND] = true;
  return adapter;
}

/**
 * Wrap a PrismaClient so every async method preserves the caller's
 * AsyncLocalStorage context across the engine boundary. Idempotent.
 *
 * Composes `prisma.$extends(ezlogsPrisma())` internally so customers
 * only have to write one wiring line for capture. If `adapter` is
 * passed and is the result of `patchPrismaPgAdapter`, the Proxy uses
 * an adapter-level serialization mutex to deposit the snapshot on the
 * adapter synchronously before each method call and clear it after —
 * the only correct way to thread per-call context through Prisma's
 * NAPI engine boundary. Without the adapter arg, the wrapper still
 * applies the capture extension but cannot fix the correlation bug;
 * see `patchPrismaPgAdapter`'s docstring for the explanation.
 *
 * The returned value is typed as the same shape as the input. We
 * cast back to `T` because runtime Proxy preserves the surface but
 * TypeScript can't follow this through a generic.
 */
export function patchPrismaClient<T extends object>(
  prisma: T,
  adapter?: object,
): T {
  if (!prisma || typeof prisma !== "object") {
    // Defensive: don't crash on a misuse, just return as-is. The
    // engine boundary is the only thing that breaks correlation;
    // a missing PrismaClient breaks the customer's app at a much
    // louder layer than ours.
    return prisma;
  }

  if ((prisma as Record<symbol, unknown>)[EZLOGS_PRISMA_BRAND] === true) {
    return prisma;
  }

  const captureAndRun = makeAsyncContextCapture();
  if (!captureAndRun) {
    logger.debug(
      "patchPrismaClient: AsyncLocalStorage.snapshot() unavailable; " +
        "skipping ALS bind, applying ezlogsPrisma() only.",
    );
    return applyEzlogsExtension(prisma);
  }

  const patchedAdapter =
    adapter &&
    typeof adapter === "object" &&
    (adapter as PatchedAdapter)[EZLOGS_ADAPTER_BRAND] === true
      ? (adapter as PatchedAdapter)
      : null;

  if (adapter && !patchedAdapter) {
    // Customer passed an adapter but forgot to wrap it. The
    // correlation fix won't work without the adapter wrap; surface
    // it loudly in dev so they don't ship the half-fixed config.
    logger.debug(
      "patchPrismaClient: adapter is not the output of " +
        "patchPrismaPgAdapter(). Correlation_id will be NULL on " +
        "concurrent requests. Wrap the adapter first.",
    );
  }

  const extended = applyEzlogsExtension(prisma);
  const wrapped = buildClientProxy(extended, captureAndRun, patchedAdapter);
  return wrapped as T;
}

function applyEzlogsExtension<T extends object>(prisma: T): T {
  const client = prisma as { $extends?: (ext: unknown) => T };
  if (typeof client.$extends !== "function") {
    // Either not a PrismaClient or already-extended-and-frozen. Pass
    // through; capture stops working but the caller's app keeps
    // running.
    logger.debug(
      "patchPrismaClient: client has no $extends; skipping ezlogsPrisma extension.",
    );
    return prisma;
  }
  try {
    // No tagging here: the adapter-pg path tags via the patched `pg`
    // driver, and a nested $transaction would deadlock on the
    // per-adapter mutex below.
    return client.$extends(buildPrismaExtension(null, prisma)) as T;
  } catch (error) {
    logger.debug(`patchPrismaClient: $extends failed: ${describeError(error)}`);
    return prisma;
  }
}

/**
 * Factory shape from `makeAsyncContextCapture`. Calling this captures
 * the ALS context at the moment of the call and returns a runner that
 * re-establishes it. Captured lazily, per Prisma-method invocation —
 * NOT once at agent init (init-time scope is empty).
 */
type CaptureAndRun = () => <R>(fn: () => R) => R;

function buildClientProxy<T extends object>(
  client: T,
  captureAndRun: CaptureAndRun,
  adapter: PatchedAdapter | null,
): T {
  const modelProxyCache = new WeakMap<object, unknown>();

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === EZLOGS_PRISMA_BRAND) return true;

      const value = Reflect.get(target, prop, receiver);

      if (typeof prop !== "string") return value;

      if (RAW_METHODS.has(prop) && typeof value === "function") {
        return bindFunctionInSnapshot(value as Function, target, captureAndRun, adapter);
      }

      // Model delegate access. PrismaClient's models are non-enumerable
      // accessor properties whose value is a delegate object with the
      // CRUD methods on it. We wrap the delegate on first access and
      // memoize so identity is stable for the caller (some libs cache
      // `prisma.user` by reference).
      if (isLikelyModelDelegate(value)) {
        const cached = modelProxyCache.get(value as object);
        if (cached) return cached;
        const wrappedDelegate = buildModelProxy(value as object, captureAndRun, adapter);
        modelProxyCache.set(value as object, wrappedDelegate);
        return wrappedDelegate;
      }

      return value;
    },
  }) as T;
}

function buildModelProxy(
  delegate: object,
  captureAndRun: CaptureAndRun,
  adapter: PatchedAdapter | null,
): unknown {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        MODEL_METHODS.has(prop) &&
        typeof value === "function"
      ) {
        return bindFunctionInSnapshot(value as Function, target, captureAndRun, adapter);
      }
      return value;
    },
  });
}

/**
 * Wrap a Prisma method so that:
 *
 *   1. The method call itself runs inside the captured ALS snapshot.
 *      `await prisma.user.create(...)` schedules promise continuations
 *      that the engine threads back through the adapter; the snapshot
 *      re-establishes the agent's ALS frame for every one of them.
 *
 *   2. Any function arguments (notably `$transaction(async tx => …)`'s
 *      callback) are also wrapped, so the tx body runs inside the
 *      snapshot — its DB writes go through `patchPgClient` with the
 *      correct correlation id even though Prisma's `$transaction`
 *      internally crosses an async boundary before invoking the user
 *      callback.
 *
 * The snapshot is captured LAZILY at call time (`captureAndRun()`),
 * NOT at patch time — agent init runs before any request scope is
 * open, so an init-time snapshot would be empty.
 *
 * The returned wrapper preserves `this` via the captured `target`
 * (a model delegate or the PrismaClient itself). Forwarding through
 * Reflect.apply keeps argument arity and `arguments`-shape intact.
 */
function bindFunctionInSnapshot(
  fn: Function,
  thisArg: object,
  captureAndRun: CaptureAndRun,
  adapter: PatchedAdapter | null,
): Function {
  return function bound(this: unknown, ...args: unknown[]): unknown {
    const run = captureAndRun();
    const boundArgs = args.map((a) =>
      typeof a === "function"
        ? wrapCallbackInSnapshot(a as Function, run)
        : a,
    );
    const invoke = () => Reflect.apply(fn, thisArg, boundArgs);

    // No partnered adapter — fall back to the snapshot-only path.
    // Correctness depends on async_hooks propagating through the
    // engine boundary, which empirically it doesn't on adapter-pg;
    // this branch is the "best-effort" path for drivers we haven't
    // proven the bug on.
    if (!adapter) return run(invoke);

    // Adapter-wrap path: serialize Prisma method calls per-adapter
    // so the snapshot deposited on `adapter[ADAPTER_SNAPSHOT_KEY]`
    // can't be clobbered by a concurrent call before the adapter
    // callback for THIS call has fired. The cost is real
    // per-adapter throughput; the gain is correlation correctness.
    return enterAdapterMutex(adapter, () =>
      run(() => {
        adapter[ADAPTER_SNAPSHOT_KEY] = run;
        let result: unknown;
        try {
          result = invoke();
        } catch (sync) {
          adapter[ADAPTER_SNAPSHOT_KEY] = null;
          throw sync;
        }
        // Most Prisma methods return a thenable; the adapter
        // callback fires after that promise's continuation. Clear
        // the snapshot only after the awaited result settles.
        if (isThenable(result)) {
          return (result as Promise<unknown>).finally(() => {
            adapter[ADAPTER_SNAPSHOT_KEY] = null;
          });
        }
        adapter[ADAPTER_SNAPSHOT_KEY] = null;
        return result;
      }),
    );
  };
}

/**
 * Per-adapter serialization. Maintains a single Promise chain on
 * `adapter[ADAPTER_MUTEX_KEY]`; each entry awaits the previous one
 * before running. Returns the entry's promise so callers can `await`
 * the whole thing.
 */
function enterAdapterMutex<R>(
  adapter: PatchedAdapter,
  body: () => R | Promise<R>,
): Promise<R> {
  const prev = adapter[ADAPTER_MUTEX_KEY] ?? Promise.resolve();
  const next = prev.then(() => body());
  // Chain the NEXT entry off this body's completion, regardless of
  // whether it threw — otherwise one failed call wedges the mutex.
  adapter[ADAPTER_MUTEX_KEY] = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function wrapCallbackInSnapshot(
  cb: Function,
  run: <R>(fn: () => R) => R,
): Function {
  return function wrapped(this: unknown, ...args: unknown[]) {
    return run(() => Reflect.apply(cb, this, args));
  };
}

function isLikelyModelDelegate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  // PrismaClient model delegates always expose `create` and `findMany`
  // as functions. Probing both keeps false-positives off random plain
  // objects exposed off the client (`prisma.$on` returns a function,
  // for instance, not an object).
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.create === "function" &&
    typeof candidate.findMany === "function"
  );
}
