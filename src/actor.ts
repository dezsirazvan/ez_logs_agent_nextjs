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
import type { ActorContext } from "./configuration.js";

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

/** Run `callback` with a fresh, empty actor scope. Used by HTTP capture. */
export function runWithActorScope<R>(callback: () => R): R {
  return storage.run(null, callback);
}

/**
 * ActorValidator.sanitize — port of actor_validator.rb.
 *
 * - null input is valid (returns null — "unknown provenance").
 * - Must be a plain object with a non-empty `id` field.
 * - `label` is optional, stringified if present.
 * - Both `id` (string | symbol-style key) variants accepted; we
 *   coerce to string. Ruby checks `actor[:id] || actor["id"]`; in
 *   JS, only string keys exist on plain objects.
 */
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
