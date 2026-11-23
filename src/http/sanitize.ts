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
  // 0.2.0 additions (in the Rails gem's list since 0.2.11).
  "passcode",
  "cardnumber",
  // One-time and recovery codes (0.4.13; every list).
  "verification_code",
  "recovery_code",
  "backup_code",
  "one_time_code",
  "login_code",
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
  "jti",
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

// Value-shape masking, the same rules as the Rails gem's `Sanitizer.scrub_text`
// and the server's ingest masker (shared vectors and adversarial inputs:
// tests/fixtures/secret_text_vectors.json). Every rule is linear in the
// input's length. Whitespace is spelled out so Ruby (ASCII `\s`) and
// JavaScript (Unicode `\s`) read NBSP and other spaces the same way.
const WS = " \\t\\n\\r\\f\\v\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
const URL_STOP = WS + "\"'<>\\\\`";
// A URL keeps its scheme, host and path; its `user:pass@` and everything from `?` or `#` go.
const URL_PATTERN = new RegExp(
  `([A-Za-z][A-Za-z0-9+.-]{0,30}://)(?:[^${URL_STOP}/?#]*@)?([^${URL_STOP}?#]*)(?:[?#][^${URL_STOP}]*)?`,
  "g",
);
// The same written URL-encoded (`https%3A%2F%2Fapp%2Freset%3Ftoken%3D…`), any case.
const ENCODED_URL = new RegExp(
  `([A-Za-z][A-Za-z0-9+.-]{0,30}%3A%2F%2F)(?:(?:(?!%40|%2F|%3F|%23)[^${URL_STOP}/?#])*%40)?` +
    `((?:(?!%3F|%23)[^${URL_STOP}?#])*)(?:(?:%3F|%23)[^${URL_STOP}]*)?`,
  "gi",
);
const ENCODED_SCHEME = /%3A%2F%2F/i;
// A whole value that is a path (`/reset/…?token=…`, `//cdn/x?sig=…`): its query and fragment go.
const RELATIVE_PATH = new RegExp(`^/[^${WS}]*$`);
// A path segment that looks generated: 16+ characters with a lowercase letter, an uppercase letter
// and a digit, never a file name with a "." (webhook and reset tokens; some random ids such as nanoids too), or a Telegram bot token.
const TOKEN_SEGMENT = /^(?:bot\d+:[A-Za-z0-9_-]+|(?=[^a-z]*[a-z])(?=[^A-Z]*[A-Z])(?=\D*\d)(?![^.]*\.)[\s\S]{16,})$/;
const SEGMENT_SPLIT = /(\/|%2F)/i;
// Secrets recognizable by their shape inside free text: PEM private keys (the
// body ends at the next `-----`), well-known API key prefixes (Stripe, Stripe
// webhook, GitHub, Slack, AWS). Never inside a word.
const START = "(?<![A-Za-z0-9])";
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[^-]*(?:-(?!----)[^-]*)*(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g,
  new RegExp(`${START}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+`, "g"),
  new RegExp(`${START}whsec_[A-Za-z0-9+/=]{8,}`, "g"),
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{20,}`, "g"),
  new RegExp(`${START}xox[abposr]-[A-Za-z0-9-]+`, "g"),
  new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`, "g"),
];
// Runs judged whole (isJwt, an OpenAI-style key with a digit): a match never rescans its own text.
const JWT_RUN = new RegExp(`${START}eyJ[\\w-]*(?:\\.[\\w-]*)*`, "g");
const SK_RUN = new RegExp(`${START}sk-[A-Za-z0-9_-]*`, "g");
// A word after "Bearer" or "Basic", judged by isCredential (never "Basic Monthly", "Bearer of bad news").
const AUTH_CREDENTIAL = new RegExp(`${START}(Bearer|Basic)[${WS}]+([\\w.~+/=-]+)`, "gi");
const CARD_NUMBER = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function maskSegments(path: string): string {
  return path
    .split(SEGMENT_SPLIT)
    .map((part) => (TOKEN_SEGMENT.test(part) ? "[FILTERED]" : part))
    .join("");
}

// "eyJ…" then dots: a header, a payload, then a signature or a payload of 16+.
function isJwt(run: string): boolean {
  const parts = run.split(".");
  return parts.length >= 2 && parts[0]!.length > 3 && parts[1]!.length > 0 && (parts.length >= 3 || parts[1]!.length >= 16);
}

// A credential has a digit or symbol, or a lower-then-upper letter pair (base64), or 16+
// characters; after "Basic" also 8+ characters ("Basic 2", "Basic Membership" are plan names).
function isCredential(scheme: string, token: string): boolean {
  const shaped = /[\d._~+/=-]/.test(token) || /[a-z][A-Z]/.test(token);
  if (scheme.toLowerCase() === "bearer") return shaped || token.length >= 16;
  return token.length >= 16 || (shaped && token.length >= 8);
}

/**
 * Mask secrets inside free text (every string and key an event carries):
 * URLs (also URL-encoded ones, and a whole value that is a path) lose their
 * credentials, query and fragment, and token-like path segments; the shapes
 * above, JWTs, `sk-` keys with a digit, `Bearer` / `Basic` credentials and
 * Luhn-valid 15-16 digit numbers (in a path too) become `"[FILTERED]"`; with
 * `emails`, email addresses too.
 */
export function scrubSecretsInText(
  text: string,
  options: { emails?: boolean; segments?: boolean } = {},
): string {
  // segments: false for the event's own request or outbound `path` (titles read its ids; a token in a
  // route is a known limit until agents send the route pattern).
  const cut = options.segments === false ? (p: string) => p : maskSegments;
  let out = text;
  if (out.includes("://")) out = out.replace(URL_PATTERN, (_m, scheme: string, rest: string) => scheme + cut(rest));
  if (ENCODED_SCHEME.test(out)) out = out.replace(ENCODED_URL, (_m, scheme: string, rest: string) => scheme + cut(rest));
  if (RELATIVE_PATH.test(out)) out = cut(out.replace(/[?#][\s\S]*$/, ""));
  for (const pattern of SECRET_TEXT_PATTERNS) out = out.replace(pattern, "[FILTERED]");
  out = out.replace(JWT_RUN, (run) => (isJwt(run) ? "[FILTERED]" : run));
  out = out.replace(SK_RUN, (run) => (run.length >= 19 && /\d/.test(run) ? "[FILTERED]" : run));
  out = out.replace(AUTH_CREDENTIAL, (match, scheme: string, token: string) =>
    isCredential(scheme, token) ? `${scheme} [FILTERED]` : match,
  );
  out = out.replace(CARD_NUMBER, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return (digits.length === 15 || digits.length === 16) && passesLuhn(digits) ? "[FILTERED]" : match;
  });
  return options.emails ? out.replace(EMAIL, "[FILTERED]") : out;
}

// Action-name words that make an action's unnamed arguments secrets (setPin(4821),
// verifyOtp("123456"), Devise's reset_password_instructions(user, token)). Same list as the
// server redactor and the Rails gem.
export const SECRET_ACTION_WORDS: ReadonlySet<string> = new Set([
  "pin", "otp", "code", "verify", "mfa", "2fa", "cvv", "cvc", "card",
  "password", "passwd", "secret", "token", "sign", "signin", "login",
  "reset", "credential", "credentials", "unlock", "confirmation", "invitation",
]);
const METHOD_NAME = /^[a-z]+(?:_[a-z]+)+$/;
// ActionMailer's job arguments: the mailer class, its method, then "deliver_now" / "deliver_later"
// (a Rails shape; kept for parity with the gem and the server, it never fires on a JS queue).
const MAILER_CLASS = /^[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*$/;
const MAILER_METHOD = /^[a-z_][a-z0-9_]*$/;
const DELIVERY = /^deliver_(?:now|later)!?$/;
const KEPT_CALL_ARG = /^(?:gid:\/\/|\d{1,20}$|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$)/;

function isSecretName(name: string): boolean {
  const words = name.split("_");
  const pairs = words.slice(1).map((w, i) => words[i] + w);
  return [...words, ...pairs].some((w) => SECRET_ACTION_WORDS.has(w));
}

function maskCallArg(arg: unknown): unknown {
  if (typeof arg === "string") return METHOD_NAME.test(arg) || KEPT_CALL_ARG.test(arg) ? arg : "[FILTERED]";
  if (Array.isArray(arg)) return arg.map(maskCallArg);
  if (isPlainObject(arg)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) out[k] = k === "args" ? maskCallArg(v) : v;
    return out;
  }
  return arg;
}

/**
 * A mailer job whose method has a secret word (`reset_password_instructions`):
 * its positional strings are masked, except method names, GlobalIDs, numbers
 * and UUIDs. Only ActionMailer's own shape (mailer class, method,
 * deliver_now/deliver_later); an ordinary job's "card_declined" stays. Same
 * rule as the Rails gem and the server.
 */
export function maskSecretCallArgs(args: unknown[]): unknown[] {
  const [mailer, method, delivery] = args;
  const mailerCall =
    args.length > 3 &&
    typeof mailer === "string" && MAILER_CLASS.test(mailer) &&
    typeof method === "string" && MAILER_METHOD.test(method) &&
    typeof delivery === "string" && DELIVERY.test(delivery) &&
    isSecretName(method);
  return mailerCall ? args.map((a, i) => (i > 2 ? maskCallArg(a) : a)) : args;
}

/** A key masked like a value; two keys masked alike both stay ("[FILTERED]", "[FILTERED] 2"). */
export function uniqueKey(taken: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(taken, key)) return key;
  let n = 2;
  while (Object.hasOwn(taken, `${key} ${n}`)) n += 1;
  return `${key} ${n}`;
}

/**
 * Job arguments — port of the Rails gem's `Sanitizer.sanitize_args`:
 * a positional list, same key redaction, depth and array rules.
 */
export function sanitizeArgs(args: unknown[], userPatterns: readonly string[] = []): unknown {
  return sanitizeArrayValue(maskSecretCallArgs(args), 0, userPatterns);
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
