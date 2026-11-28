// Outgoing fetch correlation injection.
//
// When a request is being captured, downstream `fetch()` calls made
// from inside the handler should carry the same correlation id so the
// EZLogs server can stitch the cross-service chain back together.
//
// The Ruby agent's analog is the Sidekiq client middleware that
// stamps job_payload["correlation_id"] at enqueue. There's no Ruby
// equivalent for outgoing HTTP because Ruby HTTP libraries are too
// fragmented (Net::HTTP, Faraday, HTTParty, Typhoeus, etc.) — but
// in Node, `globalThis.fetch` is a single point.
//
// Behavior:
//   - On init, if `patchGlobalFetch !== false`, we wrap globalThis.fetch.
//   - Each outgoing call gets `X-Correlation-ID: <current()>` injected,
//     but only if (a) we're inside an active correlation scope AND
//     (b) the caller hasn't already set the header.
//   - The patch is idempotent: applying it twice is a no-op.
//   - It's reversible via `unpatchGlobalFetch()` (used in tests).

import { current as currentCorrelation } from "../correlation.js";
import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import { channelsRecordCalls, correlationForCall, now, recordCall, signOutWatch } from "./outbound-capture.js";
import { loadNodeBuiltin } from "../node-builtin.js";

const HEADER = "x-correlation-id";

let originalFetch: typeof fetch | null = null;
let patched = false;

export function patchGlobalFetch(): void {
  if (patched) return;
  if (typeof globalThis.fetch !== "function") return;

  originalFetch = globalThis.fetch;

  const wrapped: typeof fetch = (input, init) => {
    const id = currentCorrelation();
    if (!id) return originalFetch!.call(globalThis, input, init);

    // Where Node's channels don't record calls (Edge), the call is measured here, around the
    // promise the app already awaits: nothing is added to its wait (http/outbound-capture.ts).
    const measure = channelsRecordCalls() ? null : startMeasure(input, init);
    const signOut = channelsRecordCalls() ? null : watchSignOut(input, init);
    let enriched: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] } = { input, init };
    try {
      // Never the agent's own POST to EZLogs: on serverless its flush runs inside the request.
      if (!toEzlogsServer(input)) enriched = injectHeader(input, init, id);
    } catch (error) {
      // Never break a host fetch call — log and pass through unchanged.
      logger.debug(`outgoing-fetch injection failed: ${describeError(error)}`);
    }
    // Called once, outside the try: a fetch that throws must never be sent a second time.
    const call = originalFetch!.call(globalThis, enriched.input, enriched.init);
    if (signOut) call.then((response) => signOut(response.status), () => undefined);
    return measure ? measure(call) : call;
  };

  globalThis.fetch = wrapped;
  patched = true;
  subscribeUndiciRequests();
}

// `next dev` saves the original fetch before instrumentation runs and
// puts it back on every recompile, which silently drops the wrapper
// above. Node's own fetch (undici) announces every request on a
// diagnostics channel, whoever replaced `globalThis.fetch`, so the
// header is also added there. The wrapper stays for runtimes without
// that channel; whichever runs first sets the header, the other sees
// it and leaves it alone.
let subscribed = false;

function subscribeUndiciRequests(): void {
  if (subscribed) return;
  const channel = loadDiagnosticsChannel();
  if (!channel) return;
  channel.subscribe("undici:request:create", onUndiciRequest);
  subscribed = true;
}

interface UndiciRequestLike {
  headers?: unknown;
  addHeader?: (name: string, value: string) => unknown;
}

function onUndiciRequest(message: unknown): void {
  try {
    const request = (message as { request?: UndiciRequestLike & { origin?: unknown } } | null)?.request;
    if (!request || typeof request.addHeader !== "function") return;
    const id = currentCorrelation();
    if (!id || hasCorrelationHeader(request.headers)) return;
    if (sameOrigin(String(request.origin ?? ""), configuration().serverUrl)) return;
    request.addHeader(HEADER, id);
  } catch (error) {
    logger.debug(`outgoing request header injection failed: ${describeError(error)}`);
  }
}

// undici keeps request headers as a flat [name, value, ...] array
// (v6+) or a raw "name: value\r\n" string (v5).
function hasCorrelationHeader(headers: unknown): boolean {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === HEADER) return true;
    }
    return false;
  }
  if (typeof headers === "string") return headers.toLowerCase().includes(`${HEADER}:`);
  return false;
}

interface DiagnosticsChannelModule {
  subscribe(name: string, onMessage: (message: unknown, name: string | symbol) => void): void;
  unsubscribe(name: string, onMessage: (message: unknown, name: string | symbol) => void): boolean;
}

function loadDiagnosticsChannel(): DiagnosticsChannelModule | null {
  const mod = loadNodeBuiltin<DiagnosticsChannelModule>(["diagnostics", "channel"].join("_"));
  return typeof mod?.subscribe === "function" ? mod : null;
}

export function unpatchGlobalFetch(): void {
  if (!patched || originalFetch === null) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  patched = false;
  if (subscribed) {
    loadDiagnosticsChannel()?.unsubscribe("undici:request:create", onUndiciRequest);
    subscribed = false;
  }
}

export function isPatched(): boolean {
  return patched;
}

interface EnrichedFetchArgs {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
}

function injectHeader(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  correlationId: string,
): EnrichedFetchArgs {
  // Three call shapes we have to handle:
  //   fetch(url, init)            — most common
  //   fetch(request)              — Request-as-input
  //   fetch(request, init)        — overrides on a Request
  //
  // For the Request-as-input shapes we clone the Request with merged
  // headers; for plain url+init we mutate a copy of `init`.

  if (input instanceof Request && !init) {
    if (input.headers.has(HEADER)) return { input, init };
    const merged = new Headers(input.headers);
    merged.set(HEADER, correlationId);
    return {
      input: new Request(input, { headers: merged }),
      init: undefined,
    };
  }

  const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
  if (headers.has(HEADER)) return { input, init };
  headers.set(HEADER, correlationId);

  return {
    input,
    init: { ...init, headers },
  };
}

// ---------------------------------------------------------------- Edge measuring and self-skip

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function methodOf(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function sameOrigin(a: string, b: string | null): boolean {
  if (!b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// A prefix check first, so an ordinary call parses no URL here.
function toEzlogsServer(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const server = configuration().serverUrl;
    if (!server) return false;
    const url = urlOf(input);
    return url.startsWith(server.replace(/\/+$/, "")) && sameOrigin(url, server);
  } catch {
    return false;
  }
}

function watchSignOut(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): ((status: number) => void) | null {
  try {
    return signOutWatch(methodOf(input, init), urlOf(input));
  } catch {
    return null;
  }
}

function startMeasure(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): ((call: Promise<Response>) => Promise<Response>) | null {
  try {
    const url = urlOf(input);
    const id = correlationForCall(new URL(url).origin);
    if (!id) return null;
    const started = now();
    const method = methodOf(input, init);
    return (call) =>
      call.then(
        (response) => {
          recordCall(id, started, url, method, response.status, null);
          return response;
        },
        (error: unknown) => {
          recordCall(id, started, url, method, 0, (error as { name?: string } | null)?.name ?? "Error");
          throw error;
        },
      );
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
