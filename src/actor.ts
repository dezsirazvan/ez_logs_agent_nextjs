// Actor — port of actor.rb + actor_validator.rb.
//
// Represents "who triggered this action" — the logged-in user. The
// agent does not infer this; the user provides an `actorFromRequest`
// hook in the configuration. The middleware calls the hook after the
// downstream handler runs (when the request has had a chance to
// authenticate the user) and stores the result here. Capturers read
// via getCurrentActor() and include it in event context.
//
// Schema (matches Ruby exactly):
//   { id: string (REQUIRED), label?: string }
//
// Storage: AsyncLocalStorage (or Edge fallback) scoped to a single
// request. Wrap each request in runWithActorScope, set inside via
// setActor.

import { logger } from "./logger.js";
import { createScopedStorage } from "./edge-fallback.js";
import { configuration, type ActorContext } from "./configuration.js";
import { scopeExpired } from "./correlation.js";

export type { ActorContext } from "./configuration.js";

// Same globalThis-pinning as correlation.ts — see comment there.
const storage = createScopedStorage<ActorContext | null>(
  Symbol.for("ezlogs-nextjs:actor-storage"),
);

/**
 * Returns the actor for the current request, or null if none has
 * been set yet (or the actorFromRequest hook returned null).
 */
export function getCurrentActor(): ActorContext | null {
  // Past its request's grace window the scope links nothing (see
  // `endCorrelationScope`): no correlation id, so no actor either.
  if (scopeExpired()) return null;
  return storage.read();
}

/**
 * Set the actor for the current scope. Validates and sanitizes the
 * input; invalid actors are logged at debug level and discarded
 * (parity with Ruby's `Actor.current=`).
 */
export function setActor(input: unknown): ActorContext | null {
  const sanitized = validateActor(input);
  if (input != null && sanitized === null) {
    logger.debug(`Actor: invalid actor structure ignored: ${describe(input)}`);
  }
  storage.update(sanitized);
  return sanitized;
}

// Per-scope Supabase actor source: the clients constructed in this
// request, in order, and whether they were already asked (no user).
// Mutable object, one per runWithActorScope.
interface ActorSourceSlot {
  clients?: unknown[];
  tried?: boolean;
}
const sourceStorage = createScopedStorage<ActorSourceSlot>(
  Symbol.for("ezlogs-nextjs:actor-source-storage"),
);

/** The current scope's actor-source slot, or null outside any scope. */
export function currentActorSource(): ActorSourceSlot | null {
  return sourceStorage.read();
}

/**
 * Run `callback` in a fresh actor scope: empty (HTTP capture), or
 * holding the actor a job carried from the request that started it.
 */
export function runWithActorScope<R>(
  callback: () => R,
  actor: ActorContext | null = null,
): R {
  return storage.run(actor, () => sourceStorage.run({}, callback));
}

/**
 * Fallback actor extraction via the most-recently-constructed Supabase
 * client. Called AFTER the user's handler has run — by that point a
 * Supabase client has typically been created and its auth cookies are
 * accessible — and before a workflow run is started, so its steps can
 * carry the actor. Skipped when actorFromSupabase=false or when an
 * actor is already set (e.g. by the actorFromRequest hook).
 */
export async function maybeExtractSupabaseActor(): Promise<void> {
  const config = configuration();
  if (!config.actorFromSupabase) return;
  if (getCurrentActor()) return; // user-supplied hook already populated it
  // Asked already with no user, and no new client since: skip getUser().
  const slot = currentActorSource();
  if (slot?.tried) return;

  try {
    // Lazy import so non-Supabase apps don't pay the cost.
    const mod = await import("./db/supabase.js");
    // The agent's own call: never recorded as the app's outside call.
    const { runInternal } = await import("./http/outbound-capture.js");
    const actor = await runInternal(() => mod.tryExtractSupabaseActor());
    if (slot) slot.tried = true;
    if (actor) setActor(actor);
  } catch (error) {
    logger.debug(`actorFromSupabase failed: ${describe(error)}`);
  }
}

/**
 * ActorValidator.sanitize — port of actor_validator.rb.
 *
 * - null input is valid (returns null — "unknown provenance").
 * - Must be a plain object with a non-empty `id` field.
 * - `label` is optional, stringified if present.
 * - `kind` is optional; only the documented actor_kind enum values
 *   (human|agent|system|hybrid) survive — anything else is dropped.
 * - `principal` is optional; same id-required, label-optional shape
 *   as the top-level actor. Malformed principals are dropped silently
 *   (don't reject the whole actor).
 */
const VALID_KINDS = new Set<string>(["human", "agent", "system", "hybrid"]);

export function validateActor(input: unknown): ActorContext | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return null;
  if (Array.isArray(input)) return null;

  const obj = input as Record<string, unknown>;
  const rawId = obj.id;
  if (rawId === null || rawId === undefined) return null;

  const id = String(rawId);
  if (id === "") return null;

  const result: ActorContext = { id };

  if (obj.label !== undefined && obj.label !== null) {
    result.label = String(obj.label);
  }

  if (obj.kind !== undefined && obj.kind !== null) {
    const kind = String(obj.kind);
    if (VALID_KINDS.has(kind)) {
      result.kind = kind as NonNullable<ActorContext["kind"]>;
    }
  }

  const principal = sanitizePrincipal(obj.principal);
  if (principal) result.principal = principal;

  return result;
}

/**
 * Sanitize the optional principal sub-structure. Returns null if the
 * principal is missing or malformed; we drop silently rather than
 * rejecting the parent actor — principal is purely advisory.
 */
function sanitizePrincipal(input: unknown): { id: string; label?: string } | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return null;
  if (Array.isArray(input)) return null;

  const obj = input as Record<string, unknown>;
  const rawId = obj.id;
  if (rawId === null || rawId === undefined) return null;

  const id = String(rawId);
  if (id === "") return null;

  const result: { id: string; label?: string } = { id };
  if (obj.label !== undefined && obj.label !== null) {
    result.label = String(obj.label);
  }
  return result;
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Test-only. Clears the Edge-fallback store. */
export function _resetActorForTests(): void {
  storage._resetForTests();
}
