/**
 * tRPC wire shapes, matched structurally (no tRPC import).
 *
 *   - Request input: superjson wraps every input as `{ json, meta? }`,
 *     batched calls key them by index (`{ "0": { json } }`), and GET
 *     queries carry the same JSON in `?input=` (+ `?batch=1`). We lift
 *     the input itself into request_params so "What was sent" shows
 *     `name: …`, not `0.json.name: …`. Other params (the `trpc`
 *     procedure path from `[trpc]`) are kept.
 *   - Error body: `{ error: { message, code, data: { code, zodError } } }`
 *     (optionally superjson-wrapped as `{ error: { json: {…} } }`), or
 *     an array of those for a batch. We read the zod field error first,
 *     then the message, with the 0.3.3 validation masking.
 */

import { capErrorText, specificErrorMessage } from "./source-data.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `{ json, meta? }` (superjson's serialize output) and nothing else. */
function isSuperjsonEnvelope(value: unknown): value is { json: unknown } {
  if (!isRecord(value) || !("json" in value)) return false;
  return Object.keys(value).every((k) => k === "json" || k === "meta");
}

function unwrap(value: unknown): unknown {
  return isSuperjsonEnvelope(value) ? value.json : value;
}

/** `{ "0": …, "1": … }`: every key a consecutive index from 0. */
function isIndexed(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k, i) => k === String(i));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Request params with the tRPC / superjson envelope removed. Only on a
 * tRPC route: a `trpc` param (the `[trpc]` segment) or a route module
 * path containing `[trpc]`. Returns the input unchanged otherwise or
 * when it isn't one of those shapes.
 */
export function unwrapTrpcParams(raw: unknown, url: URL, routeModulePath: string | null = null): unknown {
  if (!isRecord(raw)) return raw;
  if (!("trpc" in raw) && !routeModulePath?.includes("[trpc]")) return raw;
  const batch = url.searchParams.get("batch") === "1";
  const rest: Record<string, unknown> = {};
  let payload: unknown = undefined;

  if (typeof raw.input === "string") {
    // GET query: `?input=<json>`. Any JSON input is parsed (plain,
    // superjson, batched), so its fields get the usual key sanitizing
    // instead of riding along as one opaque string.
    const parsed = safeJsonParse(raw.input);
    if (parsed !== undefined) {
      for (const [k, v] of Object.entries(raw)) if (k !== "input" && k !== "batch") rest[k] = v;
      if (isSuperjsonEnvelope(parsed) || (batch && isRecord(parsed) && isIndexed(parsed))) payload = parsed;
      else return liftInput(parsed, rest);
    }
  }
  if (payload === undefined) {
    // POST body (+ route params such as `trpc`, merged in by capture).
    const indexed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^\d+$/.test(k)) indexed[k] = v;
      else rest[k] = v;
    }
    const envelopes = Object.values(indexed);
    if (
      isIndexed(indexed) &&
      (batch || envelopes.every(isSuperjsonEnvelope))
    ) {
      payload = indexed;
    } else if (isSuperjsonEnvelope(raw)) {
      return liftInput(raw.json, {});
    } else {
      return raw;
    }
  }

  if (isSuperjsonEnvelope(payload)) return liftInput(payload.json, rest);
  const calls = Object.values(payload as Record<string, unknown>).map(unwrap);
  if (calls.length === 1) return liftInput(calls[0], rest);
  const out: Record<string, unknown> = {};
  calls.forEach((input, i) => {
    if (input !== null && input !== undefined) out[String(i)] = input;
  });
  return { ...out, ...rest };
}

// One call's input at the top level; a scalar input goes under `input`.
function liftInput(input: unknown, rest: Record<string, unknown>): unknown {
  let out: Record<string, unknown>;
  if (input === null || input === undefined) out = { ...rest };
  else if (isRecord(input)) out = { ...input, ...rest };
  else out = { input, ...rest };
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The reason from a tRPC error body (single or batch), or null when
 * the body isn't one. Never returns a raw zod issue JSON dump.
 */
export function trpcErrorMessage(
  body: unknown,
  userPatterns: readonly string[] = [],
): string | null {
  const items = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const error = unwrap(item.error);
    if (!isRecord(error) || typeof error.message !== "string") continue;
    const data = error.data;
    if (!isRecord(data) || typeof data.code !== "string") continue;

    const reason = callReason(error.message.trim(), data.zodError, userPatterns);
    if (!reason) continue;
    // Name the failing procedure: in a batch it is one of several.
    const path = typeof data.path === "string" && data.path.length > 0 ? `${data.path}: ` : "";
    return capErrorText(`${path}${reason}`);
  }
  return null;
}

function callReason(message: string, zodError: unknown, userPatterns: readonly string[]): string | null {
  const specific = isRecord(zodError) ? specificErrorMessage(zodError, userPatterns) : null;
  if (specific) return specific;
  // tRPC's message for an input-validation error is the zod issue
  // list as JSON (which can echo input). Read its issue text instead.
  if (message.startsWith("[") || message.startsWith("{")) {
    const parsed = safeJsonParse(message);
    const issues = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.issues : null;
    const fromIssues = Array.isArray(issues) ? specificErrorMessage({ issues }, userPatterns) : null;
    if (fromIssues) return fromIssues;
    if (parsed !== undefined) return "Validation failed";
  }
  return message.length > 0 ? message : null;
}
