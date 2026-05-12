// Shared DB capture helpers.
//
// All three DB adapters (Prisma, Drizzle, supabase-js) produce events
// with the same wire shape — `source_type: "database_callback"`,
// `source_data: { model_class, operation }`, etc. The differences live
// in HOW each adapter discovers row state. Everything that's identical
// (sensitive-key filtering, value formatting, scalar checks, display-
// name resolution, event emission) lives here.
//
// IGNORED_ATTRIBUTES, SENSITIVE_PATTERNS, scalar() and the format-for-
// JSON rules are direct ports of database_capturer.rb.

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import { build as buildEvent } from "../event-builder.js";
import { pushEvent } from "../pipeline/buffer.js";
import { current as currentCorrelation } from "../correlation.js";
import { getCurrentActor } from "../actor.js";

export type DbOperation = "create" | "update" | "destroy";

// Technical fields that shouldn't appear in business-meaning context.
// Scoped to conventions that actually exist in Node DB stacks:
//   - id: already lives in resource_ids
//   - timestamps: Prisma's @default(now()) / @updatedAt, Drizzle's
//     timestamp helpers, and supabase-js's typical `created_at` /
//     `updated_at` columns
//   - soft-delete timestamps: paranoid-mode convention across most
//     Node ORMs
//   - Auth.js / NextAuth columns that show up in every Next.js app
//     using the standard adapter
//
// Customers add their own via excludedTables (rough cut) or by
// extending this list once a config option exists for it.
export const IGNORED_ATTRIBUTES: readonly string[] = Object.freeze([
  "id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "deletedAt",
  "deleted_at",
  // Auth.js / NextAuth standard columns
  "emailVerified",
  "expires",
]);

// DB-specific sensitive patterns. NOTE: this list intentionally differs
// from EventBuilder's SENSITIVE_KEYS (5 entries) AND from the HTTP
// middleware's SENSITIVE_VARIABLE_PATTERNS (27 entries). The DB list
// has 8 entries and is the smallest of the three because column names
// in real schemas are more terse and less varied. Same as Ruby.
export const DB_SENSITIVE_PATTERNS: readonly string[] = Object.freeze([
  "password",
  "token",
  "secret",
  "api_key",
  "credit_card",
  "ssn",
  "social_security",
  "encrypted",
]);

export interface DbAttributeChange {
  attribute: string;
  /**
   * Previous value, when known. Omitted (NOT set to null) when the
   * adapter couldn't determine the prior state — null is a real value
   * that may be the actual previous value, so encoding "unknown" with
   * null misleads the dashboard into rendering "empty → newVal".
   */
  from?: unknown;
  to: unknown;
}

export interface DbEmitInput {
  modelClass: string;
  operation: DbOperation;
  resourceId: string | number | bigint | null | undefined;
  /** Initial attributes (creates). Filtered + formatted before use. */
  initialAttributes?: Record<string, unknown> | null;
  /** Per-attribute changes (updates). Filtered + formatted before use. */
  changes?: DbAttributeChange[] | null;
  /** Already-resolved display name, or the model instance to extract one from. */
  displayName?: string | null;
  /** Raw model instance — used for fallback display-name resolution. */
  modelInstance?: Record<string, unknown> | null;
  /**
   * Internal: set by the trigger reader to bypass the
   * "trigger path is authoritative, drop adapter emits" gate below.
   * Per-ORM adapters never set this — they get suppressed when
   * `databaseReader` is configured. Underscore-prefixed because
   * it's not part of the public adapter contract.
   */
  _fromTrigger?: boolean;
}

// Single emit path used by all DB adapters. Builds an event with the
// canonical wire shape, applies the configured exclude list, pushes
// to the buffer. Never throws.
export function emitDbEvent(input: DbEmitInput): void {
  try {
    const config = configuration();
    if (!config.captureDb) return;
    if (config.allExcludedTables().includes(input.modelClass)) return;

    // When the customer wired the trigger reader (`databaseReader`
    // config), the Phase 5 path is authoritative for DB capture on
    // tables that have `ezlogs_audit` attached: it sees the real
    // OLD/NEW row state and emits one event per audit row. The per-ORM
    // adapters (Drizzle logger, Prisma extension, Supabase wrapper)
    // would emit a thinner version of the same write, so the
    // dashboard would render two cards per row — Phase 5 with full
    // diffs plus Phase 4 with `empty → newVal` noise. The trigger
    // reader bypasses this gate by setting `_fromTrigger: true`.
    //
    // Tables that ARE NOT trigger-tracked must fall through to the
    // adapter — otherwise the agent's "we capture every write" promise
    // breaks the moment a customer adds a new table without remembering
    // to run `SELECT ezlogs_track('foo')`. `triggerTrackedTables` is
    // populated once at startup; until detection completes (or if it
    // fails), we conservatively keep the original suppress-all
    // behavior to avoid double-emit on tables the customer DID track.
    if (config.databaseReader && !input._fromTrigger) {
      const tracked = config.triggerTrackedTables;
      if (tracked === null || tracked.has(input.modelClass)) return;
    }

    // UPDATE with only ignored/sensitive fields touched (e.g. just
    // `updated_at` flipped) yields zero meaningful changes after the
    // filter inside buildContext. Emitting an empty card adds noise
    // to the dashboard with no signal — skip the event entirely.
    // Per-ORM adapters before triggers handled this by never calling
    // emit on touch-only updates; the trigger reader can't tell ahead
    // of time, so the gate lives here.
    if (input.operation === "update") {
      const meaningful = input.changes
        ? filterMeaningfulChanges(input.changes)
        : [];
      if (meaningful.length === 0) return;
    }

    const resourceIdStr =
      input.resourceId === null || input.resourceId === undefined
        ? null
        : String(input.resourceId);

    const context = buildContext(input);

    const event = buildEvent({
      source_type: "database_callback",
      source_data: {
        model_class: input.modelClass,
        operation: input.operation,
      },
      outcome: "success",
      correlation_id: currentCorrelation(),
      resource_ids:
        resourceIdStr === null
          ? []
          : [{ resource_type: input.modelClass, resource_id: resourceIdStr }],
      context,
      duration_ms: null,
    });

    pushEvent(event);
  } catch (error) {
    logger.debug(`db emit failed: ${describeError(error)}`);
  }
}

function buildContext(input: DbEmitInput): Record<string, unknown> | null {
  const context: Record<string, unknown> = {};

  // Carry the request-scoped actor onto every DB event in the same
  // correlation. Without this, the HTTP event has the actor populated
  // but the DB events that fire from inside the same handler ship
  // with `actor: null` — the dashboard's per-event "Triggered by"
  // panel then renders "Unknown" on the DB rows. Mirrors the same
  // `context: { actor: ... }` shape HTTP capture builds.
  const actor = getCurrentActor();
  if (actor) context.actor = actor;

  // For creates AND destroys, ship the full row as initial_attributes.
  // On destroy this is the pre-state — the only thing that gives the
  // dashboard a useful card body ("Razvan deleted invite alice@…").
  // Per-ORM adapters before triggers passed initialAttributes only on
  // create; the trigger reader passes it on destroy too. The Ruby
  // server already understands `initial_attributes` on destroy events.
  if (
    (input.operation === "create" || input.operation === "destroy") &&
    input.initialAttributes
  ) {
    const filtered = filterMeaningfulAttributes(input.initialAttributes);
    if (filtered !== null) context.initial_attributes = filtered;
  }

  if (input.operation === "update" && input.changes) {
    const filtered = filterMeaningfulChanges(input.changes);
    if (filtered.length > 0) {
      context.changes = filtered.map((c) => {
        const out: Record<string, unknown> = {
          attribute: c.attribute,
          to: formatForJson(c.to),
        };
        // Only include `from` when we actually have a previous value.
        // Sending null when we don't know would render as "empty → val"
        // in the dashboard, which is misleading.
        if (c.from !== undefined) out.from = formatForJson(c.from);
        return out;
      });
    }
  }

  const displayName =
    input.displayName ??
    (input.modelInstance ? resolveDisplayName(input.modelClass, input.modelInstance) : null);
  if (displayName !== null) context.display_name = displayName;

  return Object.keys(context).length === 0 ? null : context;
}

export function filterMeaningfulAttributes(
  attrs: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attrs)) {
    if (!isMeaningfulAttribute(key)) continue;
    const value = attrs[key];
    if (value === null || value === undefined) continue;
    if (!isScalar(value)) continue;
    out[key] = formatForJson(value);
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function filterMeaningfulChanges(
  changes: DbAttributeChange[],
): DbAttributeChange[] {
  return changes.filter((c) => {
    if (!isMeaningfulAttribute(c.attribute)) return false;
    if (!isScalar(c.to)) return false;
    // If `from` is undefined, the adapter didn't have a previous value
    // (e.g. supabase update without pre-read). Keep the change so the
    // dashboard can render the new value, just without a before-state.
    if (c.from === undefined) return true;
    if (!isScalar(c.from)) return false;
    return valuesActuallyChanged(c.from, c.to);
  });
}

export function isMeaningfulAttribute(name: string): boolean {
  if (IGNORED_ATTRIBUTES.includes(name)) return false;
  if (isDbSensitive(name)) return false;
  return true;
}

export function isDbSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  return DB_SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

// Scalar = simple, JSON-serializable value. Mirrors Ruby's `scalar?`
// but expressed in JS terms: Ruby's BigDecimal becomes Prisma's
// Decimal (toFixed-able), Ruby's Date becomes JS Date, Ruby's
// Symbol has no JS analog. Arrays of scalars are scalars too.
export function isScalar(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value instanceof Date
  ) {
    return true;
  }
  // Prisma Decimal: { d: number[], e: number, s: number, toFixed(): string }
  if (isPrismaDecimal(value)) return true;
  if (Buffer.isBuffer?.(value)) return false;
  if (Array.isArray(value)) return value.every((v) => isScalar(v));
  return false;
}

export function valuesActuallyChanged(from: unknown, to: unknown): boolean {
  if (from === null && to === null) return false;
  if (from instanceof Date && to instanceof Date) {
    return from.getTime() !== to.getTime();
  }
  return from !== to;
}

// Format a scalar for JSON output. Date → ISO string, Decimal → number,
// arrays → recursively-formatted arrays. BigInt is JSON-incompatible
// so we coerce to string. Primitives pass through.
export function formatForJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (isPrismaDecimal(value)) return Number(value.toString());
  if (Array.isArray(value)) return value.map(formatForJson);
  return value;
}

function isPrismaDecimal(
  value: unknown,
): value is { toString(): string; toFixed(digits: number): string } {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.toString === "function" &&
    typeof obj.toFixed === "function" &&
    "d" in obj &&
    "e" in obj &&
    "s" in obj
  );
}

// Display-name fallback chain — direct port of resolve_display_name,
// extended with function-resolver support so users can compose names
// from multiple columns (e.g. `${first_name} ${last_name}` when no
// single column is meaningful).
//
// Resolution order:
//   1. Custom `displayNameFor[ModelClass]` — function or column name.
//      A function resolver runs inside try/catch; if it throws or
//      returns a non-string, we fall through to the default chain
//      rather than crash the host.
//   2. `name`, `title`, `number` columns in that order.
//
// Returns null if no value found.
export function resolveDisplayName(
  modelClass: string,
  instance: Record<string, unknown>,
): string | null {
  try {
    const config = configuration();
    const resolver = config.displayNameFor[modelClass];
    const resolved = applyResolver(resolver, instance);
    if (resolved !== null) return resolved;

    for (const field of ["name", "title", "number"]) {
      const value = instance[field];
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function applyResolver(
  resolver: unknown,
  instance: Record<string, unknown>,
): string | null {
  if (typeof resolver === "string") {
    const value = instance[resolver];
    if (value !== null && value !== undefined && String(value).length > 0) {
      return String(value);
    }
    return null;
  }
  if (typeof resolver === "function") {
    try {
      const value = (resolver as (row: Record<string, unknown>) => unknown)(instance);
      if (typeof value === "string" && value.length > 0) return value;
      // Coerce non-string truthy values for ergonomics (e.g. numbers),
      // but skip null/undefined/empty so the fallback chain runs.
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
      }
    } catch {
      // Resolver threw — fall through to default chain. We deliberately
      // do not log here; user resolvers run on the hot path and a noisy
      // log per row would mask the real error in their app code.
    }
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
