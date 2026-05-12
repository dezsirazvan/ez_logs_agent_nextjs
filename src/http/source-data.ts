/**
 * HTTP source_data extraction.
 *
 * Builds the source_data object the EventBuilder receives. Mirrors the
 * Ruby agent's `extract_source_data` shape (method, path, status_code,
 * controller, action, format, user_agent, remote_ip, request_params)
 * but populates Next.js-specific values for `controller` and `action`
 * (route module path + HTTP method, or "server-action" + function
 * name). See AGENT_PARITY_NOTES.md.
 *
 * Compacts nullish keys before returning, so `source_data` only
 * contains values that were actually known at capture time.
 */

import { sanitizeRequestParams } from "./sanitize.js";

export interface HttpCaptureInput {
  method: string;
  url: URL;
  /** Final HTTP status. Null when the handler threw before responding. */
  statusCode: number | null;
  /** Already-parsed request body (JSON, form, or query). Sanitization is applied here. */
  rawParams: unknown;
  /** Route handler module path, e.g. `app/api/users` or `pages/api/users`. */
  routeModulePath?: string | null;
  /** Server-action function name when invoked via Server Actions; otherwise null. */
  serverActionName?: string | null;
  /** User-Agent header. */
  userAgent: string | null;
  /** Forwarded-for or remote-addr. */
  remoteIp: string | null;
  /** Content-Type header (used to derive `format`). */
  contentType: string | null;
  /** Optional GraphQL metadata if this is a /graphql POST. */
  graphql?: GraphqlMetadata;
  /** User-configured additional sensitive variable key patterns. */
  excludedVariableKeys: readonly string[];
}

export interface GraphqlMetadata {
  graphql_operation: string;
  graphql_type: "query" | "mutation" | "subscription" | null;
  graphql_variables: Record<string, unknown> | null;
}

export function buildHttpSourceData(
  input: HttpCaptureInput,
): Record<string, unknown> {
  const { controller, action } = resolveControllerAction(input);

  const source: Record<string, unknown> = {
    method: input.method,
    path: input.url.pathname,
    status_code: input.statusCode,
    controller,
    action,
    format: deriveFormat(input.contentType),
    user_agent: input.userAgent,
    remote_ip: input.remoteIp,
  };

  // For Server Actions, parse the camelCase action name into a verb +
  // entity pair. The dashboard's NLP layer uses these to render
  // human titles ("Updated employee" instead of "Submitted server
  // action updateemployeeaction"). When the parse doesn't yield a
  // confident verb we omit the field rather than guessing — better
  // to render the raw action name than to mislead.
  if (input.serverActionName) {
    const parsed = parseServerActionName(input.serverActionName);
    if (parsed.verb) source.verb = parsed.verb;
    if (parsed.entity) source.entity = parsed.entity;
  }

  if (input.graphql) {
    if (input.graphql.graphql_operation) {
      source.graphql_operation = input.graphql.graphql_operation;
    }
    if (input.graphql.graphql_type) {
      source.graphql_type = input.graphql.graphql_type;
    }
    if (input.graphql.graphql_variables) {
      source.graphql_variables = input.graphql.graphql_variables;
    }
  } else {
    const params = sanitizeRequestParams(input.rawParams, input.excludedVariableKeys);
    if (params !== null) source.request_params = params;
  }

  return compact(source);
}

function resolveControllerAction(input: HttpCaptureInput): {
  controller: string | null;
  action: string | null;
} {
  if (input.serverActionName) {
    return { controller: "server-action", action: input.serverActionName };
  }
  return {
    controller: input.routeModulePath ?? null,
    action: input.method,
  };
}

// Verbs we recognize as the leading token of a Server Action name.
// Each maps to the canonical past-tense form the dashboard renders
// ("update" → "Updated"). Conservative list — we only normalize
// names we're sure about; unknown leading tokens leave verb/entity
// unset so the dashboard falls back to the raw action name.
const KNOWN_VERBS = new Map<string, string>([
  ["create", "create"],
  ["add", "create"],
  ["new", "create"],
  ["update", "update"],
  ["edit", "update"],
  ["save", "update"],
  ["modify", "update"],
  ["change", "update"],
  ["set", "update"],
  ["rename", "update"],
  ["delete", "destroy"],
  ["remove", "destroy"],
  ["destroy", "destroy"],
  ["archive", "destroy"],
  ["bulk", null as unknown as string], // handled below
  ["mark", null as unknown as string],
  ["assign", "update"],
  ["unassign", "update"],
  ["report", "update"],
  ["put", "update"],
  ["list", "read"],
  ["get", "read"],
  ["fetch", "read"],
  ["read", "read"],
  ["view", "read"],
  ["search", "read"],
  ["import", "create"],
  ["export", "read"],
  ["upload", "create"],
  ["download", "read"],
  ["send", "create"],
  ["invite", "create"],
  ["accept", "update"],
  ["reject", "update"],
  ["approve", "update"],
  ["enable", "update"],
  ["disable", "update"],
  ["activate", "update"],
  ["deactivate", "update"],
  ["start", "update"],
  ["stop", "update"],
  ["cancel", "update"],
  ["complete", "update"],
  ["sync", "update"],
  ["refresh", "update"],
  ["regenerate", "update"],
  ["resend", "update"],
  ["restore", "update"],
  ["duplicate", "create"],
  ["clone", "create"],
  ["move", "update"],
  ["copy", "create"],
  ["link", "update"],
  ["unlink", "update"],
  ["attach", "update"],
  ["detach", "update"],
  ["confirm", "update"],
  ["dismiss", "update"],
  ["publish", "update"],
  ["unpublish", "update"],
]);

/**
 * Parse a Server Action function name into a verb + entity pair.
 *
 * Conventions we recognize (lifted from the App Router community
 * patterns + Vercel templates):
 *
 *   updateHardwareAction          -> { verb: "update", entity: "Hardware" }
 *   createSpaceAction             -> { verb: "create", entity: "Space" }
 *   deleteEmployeeAction          -> { verb: "destroy", entity: "Employee" }
 *   bulkAssignHardwareAction      -> { verb: "update", entity: "Hardware" }
 *   markHardwareAsReceivedAction  -> { verb: "update", entity: "Hardware" }
 *   listCanvasesAction            -> { verb: "read", entity: "Canvas" }
 *
 * The "Action" suffix is stripped if present. The trailing "s" on a
 * pluralized entity is stripped to a singular form ("Canvases"
 * → "Canvase" — we keep this naive on purpose; the dashboard's title
 * pluralization handles the display layer). When we can't confidently
 * extract a verb we return both as null so the caller can fall back.
 */
function parseServerActionName(name: string): {
  verb: string | null;
  entity: string | null;
} {
  // Strip the conventional "Action" suffix.
  const withoutSuffix = name.replace(/Action$/, "");
  if (!withoutSuffix) return { verb: null, entity: null };

  // Tokenize on the camelCase boundaries. `updateHardware` →
  // ["update", "Hardware"]. `markHardwareAsReceived` →
  // ["mark", "Hardware", "As", "Received"].
  const tokens = withoutSuffix
    .split(/(?=[A-Z])/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { verb: null, entity: null };

  let leading = tokens[0]!.toLowerCase();
  let entityStart = 1;

  // Compound leading verbs we collapse to the dominant action:
  //   "bulkAssign…" → verb=update,    entity starts after "bulk"
  //   "markXAsY…"   → verb=update,    entity is the X token (between
  //                                   "mark" and "As").
  if (leading === "bulk" && tokens.length > 1) {
    leading = tokens[1]!.toLowerCase();
    entityStart = 2;
  }

  if (leading === "mark") {
    const asIdx = tokens.findIndex(
      (t, i) => i > 0 && t.toLowerCase() === "as",
    );
    if (asIdx > 1) {
      const entity = tokens.slice(1, asIdx).join("");
      return { verb: "update", entity: stripTrailingS(entity) || entity };
    }
    return { verb: "update", entity: null };
  }

  const canonical = KNOWN_VERBS.get(leading);
  if (!canonical) return { verb: null, entity: null };

  // Everything after the consumed leading verb tokens is the entity.
  const entityTokens = tokens.slice(entityStart);
  if (entityTokens.length === 0) return { verb: canonical, entity: null };

  const entity = entityTokens.join("");
  return { verb: canonical, entity: stripTrailingS(entity) || entity };
}

function stripTrailingS(entity: string): string {
  if (entity.length <= 1) return entity;
  if (entity.endsWith("ies")) return `${entity.slice(0, -3)}y`;
  if (entity.endsWith("s") && !entity.endsWith("ss")) return entity.slice(0, -1);
  return entity;
}

function deriveFormat(contentType: string | null): string | null {
  if (!contentType) return null;
  if (contentType.includes("json")) return "json";
  if (contentType.includes("xml")) return "xml";
  if (contentType.includes("form-urlencoded") || contentType.includes("multipart"))
    return "form";
  if (contentType.includes("text/html")) return "html";
  return null;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Determines outcome + error_message — port of `determine_outcome` in
 * http_request.rb. Same precedence: exception > 4xx/5xx > graphql
 * errors > success.
 */
export function determineOutcome(
  statusCode: number | null,
  exception: Error | null,
  graphqlResponseErrors: string | null,
): { outcome: "success" | "failure"; error_message: string | null } {
  if (exception) {
    return {
      outcome: "failure",
      error_message: `${exception.name}: ${exception.message}`,
    };
  }
  if (statusCode !== null && statusCode >= 400) {
    return { outcome: "failure", error_message: `HTTP ${statusCode}` };
  }
  if (graphqlResponseErrors) {
    return { outcome: "failure", error_message: graphqlResponseErrors };
  }
  return { outcome: "success", error_message: null };
}
