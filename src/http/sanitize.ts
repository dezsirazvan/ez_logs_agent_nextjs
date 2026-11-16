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
  "public_key",
  "signing_key",
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
  // Crypto-material patterns — aligned with DB_SENSITIVE_PATTERNS
  // (PR #45). Request bodies can carry the same key material as DB
  // columns (a webhook POST containing a `signature` field, an HMAC
  // header echoed into a JSON body, a `pem`-encoded cert blob, etc).
  "pem",
  "cipher",
  "nonce",
  "salt",
  "digest",
  "signature",
  "hmac",
  // 0.2.0 additions (not yet in the Rails gem's list).
  "passcode",
  "cardnumber",
]);

/**
 * Short secret names that are only safe to match as a WHOLE word:
 * substring `pin` would hit `shipping`, `otp` would hit `footprint`,
 * `iban` would hit `caribbean`. Keys are split into words after
 * camelCase → snake_case, so `pin`, `pinCode`, `mdm_unlock_pin`
 * match while `pinned` and `shipping_address` do not.
 *
 * Mirrored by `ezlogs_is_sensitive_key()` in sql/postgres/00_install.sql
 * (tests/unit/sensitive-sql-parity.test.ts keeps them in sync). When a
 * DB-relevant list changes, also bump `ezlogs_patterns_version()` there
 * so already-attached triggers re-attach.
 */
export const SENSITIVE_WORD_PATTERNS: readonly string[] = Object.freeze([
  "pin",
  "otp",
  "totp",
  "iban",
  "mfa",
  "passphrase",
]);

/** `mdmUnlockPin` → `mdm_unlock_pin`, `apiKey` → `api_key`. */
function snakeLower(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Shared key matcher for HTTP params and DB columns. Substring
 * patterns are tested against the lowercased key and its snake_case
 * form (so `apiKey` matches `api_key`); word patterns only against
 * whole words of the snake_case form.
 */
export function matchesSensitiveKey(
  key: string,
  substringPatterns: readonly string[],
): boolean {
  const lower = key.toLowerCase();
  const snake = snakeLower(key);
  if (substringPatterns.some((p) => lower.includes(p) || snake.includes(p))) {
    return true;
  }
  const words = snake.split(/[^a-z0-9]+/);
  return SENSITIVE_WORD_PATTERNS.some((w) => words.includes(w));
}

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

/** Digits passing the Luhn checksum (card numbers do). */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Secrets recognizable by their shape inside free text: JWTs, PEM
// private keys, well-known API key prefixes (Stripe, GitHub, Slack,
// AWS, OpenAI/Anthropic-style `sk-`), bearer / basic credentials.
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mask secrets inside free text (error messages, json string values):
 * the shapes above, `Bearer` / `Basic` credentials and Luhn-valid
 * 15-16 digit card numbers become `"[FILTERED]"`; with `emails`, email
 * addresses too.
 */
export function scrubSecretsInText(text: string, options: { emails?: boolean } = {}): string {
  let out = text;
  for (const pattern of SECRET_TEXT_PATTERNS) out = out.replace(pattern, "[FILTERED]");
  out = out
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [FILTERED]")
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) => {
      const digits = match.replace(/[ -]/g, "");
      return (digits.length === 15 || digits.length === 16) && passesLuhn(digits) ? "[FILTERED]" : match;
    });
  return options.emails ? out.replace(EMAIL, "[FILTERED]") : out;
}

/**
 * Job arguments — port of the Rails gem's `Sanitizer.sanitize_args`:
 * a positional list, same key redaction, depth and array rules.
 */
export function sanitizeArgs(args: unknown[], userPatterns: readonly string[] = []): unknown {
  return sanitizeArrayValue(args, 0, userPatterns);
}

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

/** A request-param key that must never travel (built-in list + user patterns). */
export function isSensitiveKey(key: string, userPatterns: readonly string[] = []): boolean {
  if (matchesSensitiveKey(key, SENSITIVE_VARIABLE_PATTERNS)) return true;
  const lower = key.toLowerCase();
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

// Auth routes: sign-in / sign-up / sign-out / login / logout /
// register / session paths, Auth.js `/api/auth/*` (incl. callbacks) and
// Supabase's PKCE / email-confirm routes (`/auth/callback?code=`, `/auth/confirm`).
const AUTH_PATH =
  /(^|\/)(api\/auth\/|auth\/(callback|confirm)|log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|sessions?(\/|$))/i;
// Server Action names doing the same (`signIn`, `verifyOtp`, `login`).
const AUTH_ACTION = /^(sign_?(in|up|out)|log_?(in|out)|register|verify|reset|magic|otp|auth)/i;
// One-time codes and OAuth state: only secret on auth routes (`code`
// is a product code anywhere else, so it is NOT globally sensitive).
const AUTH_ONLY_KEY = /^(code|state|verificationcode|onetimecode|otp.*|pin|token.*)$/;
// Params holding a URL the user is sent to next.
const REDIRECT_KEY = /^(callbackurl|redirect(url|uri|to)?|returnto|returnurl|next|continue|frompage)$/;
// Query params inside such a URL that carry a secret.
const SECRET_QUERY_PARAM = /token|code|state|otp|secret|password|key|sig|auth/i;

const normKey = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATH.test(pathname);
}

export function isAuthActionName(name: string): boolean {
  return AUTH_ACTION.test(name);
}

/**
 * Pre-pass before `sanitizeRequestParams`: on auth routes, one-time
 * codes / OAuth state / OTPs become "[FILTERED]"; everywhere,
 * secret-looking query params inside redirect-target params
 * (`callbackUrl`, `redirect`, `from_page`, …) are masked.
 */
export function maskAuthParams(params: unknown, onAuthRoute: boolean, depth = 0): unknown {
  if (depth > 4 || params === null || typeof params !== "object") return params;
  if (Array.isArray(params)) return params.map((v) => maskAuthParams(v, onAuthRoute, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    const k = normKey(key);
    if (onAuthRoute && AUTH_ONLY_KEY.test(k) && value !== null && value !== undefined && value !== "") {
      out[key] = "[FILTERED]";
    } else if (REDIRECT_KEY.test(k) && typeof value === "string") {
      out[key] = maskUrlSecrets(value);
    } else {
      out[key] = maskAuthParams(value, onAuthRoute, depth + 1);
    }
  }
  return out;
}

/** `/reset?token=abc&step=2` → `/reset?token=[FILTERED]&step=2`; non-URLs unchanged. */
export function maskUrlSecrets(value: string): string {
  if (!value.includes("?")) return value;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const url = new URL(value, "http://localhost");
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM.test(name)) {
        url.searchParams.set(name, "[FILTERED]");
        changed = true;
      }
    }
    if (!changed) return value;
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}
