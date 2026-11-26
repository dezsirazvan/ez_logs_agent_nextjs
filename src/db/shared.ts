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

import {
  AUTH_SESSION_TABLE_NAMES,
  DEFAULT_EXCLUDED_TABLES,
  configuration,
  isSessionStoreColumn,
} from "../configuration.js";
import { logger } from "../logger.js";
import { build as buildEvent } from "../event-builder.js";
import { pushEvent } from "../pipeline/buffer.js";
import { current as currentCorrelation } from "../correlation.js";
import { getCurrentActor } from "../actor.js";
import { matchesSensitiveKey, scrubSecretsInText } from "../http/sanitize.js";
import { isPersonalColumn, isPersonalKey, isPersonalTable, maskPersonalNested, maskPersonalValue } from "../personal-fields.js";

export type DbOperation = "create" | "update" | "destroy";

// Technical fields that shouldn't appear in business-meaning context.
// Scoped to conventions that actually exist in Node DB stacks:
//   - id: already lives in resource_ids
//   - timestamps: Prisma's @default(now()) / @updatedAt, Drizzle's
//     timestamp helpers, and supabase-js's typical `created_at` /
//     `updated_at` columns
//   (soft-delete columns like deleted_at / archived_at are NOT ignored:
//   setting one is a business state change, same as the Rails gem)
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
  // Auth.js / NextAuth standard columns
  "emailVerified",
  "expires",
]);

// DB-specific sensitive patterns. NOTE: this list intentionally differs
// from EventBuilder's SENSITIVE_KEYS (5 entries) AND from the HTTP
// middleware's SENSITIVE_VARIABLE_PATTERNS. DB columns surface a wider
// class of crypto material (signing keys, IVs, salts, signatures) than
// HTTP params do, and defense-in-depth catches schemas that store
// these in dedicated columns rather than encrypted blobs.
//
// Origin: ez_logs_agent's database_capturer.rb (the first 18). Since
// 0.2.0 this list is a superset of the Rails list (credential, pin,
// otp, iban, card fields); the Rails gem and the server's
// EventIngest::SensitiveFieldRedactor do not have those yet.
// The trigger SQL (`ezlogs_is_sensitive_key`) mirrors this list so
// sensitive columns never reach ezlogs_audit_log.
export const DB_SENSITIVE_PATTERNS: readonly string[] = Object.freeze([
  "password",
  "token",
  "secret",
  "api_key",
  "credit_card",
  "ssn",
  "social_security",
  "encrypted",
  "private_key",
  "public_key",
  "signing_key",
  "pem",
  "cipher",
  "nonce",
  "salt",
  "digest",
  "signature",
  "hmac",
  // 0.2.0 additions. `credential` / `passwd` / `apikey` were already in
  // the HTTP list; `passcode` / `card_number` / `cardnumber` / `cvv` /
  // `cvc` are new. Whole-word `pin` / `otp` / `totp` / `iban` come from
  // SENSITIVE_WORD_PATTERNS. The SQL trigger mirrors this list.
  "credential",
  "passwd",
  "passcode",
  "apikey",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "verification_code",
  "recovery_code",
  "backup_code",
  "one_time_code",
  "login_code",
  // Credentials under other names: connection strings, webhook URLs, access and seed material,
  // single-use codes and links (1.5.5 of ez_logs_supabase; every list).
  "jwt",
  "webhook_url",
  "connection_string",
  "database_url",
  "access_key",
  "auth_key",
  "session_key",
  "license_key",
  "encryption_key",
  "ssh_key",
  "master_key",
  "mnemonic",
  "seed_phrase",
  "auth_code",
  "reset_code",
  "invite_code",
  "magic_link",
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
  /** When the write happened (trigger rows: `captured_at`). Defaults to now. */
  timestamp?: Date | null;
  /**
   * Database table name, when it differs from `modelClass` (Prisma
   * `@@map`). Only used to check whether the trigger path already
   * captures this table.
   */
  table?: string | null;
  /**
   * Resource ids for rows without a single primary key (join tables):
   * one per foreign-key column, typed by the referenced table. Used
   * only when `resourceId` is empty.
   */
  relatedResourceIds?: ReadonlyArray<{ resource_type: string; resource_id: string }> | null;
}

// Single emit path used by all DB adapters. Builds an event with the
// canonical wire shape, applies the configured exclude list, pushes
// to the buffer. Never throws.
export function emitDbEvent(input: DbEmitInput): void {
  try {
    const config = configuration();
    if (!config.captureDb) return;
    if (config.excludedTables.includes(input.modelClass)) return;
    // Default name list (`_prisma_migrations`, `session`, `Session`, …).
    // Exception: a trigger row from a session-named table whose row has
    // no session-store column (token, expiry, `sess`, `data`, `payload`,
    // `last_activity`) is business data (Umami's visitor `session`).
    // Session stores tracked by an older install stay dropped.
    if (
      DEFAULT_EXCLUDED_TABLES.includes(input.modelClass) &&
      !(input._fromTrigger && isBusinessSessionRow(input.modelClass, input.modelInstance))
    ) {
      return;
    }

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
      if (tracked === null || tracked.has(input.table ?? input.modelClass)) return;
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

    const related = resourceIdStr === null ? input.relatedResourceIds ?? [] : [];
    // The server names an event's FIRST resource with display_name; a
    // join row's own name must never label the record it points to.
    const context = buildContext(
      related.length > 0 ? { ...input, displayName: null, modelInstance: null } : input,
    );

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
          ? [...related]
          : [{ resource_type: input.modelClass, resource_id: resourceIdStr }],
      context,
      duration_ms: null,
      timestamp: input.timestamp ?? null,
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
    if (filtered !== null) context.initial_attributes = maskPersonalAttributes(filtered, personalTable(input));
  }

  if (input.operation === "update" && input.changes) {
    const filtered = filterMeaningfulChanges(input.changes);
    if (filtered.length > 0) {
      const table = personalTable(input);
      context.changes = filtered.map((c) => {
        // A personal field (personal-fields.ts): the change, never the
        // values. Masked after the diff above, so only changed values
        // reach here and two masked sides mean it changed.
        const hidden = isPersonalPath(c.attribute, table);
        const out: Record<string, unknown> = {
          attribute: c.attribute,
          to: hidden ? maskPersonalValue(c.to) : maskPersonalNested(formatForJson(c.to)),
        };
        // Only include `from` when we actually have a previous value.
        // Sending null when we don't know would render as "empty → val"
        // in the dashboard, which is misleading.
        if (c.from !== undefined) out.from = hidden ? maskPersonalValue(c.from) : maskPersonalNested(formatForJson(c.from));
        return out;
      });
    }
  }

  // A row of a list of phones or addresses would be named by the number or the street.
  const displayName = personalTable(input)
    ? null
    : (input.displayName ??
      (input.modelInstance ? resolveDisplayName(input.modelClass, input.modelInstance) : null));
  if (displayName !== null) context.display_name = displayName;

  return Object.keys(context).length === 0 ? null : context;
}

// The row's model or table when it is a list of phones, addresses or IPs
// (`PhoneNumber`, `user_addresses`): its value columns are personal.
function personalTable(input: DbEmitInput): string | null {
  for (const name of [input.modelClass, input.table]) {
    if (name && isPersonalTable(name)) return name;
  }
  return null;
}

// A dotted json leaf (`profile.phone`) is personal when any of its keys is;
// a column by its name or its table.
function isPersonalPath(path: string, table: string | null): boolean {
  const keys = path.split(".");
  return keys.some((key) => isPersonalKey(key)) || (keys.length === 1 && isPersonalColumn(path, table));
}

function maskPersonalAttributes(
  attrs: Record<string, unknown>,
  table: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = isPersonalColumn(key, table) ? maskPersonalValue(value) : maskPersonalNested(value);
  }
  return out;
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
  return flattenNestedChanges(changes).filter((c) => {
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

// json/jsonb columns: one change per changed leaf, as a dotted path
// (`settings.integration_testing_mode: false -> true`). Bounded so a
// big document can't flood the event: leaves past the depth cap stay
// non-scalar (dropped), and at most MAX_NESTED_LEAVES per column ship.
// Without a before-value (Prisma extension) every leaf of the new
// document looks "changed", so only MAX_UNKNOWN_FROM_LEAVES ship.
// String leaves are free-form app data: secret-shaped values (JWTs,
// API keys, private keys, card numbers) are masked.
// Bookkeeping leaves (`field_sources.name.updated_at`, version
// counters) are dropped, value changes rank before keys that appeared
// or disappeared, and nested leaves come after the record's own
// columns, so the cap never pushes a real change out for metadata.
// (Rails drops non-scalar changes entirely; see AGENT_PARITY_NOTES.)
const MAX_NESTED_DEPTH = 3;
const MAX_NESTED_LEAVES = 20;
const MAX_UNKNOWN_FROM_LEAVES = 5;
// Leaves examined per column before ranking (bounds the work on huge documents).
const MAX_SCANNED_LEAVES = 200;

// Nested keys that only record when / how often something was written:
// create / update stamps plus sync/refresh stamps. Not the rest of the
// top-level ignored set (`subscription.expires` is business data, a
// nested `assignee.id` names a linked record). Soft-delete style names
// (`deleted_at`, `archived_at`, `ends_at`) stay: business state.
const NESTED_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
]);
const NESTED_BOOKKEEPING_STAMP =
  /^(?:last_?)?(?:updated|modified|synced|refreshed|fetched|touched|cached)_?at$/i;
// Counters bumped on every write; only when both sides are numbers.
const NESTED_VERSION_COUNTER = /^(?:__v|version|lock_?version)$/i;

function isNestedBookkeeping(key: string, from: unknown, to: unknown): boolean {
  if (NESTED_BOOKKEEPING_KEYS.has(key) || NESTED_BOOKKEEPING_STAMP.test(key)) return true;
  return (
    NESTED_VERSION_COUNTER.test(key) &&
    typeof to === "number" &&
    (from === undefined || from === null || typeof from === "number")
  );
}

// 0: value changed (known before and after), 1: key appeared /
// disappeared, 2: before-value unknown.
function leafRank(change: DbAttributeChange): number {
  if (change.from === undefined) return 2;
  return change.from === null || change.to === null ? 1 : 0;
}

function flattenNestedChanges(changes: DbAttributeChange[]): DbAttributeChange[] {
  if (!changes.some((c) => isPlainRecord(c.to) || isPlainRecord(c.from))) return changes;
  const out: DbAttributeChange[] = [];
  const nested: DbAttributeChange[] = [];
  for (const c of changes) {
    if (!isPlainRecord(c.to) && !isPlainRecord(c.from)) {
      out.push(c);
      continue;
    }
    // A sensitive / ignored column drops the whole document. Nested
    // sensitive keys are dropped by the per-leaf check on the dotted
    // name (`settings.api_key`).
    if (!isMeaningfulAttribute(c.attribute)) continue;
    const leaves: DbAttributeChange[] = [];
    collectLeafChanges(c.attribute, c.from, c.to, 1, leaves);
    // Stable sort: document order within a rank.
    leaves.sort((a, b) => leafRank(a) - leafRank(b));
    const cap = c.from === undefined ? MAX_UNKNOWN_FROM_LEAVES : MAX_NESTED_LEAVES;
    nested.push(...leaves.slice(0, cap).map(scrubLeaf));
  }
  return out.concat(nested);
}

function collectLeafChanges(
  path: string,
  from: unknown,
  to: unknown,
  depth: number,
  out: DbAttributeChange[],
): void {
  if (out.length >= MAX_SCANNED_LEAVES) return;
  const fromObj = isPlainRecord(from);
  const toObj = isPlainRecord(to);
  // Descend only object -> object (or absent / null on one side);
  // `"x" -> {…}` is a type change, kept as one non-scalar change.
  if (
    (fromObj || toObj) &&
    depth <= MAX_NESTED_DEPTH &&
    (fromObj || from == null) &&
    (toObj || to == null)
  ) {
    const f = fromObj ? (from as Record<string, unknown>) : {};
    const t = toObj ? (to as Record<string, unknown>) : {};
    for (const key of new Set([...Object.keys(f), ...Object.keys(t)])) {
      // Unknown prior state stays unknown; a known object missing the
      // key means the key was empty.
      const before = from === undefined ? undefined : (f[key] ?? null);
      collectLeafChanges(`${path}.${key}`, before, t[key] ?? null, depth + 1, out);
    }
    return;
  }
  if (from !== undefined && sameJson(from, to)) return;
  if (path.includes(".") && isNestedBookkeeping(path.slice(path.lastIndexOf(".") + 1), from, to)) return;
  out.push(from === undefined ? { attribute: path, to } : { attribute: path, from, to });
}

function scrubLeaf(change: DbAttributeChange): DbAttributeChange {
  const scrub = (v: unknown) => (typeof v === "string" ? scrubSecretsInText(v) : v);
  const out: DbAttributeChange = { attribute: change.attribute, to: scrub(change.to) };
  if (change.from !== undefined) out.from = scrub(change.from);
  return out;
}

// A JSON object: plain prototype only (not Date, Decimal, Buffer or
// any class instance).
function isPlainRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function isMeaningfulAttribute(name: string): boolean {
  if (IGNORED_ATTRIBUTES.includes(name)) return false;
  if (isDbSensitive(name)) return false;
  return true;
}

export function isDbSensitive(name: string): boolean {
  return matchesSensitiveKey(name, DB_SENSITIVE_PATTERNS);
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

function isBusinessSessionRow(table: string, row: Record<string, unknown> | null | undefined): boolean {
  // Verification tokens are never business data.
  if (!AUTH_SESSION_TABLE_NAMES.test(table) || /verif/i.test(table) || !row) return false;
  const columns = Object.keys(row);
  return columns.length > 0 && !columns.some(isSessionStoreColumn);
}

// Display-name fallback chain — port of resolve_display_name,
// extended with function-resolver support.
//
// Resolution order:
//   1. Custom `displayNameFor[ModelClass]` — function or column name.
//      A function resolver runs inside try/catch; if it throws or
//      returns a non-string, we fall through to the default chain
//      rather than crash the host.
//   2. `name`, `title`, `number` (the Rails gem's chain), `label`.
//   3. The record's own number column (`invoice_number` on `invoices`).
// Deliberately NOT used: email, first/last/full name and other
// person-identifying columns. display_name becomes the record's
// `resource_name`, which default (redacted) shares and embeds show,
// while they mask actor labels; a person's name or email must not
// leak that way. Customers opt in per model with `displayNameFor`.
// Column names match snake_case or camelCase. Sensitive columns are
// never used. Returns null if no value found.
const DISPLAY_NAME_COLUMNS = ["name", "title", "number", "label"];
const MAX_DISPLAY_NAME_LENGTH = 120;

export function resolveDisplayName(
  modelClass: string,
  instance: Record<string, unknown>,
): string | null {
  try {
    const config = configuration();
    const resolver = config.displayNameFor[modelClass];
    // A configured column that is a phone or an address never names a row.
    const resolved = typeof resolver === "string" && isPersonalKey(resolver) ? null : applyResolver(resolver, instance);
    if (resolved !== null) return resolved;

    // Normalized column name (lowercase, no `_`) -> value.
    const columns = new Map<string, unknown>();
    for (const key of Object.keys(instance)) {
      if (isDbSensitive(key) || isPersonalKey(key)) continue; // never a secret, a phone or an address
      const norm = key.toLowerCase().replace(/_/g, "");
      if (!columns.has(norm)) columns.set(norm, instance[key]);
    }
    const text = (norm: string): string | null => {
      const value = columns.get(norm);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
        return null;
      }
      const str = String(value).trim();
      return str.length > 0 ? str.slice(0, MAX_DISPLAY_NAME_LENGTH) : null;
    };

    for (const column of DISPLAY_NAME_COLUMNS) {
      const value = text(column);
      if (value !== null) return value;
    }
    return text(`${singularNorm(modelClass)}number`);
  } catch {
    // fall through
  }
  return null;
}

// `Invoice` / `invoices` / `line_items` -> `invoice` / `lineitem`.
function singularNorm(modelClass: string): string {
  const norm = modelClass.toLowerCase().replace(/_/g, "");
  if (norm.endsWith("ies")) return norm.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(norm)) return norm;
  if (/(xes|ches|shes|sses)$/.test(norm)) return norm.slice(0, -2);
  return norm.endsWith("s") ? norm.slice(0, -1) : norm;
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
