// Correlation — port of correlation.rb.
//
// Generates and propagates a request-scoped correlation id so events
// captured anywhere downstream of an inbound HTTP request (DB writes,
// job enqueues, outgoing fetch) all carry the same id.
//
// Format (matches Ruby exactly): `ezl_<unix_ms>_<8-hex>`
//   ezl_1737000000000_deadbeef
//
// Storage uses createScopedStorage() — AsyncLocalStorage on Node /
// Vercel Edge (Next 14+), plus a module-scoped fallback for older
// runtimes that don't expose `node:async_hooks`. On Edge each
// invocation is a fresh V8 isolate so the fallback is correct
// per-request.

// No `node:crypto` import — Next.js's webpack on some compile paths
// (notably the Next-15 `instrumentation.ts` bundle) refuses bare
// `crypto` AND raises `UnhandledSchemeError` on `node:crypto`. The
// safest portable choice is the Web Crypto global, which is a
// stable Node built-in since 19 (and exposed on Node 18.17+ via
// the same `globalThis.crypto` namespace). That gives us
// synchronous random bytes via `getRandomValues`. For the platform-
// id → 8-hex derivation we use FNV-1a (non-crypto, but the goal
// is deterministic grouping, not collision resistance).
import { createScopedStorage } from "./edge-fallback.js";

/**
 * HTTP header carrying the agent's correlation id between hops.
 * Re-exported here so `correlation.ts` can resolve from it without
 * importing from `http/capture.ts` (which would be a cycle).
 * The canonical declaration lives in `http/capture.ts`.
 */
const CORRELATION_HEADER = "x-ezlogs-correlation-id";

/**
 * Platform-injected request-id headers, in priority order.
 *
 * `x-vercel-id` is set by Vercel's edge before any user code runs and
 * stays the same across cold-started concurrent invocations of one
 * request. `cf-ray` does the same on Cloudflare. `x-request-id` is the
 * Heroku / AWS ALB / fly.io convention.
 *
 * When `middleware.ts` is absent, the four HTTP entry points
 * (captureRoute, capturePagesApi, captureServerAction, the middleware
 * wrapper itself) would each generate a fresh id, scattering events
 * across separate Action cards. Keying off a platform-injected id
 * groups them again.
 */
const PLATFORM_REQUEST_ID_HEADERS = [
  "x-vercel-id",
  "cf-ray",
  "x-request-id",
] as const;

// Pin the storage instance to globalThis under a stable Symbol. When
// Turbopack/Webpack duplicate this module across server/RSC/edge
// chunks, every chunk's `storage` reference must resolve to the SAME
// AsyncLocalStorage instance — otherwise a `runWithCorrelation` opened
// in one chunk is invisible to a `current()` call in another, and DB
// events ship with correlation_id=NONE despite running inside the
// Server Action's scope.
const storage = createScopedStorage<string>(
  Symbol.for("ezlogs-nextjs:correlation-storage"),
);

/**
 * Generates a new correlation id.
 *
 * Format: `ezl_<Date.now()>_<8 random hex chars>` — identical to
 * Ruby's `SecureRandom.hex(4)` output (8 lowercase hex chars).
 */
export function generate(): string {
  const ts = Date.now();
  const hex = randomHexBytes(4);
  return `ezl_${ts}_${hex}`;
}

/**
 * Synchronous random hex via Web Crypto. `getRandomValues` is a
 * Node global since 18.17 (and stable since 19); no module import
 * needed, no async API.
 */
function randomHexBytes(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Headers-like accessor — accepts either a real `Headers` object
 * (App Router request) or the lowercased object Pages Router gives
 * us in `req.headers`.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * Resolve a correlation id for the current request, in priority:
 *
 *   1. `x-ezlogs-correlation-id` (set by an upstream ezlogs middleware
 *      or hop). Used verbatim.
 *   2. A platform-injected request id (`x-vercel-id`, `cf-ray`,
 *      `x-request-id`) wrapped to the agent's wire format. Same
 *      input -> same output, so multiple cold-started entry points
 *      in one request share the same correlation id even when the
 *      customer doesn't have `middleware.ts`.
 *   3. A freshly generated id.
 *
 * The hashing is deterministic but not security-sensitive — correlation
 * ids are tenant-scoped on the server, so spoofing a platform id only
 * causes grouping with other events from the same tenant.
 */
export function resolveCorrelation(headers: HeadersLike | null | undefined): string {
  if (!headers) return generate();

  const ezlogs = safeRead(headers, CORRELATION_HEADER);
  if (ezlogs) return ezlogs;

  for (const name of PLATFORM_REQUEST_ID_HEADERS) {
    const platformId = safeRead(headers, name);
    if (platformId) return wrapPlatformId(platformId);
  }

  return generate();
}

function safeRead(headers: HeadersLike, name: string): string | null {
  try {
    const value = headers.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function wrapPlatformId(platformId: string): string {
  const ts = Date.now();
  const hex = fnv1aHex(platformId);
  return `ezl_${ts}_${hex}`;
}

/**
 * FNV-1a 32-bit hash → 8-char zero-padded hex. We only need a
 * deterministic, low-collision-rate fingerprint of a
 * platform-injected request id (`x-vercel-id`, `cf-ray`,
 * `x-request-id`) so concurrent invocations of the same request
 * group into one action. This is not a security boundary — no
 * crypto-grade hash needed, and going async (Web Crypto's
 * `subtle.digest`) would ripple through every sync `current()`
 * call site.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5; // 2166136261, FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime = 16777619; multiplication via Math.imul stays in
    // 32-bit signed range without precision loss.
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit then 8-char zero-padded hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Returns the current correlation id, or null if no request context is
 * active.
 */
export function current(): string | null {
  return storage.read();
}

/**
 * Run `callback` inside a fresh correlation scope. Used by the HTTP
 * capture middleware to wrap each inbound request. Downstream code
 * inside the callback (and any awaited work) sees the new id via
 * `current()`. After the callback resolves, the previous context is
 * restored.
 */
export function runWithCorrelation<R>(
  correlationId: string,
  callback: () => R,
): R {
  return storage.run(correlationId, callback);
}

/** Test-only. Returns whether AsyncLocalStorage is in use. */
export function _isUsingAsyncLocalStorageForTests(): boolean {
  return storage._isAsyncLocalStorage();
}

/** Test-only. Clears the Edge-fallback variable. */
export function _resetCorrelationForTests(): void {
  storage._resetForTests();
}
