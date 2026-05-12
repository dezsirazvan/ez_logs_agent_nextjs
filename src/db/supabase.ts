// Supabase JS DB capture.
//
// Wraps a supabase-js client so every mutating call through
// supabase.from(<table>) emits a database_callback event with the
// canonical wire shape.
//
// Usage:
//
//   import { createClient } from "@supabase/supabase-js"
//   import { wrapSupabase } from "ezlogs-nextjs/supabase"
//
//   const supabase = wrapSupabase(createClient(url, anonKey))
//
// What's captured per method:
//   .insert(values)  -> create event with initial_attributes
//   .upsert(values)  -> update event (the typical Supabase upsert is
//                       conceptually an update with insert fallback)
//   .update(values)  -> update event with changes from `values`
//   .delete()        -> destroy event
//
// resource_id population:
//   - When the user chains .select() (the now-recommended supabase
//     pattern for getting back the affected rows), we read the id
//     from the resolved `data`.
//   - Otherwise resource_id is null. supabase-js doesn't return row
//     state by default. Documented as a partial-data condition.
//
// Known parity gap (documented in AGENT_PARITY_NOTES.md): no real
// before/after for updates. We populate `to:` from the user-passed
// values and leave `from: null`. Same gap as Prisma.

import { logger } from "../logger.js";
import { configuration } from "../configuration.js";
import {
  emitDbEvent,
  resolveDisplayName,
  type DbAttributeChange,
  type DbOperation,
} from "./shared.js";

/**
 * Returns true when the trigger path will be the authoritative source
 * for `table`'s writes — i.e. `databaseReader` is wired AND we've
 * confirmed `ezlogs_audit` is attached to `table`. In that case the
 * supabase adapter's emit is suppressed (gate in `emitDbEvent`), and
 * any pre-read we do here would be thrown away. Skip it.
 *
 * When detection is still null (in flight or failed) we DON'T skip:
 * losing the `from` value is a worse outcome than one wasted SELECT,
 * and the suppress-all gate keeps the dashboard quiet anyway.
 */
function triggerPathWillCapture(table: string): boolean {
  const config = configuration();
  if (!config.databaseReader) return false;
  const tracked = config.triggerTrackedTables;
  if (tracked === null) return false;
  return tracked.has(table);
}

interface SupabaseClientLike {
  from: (table: string) => SupabaseQueryBuilder;
  auth?: SupabaseAuthLike;
}

interface SupabaseAuthLike {
  getUser?: () => Promise<{
    data?: { user?: SupabaseUser | null };
    error?: unknown;
  }>;
}

interface SupabaseUser {
  id?: string;
  email?: string | null;
  user_metadata?: { name?: string; full_name?: string };
}

interface SupabaseQueryBuilder {
  insert: (values: unknown, options?: unknown) => SupabaseFilterBuilder;
  upsert: (values: unknown, options?: unknown) => SupabaseFilterBuilder;
  update: (values: unknown, options?: unknown) => SupabaseFilterBuilder;
  delete: (options?: unknown) => SupabaseFilterBuilder;
  select?: (...args: unknown[]) => SupabaseFilterBuilder;
  // ...other read methods like .rpc on related shapes — left untyped,
  // we only intercept mutations.
}

interface SupabaseFilterBuilder {
  // The chainable result of a mutation. supabase-js calls these
  // PostgrestFilterBuilder + PostgrestTransformBuilder. We treat
  // them as a thenable that resolves to { data, error, ... }.
  then?: PromiseLike<unknown>["then"];
}

interface PostgrestResult {
  data: unknown;
  error: unknown;
  status?: number;
}

/**
 * Public entry. Returns the same client object with `.from()` swapped
 * for an instrumented version. Rest of the client (auth, storage,
 * realtime, rpc) is untouched.
 *
 * Typed as a pass-through `<T>(client: T): T` so callers keep the
 * exact `SupabaseClient<Database, ...>` typing they had. Internal
 * narrowing via duck-typing — we don't constrain T because Supabase's
 * generated types vary across versions and any structural constraint
 * here would force users into casts.
 *
 * Most users don't need to call this directly — `ezlogs.init()`
 * patches the supabase-js prototype automatically. This export remains
 * for users who construct clients in unusual ways and want explicit
 * per-client wrapping.
 */
export function wrapSupabase<T>(client: T): T {
  if (client === null || typeof client !== "object") return client;

  const obj = client as unknown as SupabaseClientLike & {
    __ezlogsWrapped?: boolean;
  };
  if (obj.__ezlogsWrapped) return client;
  if (typeof obj.from !== "function") return client;

  const originalFrom = obj.from.bind(obj) as (
    table: string,
  ) => SupabaseQueryBuilder;

  // Pre-read closure: given a table + a set of equality filters, fetch
  // the current row BEFORE the user's mutation runs so we can produce
  // a real before/after diff. We chain every captured `.eq()` so the
  // pre-read narrows to the same row(s) the mutation will hit — this
  // matters for patterns like `.update(...).eq('id', X).eq('tenant_id', Y)`
  // where the secondary filter is a security/scope check. We use the
  // SAME client (with auth cookies and RLS context) so the pre-read
  // sees what the user's session is allowed to see. Failures fall back
  // to "after-only" diffs.
  const prereadRow = async (
    table: string,
    filters: ReadonlyArray<{ column: string; value: unknown }>,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const queryBuilder = originalFrom(table) as SupabaseQueryBuilder & {
        select?: (...args: unknown[]) => SupabaseFilterBuilder;
      };
      if (typeof queryBuilder.select !== "function") return null;
      let chain = queryBuilder.select("*") as Record<string, unknown> &
        SupabaseFilterBuilder;
      for (const f of filters) {
        if (typeof chain.eq !== "function") return null;
        chain = (chain.eq as (c: string, v: unknown) => SupabaseFilterBuilder)(
          f.column,
          f.value,
        ) as Record<string, unknown> & SupabaseFilterBuilder;
      }
      if (typeof chain.maybeSingle === "function") {
        chain = (chain.maybeSingle as () => SupabaseFilterBuilder)() as Record<
          string,
          unknown
        > &
          SupabaseFilterBuilder;
      } else if (typeof chain.limit === "function") {
        chain = (chain.limit as (n: number) => SupabaseFilterBuilder)(
          1,
        ) as Record<string, unknown> & SupabaseFilterBuilder;
      }
      const result = (await (chain as unknown as Promise<PostgrestResult>));
      if (!result || result.error) return null;
      if (Array.isArray(result.data)) {
        const first = result.data[0];
        return isPlainObject(first)
          ? (first as Record<string, unknown>)
          : null;
      }
      return isPlainObject(result.data)
        ? (result.data as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  obj.from = ((table: string) => {
    const builder = originalFrom(table);
    return wrapBuilder(builder, table, prereadRow);
  }) as typeof obj.from;

  Object.defineProperty(obj, "__ezlogsWrapped", {
    value: true,
    enumerable: false,
    configurable: false,
  });

  // Register this client as a candidate actor source. The HTTP capture
  // will call `.auth.getUser()` on the most-recently-registered client
  // when `actorFromSupabase` is enabled (the default) and no other
  // actor has been set on the request scope.
  registerActorSource(obj);

  return client;
}

// ---- actor extraction ---------------------------------------------------

// Per-async-context "current Supabase client" — the most recent one
// constructed inside the current correlation scope. Stored on globalThis
// so it survives Next.js / Webpack / Turbopack module duplication.
const GLOBAL_CLIENT_KEY = Symbol.for("ezlogs-nextjs:supabase-current-client");

interface GlobalWithCurrentClient {
  [GLOBAL_CLIENT_KEY]?: SupabaseClientLike | null;
}

function registerActorSource(client: SupabaseClientLike): void {
  try {
    const g = globalThis as unknown as GlobalWithCurrentClient;
    g[GLOBAL_CLIENT_KEY] = client;
  } catch {
    // ignore — actor extraction is best-effort
  }
}

/**
 * Returns the current actor (if any) by asking the most-recently-
 * registered Supabase client for its authenticated user. Returns null
 * when no client is registered or the call fails. Used by the HTTP
 * capturer's default `actorFromSupabase` path.
 *
 * Cheap-but-not-free: each call is a Supabase auth roundtrip. Callers
 * should cache the result for the duration of a request.
 */
export async function tryExtractSupabaseActor(): Promise<{
  id: string;
  label?: string;
} | null> {
  const g = globalThis as unknown as GlobalWithCurrentClient;
  const client = g[GLOBAL_CLIENT_KEY];
  if (!client || typeof client.auth?.getUser !== "function") return null;

  try {
    const { data } = await client.auth.getUser();
    const user = data?.user;
    if (!user || typeof user.id !== "string" || !user.id) return null;
    const label =
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      user.email ??
      undefined;
    return label ? { id: user.id, label } : { id: user.id };
  } catch {
    return null;
  }
}

type PrereadFn = (
  table: string,
  filters: ReadonlyArray<{ column: string; value: unknown }>,
) => Promise<Record<string, unknown> | null>;

function wrapBuilder(
  builder: SupabaseQueryBuilder,
  table: string,
  preread: PrereadFn,
): SupabaseQueryBuilder {
  if (typeof builder.insert === "function") {
    builder.insert = wrapMutation(
      builder.insert.bind(builder),
      { table, operation: "create" },
      preread,
    );
  }
  if (typeof builder.upsert === "function") {
    builder.upsert = wrapMutation(
      builder.upsert.bind(builder),
      { table, operation: "update" }, // supabase upsert is conceptually update-with-fallback
      preread,
    );
  }
  if (typeof builder.update === "function") {
    builder.update = wrapMutation(
      builder.update.bind(builder),
      { table, operation: "update" },
      preread,
    );
  }
  if (typeof builder.delete === "function") {
    builder.delete = wrapDeleteMutation(
      builder.delete.bind(builder),
      table,
      preread,
    );
  }
  return builder;
}

interface MutationContext {
  table: string;
  operation: DbOperation;
}

function wrapMutation(
  original: (values: unknown, options?: unknown) => SupabaseFilterBuilder,
  ctx: MutationContext,
  preread: PrereadFn,
): (values: unknown, options?: unknown) => SupabaseFilterBuilder {
  return (values: unknown, options?: unknown) => {
    const filterBuilder = original(values, options);
    const filters = trackFilterChain(filterBuilder);
    // For UPDATEs we kick off a pre-read once the filter chain is
    // complete. We can't initiate it now because the user hasn't
    // chained .eq()/.match() yet — those calls happen between this
    // function returning and the user awaiting the builder. We piggy-
    // back on the .then() interception (instrumentFilterBuilder) which
    // fires at await time, by which point the filter chain is final.
    // Capture into a closure variable so the post-resolve emitter has
    // access to whatever pre-read produced. Pre-read is kicked off
    // BEFORE the user's mutation actually fires (we run it inside the
    // wrapped .then() before delegating to the original .then()).
    const beforeRowRef: { row: Record<string, unknown> | null } = { row: null };
    return instrumentFilterBuilder(
      filterBuilder,
      (result) => emitFromMutation(ctx, values, result, filters, beforeRowRef.row),
      async () => {
        if (ctx.operation !== "update") return;
        // Skip the pre-read when the trigger path will already capture
        // this table — its `old_row` carries the same before-state with
        // no extra round-trip. The adapter emit is suppressed downstream
        // so anything we read here would be discarded.
        if (triggerPathWillCapture(ctx.table)) return;
        const prereadFilters = prereadFiltersFromCaptured(filters);
        if (prereadFilters !== null) {
          beforeRowRef.row = await preread(ctx.table, prereadFilters);
        }
      },
    );
  };
}

function wrapDeleteMutation(
  original: (options?: unknown) => SupabaseFilterBuilder,
  table: string,
  preread: PrereadFn,
): (options?: unknown) => SupabaseFilterBuilder {
  return (options?: unknown) => {
    const filterBuilder = original(options);
    const filters = trackFilterChain(filterBuilder);
    // Pre-read closure for delete: we want the row state BEFORE the
    // delete fires so the dashboard can render "Deleted Hardware:
    // Dell Latitude 5540" instead of just an opaque id.
    const beforeRowRef: { row: Record<string, unknown> | null } = { row: null };
    return instrumentFilterBuilder(
      filterBuilder,
      (result) => emitFromDelete(table, result, filters, beforeRowRef.row),
      async () => {
        // Same skip rule as updates — trigger path's `old_row` has the
        // pre-state. No reason to round-trip again.
        if (triggerPathWillCapture(table)) return;
        const prereadFilters = prereadFiltersFromCaptured(filters);
        if (prereadFilters !== null) {
          beforeRowRef.row = await preread(table, prereadFilters);
        }
      },
    );
  };
}

// Filters captured from the postgrest filter chain. We don't need every
// operator — only the equality/IN/match cases that yield a usable
// resource id when the user doesn't chain `.select()`. When the user
// does chain `.select()` we get the full row from the result and these
// fall back to a secondary signal.
interface CapturedFilters {
  equals: Record<string, unknown>;
  /** Captured `.in('id', [...])` membership filters. */
  inLists: Record<string, unknown[]>;
}

/**
 * Patch the postgrest filter builder so subsequent .eq()/.in()/.match()
 * calls record their arguments. We mutate IN PLACE because the user's
 * code holds the same reference and chains directly on it. Returns the
 * captured-filters bag the emit-side reads to extract resource ids.
 */
function trackFilterChain(builder: SupabaseFilterBuilder): CapturedFilters {
  const captured: CapturedFilters = { equals: {}, inLists: {} };
  if (!builder || typeof builder !== "object") return captured;

  const builderObj = builder as Record<string, unknown> & SupabaseFilterBuilder;

  const wrapEq = (orig: unknown) => {
    if (typeof orig !== "function") return orig;
    return function patchedEq(this: unknown, column: unknown, value: unknown) {
      try {
        if (typeof column === "string") captured.equals[column] = value;
      } catch {
        // ignore — recording is best-effort
      }
      return (orig as (...a: unknown[]) => unknown).call(this, column, value);
    };
  };

  const wrapIn = (orig: unknown) => {
    if (typeof orig !== "function") return orig;
    return function patchedIn(this: unknown, column: unknown, values: unknown) {
      try {
        if (typeof column === "string" && Array.isArray(values)) {
          captured.inLists[column] = values;
        }
      } catch {
        // ignore
      }
      return (orig as (...a: unknown[]) => unknown).call(this, column, values);
    };
  };

  const wrapMatch = (orig: unknown) => {
    if (typeof orig !== "function") return orig;
    return function patchedMatch(this: unknown, query: unknown) {
      try {
        if (isPlainObject(query)) {
          for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
            captured.equals[k] = v;
          }
        }
      } catch {
        // ignore
      }
      return (orig as (...a: unknown[]) => unknown).call(this, query);
    };
  };

  if ("eq" in builderObj) builderObj.eq = wrapEq(builderObj.eq);
  if ("in" in builderObj) builderObj.in = wrapIn(builderObj.in);
  if ("match" in builderObj) builderObj.match = wrapMatch(builderObj.match);

  return captured;
}

// supabase-js builders are thenables — they only execute on await.
// We intercept the .then() so we can read the result and emit AFTER
// the call resolves (so we have access to row state when .select()
// was chained).
function instrumentFilterBuilder(
  builder: SupabaseFilterBuilder,
  onResolved: (result: PostgrestResult) => void,
  beforeFire?: () => Promise<void>,
): SupabaseFilterBuilder {
  if (!builder || typeof builder !== "object") return builder;

  const originalThen = builder.then?.bind(builder);
  if (typeof originalThen !== "function") return builder;

  const wrappedThen = function ezlogsThen<TResult1, TResult2>(
    this: SupabaseFilterBuilder,
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    // Run beforeFire FIRST (e.g. row pre-read) so the captured state
    // reflects the row BEFORE the user's mutation HTTP request goes
    // out. Then delegate to the original .then(), which actually
    // executes the mutation. Finally, on resolution, emit using the
    // pre-read state. The user's await still resolves with whatever
    // the original mutation returned — we don't change the outcome,
    // only insert one round-trip ahead of it for accuracy.
    return new Promise<TResult1 | TResult2>((resolve, reject) => {
      const proceed = (): void => {
        originalThen(
          (raw: unknown) => {
            const result = raw as PostgrestResult;
            try {
              if (!result?.error) onResolved(result);
            } catch (error) {
              logger.debug(`supabase capture failed: ${describeError(error)}`);
            }
            try {
              const passthrough = onfulfilled ? onfulfilled(raw) : (raw as TResult1);
              resolve(passthrough as TResult1);
            } catch (e) {
              reject(e);
            }
          },
          (reason: unknown) => {
            try {
              const passthrough = onrejected
                ? onrejected(reason)
                : (Promise.reject(reason) as unknown as TResult2);
              resolve(passthrough as TResult2);
            } catch (e) {
              reject(e);
            }
          },
        );
      };

      if (beforeFire) {
        beforeFire().then(proceed, () => proceed());
      } else {
        proceed();
      }
    });
  };
  (builder as { then: typeof wrappedThen }).then = wrappedThen;

  return builder;
}

function emitFromMutation(
  ctx: MutationContext,
  values: unknown,
  result: PostgrestResult | undefined,
  filters: CapturedFilters,
  beforeRow: Record<string, unknown> | null,
): void {
  // values can be a single row or an array of rows. We emit one event
  // per row for inserts when the array is small; we emit a single
  // batch-event with no row-id when bigger or when not-an-array.
  if (Array.isArray(values)) {
    const resultRows = pickResultRows(result);
    values.forEach((row, index) => {
      if (!isPlainObject(row)) return;
      // Pre-read only applies to single-row updates (we have one
      // filter id, one before-state). For arrays we don't have a
      // before-state per row.
      emitOneRow(ctx, row as Record<string, unknown>, resultRows[index] ?? null, filters, null);
    });
    return;
  }

  if (!isPlainObject(values)) {
    // No row payload, but the user may still have given us an id via
    // .eq('id', X) (common for `.delete().eq('id', ...)` style calls
    // that the postgrest builder routes through this path).
    emitDbEvent({
      modelClass: ctx.table,
      operation: ctx.operation,
      resourceId: idFromFilters(filters),
    });
    return;
  }

  const valueObj = values as Record<string, unknown>;
  const resultRow = pickFirstResultRow(result);
  emitOneRow(ctx, valueObj, resultRow, filters, beforeRow);
}

function emitOneRow(
  ctx: MutationContext,
  values: Record<string, unknown>,
  resultRow: Record<string, unknown> | null,
  filters: CapturedFilters,
  beforeRow: Record<string, unknown> | null,
): void {
  // Resolution order matches Ruby's behavior:
  //   1. Result row id (when user chained `.select()`)
  //   2. Values payload's `id` (when explicit on insert/upsert)
  //   3. Filter chain's id (when `.update().eq('id', X)` / `.match({id: X})`)
  // This is what makes the common pattern `.update({...}).eq('id', X)`
  // produce an event with the right resource_id even when the caller
  // doesn't chain `.select()` on the mutation.
  const resourceId = (resultRow?.id ??
    values.id ??
    idFromFilters(filters) ??
    null) as string | number | bigint | null;
  // Prefer the pre-read row for display name resolution — it carries
  // ALL columns of the live row, not just the fields the user is
  // changing. Falls back to the after-state and finally the values
  // payload.
  const merged = beforeRow ?? resultRow ?? values;
  const displayName = resolveDisplayName(ctx.table, merged);

  if (ctx.operation === "create") {
    emitDbEvent({
      modelClass: ctx.table,
      operation: "create",
      resourceId,
      initialAttributes: values,
      displayName,
      modelInstance: merged,
    });
    return;
  }

  if (ctx.operation === "update") {
    const changes = buildUpdateChanges(values, beforeRow);
    emitDbEvent({
      modelClass: ctx.table,
      operation: "update",
      resourceId,
      changes,
      displayName,
      modelInstance: merged,
    });
  }
}

function emitFromDelete(
  table: string,
  result: PostgrestResult,
  filters: CapturedFilters,
  beforeRow: Record<string, unknown> | null,
): void {
  const resultRow = pickFirstResultRow(result);
  // Resource id resolution: prefer the result row (when .select() was
  // chained), then the pre-read row, then the filter chain.
  const resourceId = (resultRow?.id ??
    beforeRow?.id ??
    idFromFilters(filters) ??
    null) as string | number | bigint | null;
  // Display name resolution: pre-read row gives us the row's full
  // state at deletion time, which is what the dashboard wants for
  // "Deleted Hardware: Dell Latitude 5540".
  const richestRow = resultRow ?? beforeRow;
  const displayName = richestRow ? resolveDisplayName(table, richestRow) : null;

  emitDbEvent({
    modelClass: table,
    operation: "destroy",
    resourceId,
    displayName,
    modelInstance: richestRow,
  });
}

/**
 * Pull a single-row pre-read key out of the captured filter chain.
 *
 * Returns the array of scalar `.eq()` filters to AND in the pre-read
 * SELECT. Pre-read only fires when an `id` equality is present —
 * without it the chain may match many rows (e.g. a bulk
 * `.update(...).eq('status','open')`), and a SELECT * over that range
 * is the wrong shape for "fetch the row about to be mutated."
 *
 * When `id` IS present, every other captured `.eq()` is ANDed in so
 * the pre-read narrows to the same row(s) the mutation will hit. This
 * matters for patterns like
 * `.update(...).eq('id', X).eq('asset_type', 'hardware')` — the second
 * filter is part of the customer's scope contract; the pre-read must
 * respect it.
 *
 * `.in()` membership lists are ignored: they target multiple rows.
 */
function prereadFiltersFromCaptured(
  filters: CapturedFilters,
): Array<{ column: string; value: string | number | bigint }> | null {
  const idValue = filters.equals["id"];
  if (!isScalarFilterValue(idValue)) return null;
  const out: Array<{ column: string; value: string | number | bigint }> = [];
  for (const column of Object.keys(filters.equals)) {
    const value = filters.equals[column];
    if (!isScalarFilterValue(value)) continue;
    out.push({ column, value });
  }
  return out;
}

/**
 * Returns the captured `id` value when the chain has an `id` equality.
 * Used as a fallback for resource_id when no pre-read row was
 * available (e.g. RLS denied the SELECT) and the user didn't chain
 * `.select()`. Tolerates additional `.eq()` filters alongside the
 * `id` one — the customer's scope filters don't change which row's
 * id we should attribute the event to.
 */
function idFromFilters(filters: CapturedFilters): string | number | bigint | null {
  const value = filters.equals["id"];
  return isScalarFilterValue(value) ? value : null;
}

function isScalarFilterValue(
  value: unknown,
): value is string | number | bigint {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  );
}

function buildUpdateChanges(
  values: Record<string, unknown>,
  beforeRow: Record<string, unknown> | null,
): DbAttributeChange[] {
  return Object.keys(values).map((attribute) => {
    const change: DbAttributeChange = {
      attribute,
      to: values[attribute],
    };
    // Only attach `from` when we actually have a pre-state for this
    // column. Setting `from: null` when we don't would mislead the
    // dashboard into rendering "empty → newVal" for every field.
    if (beforeRow && Object.prototype.hasOwnProperty.call(beforeRow, attribute)) {
      change.from = beforeRow[attribute];
    }
    return change;
  });
}

function pickFirstResultRow(
  result: PostgrestResult | undefined,
): Record<string, unknown> | null {
  if (!result || result.error) return null;
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    return isPlainObject(first) ? (first as Record<string, unknown>) : null;
  }
  if (isPlainObject(result.data)) return result.data as Record<string, unknown>;
  return null;
}

function pickResultRows(
  result: PostgrestResult | undefined,
): Array<Record<string, unknown> | undefined> {
  if (!result || result.error || !Array.isArray(result.data)) return [];
  return result.data.map((row) =>
    isPlainObject(row) ? (row as Record<string, unknown>) : undefined,
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
