/**
 * HTTP capture entry points.
 *
 * Next.js doesn't expose a "wrap every inbound request" hook the way
 * Rack does (instrumentation.ts is for server-startup tooling, not
 * per-request interception). The reliable pattern — used by Sentry,
 * Highlight, OpenTelemetry's Next.js packages, and now us — is:
 *
 *   1. `captureRoute(handler)` — wrap App Router Route Handlers /
 *      Pages Router API handlers / Server Actions. The user opts in
 *      per-route. Programmatic, fully typed, no magic.
 *
 *   2. `withMiddlewareCapture(middleware)` — wrap the user's root
 *      `middleware.ts` so every request that hits the Next.js Edge
 *      middleware seeds a correlation id and (optionally) an actor.
 *      Downstream Route Handlers see them via current().
 *
 *   3. `onRequestError(error, request, context)` — wire this in
 *      `instrumentation.ts` so unhandled errors still produce events.
 *
 * All three feed the same internal `captureHttpEvent()` so the wire
 * shape is identical regardless of entry point.
 */

import { configuration, type ActorContext } from "../configuration.js";
import { logger } from "../logger.js";
import { build as buildEvent } from "../event-builder.js";
import { pushEvent } from "../pipeline/buffer.js";
import { flushScheduler } from "../pipeline/flush-scheduler.js";
import { isServerless } from "../pipeline/serverless.js";
import { getCurrentActor, runWithActorScope, setActor } from "../actor.js";
import { classifyUserAgent, type AgentDetection } from "../user-agent-detector.js";
import {
  current as currentCorrelation,
  resolveCorrelation,
  runWithCorrelation,
} from "../correlation.js";
import { flushAuditLog, takeAuditSnapshot } from "../triggers/reader.js";
import { runWithAuditSnapshotScope } from "../triggers/audit-snapshot.js";
import { runWithEmittedAuditIdsScope } from "../triggers/emit-dedup.js";
import { hasExcludedExtension, pathMatches } from "./path-matcher.js";
import { DEFAULT_EXCLUDED_EXTENSIONS } from "../configuration.js";
import {
  buildHttpSourceData,
  determineOutcome,
  type GraphqlMetadata,
} from "./source-data.js";
import {
  extractGraphqlErrorsFromBody,
  isGraphqlPath,
  parseGraphqlBody,
} from "./graphql.js";

interface CaptureContext {
  routeModulePath?: string | null;
  serverActionName?: string | null;
}

interface RawRequestSnapshot {
  method: string;
  url: URL;
  userAgent: string | null;
  remoteIp: string | null;
  contentType: string | null;
  /** Already-parsed body (JSON form/body/query). The caller decides — we sanitize. */
  rawParams: unknown;
  /** GraphQL request body (parsed) if this is a /graphql POST. */
  graphqlBody: unknown;
  /**
   * Server Action identifier when the request carries Next.js's
   * `Next-Action` header. The classifier uses this to populate
   * source_data with controller="server-action" and a meaningful
   * action name instead of the generic "POST /page-url" shape.
   */
  serverActionId: string | null;
}

/**
 * Wrap a Route Handler / API handler / Server Action so each
 * invocation produces an event.
 *
 * Generic over the handler signature so users keep their typed
 * `(req: NextRequest) => Promise<Response>` shape.
 */
export function captureRoute<TArgs extends unknown[], TResult extends Response | Promise<Response>>(
  handler: (...args: TArgs) => TResult,
  context: CaptureContext = {},
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs): Promise<Response> => {
    // Pre-handler fail-open guard. Any throw from snapshotRequest,
    // resolveCorrelation, runWithCorrelation, or runWithActorAndAuditScope
    // SETUP must not break the host: we bypass capture and call the
    // handler directly. Once the handler has been invoked (handlerInvoked
    // flips to true), errors must propagate naturally — re-invoking the
    // handler would run it twice. EZLogs must never break the host.
    let handlerInvoked = false;
    const runHandler = (...invokeArgs: TArgs) => {
      handlerInvoked = true;
      return handler(...invokeArgs);
    };

    try {
      if (!configuration().captureHttp) {
        return Promise.resolve(runHandler(...args));
      }

      const request = args[0] as Request | undefined;
      if (!request || typeof request !== "object" || !("url" in request)) {
        // Not a request-shaped first arg — pass through. We only capture
        // when the handler matches the expected route signature.
        return Promise.resolve(runHandler(...args));
      }

      const snapshot = await snapshotRequest(request as Request);
      if (snapshot === null) return Promise.resolve(runHandler(...args)); // excluded

      // Reuse the correlation id seeded by middleware (or upstream) when
      // present; otherwise derive one from a platform-injected request id
      // (`x-vercel-id`, `cf-ray`, `x-request-id`) so multiple cold-started
      // entry points in the same request still group; finally fall back
      // to a fresh generated id. This is what lets DB events from inside
      // Server Actions, RSC renders, and route handlers all share the
      // same id and group into one Action card — even without
      // `middleware.ts`.
      const correlationId = resolveCorrelation((request as Request).headers ?? null);

      return await runWithCorrelation(correlationId, () =>
        runWithActorAndAuditScope(async () => {
          await maybeRunActorHook(request as Request);

          const startMs = Date.now();
          let statusCode: number | null = null;
          let response: Response | null = null;
          let exception: Error | null = null;
          let graphqlErrorMessage: string | null = null;

          try {
            response = await Promise.resolve(runHandler(...args));
            statusCode = response.status;

            if (snapshot.graphqlBody !== null && response.status === 200) {
              graphqlErrorMessage = await readGraphqlErrors(response);
            }
            return response;
          } catch (e) {
            exception = e instanceof Error ? e : new Error(String(e));
            throw e;
          } finally {
            // Last chance to populate the actor — at this point any
            // Supabase client constructed during the handler is
            // registered, and its auth cookies have been read.
            await maybeExtractSupabaseActor();

            await emitEvent({
              snapshot,
              context,
              statusCode,
              exception,
              graphqlErrorMessage,
              durationMs: Date.now() - startMs,
              startedAt: new Date(startMs),
            });
            // In serverless mode, the periodic flush scheduler can't be
            // trusted (the process freezes between invocations). Drain
            // synchronously here so this request's events ship before
            // the function returns.
            if (isServerless()) {
              await flushScheduler.flushNow().catch(() => {
                // never break the host request — flushNow already swallows
              });
            }
          }
        }),
      );
    } catch (preCaptureError) {
      if (handlerInvoked) throw preCaptureError;
      logger.warn(
        `captureRoute pre-handler setup failed (${describeError(preCaptureError)}); bypassing capture for this request`,
      );
      return Promise.resolve(handler(...args));
    }
  };
}

/**
 * Next.js root middleware wrapper. Seeds a correlation id and runs
 * the user's middleware function inside the scope so any awaited DB /
 * fetch calls in the middleware itself carry the id.
 *
 * Middleware runs at the OUTERMOST layer of every request, before
 * Next.js dispatches to a route handler, Server Action, or RSC
 * render. This wrapper:
 *
 *   1. Generates a correlation_id once per request.
 *   2. Stamps it on the request as `x-ezlogs-correlation-id` so
 *      ALL downstream handlers (route.ts, Server Actions, RSC,
 *      page-level POSTs) can read it via `headers().get(...)`.
 *   3. Mirrors the same id onto the response so the browser can
 *      surface it for client-side telemetry if needed.
 *
 * This is the single seed point that lets every captured event in
 * a request share one correlation_id — matching the Ruby agent's
 * Rack-middleware pattern, adapted for Next.js.
 */
export const CORRELATION_HEADER = "x-ezlogs-correlation-id";

/**
 * Structural shape of what we read from / write to. We avoid a hard
 * dep on `next/server` (NextRequest / NextResponse types) because
 * `next` is an optional peer dep — typing against the WHATWG fetch
 * primitives keeps the agent decoupled from the Next.js version.
 *
 * We need `url` and `method` for page-navigation event emission, in
 * addition to headers. NextRequest extends Request, so it satisfies
 * this shape.
 */
interface MiddlewareRequest {
  headers: Headers;
  url: string;
  method: string;
}

interface ResponseWithHeaders {
  headers: Headers;
  status?: number;
}

export function withMiddlewareCapture<
  TRequest extends MiddlewareRequest,
  TResponse extends ResponseWithHeaders,
>(
  middleware: (request: TRequest, ...rest: unknown[]) => Promise<TResponse> | TResponse,
): (request: TRequest, ...rest: unknown[]) => Promise<TResponse> {
  return async (request, ...rest): Promise<TResponse> => {
    let middlewareInvoked = false;
    const runMiddleware = (req: TRequest, ...mRest: unknown[]) => {
      middlewareInvoked = true;
      return middleware(req, ...mRest);
    };

    try {
      // Read existing id (forwarded from upstream — load balancer, prior
      // ezlogs hop, etc). Otherwise derive from a platform-injected
      // request id, otherwise generate fresh. We never overwrite —
      // caller intent wins, mirroring our outgoing-fetch injector.
      const correlationId = resolveCorrelation(request.headers);

      // Mutate the incoming request's headers so every downstream
      // handler sees the id via `headers()` from `next/headers`. Next.js's
      // middleware request-headers ARE mutable until the response is
      // returned — this is the documented pattern Sentry, Datadog, etc.
      // use to thread tracing context through.
      try {
        request.headers.set(CORRELATION_HEADER, correlationId);
      } catch {
        // headers locked — fall back to response-only stamping below.
      }

      return await runWithCorrelation(correlationId, () =>
        runWithActorAndAuditScope(async () => {
          const startMs = Date.now();
          const startedAt = new Date(startMs);
          const response = await Promise.resolve(runMiddleware(request, ...rest));

          // Stamp on the response too so the browser can pick it up for
          // client-side telemetry, and so any RSC payload returned to the
          // client carries a correlatable id.
          try {
            if (response?.headers && typeof response.headers.set === "function") {
              response.headers.set(CORRELATION_HEADER, correlationId);
            }
          } catch {
            // ignore — never break the host's middleware return value
          }

          // Emit a page-navigation event when the request looks like a
          // human navigating to a page (HTML accept, GET, no Server Action
          // header, no RSC payload marker). Route handlers, API calls,
          // and Server Actions are filtered out here so they don't double-
          // emit alongside captureRoute / captureServerAction.
          try {
            if (shouldEmitPageNavigation(request)) {
              // Run the user's actor hook so page navigations carry
              // "Triggered by" too. Without this every page view in the
              // dashboard renders "Unknown" while the route-handler
              // events from the same user show their email — confusing.
              // Casting because the middleware request and `Request` are
              // structurally compatible at the headers.get() / cookies
              // level the hook actually uses.
              await maybeRunActorHook(request as unknown as Request);
              await maybeExtractSupabaseActor();
              await emitPageNavigationEvent({
                request,
                statusCode:
                  typeof response?.status === "number" ? response.status : null,
                durationMs: Date.now() - startMs,
                startedAt,
              });
            }
          } catch (error) {
            logger.debug(`page navigation capture failed: ${describeError(error)}`);
          }

          return response;
        }),
      );
    } catch (preCaptureError) {
      if (middlewareInvoked) throw preCaptureError;
      logger.warn(
        `withMiddlewareCapture pre-handler setup failed (${describeError(preCaptureError)}); bypassing capture for this request`,
      );
      return await Promise.resolve(middleware(request, ...rest));
    }
  };
}

/**
 * Should a middleware-intercepted request produce a page-navigation
 * event? Yes when:
 *   - It's a GET (page renders are GETs; POST in middleware is a form
 *     submission that one of our other capturers will pick up).
 *   - It's NOT a Server Action invocation (`Next-Action` header).
 *   - It's NOT an RSC client-side fetch (`Next-Url` + RSC accept, or
 *     `?_rsc=...` query, or `RSC=1` header — Next sets these on
 *     client-side route transitions and they'd flood the timeline).
 *   - The path isn't excluded (static assets, `_next/*`, etc.).
 */
function shouldEmitPageNavigation(request: MiddlewareRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.get("next-action")) return false;
  if (request.headers.get("rsc")) return false;
  if (request.headers.get("next-router-prefetch")) return false;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.searchParams.has("_rsc")) return false;
  if (isExcludedPath(url.pathname, request.method)) return false;
  // API and route-handler paths are captured by captureRoute already;
  // emitting them again here would double up. We use the simple
  // /api/ prefix heuristic (covers both App Router /api/ and Pages
  // Router /api/) because the middleware doesn't know the actual route
  // resolution result.
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

async function emitPageNavigationEvent(input: {
  request: MiddlewareRequest;
  statusCode: number | null;
  durationMs: number;
  startedAt: Date;
}): Promise<void> {
  try {
    // Drain DB events the trigger captured during this request before
    // we ship the HTTP event itself.
    await flushTriggerAuditLog();
    const url = new URL(input.request.url);
    const userAgent = input.request.headers.get("user-agent");
    const remoteIp = extractRemoteIp(input.request.headers);

    const sourceData = buildHttpSourceData({
      method: "GET",
      url,
      statusCode: input.statusCode,
      rawParams: null,
      // Synthesize a Rails-like controller name from the path so the
      // dashboard's NLP can produce "Viewed <page>" titles consistent
      // with the Ruby agent's output.
      routeModulePath: pageControllerFromPath(url.pathname),
      userAgent,
      remoteIp,
      contentType: null,
      excludedVariableKeys: configuration().excludedGraphqlVariableKeys,
    });

    const { outcome, error_message } = determineOutcome(
      input.statusCode,
      null,
      null,
    );

    const event = buildEvent({
      source_type: "http_request",
      source_data: sourceData,
      outcome,
      correlation_id: currentCorrelation(),
      resource_ids: [],
      context: getCurrentActor() ? { actor: getCurrentActor() } : null,
      duration_ms: input.durationMs,
      error_message,
      timestamp: input.startedAt,
    });

    pushEvent(event);
  } catch (error) {
    logger.error(`page navigation emit failed: ${describeError(error)}`);
  }
}

/**
 * Derive a controller-style identifier from a page URL. Strips dynamic
 * segment markers and trailing slashes so the dashboard groups
 * navigations across instances of the same page (e.g.
 * `/hardware/abc-123` and `/hardware/def-456` both become `hardware`).
 *
 * We don't have access to Next's matched route at the middleware
 * level, so this is a heuristic. UUIDs and numeric ids in the path
 * are normalized to `[id]`.
 */
function pageControllerFromPath(pathname: string): string {
  const stripped = pathname.replace(/^\/+|\/+$/g, "");
  if (!stripped) return "page:home";
  const segments = stripped.split("/").map((segment) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
      return "[id]";
    }
    if (/^\d+$/.test(segment)) return "[id]";
    return segment;
  });
  return `page:${segments.join("/")}`;
}

/**
 * Pages Router API wrapper. Pages Router handlers use the older
 * Node-style `(req, res) => void | Promise<void>` signature instead
 * of the WHATWG `(request) => Response` signature App Router uses.
 *
 * We snapshot enough off the Node `req` to build the same source_data
 * shape, observe `res.statusCode` after the user's handler resolves,
 * and emit the event. Any thrown error is captured then re-raised so
 * the user's error handling still works.
 *
 * Used by the build-time auto-wrap loader for `pages/api/**` routes.
 * Also exported publicly for users who want to wrap manually.
 */
export function capturePagesApi<TArgs extends [PagesApiReq, PagesApiRes, ...unknown[]]>(
  handler: (...args: TArgs) => unknown,
  context: CaptureContext = {},
): (...args: TArgs) => Promise<unknown> {
  return async (...args: TArgs): Promise<unknown> => {
    let handlerInvoked = false;
    const runHandler = (...invokeArgs: TArgs) => {
      handlerInvoked = true;
      return handler(...invokeArgs);
    };

    try {
      if (!configuration().captureHttp) {
        return Promise.resolve(runHandler(...args));
      }
      const req = args[0];
      const res = args[1];
      if (!req || !res) return Promise.resolve(runHandler(...args));

      const snapshot = snapshotPagesRequest(req);
      if (snapshot === null) return Promise.resolve(runHandler(...args)); // excluded

      // Pages Router gives us a plain headers object, not a Headers
      // instance. Adapt to the same get-shape the resolver expects, then
      // run through the platform-id fallback chain.
      const correlationId = resolveCorrelation({
        get: (name: string) => readPagesHeader(req, name),
      });

      return await runWithCorrelation(correlationId, () =>
        runWithActorAndAuditScope(async () => {
          await maybeRunActorHookFromPages(req);

          const startMs = Date.now();
          let exception: Error | null = null;

          try {
            const result = await Promise.resolve(runHandler(...args));
            return result;
          } catch (e) {
            exception = e instanceof Error ? e : new Error(String(e));
            throw e;
          } finally {
            await maybeExtractSupabaseActor();

            await emitEvent({
              snapshot,
              context,
              statusCode: typeof res.statusCode === "number" ? res.statusCode : null,
              exception,
              graphqlErrorMessage: null,
              durationMs: Date.now() - startMs,
              startedAt: new Date(startMs),
            });
            if (isServerless()) {
              await flushScheduler.flushNow().catch(() => undefined);
            }
          }
        }),
      );
    } catch (preCaptureError) {
      if (handlerInvoked) throw preCaptureError;
      logger.warn(
        `capturePagesApi pre-handler setup failed (${describeError(preCaptureError)}); bypassing capture for this request`,
      );
      return Promise.resolve(handler(...args));
    }
  };
}

interface PagesApiReq {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined> | Headers;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
}

interface PagesApiRes {
  statusCode?: number;
  [key: string]: unknown;
}

/**
 * Server Action wrapper.
 *
 * Server Actions don't fit the Request -> Response model — they're
 * async functions invoked by the Next.js RSC pipeline with whatever
 * args their signature defines (commonly FormData). They also don't
 * have a URL, status code, or query string.
 *
 * We can't auto-wrap them via the build plugin without risking
 * Next.js's internal binding mechanism (the compiler attaches
 * `$$id` / `$$bound` to action exports for client/server linking).
 * So Server Actions are a manual opt-in:
 *
 *   "use server"
 *   import { captureServerAction } from "ezlogs-nextjs"
 *
 *   export const updateProfile = captureServerAction(
 *     async (formData: FormData) => {
 *       // ... your action body ...
 *     },
 *     "updateProfile",
 *   )
 *
 * The wrapped function preserves async/sync shape and re-throws on
 * failure so Next.js's error handling still works.
 */
export function captureServerAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => TResult | Promise<TResult>,
  actionName: string,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    let actionInvoked = false;
    const runAction = (...invokeArgs: TArgs) => {
      actionInvoked = true;
      return action(...invokeArgs);
    };

    try {
      if (!configuration().captureHttp) {
        return Promise.resolve(runAction(...args));
      }

      // Reuse the correlation id seeded by middleware. Server Actions are
      // dispatched by Next's RSC pipeline with no Request argument, so we
      // can't read headers off args[0] like captureRoute does. Instead we
      // pull from `next/headers` which is the documented way to read the
      // current request's headers from inside a Server Action. We wrap
      // it as a `HeadersLike` so the same fallback chain (ezlogs header
      // -> x-vercel-id -> cf-ray -> x-request-id -> generate) runs here
      // as in `captureRoute`.
      const headersAdapter = await readNextHeadersAsAdapter();
      const correlationId = resolveCorrelation(headersAdapter);

      return await runWithCorrelation(correlationId, () =>
        runWithActorAndAuditScope(async () => {
          const startMs = Date.now();
          const startedAt = new Date(startMs);
          let exception: Error | null = null;

          // Resolve the actor BEFORE the user's action body runs so any
          // DB / job events it emits inherit the actor through scope.
          // Without this the HTTP event would carry the actor (we
          // resolve again before emit) but every DB Change event emitted
          // from inside the same action would ship with `actor: null`,
          // and the dashboard would render "Triggered by: Unknown" on
          // each Database Change row even though the parent action knew
          // who triggered it.
          await maybeRunActorHookFromServerAction();

          try {
            const result = await Promise.resolve(runAction(...args));
            // Late-fallback: a Supabase client constructed inside the
            // action might only have its auth cookies attached now.
            // maybeExtractSupabaseActor short-circuits when an actor
            // is already set, so this is a no-op when the hook above
            // succeeded.
            await maybeExtractSupabaseActor();

            // Many apps (next-safe-action, Vercel templates, Velory, …)
            // don't throw on failure — they catch the error and return
            // `{ success: false, error: "..." }` so the client can render
            // the message inline. The HTTP response stays 200, so we have
            // to inspect the value to know the action failed. See
            // ServerActionErrorClassifier in configuration.ts.
            const failure = classifyServerActionResult(result);
            await emitServerActionEvent({
              actionName,
              statusCode: failure ? 500 : 200,
              exception: failure ? new Error(failure.errorMessage) : null,
              durationMs: Date.now() - startMs,
              startedAt,
              args,
            });
            return result;
          } catch (e) {
            // Next.js implements redirect() and notFound() by THROWING
            // sentinel errors that the RSC pipeline catches upstream.
            // These aren't application failures — they're control flow.
            // Re-throw without recording the action as failed.
            if (isNextControlFlowError(e)) {
              // Actor was resolved up-front; just collect any
              // late-bound Supabase actor as a final fallback.
              await maybeExtractSupabaseActor();
              await emitServerActionEvent({
                actionName,
                statusCode: 200,
                exception: null,
                durationMs: Date.now() - startMs,
                startedAt,
                args,
              });
              throw e;
            }
            exception = e instanceof Error ? e : new Error(String(e));
            await maybeExtractSupabaseActor();
            await emitServerActionEvent({
              actionName,
              statusCode: 500,
              exception,
              durationMs: Date.now() - startMs,
              startedAt,
              args,
            });
            throw e;
          } finally {
            if (isServerless()) {
              await flushScheduler.flushNow().catch(() => undefined);
            }
          }
        }),
      );
    } catch (preCaptureError) {
      if (actionInvoked) throw preCaptureError;
      logger.warn(
        `captureServerAction pre-handler setup failed (${describeError(preCaptureError)}); bypassing capture for this action`,
      );
      return Promise.resolve(action(...args));
    }
  };
}

/**
 * Runtime-conditional Server Action wrapper. Build-time auto-wrap
 * doesn't know whether each exported symbol from a "use server" file
 * is a function (an actual action) or an unrelated value (constants,
 * re-exported types, etc.). This helper guards the wrap at runtime:
 *
 *   - If the value is a function, return captureServerAction(value, name).
 *   - Otherwise return the value untouched.
 *
 * Designed to be a drop-in for `export const NAME = <expr>` rewrites
 * by the Server Action loader.
 */
export function captureServerActionExport<T>(value: T, actionName: string): T {
  if (typeof value !== "function") return value;
  return captureServerAction(
    value as unknown as (...args: unknown[]) => unknown,
    actionName,
  ) as unknown as T;
}

/**
 * Capture an inline `"use server"` action declared inside an RSC
 * component (page / layout / etc.). The build-time loader rewrites
 *
 *   async function deletePost(formData) {
 *     "use server"
 *     ...body...
 *   }
 *
 * into
 *
 *   async function deletePost(formData) {
 *     "use server"
 *     return await __ezlogs_run_inline_server_action("deletePost", async () => {
 *       ...body...
 *     })
 *   }
 *
 * so SWC's Server Reference registration still sees the declaration
 * and the `"use server"` prologue. The wrap fires only at call time
 * and reuses every guarantee `captureServerAction` provides:
 * correlation/actor scope, redirect()/notFound() handling, structural
 * `{success: false}` classification, and (on serverless) an end-of-call
 * flush.
 *
 * The action name is passed as a string literal at build time — we
 * can't read it off the function reference because SWC's Server
 * Reference registration rebinds the symbol to a wrapper whose
 * `.name` is empty or `$$ACTION_*`.
 *
 * `args: undefined` is intentional — inline declarations don't expose
 * a stable parameter shape to the wrap layer. v2 enhancement.
 */
export async function __ezlogs_run_inline_server_action<TResult>(
  actionName: string,
  body: () => TResult | Promise<TResult>,
): Promise<TResult> {
  const wrapped = captureServerAction(
    async () => Promise.resolve(body()),
    actionName,
  );
  return wrapped();
}

/**
 * Classify a Server Action's return value as success or failure.
 *
 * Layers, in order — first match wins after the user classifier:
 *
 *   1. User-supplied `isServerActionError` from configuration. If it
 *      returns a truthy value (boolean true or `{errorMessage}`) we
 *      stop here. A thrown classifier or one that returns `undefined`
 *      is treated as "no opinion" and we fall through.
 *   2. **next-safe-action**: `{ data?, serverError?: string,
 *      validationErrors?: object }`. Failure when `serverError` is a
 *      non-empty string OR `validationErrors` has at least one key
 *      with a non-empty value.
 *   3. **zsa tuple**: `[null, { code: string, message: string }]`.
 *   4. **zsa object**: `{ data: null, error: { code, message } }`.
 *   5. **Conform**: `{ status: 'error', ... }`.
 *   6. **Zod safeParse**: `{ success: false, error: { issues: [...] } }`.
 *      Discriminator vs (7) is `error` being an object with `issues`.
 *   7. **Existing fallback**: `{ success: false, error: <truthy string> }`.
 *      The original Phase 3 heuristic — Velory's `createServerAction`
 *      shape, the Vercel App Router examples, most hand-rolled wrappers.
 *
 * No imports of next-safe-action / zsa / Conform / Zod — purely
 * structural matching. Returns null on success, `{errorMessage}` on
 * failure. Phase 4 additions.
 */
function classifyServerActionResult(
  result: unknown,
): { errorMessage: string } | null {
  const classifier = configuration().isServerActionError;
  if (classifier) {
    try {
      const verdict = classifier(result);
      if (verdict === true) {
        return { errorMessage: defaultErrorMessage(result) };
      }
      if (
        verdict &&
        typeof verdict === "object" &&
        typeof (verdict as { errorMessage?: unknown }).errorMessage === "string"
      ) {
        return verdict as { errorMessage: string };
      }
      // false / null / undefined — fall through to the built-in shapes.
    } catch (error) {
      // A buggy classifier must NOT crash the host. Fall through.
      logger.debug(`isServerActionError classifier threw: ${describeError(error)}`);
    }
  }

  // (3) zsa tuple `[null, { code, message }]`. Cheap shape check first.
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    result[0] === null &&
    isZsaError(result[1])
  ) {
    const err = result[1] as { message: string };
    return { errorMessage: truncate(err.message) };
  }

  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;

    // (2) next-safe-action `{ serverError?, validationErrors? }`.
    if (typeof r.serverError === "string" && r.serverError.length > 0) {
      return { errorMessage: truncate(r.serverError) };
    }
    if (
      r.validationErrors &&
      typeof r.validationErrors === "object" &&
      !Array.isArray(r.validationErrors) &&
      hasNonEmptyValidationError(r.validationErrors as Record<string, unknown>)
    ) {
      return {
        errorMessage: formatValidationErrors(
          r.validationErrors as Record<string, unknown>,
        ),
      };
    }

    // (4) zsa object `{ data: null, error: { code, message } }`.
    if (r.data === null && isZsaError(r.error)) {
      const err = r.error as { message: string };
      return { errorMessage: truncate(err.message) };
    }

    // (5) Conform `{ status: 'error' }`. The Conform `submission.reply()`
    // shape; check for the `intent` field as a soft co-signal so we
    // don't false-positive on apps that return `{ status: 'error' }`
    // for generic non-failure reasons.
    if (r.status === "error" && "intent" in r) {
      return { errorMessage: conformErrorMessage(r) };
    }

    // (6) Zod safeParse: `{ success: false, error: { issues: [...] } }`.
    if (r.success === false && isZodErrorLike(r.error)) {
      return {
        errorMessage: formatZodIssues(
          (r.error as { issues: unknown[] }).issues,
        ),
      };
    }

    // (7) Existing Phase 3 fallback.
    if (r.success === false && typeof r.error === "string" && r.error.length > 0) {
      return { errorMessage: truncate(r.error) };
    }
  }

  return null;
}

function defaultErrorMessage(result: unknown): string {
  // Try the well-known shapes first so a user classifier returning
  // `true` doesn't lose the actionable detail.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (typeof r.serverError === "string" && r.serverError.length > 0) {
      return truncate(r.serverError);
    }
    const err = r.error;
    if (typeof err === "string" && err.length > 0) return truncate(err);
    if (isZsaError(err)) return truncate((err as { message: string }).message);
    if (isZodErrorLike(err)) {
      return formatZodIssues((err as { issues: unknown[] }).issues);
    }
  }
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    result[0] === null &&
    isZsaError(result[1])
  ) {
    return truncate((result[1] as { message: string }).message);
  }
  return "Server Action returned a failure result";
}

const MAX_ERROR_MESSAGE_LENGTH = 200;

function truncate(value: string): string {
  if (value.length <= MAX_ERROR_MESSAGE_LENGTH) return value;
  return value.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + "…";
}

function isZsaError(value: unknown): value is { code: string; message: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as { code?: unknown; message?: unknown };
  return typeof v.code === "string" && typeof v.message === "string" && v.message.length > 0;
}

function isZodErrorLike(value: unknown): value is { issues: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const issues = (value as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.length > 0;
}

function formatZodIssues(issues: unknown[]): string {
  // ZodIssue shape: `{ path: (string|number)[], message: string, ... }`.
  // Concatenate up to a few messages for actionability without flood.
  const messages: string[] = [];
  for (const issue of issues) {
    if (issue && typeof issue === "object") {
      const m = (issue as { message?: unknown }).message;
      if (typeof m === "string" && m.length > 0) messages.push(m);
    }
    if (messages.length >= 3) break;
  }
  if (messages.length === 0) return "Validation failed";
  return truncate(messages.join("; "));
}

function hasNonEmptyValidationError(
  errors: Record<string, unknown>,
): boolean {
  for (const value of Object.values(errors)) {
    if (Array.isArray(value) && value.length > 0) return true;
    if (typeof value === "string" && value.length > 0) return true;
    if (value && typeof value === "object" && Object.keys(value).length > 0) {
      return true;
    }
  }
  return false;
}

function formatValidationErrors(errors: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, value] of Object.entries(errors)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
      parts.push(`${field}: ${value[0]}`);
    } else if (typeof value === "string" && value.length > 0) {
      parts.push(`${field}: ${value}`);
    }
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) return "Validation failed";
  return truncate(parts.join("; "));
}

function conformErrorMessage(result: Record<string, unknown>): string {
  // Conform's `submission.reply()` may carry a `submission.error` map
  // keyed by field name with array-of-string messages, or a top-level
  // `error` of the same shape.
  const candidates: unknown[] = [
    result.error,
    (result.submission as Record<string, unknown> | undefined)?.error,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const formatted = formatValidationErrors(c as Record<string, unknown>);
      if (formatted !== "Validation failed") return formatted;
    }
  }
  return "Form submission failed";
}

/**
 * Next.js's redirect() and notFound() helpers throw sentinel errors
 * that propagate up through the RSC pipeline as control flow. They
 * carry a `digest` field starting with "NEXT_REDIRECT" or
 * "NEXT_NOT_FOUND". We must let those bubble through without
 * recording them as application failures, otherwise every redirect
 * shows up as a failed Action card.
 */
function isNextControlFlowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") return false;
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND");
}

async function emitServerActionEvent(input: {
  actionName: string;
  statusCode: number;
  exception: Error | null;
  durationMs: number;
  startedAt: Date;
  args?: unknown[];
}): Promise<void> {
  try {
    // Drain trigger audit rows tagged with this request's correlation
    // before we ship the HTTP event — the dashboard expects DB events
    // grouped under the same correlation as the action that caused them.
    await flushTriggerAuditLog();
    // Read the page that triggered this Server Action so the card can
    // surface the calling context. `referer` is the page URL the form
    // submission came from; `next-url` is set by the App Router on
    // Server Action invocations and tends to be the current route.
    const referer = await readNextHeader("referer");
    const nextUrl = await readNextHeader("next-url");
    const userAgent = await readNextHeader("user-agent");
    const fromPage = referer ?? nextUrl ?? null;

    // Surface the action's arguments so the dashboard can render the
    // actual form payload (`email`, `role`, ...) instead of just
    // `from_page`. Phase 4 finding: without this, every Server Action
    // event looks identical at a glance — the card shows nothing about
    // what the user actually submitted. The existing sanitization in
    // buildHttpSourceData (sensitive-field redaction, sanitize.ts)
    // applies to whatever we pass through.
    const argParams = extractServerActionArgs(input.args);
    const requestParams: Record<string, unknown> | null =
      argParams !== null || fromPage !== null
        ? { ...(argParams ?? {}), ...(fromPage !== null ? { from_page: fromPage } : {}) }
        : null;

    // Synthesize a URL with a real pathname so the dashboard can render
    // a useful label. `__server-action/<name>` is conventionally a
    // bundler-internal path that won't collide with user routes.
    const syntheticUrl = new URL(
      `http://localhost/__server-action/${encodeURIComponent(input.actionName)}`,
    );

    const sourceData = buildHttpSourceData({
      method: "POST", // Server Actions are always POST under the hood.
      url: syntheticUrl,
      statusCode: input.statusCode,
      rawParams: requestParams,
      serverActionName: input.actionName,
      userAgent,
      remoteIp: null,
      contentType: null,
      excludedVariableKeys: configuration().excludedGraphqlVariableKeys,
    });

    const { outcome, error_message } = determineOutcome(
      input.statusCode,
      input.exception,
      null,
    );

    const event = buildEvent({
      source_type: "http_request",
      source_data: sourceData,
      outcome,
      correlation_id: currentCorrelation(),
      resource_ids: [],
      context: getCurrentActor() ? { actor: getCurrentActor() } : null,
      duration_ms: input.durationMs,
      error_message,
      timestamp: input.startedAt,
    });

    pushEvent(event);
  } catch (error) {
    logger.error(`server-action capture emit failed: ${describeError(error)}`);
  }
}

/**
 * Convert a Server Action's positional arguments into a flat
 * params object the dashboard can render. We don't try to be clever
 * about typed schemas — we just expose what's there:
 *
 *   - FormData → flatten to `{ field: value }`. Multi-value fields
 *     collapse to the first occurrence (rare in form submissions).
 *     `File` values become a placeholder so we never serialize raw
 *     bytes. Fields with `_` / `$` prefixes (Next/RSC internals like
 *     `$ACTION_REF_1`) are dropped.
 *   - Plain object → passed through. Sensitive-field redaction
 *     happens downstream in `sanitize.ts`.
 *   - Multiple args → namespace each by position (`arg0`, `arg1`)
 *     unless the first arg is a FormData / object (which becomes the
 *     top level for ergonomics).
 *
 * Returns null when there's nothing meaningful to surface — the
 * caller then renders the existing `from_page` block alone.
 */
function extractServerActionArgs(
  args: unknown[] | undefined,
): Record<string, unknown> | null {
  if (!args || args.length === 0) return null;

  // Find the "payload" arg — what the user actually submitted.
  //
  // App Router invokes Server Actions in two shapes:
  //   - `<form action={fn}>`            -> args = [FormData]
  //   - useActionState(fn, initialState) -> args = [prevState, FormData]
  //   - direct call (next-safe-action,
  //     custom factories)               -> args = [typedInput]
  //
  // The interesting payload is always either a FormData OR a plain
  // object. We pick the FIRST such arg and lift its fields to the
  // top level, so the dashboard renders `email: ...` instead of
  // `arg1.email: ...`. Anything else (the prev-state object, scalars,
  // ids passed positionally) gets namespaced as `arg<n>` so the
  // params panel still shows it without polluting the top level.
  const payloadIndex = findPayloadIndex(args);

  if (payloadIndex !== -1) {
    // We found the actual user-submitted payload. Lift its fields and
    // STOP — the other positional args are RSC plumbing (the prev-state
    // arg from useActionState carries the previous return value, which
    // is just confusing noise when surfaced as `arg0.name`,
    // `arg0.success`, etc).
    const payload = args[payloadIndex];
    const out: Record<string, unknown> = {};
    if (typeof FormData !== "undefined" && payload instanceof FormData) {
      Object.assign(out, formDataToObject(payload));
    } else if (isPlainParamObject(payload)) {
      Object.assign(out, payload as Record<string, unknown>);
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  // No recognizable payload — preserve positional args (rare: a Server
  // Action called with raw scalars/dates). Without this we'd silently
  // drop information for non-form actions.
  const out: Record<string, unknown> = {};
  args.forEach((a, i) => {
    if (isInsignificantArg(a)) return;
    const v = serializeArgValue(a);
    if (v !== undefined) out[`arg${i}`] = v;
  });
  return Object.keys(out).length === 0 ? null : out;
}

function findPayloadIndex(args: unknown[]): number {
  // 1. Prefer FormData wherever it appears (`<form action>` and
  //    useActionState both put it as the LAST arg).
  for (let i = args.length - 1; i >= 0; i -= 1) {
    if (typeof FormData !== "undefined" && args[i] instanceof FormData) {
      return i;
    }
  }
  // 2. Otherwise prefer a non-empty plain object (typed input).
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (isPlainParamObject(a) && Object.keys(a as object).length > 0) {
      return i;
    }
  }
  // 3. Fallback to the first plain object even if empty (rare).
  for (let i = 0; i < args.length; i += 1) {
    if (isPlainParamObject(args[i])) return i;
  }
  return -1;
}

function isInsignificantArg(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "function") return true;
  if (isPlainParamObject(value) && Object.keys(value).length === 0) {
    // useActionState's initial-state arg is typically `{}`. Skipping
    // it keeps `arg0: {}` out of the params panel.
    return true;
  }
  return false;
}

function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Iterate via .keys() to dedupe — most form fields are single-valued.
  // For multi-value fields we keep the first; rare in practice.
  const seen = new Set<string>();
  for (const key of fd.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    // Drop Next/RSC-internal fields (`$ACTION_REF_1`, etc.) and
    // anything starting with an underscore — convention is "private".
    if (key.startsWith("$") || key.startsWith("_")) continue;
    const value = fd.get(key);
    if (value === null) continue;
    if (typeof value === "string") {
      out[key] = value;
    } else {
      // File-like — render a placeholder so the wire payload stays small.
      const file = value as { name?: unknown; size?: unknown; type?: unknown };
      out[key] = {
        _file: typeof file.name === "string" ? file.name : "<file>",
        size: typeof file.size === "number" ? file.size : null,
        type: typeof file.type === "string" ? file.type : null,
      };
    }
  }
  return out;
}

function isPlainParamObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (typeof FormData !== "undefined" && value instanceof FormData) return false;
  // Reject other built-in objects (Request, URL, Date, ...) — they're
  // not "form params" and we don't want to JSON-stringify them.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeArgValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return formDataToObject(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeArgValue);
  if (isPlainParamObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeArgValue(v);
    return out;
  }
  return undefined;
}

/**
 * Standalone capture entry — exposed for advanced users (e.g. custom
 * frameworks, tests, third-party integrations) who already have a
 * (request, response, error) tuple and just want an event recorded.
 */
export async function captureHttpEvent(input: {
  request: Request;
  response: Response | null;
  error: Error | null;
  durationMs: number;
  startedAt?: Date;
  context?: CaptureContext;
}): Promise<void> {
  if (!configuration().captureHttp) return;

  const snapshot = await snapshotRequest(input.request);
  if (snapshot === null) return;

  let graphqlErrorMessage: string | null = null;
  if (snapshot.graphqlBody !== null && input.response && input.response.status === 200) {
    graphqlErrorMessage = await readGraphqlErrors(input.response);
  }

  await emitEvent({
    snapshot,
    context: input.context ?? {},
    statusCode: input.response?.status ?? null,
    exception: input.error,
    graphqlErrorMessage,
    durationMs: input.durationMs,
    startedAt: input.startedAt ?? new Date(),
  });
}

async function snapshotRequest(request: Request): Promise<RawRequestSnapshot | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (isExcludedPath(url.pathname, request.method)) return null;

  const method = request.method;
  const headers = request.headers;
  const userAgent = headers.get("user-agent");
  const remoteIp = extractRemoteIp(headers);
  const contentType = headers.get("content-type");
  // Next.js sets `Next-Action` on the request when an RSC pipeline is
  // invoking a Server Action. The header value is the action ID
  // (a content hash). When present we treat the request as a Server
  // Action invocation rather than a plain page POST.
  const serverActionId = headers.get("next-action");

  let rawParams: unknown = null;
  let graphqlBody: unknown = null;

  // GET / HEAD: query string only (never read the body).
  if (method === "GET" || method === "HEAD") {
    const params = Object.fromEntries(url.searchParams.entries());
    rawParams = Object.keys(params).length === 0 ? null : params;
    return { method, url, userAgent, remoteIp, contentType, rawParams, graphqlBody, serverActionId };
  }

  // Non-idempotent methods: peek at the body. We MUST clone because
  // reading body consumes the stream and the user's handler will need
  // it. clone() is cheap on Next.js Request (Node + Edge runtime).
  const cloned = safeClone(request);
  if (!cloned) {
    return { method, url, userAgent, remoteIp, contentType, rawParams, graphqlBody, serverActionId };
  }

  const isGraphql = method === "POST" && isGraphqlPath(url.pathname);

  try {
    if (contentType?.includes("application/json")) {
      const text = await cloned.text();
      const parsed = text ? safeJsonParse(text) : null;
      if (isGraphql) graphqlBody = parsed;
      else rawParams = parsed;
    } else if (contentType?.includes("application/x-www-form-urlencoded")) {
      // Parse form-urlencoded as text to avoid the WHATWG formData()
      // surface, which is brittle across Edge runtimes.
      const text = await cloned.text();
      if (text) {
        const params = new URLSearchParams(text);
        const obj: Record<string, unknown> = {};
        params.forEach((value, key) => {
          obj[key] = value;
        });
        rawParams = Object.keys(obj).length === 0 ? null : obj;
      }
    }
    // multipart/form-data: intentionally not parsed in v0.1. File
    // uploads aren't useful business context, and parsing multipart
    // safely on Edge is its own can of worms. Documented in
    // AGENT_PARITY_NOTES.md.
  } catch (error) {
    logger.debug(`http snapshot body-parse failed: ${describeError(error)}`);
  }

  return { method, url, userAgent, remoteIp, contentType, rawParams, graphqlBody, serverActionId };
}

async function maybeRunActorHook(request: Request): Promise<void> {
  const hook = configuration().actorFromRequest;
  let hookResult: unknown = null;
  if (hook) {
    try {
      hookResult = await Promise.resolve(hook(request));
    } catch (error) {
      logger.debug(`actorFromRequest hook failed: ${describeError(error)}`);
    }
  }
  const userAgent = safeGetHeader(request.headers, "user-agent");
  applyActorFromHookAndUa(hookResult, userAgent);
}

async function maybeRunActorHookFromPages(req: PagesApiReq): Promise<void> {
  const hook = configuration().actorFromRequest;
  let hookResult: unknown = null;
  if (hook) {
    try {
      hookResult = await Promise.resolve(hook(req));
    } catch (error) {
      logger.debug(`actorFromRequest hook (pages) failed: ${describeError(error)}`);
    }
  }
  const userAgent = readPagesHeader(req, "user-agent");
  applyActorFromHookAndUa(hookResult, userAgent);
}

/**
 * Run the user's `actorFromRequest` hook from inside a Server Action.
 *
 * Server Actions are dispatched by the RSC pipeline with no Request
 * argument, so we synthesize a request-shaped facade backed by
 * `next/headers`. Most user hooks read just `request.headers.get(...)`
 * to inspect cookies / authorization headers; that works against the
 * facade unchanged. Hooks that try to read URL or method get a
 * best-effort empty value.
 *
 * Without this, Server Action events for any non-Supabase auth scheme
 * (custom JWT cookies, Clerk, NextAuth, Auth.js...) ship with no
 * actor, even when the user wired `actorFromRequest`.
 */
async function maybeRunActorHookFromServerAction(): Promise<void> {
  const hook = configuration().actorFromRequest;
  const headers = await loadNextHeaders();
  if (!hook && !headers) {
    logger.debug("actorFromRequest (server action): no hook + no next/headers");
    return;
  }

  let hookResult: unknown = null;
  if (hook) {
    if (!headers) {
      logger.debug(
        "actorFromRequest hook (server action): skipped, no next/headers available",
      );
    } else {
      const facade = { headers, method: "POST", url: "" };
      try {
        hookResult = await Promise.resolve(hook(facade));
        logger.debug(
          hookResult
            ? `actorFromRequest hook (server action): set actor id=${(hookResult as { id?: unknown }).id ?? "?"}`
            : "actorFromRequest hook (server action): returned null/undefined",
        );
      } catch (error) {
        logger.debug(
          `actorFromRequest hook (server action) failed: ${describeError(error)}`,
        );
      }
    }
  }

  const userAgent = headers ? safeGetHeader(headers, "user-agent") : null;
  applyActorFromHookAndUa(hookResult, userAgent);
}

/**
 * Fallback actor extraction via the most-recently-constructed Supabase
 * client. Called AFTER the user's handler has run — by that point a
 * Supabase client has typically been created and its auth cookies are
 * accessible. Skipped when actorFromSupabase=false or when a previous
 * actorFromRequest hook already set an actor.
 */
async function maybeExtractSupabaseActor(): Promise<void> {
  const config = configuration();
  if (!config.actorFromSupabase) return;
  if (getCurrentActor()) return; // user-supplied hook already populated it

  try {
    // Lazy import so non-Supabase apps don't pay the cost.
    const mod = await import("../db/supabase.js");
    const actor = await mod.tryExtractSupabaseActor();
    if (actor) setActor(actor);
  } catch (error) {
    logger.debug(`actorFromSupabase failed: ${describeError(error)}`);
  }
}

/**
 * Build a RawRequestSnapshot from a Pages Router Node-style req.
 * Mirrors snapshotRequest() but without the WHATWG fetch body APIs —
 * Pages Router's body parsing depends on next/api-config so we accept
 * `req.body` already-parsed when present.
 */
function snapshotPagesRequest(req: PagesApiReq): RawRequestSnapshot | null {
  let url: URL;
  try {
    // Pages Router req.url is a path-relative string like "/api/users?x=1".
    // We synthesize an origin so URL parses; only pathname/search are used.
    url = new URL(req.url ?? "/", "http://internal.localhost");
  } catch {
    return null;
  }

  if (isExcludedPath(url.pathname, req.method)) return null;

  const method = (req.method ?? "GET").toUpperCase();
  const headers = pagesHeaders(req.headers);
  const userAgent = headers.get("user-agent");
  const remoteIp =
    extractRemoteIp(headers) ?? req.socket?.remoteAddress ?? null;
  const contentType = headers.get("content-type");

  let rawParams: unknown = null;
  let graphqlBody: unknown = null;

  if (method === "GET" || method === "HEAD") {
    const params: Record<string, unknown> = {};
    if (req.query) {
      for (const key of Object.keys(req.query)) {
        params[key] = req.query[key] ?? null;
      }
    }
    rawParams = Object.keys(params).length === 0 ? null : params;
  } else {
    // Pages Router body is whatever next/api-config parsed (json by
    // default, configurable via `export const config`). If it's a
    // plain object we use it; otherwise null.
    const isGraphql = method === "POST" && isGraphqlPath(url.pathname);
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      if (isGraphql) graphqlBody = req.body;
      else rawParams = req.body;
    }
  }

  // Pages Router doesn't have Server Actions — they're App Router only.
  return { method, url, userAgent, remoteIp, contentType, rawParams, graphqlBody, serverActionId: null };
}

/**
 * Adapt a Pages-Router headers shape (plain object | Headers) into a
 * Headers-like object so the rest of the capture code can treat it
 * uniformly. We only need .get().
 */
function pagesHeaders(
  raw: Record<string, string | string[] | undefined> | Headers,
): Headers {
  if (raw instanceof Headers) return raw;
  const out = new Headers();
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out.set(key, value.join(", "));
    } else {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Read a single header from `next/headers` for use inside a Server
 * Action (which has no Request argument). Lazy-imported so non-Next
 * apps and tests don't trip on the import. Returns null if not running
 * inside a Next request scope.
 */
async function readNextHeader(name: string): Promise<string | null> {
  const headers = await loadNextHeaders();
  if (!headers) return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/**
 * Wrap the `next/headers` Headers object as a `HeadersLike` so it can
 * be passed to `resolveCorrelation`. Returns a no-op adapter (always
 * null) when `next/headers` isn't available — matching `readNextHeader`'s
 * graceful failure mode. Used at Server Action entry to drive the
 * correlation fallback chain.
 */
async function readNextHeadersAsAdapter(): Promise<{
  get: (name: string) => string | null;
}> {
  const headers = await loadNextHeaders();
  if (!headers) return { get: () => null };
  return {
    get(name: string): string | null {
      try {
        return headers.get(name);
      } catch {
        return null;
      }
    },
  };
}

type NextHeadersMod = {
  headers: () => Headers | Promise<Headers>;
};

async function loadNextHeaders(): Promise<Headers | null> {
  // Try `next/headers` first (the documented specifier — what Next's
  // bundler resolves through its `exports`-aware layer). If that
  // throws — typically when this runs in a runtime that uses strict
  // ESM resolution (Node 18+ ESM, Next 15's instrumentation-bundling
  // path) and Next's `package.json` has no `exports["./headers"]`
  // entry — fall back to the literal-file `next/headers.js` which
  // strict ESM resolves directly.
  //
  // CRITICAL: both specifiers are string LITERALS in `import("…")`,
  // not variables. A variable specifier (`import(someVar)`) would
  // trigger Webpack's lazy-namespace code-splitting and pull every
  // `*.js` in the parent dir into the customer's bundle — including
  // `nextjs-plugin/*.js` which has Node-only imports.
  //
  // `next` is declared as an optional peer dep — apps that don't
  // install Next won't reach this code (Server Action capture is a
  // Next-only feature), and the catches below cover the missing
  // module case.
  const mod = await tryLoadNextHeadersModule();
  if (!mod) return null;
  try {
    return await Promise.resolve(mod.headers());
  } catch (error) {
    logger.debug(`loadNextHeaders mod.headers() failed: ${describeError(error)}`);
    return null;
  }
}

async function tryLoadNextHeadersModule(): Promise<NextHeadersMod | null> {
  try {
    // @ts-expect-error -- next is an optional peer dep, not present at typecheck time
    return (await import("next/headers")) as NextHeadersMod;
  } catch (firstError) {
    try {
      // @ts-expect-error -- same optional-peer-dep caveat
      return (await import("next/headers.js")) as NextHeadersMod;
    } catch (secondError) {
      logger.debug(
        `loadNextHeaders: neither "next/headers" nor "next/headers.js" resolved (${describeError(firstError)}; ${describeError(secondError)})`,
      );
      return null;
    }
  }
}

/**
 * Read a single header from a Pages Router req without materializing
 * a full Headers object. Pages req.headers is a plain object with
 * lowercased keys (Node http server normalization).
 */
function readPagesHeader(req: PagesApiReq, name: string): string | null {
  const raw = req.headers;
  if (raw instanceof Headers) return raw.get(name);
  const lower = name.toLowerCase();
  const value = raw?.[lower] ?? raw?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

interface EmitInput {
  snapshot: RawRequestSnapshot;
  context: CaptureContext;
  statusCode: number | null;
  exception: Error | null;
  graphqlErrorMessage: string | null;
  durationMs: number;
  startedAt: Date;
}

async function emitEvent(input: EmitInput): Promise<void> {
  try {
    // Drain trigger audit rows tagged with this request's correlation
    // before we ship the HTTP event. Same actor + correlation scope
    // is still open here, so the reader matches rows back correctly.
    await flushTriggerAuditLog();

    const config = configuration();

    let graphql: GraphqlMetadata | null = null;
    if (input.snapshot.graphqlBody !== null) {
      const parsed = parseGraphqlBody(
        input.snapshot.graphqlBody,
        config.allExcludedGraphqlOperations(),
        config.excludedGraphqlVariableKeys,
      );
      if (parsed.metadata === "skip") return; // introspection / excluded op
      graphql = parsed.metadata;
    }

    // Server Action requests carry the `Next-Action` header. When
    // present we override the controller/action classification so the
    // event surfaces as a Server Action invocation rather than a
    // generic POST to the page URL. The ID itself is a content hash —
    // a human-name resolution path lands in a follow-up commit; for
    // now the hash makes the event distinguishable and groupable.
    const serverActionName =
      input.context.serverActionName ??
      (input.snapshot.serverActionId
        ? `server-action:${input.snapshot.serverActionId.slice(0, 12)}`
        : null);

    const sourceDataInput = {
      method: input.snapshot.method,
      url: input.snapshot.url,
      statusCode: input.statusCode,
      rawParams: input.snapshot.rawParams,
      routeModulePath: input.context.routeModulePath ?? null,
      serverActionName,
      userAgent: input.snapshot.userAgent,
      remoteIp: input.snapshot.remoteIp,
      contentType: input.snapshot.contentType,
      excludedVariableKeys: config.excludedGraphqlVariableKeys,
      ...(graphql !== null ? { graphql } : {}),
    };
    const sourceData = buildHttpSourceData(sourceDataInput);

    const { outcome, error_message } = determineOutcome(
      input.statusCode,
      input.exception,
      input.graphqlErrorMessage,
    );

    const contextValue = buildContext();

    const event = buildEvent({
      source_type: "http_request",
      source_data: sourceData,
      outcome,
      correlation_id: currentCorrelation(),
      resource_ids: [],
      context: contextValue,
      duration_ms: input.durationMs,
      error_message,
      timestamp: input.startedAt,
    });

    pushEvent(event);
  } catch (error) {
    // Best-effort diagnostic context: correlation_id is the single
    // most useful field for tracing a missing event back to the
    // surrounding request — without it we'd be blind.
    const cid = currentCorrelation();
    const cidLabel = cid ? ` (correlation_id=${cid})` : "";
    logger.error(`http capture emit failed${cidLabel}: ${describeError(error)}`);
  }
}

function buildContext(): Record<string, unknown> | null {
  const currentActor = getCurrentActor();
  if (!currentActor) return null;
  return { actor: currentActor };
}

/**
 * Drain `ezlogs_audit_log` rows for the current correlation into the
 * agent buffer. Called at the end of each HTTP entry point — actor +
 * correlation scope are still open here, so the reader can match rows
 * back to this request.
 *
 * No-op when the customer hasn't configured `databaseReader` (the
 * trigger path is opt-in; per-ORM adapters keep working if not set).
 * Errors are swallowed at the reader level — this call must never
 * fail the user-facing response.
 */
async function flushTriggerAuditLog(): Promise<void> {
  const reader = configuration().databaseReader;
  if (!reader) return;
  await flushAuditLog(reader);
}

/**
 * Snapshot `MAX(id)` from the audit log at the start of each request,
 * so the reader's time-window fallback can drain rows the trigger
 * fired during the request whose `correlation_id` is NULL (i.e. the
 * customer's client couldn't run SET LOCAL — supabase-js, PostgREST).
 *
 * Wrapped around the user's handler so the snapshot is visible
 * inside the actor + correlation scope. No-op when
 * `databaseSnapshotMode` isn't enabled. Used by every HTTP capturer
 * via the `runWithAuditSnapshotIfEnabled` wrapper below.
 */
async function takeTriggerAuditSnapshotIfEnabled(): Promise<void> {
  const config = configuration();
  if (!config.databaseSnapshotMode) return;
  if (!config.databaseReader) return;
  await takeAuditSnapshot(config.databaseReader);
}

/**
 * Wrap a handler in (actor scope) + optional (audit-snapshot scope) +
 * optional (audit-emit-dedup scope) for capturers. Replaces the bare
 * `runWithActorScope` calls so the trigger plumbing is wired in one
 * place rather than at every entry point. Capturers do:
 *
 *   return runWithCorrelation(correlationId, () =>
 *     runWithActorAndAuditScope(async () => {
 *       ... handler body, including any maybeRunActorHook(...) ...
 *     }),
 *   );
 *
 * Scope layers:
 *   - actor scope: always (the agent needs `getCurrentActor()` everywhere).
 *   - audit-snapshot scope: only when `databaseSnapshotMode` is on
 *     (supabase / no-SET-LOCAL fallback path).
 *   - audit-emit-dedup scope: whenever a `databaseReader` is configured.
 *     The trigger reader can be flushed more than once per request
 *     (middleware page-nav, server-action exit, generic capture). Each
 *     flush re-reads the same audit rows by correlation — the dedup
 *     scope holds the set of ids already emitted so re-reads no-op.
 *     Always opened together with snapshot mode so the snapshot scope
 *     itself doesn't accidentally enable dedup independently.
 */
function runWithActorAndAuditScope<R>(callback: () => Promise<R>): Promise<R> {
  const config = configuration();
  const hasReader = config.databaseReader != null;
  const snapshotEnabled = config.databaseSnapshotMode;

  if (!hasReader) {
    return runWithActorScope(callback);
  }

  // Trigger path is wired (databaseReader configured). Always open the
  // dedup scope; optionally open the snapshot scope on top.
  return runWithActorScope(() =>
    runWithEmittedAuditIdsScope(() => {
      if (!snapshotEnabled) return callback();
      return runWithAuditSnapshotScope(async () => {
        await takeTriggerAuditSnapshotIfEnabled();
        return callback();
      });
    }),
  );
}

function isExcludedPath(path: string, method?: string | null): boolean {
  const config = configuration();
  const normalizedMethod = (method ?? "").toUpperCase();
  for (const pattern of config.allExcludedPaths()) {
    if (typeof pattern === "string") {
      if (pathMatches(path, pattern)) return true;
      continue;
    }
    // Method-conditional pattern: only excludes when both the path and
    // the method match. NextAuth uses this to skip session-refresh GETs
    // while still capturing POST callbacks.
    if (!pathMatches(path, pattern.path)) continue;
    if (pattern.methods.some((m) => m.toUpperCase() === normalizedMethod)) {
      return true;
    }
  }
  if (hasExcludedExtension(path, DEFAULT_EXCLUDED_EXTENSIONS)) return true;
  return false;
}

function extractRemoteIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip") ?? null;
}

function safeClone(request: Request): Request | null {
  try {
    return request.clone();
  } catch {
    return null;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readGraphqlErrors(response: Response): Promise<string | null> {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    if (!text) return null;
    const parsed = safeJsonParse(text);
    return extractGraphqlErrorsFromBody(parsed);
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Merge the hook's actor result with UA-derived actor_kind detection,
 * then push the final actor into the request scope.
 *
 * Rules (parity with Ruby `Middleware::HttpRequest#merge_actor_with_ua`):
 * - Hook actor present, no UA match  -> use hook actor as-is.
 * - Hook actor present, UA match     -> hook keeps id/label; `kind` is
 *   filled from the UA only when the hook didn't supply one. Models
 *   "Claude operating on Jessica's behalf via API key."
 * - No hook actor, UA match          -> synthesize an agent actor so
 *   the Pulse Agent view has something to anchor on.
 * - No hook actor, no UA match       -> leave the scope empty.
 */
function applyActorFromHookAndUa(hookResult: unknown, userAgent: string | null): void {
  const uaMatch = classifyUserAgent(userAgent);

  if (hookResult != null && typeof hookResult === "object" && !Array.isArray(hookResult)) {
    if (uaMatch === null) {
      setActor(hookResult);
      return;
    }
    const hookObj = hookResult as Record<string, unknown>;
    const existingKind = hookObj.kind;
    if (typeof existingKind === "string" && existingKind.length > 0) {
      setActor(hookObj);
      return;
    }
    setActor({ ...hookObj, kind: uaMatch.kind });
    return;
  }

  if (uaMatch !== null) {
    setActor(synthesizeAgentActor(uaMatch));
    return;
  }

  setActor(null);
}

function synthesizeAgentActor(detection: AgentDetection): ActorContext {
  return {
    id: detection.suggestedId,
    label: detection.label,
    kind: detection.kind,
  };
}

/**
 * Read a header without ever throwing — some Edge-runtime Headers
 * implementations refuse certain lookups. Fail closed (null) so the
 * detector treats it as "no UA available" rather than crashing capture.
 */
function safeGetHeader(headers: Headers, name: string): string | null {
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}
