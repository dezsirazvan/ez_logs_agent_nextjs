/**
 * EventBuilder — port of ez_logs_agent/lib/ez_logs_agent/event_builder.rb.
 *
 * This module is the wire-format contract. The Node agent's only correctness
 * requirement is that the JSON it ships matches what the Ruby agent ships
 * for an equivalent invocation, byte-for-byte.
 *
 * KEY ORDERING IS LOAD-BEARING.
 * The output object's top-level keys are emitted in this order:
 *   timestamp, source_type, source_data, outcome, correlation_id,
 *   resource_ids, context, duration_ms, error_message
 * Do not refactor `build()` to use object spread or computed keys; the
 * parity tests assert deep equality AND key ordering against the Ruby
 * fixtures.
 *
 * Pure, side-effect-free. Validates, sanitizes, returns the event object.
 * Does NOT buffer, ship, or generate correlation IDs.
 */

export type SourceType =
  | "http_request"
  | "background_job"
  | "database_callback";

export type Outcome = "success" | "failure";

export interface ResourceId {
  resource_type: string;
  resource_id: string;
}

export interface Event {
  timestamp: string;
  source_type: SourceType;
  source_data: Record<string, unknown>;
  outcome: Outcome;
  correlation_id: string | null;
  resource_ids: ResourceId[];
  context: Record<string, unknown> | null;
  duration_ms: number | null;
  error_message: string | null;
}

export interface BuildInput {
  source_type: SourceType | string;
  source_data: Record<string, unknown>;
  outcome: Outcome | string;
  correlation_id?: string | null;
  resource_ids?: ResourceId[];
  context?: Record<string, unknown> | null;
  duration_ms?: number | null;
  error_message?: string | null;
  timestamp?: string | Date | null;
}

/** Sensitive keys filtered from source_data and context (matches Ruby SENSITIVE_KEYS). */
export const SENSITIVE_KEYS: readonly string[] = Object.freeze([
  "password",
  "token",
  "secret",
  "api_key",
  "credit_card",
]);

const VALID_SOURCE_TYPES: readonly string[] = [
  "http_request",
  "background_job",
  "database_callback",
];

const VALID_OUTCOMES: readonly string[] = ["success", "failure"];

export function build(input: BuildInput): Event {
  const source_type = validateSourceType(input.source_type);
  const source_data_raw = validateSourceData(input.source_data);
  const outcome = validateOutcome(input.outcome);
  const timestamp = validateTimestamp(input.timestamp ?? null);
  const resource_ids = validateResourceIds(input.resource_ids ?? []);
  const context_raw = validateContext(input.context ?? null);
  const duration_ms = validateDurationMs(input.duration_ms ?? null);
  const error_message = input.error_message ?? null;

  validateOutcomeErrorConsistency(outcome, error_message);

  const source_data = sanitizeRecord(source_data_raw);
  const context = context_raw === null ? null : sanitizeRecord(context_raw);
  const correlation_id = input.correlation_id ?? null;

  // Top-level key order matters — this is the wire format. See file header.
  const event: Event = {
    timestamp,
    source_type,
    source_data,
    outcome,
    correlation_id,
    resource_ids,
    context,
    duration_ms,
    error_message,
  };
  return event;
}

function validateSourceType(value: unknown): SourceType {
  if (value === null || value === undefined) {
    throw new ArgError("source_type is required");
  }
  const normalized = String(value);
  if (!VALID_SOURCE_TYPES.includes(normalized)) {
    throw new ArgError(
      `source_type must be one of ${VALID_SOURCE_TYPES.join(", ")}, got: ${normalized}`,
    );
  }
  return normalized as SourceType;
}

function validateSourceData(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new ArgError("source_data is required");
  }
  if (!isPlainObject(value)) {
    throw new ArgError(
      `source_data must be an object, got: ${describe(value)}`,
    );
  }
  return value;
}

function validateOutcome(value: unknown): Outcome {
  if (value === null || value === undefined) {
    throw new ArgError("outcome is required");
  }
  const normalized = String(value);
  if (!VALID_OUTCOMES.includes(normalized)) {
    throw new ArgError(
      `outcome must be one of ${VALID_OUTCOMES.join(", ")}, got: ${normalized}`,
    );
  }
  return normalized as Outcome;
}

/**
 * Format: `YYYY-MM-DDTHH:MM:SS.mmmZ` (3-digit millisecond, literal `Z`).
 * Matches Ruby's `%Y-%m-%dT%H:%M:%S.%3NZ`. JavaScript's `toISOString()`
 * already produces this exact format for valid Dates.
 */
function validateTimestamp(value: string | Date | null): string {
  if (value === null) {
    return new Date().toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ArgError(
        `timestamp must be valid ISO 8601 format, got: ${value}`,
      );
    }
    // Ruby preserves the input string verbatim when given a String. We do the
    // same — if a caller hands us "2026-01-15T12:00:00.000Z", we ship it as-is.
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ArgError("timestamp must be a valid Date");
    }
    return value.toISOString();
  }
  throw new ArgError(
    `timestamp must be a string or Date, got: ${describe(value)}`,
  );
}

function validateResourceIds(value: unknown): ResourceId[] {
  if (!Array.isArray(value)) {
    throw new ArgError(`resource_ids must be an array, got: ${describe(value)}`);
  }
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new ArgError(
        `resource_ids[${index}] must be an object, got: ${describe(entry)}`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (!("resource_type" in e) || !("resource_id" in e)) {
      throw new ArgError(
        `resource_ids[${index}] must have resource_type and resource_id keys, got: ${Object.keys(e).join(", ")}`,
      );
    }
    if (typeof e.resource_type !== "string") {
      throw new ArgError(
        `resource_ids[${index}].resource_type must be a string, got: ${describe(e.resource_type)}`,
      );
    }
    if (typeof e.resource_id !== "string") {
      throw new ArgError(
        `resource_ids[${index}].resource_id must be a string, got: ${describe(e.resource_id)}`,
      );
    }
  });
  return value as ResourceId[];
}

function validateContext(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new ArgError(
      `context must be an object or null, got: ${describe(value)}`,
    );
  }
  return value;
}

function validateDurationMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArgError(`duration_ms must be a number, got: ${describe(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new ArgError(`duration_ms must be an integer, got: ${value}`);
  }
  if (value < 0) {
    throw new ArgError(`duration_ms must be >= 0, got: ${value}`);
  }
  return value;
}

function validateOutcomeErrorConsistency(
  outcome: Outcome,
  error_message: string | null,
): void {
  if (outcome === "failure") {
    if (error_message === null || error_message === "") {
      throw new ArgError("error_message is required when outcome is 'failure'");
    }
  } else if (outcome === "success") {
    if (error_message !== null) {
      throw new ArgError("error_message must be null when outcome is 'success'");
    }
  }
}

function sanitizeRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (isSensitiveKey(key)) {
      result[key] = "[FILTERED]";
    } else if (isPlainObject(value)) {
      result[key] = sanitizeRecord(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        isPlainObject(item)
          ? sanitizeRecord(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((p) => lower.includes(p));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  return typeof value;
}

/**
 * Mirrors Ruby's ArgumentError. Thrown for any validation failure during
 * `build()`. Callers in capturers wrap `build()` in try/catch and log+drop
 * — never propagated to the host app.
 */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}
