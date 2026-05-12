/**
 * Request-params sanitization — port of the SENSITIVE_VARIABLE_PATTERNS
 * + sanitize_variable_value chain in http_request.rb.
 *
 * Two distinct lists exist in the Ruby agent:
 *
 *   1. EventBuilder::SENSITIVE_KEYS (5 entries) — applied LAST, by
 *      EventBuilder.build, after capturers have already done their
 *      own filtering. See src/event-builder.ts.
 *
 *   2. SENSITIVE_VARIABLE_PATTERNS (this file, ~24 entries) — applied
 *      EARLIER, by the HTTP middleware itself, against incoming
 *      request_params before they're handed to EventBuilder. Richer
 *      list because raw user-submitted form/JSON payloads are the
 *      highest-risk source.
 *
 * Both lists are case-insensitive substring matches. Both pass through
 * arrays/nested objects with depth and size limits. The wire-format
 * parity test exercises both — do not deviate without bumping format.
 */

export const SENSITIVE_VARIABLE_PATTERNS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "pwd",
  "token",
  "access_token",
  "refresh_token",
  "api_token",
  "auth_token",
  "secret",
  "api_secret",
  "client_secret",
  "api_key",
  "apikey",
  "private_key",
  "privatekey",
  "secret_key",
  "secretkey",
  "credential",
  "auth",
  "authorization",
  "encrypted",
  "encrypted_data",
  "ssn",
  "social_security",
  "credit_card",
  "card_number",
  "cvv",
  "cvc",
]);

const MAX_NESTING_DEPTH = 3;
const MAX_ARRAY_DISPLAY_SIZE = 5;

/** Sanitize a flat or nested record of request params. Returns null for empty input. */
export function sanitizeRequestParams(
  params: unknown,
  userPatterns: readonly string[] = [],
): Record<string, unknown> | null {
  if (params === null || params === undefined) return null;
  if (!isPlainObject(params)) return null;
  const obj = params as Record<string, unknown>;

  // Strip framework-internal keys (parity with Ruby's
  // params.except("controller", "action", "format", "authenticity_token")).
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (FRAMEWORK_INTERNAL_KEYS.has(key)) continue;
    cleaned[key] = obj[key];
  }
  if (Object.keys(cleaned).length === 0) return null;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cleaned)) {
    out[key] = sanitizeValue(key, cleaned[key], 0, userPatterns);
  }
  return out;
}

const FRAMEWORK_INTERNAL_KEYS = new Set([
  // Rails leftovers — kept for parity since users may funnel through a
  // proxy that adds them, e.g. via a NextAuth credentials provider that
  // forwards CSRF tokens.
  "controller",
  "action",
  "format",
  "authenticity_token",
  "_method",
  // Next.js / common JS conventions
  "csrfToken",
  "_csrf",
  "_next",
]);

function sanitizeValue(
  key: string,
  value: unknown,
  depth: number,
  userPatterns: readonly string[],
): unknown {
  if (isSensitiveKey(key, userPatterns)) return "[FILTERED]";
  if (isPlainObject(value)) {
    return sanitizeNestedObject(value as Record<string, unknown>, depth, userPatterns);
  }
  if (Array.isArray(value)) {
    return sanitizeArrayValue(value, depth, userPatterns);
  }
  return value;
}

function sanitizeNestedObject(
  hash: Record<string, unknown>,
  depth: number,
  userPatterns: readonly string[],
): unknown {
  if (depth >= MAX_NESTING_DEPTH) return "[Object]";
  if (Object.keys(hash).length === 0) return {};

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(hash)) {
    out[k] = sanitizeValue(k, hash[k], depth + 1, userPatterns);
  }
  return out;
}

function sanitizeArrayValue(
  array: unknown[],
  depth: number,
  userPatterns: readonly string[],
): unknown {
  if (array.length === 0) return [];

  const allPrimitive = array.every(isPrimitive);
  if (allPrimitive) {
    if (array.length <= MAX_ARRAY_DISPLAY_SIZE) return array;
    const preview = array.slice(0, MAX_ARRAY_DISPLAY_SIZE);
    return `${JSON.stringify(preview)}... (${array.length} total)`;
  }

  if (array.length <= MAX_ARRAY_DISPLAY_SIZE) {
    return array.map((item) => sanitizeArrayItem(item, depth, userPatterns));
  }

  return {
    _truncated: true,
    _count: array.length,
    _preview: array
      .slice(0, MAX_ARRAY_DISPLAY_SIZE)
      .map((item) => sanitizeArrayItem(item, depth, userPatterns)),
  };
}

function sanitizeArrayItem(
  item: unknown,
  depth: number,
  userPatterns: readonly string[],
): unknown {
  if (isPrimitive(item)) return item;
  if (isPlainObject(item)) {
    return sanitizeNestedObject(item as Record<string, unknown>, depth + 1, userPatterns);
  }
  if (Array.isArray(item)) return sanitizeArrayValue(item, depth + 1, userPatterns);
  return "[Object]";
}

function isSensitiveKey(key: string, userPatterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_VARIABLE_PATTERNS.some((p) => lower.includes(p))) return true;
  return userPatterns.some((p) => lower.includes(p.toLowerCase()));
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
