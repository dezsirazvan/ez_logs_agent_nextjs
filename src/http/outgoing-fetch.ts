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
import { logger } from "../logger.js";

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

    try {
      const enriched = injectHeader(input, init, id);
      return originalFetch!.call(globalThis, enriched.input, enriched.init);
    } catch (error) {
      // Never break a host fetch call — log and pass through unchanged.
      logger.debug(`outgoing-fetch injection failed: ${describeError(error)}`);
      return originalFetch!.call(globalThis, input, init);
    }
  };

  globalThis.fetch = wrapped;
  patched = true;
}

export function unpatchGlobalFetch(): void {
  if (!patched || originalFetch === null) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  patched = false;
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

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
