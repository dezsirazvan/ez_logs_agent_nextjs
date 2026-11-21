// Calls the app makes to outside services (Stripe, Resend, OpenAI, ...), recorded as
// `outbound_call` steps of the current action (docs/plans/outbound_calls_design.md on the
// server). This side only measures; the server decides what a call means.
//
// Never slow, never block, never change the app's call:
//   - Node: Node's own diagnostics channels (undici for fetch, http.client for http/https, which
//     stripe-node and axios use; Node 20 has no http.client error channel, so there an http/https
//     call that got no answer is not recorded). A subscriber runs synchronously beside the call and only reads:
//     the clock, the method, origin and path, the status. Nothing is awaited, nothing is wrapped.
//   - Edge (no channels): the fetch wrapper in outgoing-fetch.ts calls recordFetch* around the
//     promise it already returns.
//   - The event is built later, when the buffer drains (PendingCall.toEvent): the path pattern,
//     the domain and the per-action cap never run in the call's path.
//
// Never recorded: calls outside an action, to the EZLogs server, the agent's own calls (its
// Supabase actor lookup and pre-reads run inside runInternal), the app's own data stores reached
// over HTTP (its Supabase project, its Upstash Redis), and excludedHosts.

import { current as currentCorrelation } from "../correlation.js";
import { configuration } from "../configuration.js";
import { createScopedStorage } from "../edge-fallback.js";
import { build, type Event } from "../event-builder.js";
import { logger } from "../logger.js";
import { loadNodeBuiltin } from "../node-builtin.js";
import { pushEvent } from "../pipeline/buffer.js";

const MAX_PER_ACTION = 50;
const MAX_SEGMENTS = 8;
// The first word after the version is kept only when it is one of these common API collections
// ("/v1/charges" → "Created a charge"). Any other word becomes :id, even one that looks plural:
// "charles" or "james" could be a person. Identical to the server's and ez_logs_agent's lists.
const COLLECTIONS = new Set([
  "accounts", "activities", "addresses", "agents", "alerts", "apps", "assets", "assistants",
  "attachments", "audiences", "balances", "batches", "bookings", "calendars", "calls",
  "campaigns", "cards", "carts", "categories", "channels", "charges", "chats", "checkouts",
  "comments", "companies", "completions", "contacts", "conversations", "coupons", "credits",
  "customers", "deals", "deployments", "devices", "discounts", "disputes", "documents", "domains",
  "emails", "embeddings", "events", "files", "forms", "groups", "images", "invoices", "issues",
  "items", "jobs", "leads", "links", "lists", "locations", "logs", "meetings", "members",
  "messages", "metrics", "models", "notes", "notifications", "orders", "organizations", "pages",
  "payment_intents", "payment_methods", "payments", "payouts", "people", "plans", "posts", "prices", "products", "profiles", "projects",
  "prompts", "queries", "records", "refunds", "reports", "requests", "responses", "reviews",
  "rooms", "runs", "sessions", "shipments", "sites", "sources", "spaces", "subscribers",
  "subscriptions", "tasks", "teams", "templates", "threads", "tickets", "tokens", "transactions",
  "transcriptions", "transfers", "translations", "uploads", "users", "videos", "webhooks",
  "workspaces",
]);
const VERSION = /^v\d{1,2}$/;
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or"]);
const PRIVATE_SUFFIXES = new Set(["local", "internal", "localhost", "lan", "home", "intranet", "corp", "test", "example", "invalid"]);
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const READS = new Set(["GET", "HEAD"]);

/** One measured call waiting in the buffer; becomes its event when the buffer drains. */
export class PendingCall {
  readonly source_type = "outbound_call";
  constructor(
    readonly correlation_id: string,
    readonly at: Date,
    readonly durationMs: number,
    readonly url: string,
    readonly method: string,
    readonly status: number,
    readonly errorName: string | null,
  ) {}

  toEvent(): Event | null {
    return buildCallEvent(this);
  }
}

const internal = createScopedStorage<boolean>(Symbol.for("ezlogs-nextjs:internal-calls"));

/** Runs the agent's own calls (Supabase actor lookup, pre-reads): never recorded. */
export function runInternal<R>(callback: () => R): R {
  return internal.run(true, callback);
}

/** The current action's id when a call to `origin` should be recorded, else null. */
export function correlationForCall(origin: string): string | null {
  try {
    const config = configuration();
    if (config.captureOutbound === false) return null;
    if (internal.read()) return null;
    const id = currentCorrelation();
    if (!id) return null;
    if (isOwnOrExcluded(origin)) return null;
    return id;
  } catch {
    return null;
  }
}

export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Counted when the call is recorded, so one busy action can't push other actions' events out of
// the buffer. Bounded: past 2000 action ids the counts start over.
const perAction = new Map<string, number>();

export function recordCall(correlationId: string, startedAt: number, url: string, method: string, status: number, errorName: string | null): void {
  try {
    if (perAction.size > 2000) perAction.clear();
    const n = (perAction.get(correlationId) ?? 0) + 1;
    perAction.set(correlationId, n);
    if (n > MAX_PER_ACTION) return;
    pushEvent(new PendingCall(correlationId, new Date(), Math.max(0, Math.round(now() - startedAt)), url, method.toUpperCase(), status, errorName) as unknown as Event);
  } catch {
    // never disturb the app's call
  }
}

// ---------------------------------------------------------------- channels (Node)

interface CallState { id: string; started: number; url: string; method: string; done: boolean }
const undiciCalls = new WeakMap<object, CallState>();
const httpCalls = new WeakMap<object, CallState>();
// On globalThis like the buffer: a bundler that duplicates this module must not subscribe twice
// (every call recorded twice) or let the fetch wrapper measure beside live channels.
const STATE_KEY = Symbol.for("ezlogs-nextjs:outbound-channels");
const state = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= { installed: false, active: false }) as { installed: boolean; active: boolean };

interface Channels {
  subscribe(name: string, onMessage: (message: unknown) => void): void;
  unsubscribe(name: string, onMessage: (message: unknown) => void): boolean;
}

/** True once Node's channels record calls (the fetch wrapper then only stamps the header). */
export function channelsRecordCalls(): boolean {
  return state.active;
}

export function installOutboundCapture(): void {
  if (state.installed) return;
  state.installed = true;
  const channels = loadNodeBuiltin<Channels>(["diagnostics", "channel"].join("_"));
  if (!channels || typeof channels.subscribe !== "function") return;
  try {
    for (const [name, handler] of SUBSCRIPTIONS) channels.subscribe(name, handler);
    state.active = true;
  } catch (error) {
    // All or nothing: the fetch wrapper measures instead, never both.
    for (const [name, handler] of SUBSCRIPTIONS) {
      try { channels.unsubscribe(name, handler); } catch { /* not subscribed */ }
    }
    logger.debug(`outbound capture channels unavailable: ${String(error)}`);
  }
}

export function uninstallOutboundCapture(): void {
  if (!state.installed) return;
  state.installed = false;
  const channels = loadNodeBuiltin<Channels>(["diagnostics", "channel"].join("_"));
  if (channels && state.active) for (const [name, handler] of SUBSCRIPTIONS) channels.unsubscribe(name, handler);
  state.active = false;
}

type UndiciRequest = { origin?: unknown; path?: unknown; method?: unknown };

function onUndiciCreate(message: unknown): void {
  try {
    const request = (message as { request?: UndiciRequest } | null)?.request;
    if (!request) return;
    const origin = String(request.origin ?? "");
    const id = correlationForCall(origin);
    if (!id) return;
    undiciCalls.set(request as object, { id, started: now(), url: origin + String(request.path ?? "/"), method: String(request.method ?? "GET"), done: false });
  } catch {
    // never disturb the call
  }
}

function onUndiciHeaders(message: unknown): void {
  try {
    const m = message as { request?: object; response?: { statusCode?: number } } | null;
    const state = m?.request ? undiciCalls.get(m.request) : undefined;
    if (!state || state.done) return;
    state.done = true;
    recordCall(state.id, state.started, state.url, state.method, Number(m?.response?.statusCode ?? 0), null);
  } catch {
    // never disturb the call
  }
}

function onUndiciError(message: unknown): void {
  try {
    const m = message as { request?: object; error?: { name?: string } } | null;
    const state = m?.request ? undiciCalls.get(m.request) : undefined;
    if (!state || state.done) return;
    state.done = true;
    recordCall(state.id, state.started, state.url, state.method, 0, m?.error?.name ?? "Error");
  } catch {
    // never disturb the call
  }
}

type HttpRequest = { method?: unknown; host?: unknown; path?: unknown; protocol?: unknown };

function onHttpStart(message: unknown): void {
  try {
    const request = (message as { request?: HttpRequest } | null)?.request;
    if (!request) return;
    const origin = `${String(request.protocol ?? "https:")}//${String(request.host ?? "")}`;
    const id = correlationForCall(origin);
    if (!id) return;
    httpCalls.set(request as object, { id, started: now(), url: origin + String(request.path ?? "/"), method: String(request.method ?? "GET"), done: false });
  } catch {
    // never disturb the call
  }
}

function onHttpFinish(message: unknown): void {
  try {
    const m = message as { request?: object; response?: { statusCode?: number } } | null;
    const state = m?.request ? httpCalls.get(m.request) : undefined;
    if (!state || state.done) return;
    state.done = true;
    recordCall(state.id, state.started, state.url, state.method, Number(m?.response?.statusCode ?? 0), null);
  } catch {
    // never disturb the call
  }
}

function onHttpError(message: unknown): void {
  try {
    const m = message as { request?: object; error?: { name?: string; code?: string } } | null;
    const state = m?.request ? httpCalls.get(m.request) : undefined;
    if (!state || state.done) return;
    state.done = true;
    recordCall(state.id, state.started, state.url, state.method, 0, m?.error?.name ?? "Error");
  } catch {
    // never disturb the call
  }
}

const SUBSCRIPTIONS: ReadonlyArray<[string, (message: unknown) => void]> = [
  ["undici:request:create", onUndiciCreate],
  ["undici:request:headers", onUndiciHeaders],
  ["undici:request:error", onUndiciError],
  ["http.client.request.start", onHttpStart],
  ["http.client.response.finish", onHttpFinish],
  ["http.client.request.error", onHttpError],
];

// ---------------------------------------------------------------- building (at drain)

function buildCallEvent(pending: PendingCall): Event | null {
  try {
    const url = parse(pending.url);
    const data: Record<string, unknown> = { kind: "http" };
    const domain = url ? domainOf(url.host) : "";
    if (domain) data.host = domain;
    if (METHODS.has(pending.method)) data.method = pending.method;
    data.path = pathPattern(url ? url.pathname : "/");
    data.status_code = pending.status;
    if (pending.errorName && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(pending.errorName)) data.error_class = pending.errorName;
    const failed = callFailed(pending.method, pending.status);
    return build({
      source_type: "outbound_call",
      source_data: data,
      outcome: failed ? "failure" : "success",
      correlation_id: pending.correlation_id,
      resource_ids: [],
      context: null,
      duration_ms: pending.durationMs,
      error_message: failed ? (pending.errorName ?? `HTTP ${pending.status}`) : null,
      timestamp: pending.at.toISOString(),
    });
  } catch (error) {
    logger.debug(`outbound call build failed: ${String(error)}`);
    return null;
  }
}

/**
 * The server's rule: API versions, and the first segment after them only when it is a
 * known collection ("/v1/customers/cus_9x/orders" → "/v1/customers/:id/:id"). Nothing after it is
 * kept, and no unknown word: grammar can't tell a name ("charles") from a collection ("charges").
 */
export function pathPattern(path: string): string {
  const segments = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).slice(0, MAX_SEGMENTS);
  let first = true;
  const kept = segments.map((segment) => {
    if (first && VERSION.test(segment)) return segment;
    const keep = first && COLLECTIONS.has(segment);
    first = false;
    return keep ? segment : ":id";
  });
  return `/${kept.join("/")}`;
}

/**
 * Only the registrable domain leaves the app: a subdomain can name a customer. Never an address
 * or an internal name ("10.0.3.7", "billing.internal").
 */
export function domainOf(host: string): string {
  const full = host.toLowerCase();
  if (full.length > 260 || !HOST.test(full)) return "";
  const name = full.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(name)) return "";
  const labels = name.split(".");
  if (labels.length < 2 || PRIVATE_SUFFIXES.has(labels[labels.length - 1]!)) return "";
  const keep = labels.length > 2 && labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function callFailed(method: string, status: number): boolean {
  if (status === 0) return true;
  if (status < 400) return false;
  return !(status === 404 && READS.has(method));
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- what is never recorded

// Compared by host name without the port: Node's http module gives no port.
function hostnameOf(url: string): string {
  const parsed = parse(url);
  return parsed ? parsed.hostname.toLowerCase() : "";
}

let serverFor: string | null = null;
let serverHost = "";
function ezlogsHost(serverUrl: string | null): string {
  if (!serverUrl) return "";
  if (serverUrl !== serverFor) {
    serverFor = serverUrl;
    serverHost = hostnameOf(serverUrl);
  }
  return serverHost;
}

function isOwnOrExcluded(origin: string): boolean {
  const name = hostnameOf(origin);
  if (!name) return true;
  const config = configuration();
  if (name === ezlogsHost(config.serverUrl)) return true; // EZLogs itself
  if (ownDataStores().has(name)) return true;
  return (config.excludedHosts ?? []).some((h) => {
    const x = String(h).toLowerCase();
    return name === x || name.endsWith(`.${x}`);
  });
}

// The app's own data stores reached over HTTP: its Supabase project and its Upstash Redis. Their
// writes already show as data changes; their calls are not outside calls. Found from the env and
// from every Supabase client the agent wraps (a client built from any other setting).
let ownStores: Set<string> | null = null;
function ownDataStores(): Set<string> {
  if (ownStores) return ownStores;
  const env = typeof process !== "undefined" ? process.env ?? {} : {};
  ownStores = new Set(
    [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL, env.UPSTASH_REDIS_REST_URL, env.KV_REST_API_URL]
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .map(hostnameOf)
      .filter(Boolean),
  );
  return ownStores;
}

/** A data store the app reaches over HTTP (a wrapped Supabase client's URL): never an outside call. */
export function addOwnDataStore(url: unknown): void {
  try {
    const name = typeof url === "string" || url instanceof URL ? hostnameOf(String(url)) : "";
    if (name) ownDataStores().add(name);
  } catch {
    // never disturb the app
  }
}

/** Tests: forget memoized state. */
export function _resetOutboundForTests(): void {
  perAction.clear();
  ownStores = null;
  serverFor = null;
}
