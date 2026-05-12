// GraphQL helpers — minimal Node port of the GraphQL detection +
// sanitization paths in http_request.rb.
//
// The Ruby agent has a paranoid response-body reader (preserves Rack
// BodyProxy memory access) because Rack response bodies can be
// streaming, lazy, or wrapped. Next.js Response objects are the WHATWG
// fetch Response — well-behaved and cloneable — so we just .clone()
// before reading. That's the entire deviation.

import { pathMatches } from "./path-matcher.js";
import { sanitizeRequestParams } from "./sanitize.js";
import type { GraphqlMetadata } from "./source-data.js";

const QUERY_PREFIXES = ["Get", "Fetch", "List", "Find", "Load", "Search", "Query"];
const MUTATION_PREFIXES = ["Create", "Update", "Delete", "Remove", "Add", "Set", "Upsert"];

export function isGraphqlPath(path: string): boolean {
  return path === "/graphql" || path.startsWith("/graphql/");
}

export interface ParseGraphqlBodyResult {
  /** Either the metadata to merge into source_data, or `"skip"` to drop the event entirely (introspection queries). */
  metadata: GraphqlMetadata | "skip" | null;
}

export function parseGraphqlBody(
  body: unknown,
  excludedOperations: readonly string[],
  excludedVariableKeys: readonly string[],
): ParseGraphqlBodyResult {
  if (!isPlainObject(body)) return { metadata: null };
  const obj = body as Record<string, unknown>;

  const queryString = typeof obj.query === "string" ? obj.query : null;
  let operationName: string | null =
    typeof obj.operationName === "string" ? obj.operationName : null;
  if (!operationName && queryString) {
    operationName = extractOperationNameFromQuery(queryString);
  }

  if (operationName && isExcludedOperation(operationName, excludedOperations)) {
    return { metadata: "skip" };
  }

  const operationType =
    inferOperationTypeFromQuery(queryString) ??
    inferOperationTypeFromName(operationName);

  const sanitizedVariables = sanitizeRequestParams(obj.variables, excludedVariableKeys);

  return {
    metadata: {
      graphql_operation: operationName ?? "anonymous",
      graphql_type: operationType,
      graphql_variables: sanitizedVariables,
    },
  };
}

export function inferOperationTypeFromQuery(
  query: string | null,
): "query" | "mutation" | "subscription" | null {
  if (!query) return null;
  const trimmed = query.trimStart();
  if (/^mutation/i.test(trimmed)) return "mutation";
  if (/^subscription/i.test(trimmed)) return "subscription";
  if (/^query/i.test(trimmed) || trimmed.startsWith("{")) return "query";
  return null;
}

export function inferOperationTypeFromName(
  name: string | null,
): "query" | "mutation" | null {
  if (!name) return null;
  if (QUERY_PREFIXES.some((p) => name.startsWith(p))) return "query";
  if (MUTATION_PREFIXES.some((p) => name.startsWith(p))) return "mutation";
  return null;
}

export function extractOperationNameFromQuery(query: string): string | null {
  const match = query.match(
    /^\s*(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/i,
  );
  return match ? match[1]! : null;
}

function isExcludedOperation(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
    return name === pattern;
  });
}

/**
 * Read GraphQL errors from a JSON response payload (already-parsed).
 * Returns the joined error messages or null. Used by the HTTP capture
 * for 200-OK GraphQL responses that nevertheless contain errors.
 */
export function extractGraphqlErrorsFromBody(parsed: unknown): string | null {
  if (!isPlainObject(parsed)) return null;
  const errors = (parsed as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const messages = errors
    .map((err) => (isPlainObject(err) ? (err as Record<string, unknown>).message : null))
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  if (messages.length === 0) return null;
  return messages.length === 1 ? messages[0]! : messages.join("; ");
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Re-export so call sites in instrumentation can match excluded paths. */
export { pathMatches };
