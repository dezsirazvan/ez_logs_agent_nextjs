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
import {
  getCurrentActor,
  maybeExtractSupabaseActor,
  runWithActorScope,
  setActor,
} from "../actor.js";
import { classifyUserAgent, type AgentDetection } from "../user-agent-detector.js";
import {
  current as currentCorrelation,
  endCorrelationScope,
  resolveCorrelation,
  runWithCorrelation,
  runExcluded,
} from "../correlation.js";
import { flushAuditLog } from "../triggers/reader.js";
import { makeAsyncContextCapture } from "../edge-fallback.js";
import {
  isAuthActionName,
  isAuthPath,
  maskAuthParams,
  passesLuhn,
  scrubSecretsInText,
} from "./sanitize.js";
import { runWithEmittedAuditIdsScope } from "../triggers/emit-dedup.js";
import { runWithDeliverySlot, type DeliverySlot } from "../job-delivery.js";
import { hasExcludedExtension, pathMatches } from "./path-matcher.js";
import { DEFAULT_EXCLUDED_EXTENSIONS } from "../configuration.js";
import {
  buildHttpSourceData,
  capErrorText,
  determineOutcome,
  isGenericErrorText,
  issueMessage,
  specificErrorMessage,
  type GraphqlMetadata,
} from "./source-data.js";
import { isTrpcRoute, trpcErrorMessage, trpcStreamErrorScanner, unwrapTrpcParams } from "./trpc.js";
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
      // Excluded path: nothing the handler emits is sent either (its DB writes included).
      if (snapshot === null) {
        const excluded = pathExcluded((request as Request).url, (request as Request).method);
        return Promise.resolve(excluded ? runExcluded(() => runHandler(...args)) : runHandler(...args));
      }
      // App Router passes `{ params }` (a Promise since Next 15) as the
      // second argument: `[id]` from the route template, like Rails'
      // path params in `filtered_parameters`.
      snapshot.rawParams = mergeRouteParams(snapshot.rawParams, await readRouteParams(args[1]));

      // Reuse the correlation id seeded by middleware (or upstream) when
      // present; otherwise derive one from a platform-injected request id
      // (`x-vercel-id`, `cf-ray`, `x-request-id`) so multiple cold-started
      // entry points in the same request still group; finally fall back
      // to a fresh generated id. This is what lets DB events from inside
      // Server Actions, RSC renders, and route handlers all share the
      // same id and group into one Action card — even without
      // `middleware.ts`.
      const correlationId = resolveCorrelation((request as Request).headers ?? null);
      // Marked by a job capture when this request only delivers a job.
      const delivery: DeliverySlot = { jobDelivery: false };
      const inngestServerKind = (request as Request).headers?.get?.(INNGEST_SERVER_KIND) ?? null;

      return await runWithCorrelation(correlationId, () =>
        runWithDeliverySlot(delivery, () => runWithActorAndAuditScope(async () => {
          await maybeRunActorHook(request as Request);

          const startMs = Date.now();
          let statusCode: number | null = null;
          let response: Response | null = null;
          let exception: Error | null = null;
          let graphqlErrorMessage: string | null = null;
          let responseErrorMessage: string | null = null;
          // Set when the body is followed: the event is then emitted
          // when the body has been sent, not when the handler returned.
          let followed = false;
          // duration_ms is the handler's time (as in Rails), even when
          // the event waits for a streamed body.
          let handlerMs: number | null = null;

          const finish = async () => {
            // Last chance to populate the actor — at this point any
            // Supabase client constructed during the handler is
            // registered, and its auth cookies have been read.
            await maybeExtractSupabaseActor();
            if (response) {
              await retryActorHookWithNewCookies(
                (request as Request).headers ?? null,
                cookiesSetBy(setCookieLines(response.headers)),
                snapshot.method,
                (request as Request).url ?? "",
              );
            }
            if (isJobRunnerSync(snapshot.method, inngestServerKind, response?.headers?.get?.(INNGEST_SDK) ?? null)) {
              delivery.jobDelivery = true;
            }

            await emitEvent({
              snapshot,
              context,
              statusCode,
              exception,
              graphqlErrorMessage,
              responseErrorMessage,
              durationMs: handlerMs ?? Date.now() - startMs,
              startedAt: new Date(startMs),
              jobDelivery: delivery.jobDelivery,
            });
            await flushOnServerless();
            endCorrelationScope();
          };

          try {
            response = await Promise.resolve(runHandler(...args));
            handlerMs = Date.now() - startMs;
            statusCode = response.status;

            if (snapshot.graphqlBody !== null && response.status === 200) {
              graphqlErrorMessage = await readGraphqlErrors(response);
            }
            const trpcRoute = isTrpcRoute(snapshot.rawParams, context.routeModulePath ?? null);
            responseErrorMessage =
              (await readResponseErrorMessage(response, trpcRoute)) ??
              authRedirectError(snapshot.url, response.status, response.headers.get("location"));
            // tRPC's httpBatchStreamLink answers 200 and puts a failed
            // call's error in a later line of the streamed body.
            const trpcStream =
              responseErrorMessage === null && trpcRoute
                ? trpcStreamErrorScanner(configuration().excludedGraphqlVariableKeys)
                : null;
            // Streamed bodies (tRPC's httpBatchStreamLink, AI SDK, SSE)
            // do their work after the handler returns: drain the DB rows
            // and emit once the body is done.
            const followedResponse = followBody(
              response,
              snapshot.method,
              (streamError) => {
                if (streamError) exception = streamError;
                responseErrorMessage ??= trpcStream?.error ?? null;
                return finish();
              },
              trpcStream ? (chunk) => trpcStream.push(chunk) : undefined,
            );
            if (followedResponse) {
              followed = true;
              return followedResponse;
            }
            return response;
          } catch (e) {
            // redirect() / notFound() / permanentRedirect() thrown from a
            // route: control flow, answered with its own status.
            const controlStatus = nextControlFlowStatus(e);
            if (controlStatus !== null) {
              statusCode = controlStatus;
              throw e;
            }
            exception = e instanceof Error ? e : new Error(String(e));
            // Next.js answers an uncaught route error with a 500 (Rails
            // reports the same for an exception).
            statusCode = 500;
            throw e;
          } finally {
            if (!followed) {
              // Before the response: a Supabase lookup may refresh the session and set cookies.
              await maybeExtractSupabaseActor();
              await offTheResponse(finish);
            }
          }
        })),
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
              const durationMs = Date.now() - startMs;
              // Run the user's actor hook so page navigations carry
              // "Triggered by" too. Without this every page view in the
              // dashboard renders "Unknown" while the route-handler
              // events from the same user show their email — confusing.
              // Casting because the middleware request and `Request` are
              // structurally compatible at the headers.get() / cookies
              // level the hook actually uses. Both run before the
              // middleware answers: a Supabase lookup may refresh the
              // session, and its cookies go on the response it returns.
              await maybeRunActorHook(request as unknown as Request);
              await maybeExtractSupabaseActor();
              // The page view is sent after the middleware answers
              // (the event's waitUntil keeps it alive where it must).
              const event = rest[0] as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
              await offTheResponse(
                async () => {
                  await emitPageNavigationEvent({
                    request,
                    statusCode:
                      typeof response?.status === "number" ? response.status : null,
                    durationMs,
                    startedAt,
                  });
                },
                typeof event?.waitUntil === "function" ? event.waitUntil.bind(event) : null,
              );
            }
          } catch (error) {
            logger.debug(`page navigation capture failed: ${describeError(error)}`);
          }

          return response;
        }).finally(endCorrelationScope),
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
 * event? Only for a page load: the browser (or a non-browser client)
 * loading the page's HTML. Yes when:
 *   - It's a GET (page renders are GETs; POST in middleware is a form
 *     submission that one of our other capturers will pick up).
 *   - It's NOT a Server Action invocation (`Next-Action` header).
 *   - It's NOT a router fetch: a `<Link>` prefetch or a client-side
 *     navigation's RSC payload. Next 15/16 strip the markers (`RSC`,
 *     `Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`,
 *     `Next-Router-State-Tree`, `?_rsc=`) before middleware / proxy
 *     runs, so the reliable signals left are `Next-Url` (sent on router
 *     fetches) and the browser's Fetch Metadata: a page load has
 *     `Sec-Fetch-Mode: navigate`; `fetch()` has cors / same-origin.
 *     Prefetches and client-side navigations look the same here, so
 *     neither counts as a page view (a prefetch is not a view; partial
 *     beats wrong). The markers are still checked for setups that keep
 *     them (`__NEXT_NO_MIDDLEWARE_URL_NORMALIZE`, edge rendering).
 *   - It's NOT a browser prefetch / prerender (`Sec-Purpose`), nor a
 *     Pages Router data or prefetch request.
 *   - The path isn't excluded (static assets, `_next/*`, etc.).
 */
function shouldEmitPageNavigation(request: MiddlewareRequest): boolean {
  if (request.method !== "GET") return false;
  const headers = request.headers;
  if (headers.get("next-action")) return false;
  for (const marker of ROUTER_FETCH_HEADERS) {
    if (headers.get(marker) !== null) return false;
  }
  if (/prefetch|prerender/i.test(headers.get("sec-purpose") ?? headers.get("purpose") ?? "")) {
    return false;
  }
  const fetchMode = headers.get("sec-fetch-mode");
  if (fetchMode !== null && fetchMode !== "navigate") return false;

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

// Headers only Next's client router (or the Pages Router) sends.
const ROUTER_FETCH_HEADERS = [
  "rsc",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-router-state-tree",
  "next-url",
  "x-middleware-prefetch",
  "x-nextjs-data",
] as const;

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
      // Excluded path: nothing the handler emits is sent either (its DB writes included).
      if (snapshot === null) {
        const excluded = pathExcluded(req.url ?? "/", req.method);
        return Promise.resolve(excluded ? runExcluded(() => runHandler(...args)) : runHandler(...args));
      }

      // Pages Router gives us a plain headers object, not a Headers
      // instance. Adapt to the same get-shape the resolver expects, then
      // run through the platform-id fallback chain.
      const correlationId = resolveCorrelation({
        get: (name: string) => readPagesHeader(req, name),
      });

      const delivery: DeliverySlot = { jobDelivery: false };
      const inngestServerKind = readPagesHeader(req, INNGEST_SERVER_KIND);

      return await runWithCorrelation(correlationId, () =>
        runWithDeliverySlot(delivery, () => runWithActorAndAuditScope(async () => {
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

            const status = typeof res.statusCode === "number" ? res.statusCode : null;
            const getHeader = res.getHeader as ((name: string) => unknown) | undefined;
            if (typeof getHeader === "function") {
              const set = getHeader.call(res, "set-cookie");
              const lines = Array.isArray(set) ? set.map(String) : set ? [String(set)] : [];
              const headers = req.headers instanceof Headers ? req.headers : toWebHeaders(req.headers);
              await retryActorHookWithNewCookies(headers, cookiesSetBy(lines), snapshot.method, req.url ?? "");
            }
            const sdkHeader = typeof getHeader === "function" ? getHeader.call(res, INNGEST_SDK) : null;
            if (isJobRunnerSync(snapshot.method, inngestServerKind, sdkHeader ? String(sdkHeader) : null)) {
              delivery.jobDelivery = true;
            }
            await emitEvent({
              snapshot,
              context,
              statusCode: status,
              exception,
              graphqlErrorMessage: null,
              // NextAuth v4 under pages/api/auth: a failed sign-in redirects to ?error=.
              responseErrorMessage: authRedirectError(
                snapshot.url,
                status,
                typeof getHeader === "function" ? getHeader.call(res, "location") : null,
              ),
              durationMs: Date.now() - startMs,
              startedAt: new Date(startMs),
              jobDelivery: delivery.jobDelivery,
            });
            await flushOnServerless();
            endCorrelationScope();
          }
        })),
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

          // The late Supabase actor lookup runs before the action answers
          // (a client constructed inside the action might only have its
          // auth cookies attached now; a no-op when the hook above set the
          // actor): it may refresh the session, and Next only takes cookies
          // while the action runs. The event is sent after the answer.
          const record = async (input: Parameters<typeof emitServerActionEvent>[0]) => {
            await maybeExtractSupabaseActor();
            await retryActorHookAfterServerAction();
            await offTheResponse(async () => {
              await emitServerActionEvent(input);
              await flushOnServerless();
              endCorrelationScope();
            });
          };

          let result: Awaited<TResult>;
          try {
            result = await Promise.resolve(runAction(...args));
          } catch (e) {
            // Next.js implements redirect() and notFound() by THROWING
            // sentinel errors that the RSC pipeline catches upstream.
            // These aren't application failures — they're control flow.
            // Re-throw without recording the action as failed.
            if (isNextControlFlowError(e)) {
              const controlStatus = nextControlFlowStatus(e) ?? 200;
              await record({
                actionName,
                // redirect() is a success; notFound() / forbidden()
                // keep their 4xx.
                statusCode: controlStatus >= 400 ? controlStatus : 200,
                exception: null,
                durationMs: Date.now() - startMs,
                startedAt,
                args,
                redirectTo: redirectTarget(e),
              });
              throw e;
            }
            exception = e instanceof Error ? e : new Error(String(e));
            await record({
              actionName,
              statusCode: 500,
              exception,
              durationMs: Date.now() - startMs,
              startedAt,
              args,
            });
            throw e;
          }

          // Many apps (next-safe-action, Vercel templates, in-house wrappers, …)
          // don't throw on failure — they catch the error and return
          // `{ success: false, error: "..." }` so the client can render
          // the message inline. The HTTP response stays 200, so we have
          // to inspect the value to know the action failed. See
          // ServerActionErrorClassifier in configuration.ts.
          let failure: ReturnType<typeof classifyServerActionResult> = null;
          try {
            failure = classifyServerActionResult(result);
          } catch (e) {
            logger.debug(`server action result classification failed: ${describeError(e)}`);
          }
          await record({
            actionName,
            // A returned failure (`{ success: false, error }`) is a
            // handled refusal, not a crash: no HTTP status is
            // invented; outcome + error_message carry it.
            statusCode: failure ? null : 200,
            exception: failure ? new Error(failure.errorMessage) : null,
            durationMs: Date.now() - startMs,
            startedAt,
            args,
          });
          return result;
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
 *      The original Phase 3 heuristic — an in-house `createServerAction`
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
      return { errorMessage: specificOrOwn(r, r.error) };
    }

    // (8) `useActionState` state with a bare error string
    // (`{ error: "Invalid email or password" }`, next-saas-starter).
    // Only when nothing in the object claims success: no truthy
    // `success` / `ok`, and no `data` payload.
    // A database row (`id`, `created_at` / `updatedAt`) carrying an
    // `error` column is data, not a failed action: rules 8-9 skip it.
    const rowShaped = isRowShaped(r);
    if (
      !rowShaped &&
      typeof r.error === "string" &&
      r.error.trim().length > 0 &&
      !r.success &&
      !r.ok &&
      r.data == null
    ) {
      return { errorMessage: specificOrOwn(r, r.error.trim()) };
    }

    // (9) Next.js docs' form-state pattern: `{ errors: fieldErrors,
    // message }` (zod `flatten().fieldErrors`) or an `errors` list.
    // Only a pure form state: any other key (`imported: 97` next to
    // per-row errors) means a counted partial success. A bare
    // `{ message }` stays a success ("Saved").
    if (
      !rowShaped &&
      !r.success &&
      !r.ok &&
      Object.keys(r).every((k) => FORM_STATE_KEYS.has(k)) &&
      hasErrorEntries(r.errors)
    ) {
      return { errorMessage: formStateErrorMessage(r) };
    }
  }

  return null;
}

const FORM_STATE_KEYS = new Set([
  "errors",
  "message",
  "success",
  "ok",
  "status",
  "fields",
  "fieldErrors",
  "formErrors",
]);

function isRowShaped(r: Record<string, unknown>): boolean {
  return Object.keys(r).some((k) => k === "id" || /(^|_)(created|updated)_?at$/i.test(k));
}

/** `errors` holds at least one non-empty string message (any depth ≤ 3). */
function hasErrorEntries(errors: unknown, depth = 0): boolean {
  if (typeof errors === "string") return errors.trim().length > 0;
  if (depth > 3 || errors === null || typeof errors !== "object") return false;
  return Object.values(errors).some((v) => hasErrorEntries(v, depth + 1));
}

/**
 * The reason for an `{ errors, message? }` form state: the first safe
 * field error ("customerId: Please select a customer."), else the
 * state's own `message`, else a fixed text. Same masking as 0.3.3.
 */
function formStateErrorMessage(r: Record<string, unknown>): string {
  const patterns = configuration().excludedGraphqlVariableKeys;
  const specific = Array.isArray(r.errors)
    ? specificErrorMessage({ errors: r.errors }, patterns) ??
      specificErrorMessage({ formErrors: r.errors }, patterns)
    : specificErrorMessage({ fieldErrors: r.errors }, patterns);
  if (specific) return capErrorText(specific);
  if (typeof r.message === "string" && r.message.trim().length > 0) {
    return capErrorText(r.message.trim());
  }
  return "Validation failed";
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
    if (typeof err === "string" && err.length > 0) return specificOrOwn(r, err);
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

/** `error` itself, or the specific reason beside it when `error` is a placeholder. */
function specificOrOwn(result: Record<string, unknown>, error: string): string {
  const specific = isGenericErrorText(error)
    ? specificErrorMessage(result, configuration().excludedGraphqlVariableKeys)
    : null;
  return capErrorText(specific ?? error);
}

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
  // Up to a few messages for actionability without flood; unsafe ones
  // (sensitive field, secret-naming message) are skipped.
  const patterns = configuration().excludedGraphqlVariableKeys;
  const messages: string[] = [];
  for (const issue of issues) {
    const m = issueMessage(issue, patterns);
    if (m) messages.push(m);
    if (messages.length >= 3) break;
  }
  if (messages.length === 0) return "Validation failed";
  return capErrorText(messages.join("; "));
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
  return nextControlFlowStatus(error) !== null;
}

/**
 * The HTTP status Next.js answers a control-flow throw with, or null
 * for a real error. Digests: `NEXT_REDIRECT;<type>;<url>;<status>;`
 * (307 / 308), `NEXT_NOT_FOUND` (Next 14) and
 * `NEXT_HTTP_ERROR_FALLBACK;<status>` (Next 15: notFound / forbidden /
 * unauthorized).
 */
function nextControlFlowStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") return null;
  const parts = digest.split(";");
  if (parts[0] === "NEXT_REDIRECT") {
    const status = Number(parts[3]);
    return status >= 300 && status < 400 ? status : 307;
  }
  if (parts[0] === "NEXT_NOT_FOUND") return 404;
  if (parts[0] === "NEXT_HTTP_ERROR_FALLBACK") {
    const status = Number(parts[1]);
    return status >= 400 && status < 500 ? status : 404;
  }
  return null;
}

function pathOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

/** The raw target of a `redirect()` throw (`NEXT_REDIRECT;<type>;<url>;<status>;`), or null. */
function redirectTarget(error: unknown): string | null {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) return null;
  // The url may itself hold `;`.
  const parts = digest.split(";").slice(2);
  while (parts.length > 0 && (parts[parts.length - 1] === "" || /^\d{3}$/.test(parts[parts.length - 1]!))) {
    parts.pop();
  }
  return parts.length > 0 ? parts.join(";") : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `source_data.redirect_to`: the redirect target as a bare path
 * ("/error"), no query or fragment. Null for another origin: an
 * external redirect (OAuth, Stripe) is never recorded as an internal
 * path. Token-like segments (20+ url-safe chars, not a UUID: invite /
 * reset tokens) and emails / secrets are masked. The agent never
 * reclassifies on it (a redirect to "/error" is the server's call).
 */
function redirectPath(target: string, requestHost: string | null): string | null {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
    const url = new URL(target, "http://ezlogs.internal");
    if (absolute && (!requestHost || url.host.toLowerCase() !== requestHost.toLowerCase())) return null;
    const path = url.pathname
      .split("/")
      .map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) && !UUID.test(seg) ? "[FILTERED]" : seg))
      .join("/");
    return path ? scrubSecretsInText(path, { emails: true }) : null;
  } catch {
    return null;
  }
}

async function emitServerActionEvent(input: {
  actionName: string;
  statusCode: number | null;
  exception: Error | null;
  durationMs: number;
  startedAt: Date;
  args?: unknown[];
  /** Raw `redirect()` target; becomes the optional `redirect_to` path. */
  redirectTo?: string | null;
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
    const argParams = extractServerActionArgs(input.args, input.actionName);
    const combined: Record<string, unknown> | null =
      argParams !== null || fromPage !== null
        ? { ...(argParams ?? {}), ...(fromPage !== null ? { from_page: fromPage } : {}) }
        : null;
    const requestParams = maskAuthParams(
      combined,
      isAuthActionName(input.actionName) || isAuthPath(pathOf(fromPage)),
    ) as Record<string, unknown> | null;

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
      remoteIp: extractRemoteIp(await readNextHeadersAsAdapter()),
      contentType: null,
      excludedVariableKeys: configuration().excludedGraphqlVariableKeys,
    });
    if (input.redirectTo) {
      const host = (await readNextHeader("x-forwarded-host")) ?? (await readNextHeader("host"));
      const redirectTo = redirectPath(input.redirectTo, host?.split(",")[0]?.trim() ?? null);
      if (redirectTo) sourceData.redirect_to = redirectTo;
    }

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
  actionName: string,
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

  // No recognizable payload — preserve positional args (a Server
  // Action called with raw scalars, e.g. `deleteInvoice(id)`).
  //
  // Positional args have no name, so key-based redaction can't see
  // them: `signIn(email, password)` would ship the password as `arg1`.
  // Top-level positional strings are therefore masked unless they are
  // id-shaped (see `maskPositional`). Objects inside positional args
  // keep their keys and go through the normal key-based sanitizer.
  const words = actionWords(actionName);
  const flags: MaskFlags = {
    secretAction: words.some((w) => SECRET_ACTION_WORDS.has(w)),
    paymentAction: words.some((w) => PAYMENT_ACTION_WORDS.has(w)),
  };
  const out: Record<string, unknown> = {};
  args.forEach((a, i) => {
    if (isInsignificantArg(a)) return;
    const v = maskPositional(serializeArgValue(a), flags);
    if (v !== undefined) out[`arg${i}`] = v;
  });
  return Object.keys(out).length === 0 ? null : out;
}

// Strict id shapes the server uses to find the primary record in a
// Server Action's args. Generated ids carry digits; the digit /
// mixed-case rules keep word-like strings ("inactive", a lowercase
// passphrase) out. A random password that happens to look exactly like
// a generated id is the accepted residual risk.
const INT_OR_UUID = /^(?:\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CUID_V1 = /^c[a-z0-9]{24}$/;
const CUID2 = /^[a-z][a-z0-9]{23}$/;
// A ULID's first char encodes the timestamp and is always 0-7.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const NANOID_21 = /^[A-Za-z0-9_-]{21}$/;

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

function isIdShaped(s: string): boolean {
  if (INT_OR_UUID.test(s) || ULID.test(s)) return true;
  // ≥2 digits on cuid v1 too: "correcthorsebatterystaple" is c + 24 letters.
  if (CUID_V1.test(s) || CUID2.test(s)) return digitCount(s) >= 2;
  if (NANOID_21.test(s)) {
    return digitCount(s) >= 2 && /[a-z]/.test(s) && /[A-Z]/.test(s);
  }
  return false;
}

// Action-name words that mean "short numeric args are secrets"
// (setPin(4821), verifyOtp("123456")). Mirrors the server redactor's
// auth-word list plus card/cvv/code.
const SECRET_ACTION_WORDS = new Set([
  "pin", "otp", "code", "verify", "mfa", "2fa", "cvv", "cvc", "card",
  "password", "passwd", "secret", "token", "sign", "signin", "login",
  "reset", "credential", "credentials", "unlock",
]);

// Action-name words that mean "this is about payment cards".
const PAYMENT_ACTION_WORDS = new Set([
  "card", "pay", "payment", "charge", "checkout", "billing", "cvv", "cvc",
]);

/** `verify2FA` → ["verify", "2fa"], `setPinCode` → ["set", "pin", "code"]. */
function actionWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Card-number shaped, Luhn-valid digits. 15-16 digits (Amex / Visa /
 * Mastercard length) are masked whatever the action is called; other
 * PAN lengths (13-19) only for payment-named actions, so 13-digit ms
 * timestamps and 17-19 digit snowflake ids elsewhere stay visible.
 * Residual: ~10% of 15-16 digit ids pass Luhn and get masked.
 */
function looksLikeCardNumber(digits: string, paymentAction: boolean): boolean {
  if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return false;
  return paymentAction || digits.length === 15 || digits.length === 16;
}

interface MaskFlags {
  secretAction: boolean;
  paymentAction: boolean;
}

/**
 * Unnamed string → "[FILTERED]" unless id-shaped. Numbers, booleans
 * and null pass through (numeric ids are the common case). Arrays of
 * positional strings (`bulkDelete(ids)`) get the same per-item rule.
 *
 * Digit values (string or number) are also masked when they look like
 * a card number (see looksLikeCardNumber), or are 4-8 digits and the
 * action name has a secret word (`setPin`, `verifyOtp`, `verify2FA`).
 * shortcut: a PIN passed to an innocently named action
 * (`update(4821)`) still shows; upgrade with param-name hints if needed.
 */
function maskPositional(value: unknown, flags: MaskFlags): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPositional(v, flags));
  const digits =
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? value
        : null;
  if (digits !== null) {
    if (looksLikeCardNumber(digits, flags.paymentAction)) return "[FILTERED]";
    if (flags.secretAction && digits.length >= 4 && digits.length <= 8) return "[FILTERED]";
  }
  if (typeof value === "string") {
    return isIdShaped(value) ? value : "[FILTERED]";
  }
  return value;
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
      // The hook reads `headers.get(...)`; Node's req.headers is a plain object.
      const headers = req.headers instanceof Headers ? req.headers : toWebHeaders(req.headers);
      hookResult = await Promise.resolve(hook({ headers }));
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
  cookies?: () => CookieStoreLike | Promise<CookieStoreLike>;
};

type CookieStoreLike = { getAll: () => Array<{ name: string; value: string }> };

/**
 * Server Action form of retryActorHookWithNewCookies: Next's `cookies()` store in an action
 * holds the request's cookies plus the ones the action set (a deleted one reads "").
 */
async function retryActorHookAfterServerAction(): Promise<void> {
  if (!configuration().actorFromRequest || getCurrentActor()) return;
  try {
    const mod = await tryLoadNextHeadersModule();
    if (!mod?.cookies) return;
    const headers = await Promise.resolve(mod.headers());
    const store = await Promise.resolve(mod.cookies());
    // The store holds the request's cookies as Next parsed them (decoded, a bare name reads
    // "true") plus the ones the action set: keep only what is new or changed, encoded the way
    // Next writes it, so ordinary traffic never asks the hook twice.
    const sent = new Map<string, string>();
    for (const part of (headers?.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      const name = (eq < 0 ? part : part.slice(0, eq)).trim();
      if (!name) continue;
      const raw = eq < 0 ? "true" : part.slice(eq + 1).trim();
      let value = raw;
      try {
        value = decodeURIComponent(raw);
      } catch {
        // malformed escape: Next keeps it as is
      }
      sent.set(name, value);
    }
    const changed = store
      .getAll()
      .filter((c) => sent.get(c.name) !== c.value)
      .map((c): [string, string] => [c.name, c.value === "" ? "" : encodeURIComponent(c.value)]);
    if (changed.length === 0) return;
    await retryActorHookWithNewCookies(headers, changed, "POST", "");
  } catch (error) {
    logger.debug(`actorFromRequest (server action, after the action) skipped: ${describeError(error)}`);
  }
}

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
function toWebHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw ?? {})) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      try {
        headers.append(name, v);
      } catch {
        // A name / value the Headers class rejects: skip that header.
      }
    }
  }
  return headers;
}

function readPagesHeader(req: PagesApiReq, name: string): string | null {
  const raw = req.headers;
  if (raw instanceof Headers) return raw.get(name);
  const lower = name.toLowerCase();
  const value = raw?.[lower] ?? raw?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

// Inngest calls its serve route with this header: GET to inspect it, PUT to sync the
// app's functions (the dev server every few seconds), POST to run one. A run is a job
// delivery its middleware marks; a sync or inspection is the runner's plumbing, never a
// person's action. The serve handler answers with x-inngest-sdk, which a caller can't
// set, so only a real serve route skips its HTTP event. Its DB rows, if any, still flush.
const INNGEST_SERVER_KIND = "x-inngest-server-kind";
const INNGEST_SDK = "x-inngest-sdk";

function isJobRunnerSync(method: string | undefined, inngestServerKind: string | null, sdkResponseHeader: string | null): boolean {
  const m = (method ?? "").toUpperCase();
  return inngestServerKind !== null && sdkResponseHeader !== null && (m === "GET" || m === "PUT");
}

interface EmitInput {
  snapshot: RawRequestSnapshot;
  context: CaptureContext;
  statusCode: number | null;
  exception: Error | null;
  graphqlErrorMessage: string | null;
  /** `error` / `message` from a JSON error response body. */
  responseErrorMessage?: string | null;
  durationMs: number;
  startedAt: Date;
  /** The request only delivered a job (job-delivery.ts): its job event stands for it. */
  jobDelivery?: boolean;
}

async function emitEvent(input: EmitInput): Promise<void> {
  try {
    // Drain trigger audit rows tagged with this request's correlation
    // before we ship the HTTP event. Same actor + correlation scope
    // is still open here, so the reader matches rows back correctly.
    await flushTriggerAuditLog();
    if (input.jobDelivery) return;

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
      rawParams: maskAuthParams(
        unwrapTrpcParams(input.snapshot.rawParams, input.snapshot.url, input.context.routeModulePath ?? null),
        isAuthPath(input.snapshot.url.pathname),
      ),
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
      input.responseErrorMessage ?? null,
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

/**
 * The same response with its body passed through chunk by chunk (no
 * buffering), calling `onDone` once when the body has been fully read,
 * cancelled (client gone: no error) or has errored. Each read runs in the
 * request's async context, so a pull-based stream's work still sees the
 * request's correlation id and actor. Null (caller keeps the original)
 * when there is no body to follow: none, HEAD (Next never reads it), or
 * no `AsyncLocalStorage.snapshot`. Serverless: followed only when the
 * platform's `waitUntil` can keep the function alive until the event
 * ships; otherwise the event ships before the response, as before.
 * `onChunk` sees each chunk before it is passed on (its errors are ignored).
 */
function followBody(
  response: Response,
  method: string,
  onDone: (error: Error | null) => Promise<void>,
  onChunk?: (chunk: Uint8Array) => void,
): Response | null {
  try {
    if (!response.body || method === "HEAD" || response.bodyUsed) return null;
    const capture = makeAsyncContextCapture();
    if (!capture) return null;
    const keepAlive = isServerless() ? platformWaitUntil() : null;
    if (isServerless() && !keepAlive) return null;
    const run = capture();
    let settled!: () => void;
    keepAlive?.(new Promise<void>((resolve) => (settled = resolve)));
    const source = response.body;
    // Locked only once Next starts sending, so a throw below leaves the
    // original response intact.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      run(() => onDone(error))
        .catch((e) => logger.debug(`streamed response capture failed: ${describeError(e)}`))
        .finally(() => settled?.());
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await run(() => (reader ??= source.getReader()).read());
            if (chunk.done) {
              controller.close();
              finish(null);
            } else {
              try {
                onChunk?.(chunk.value);
              } catch (e) {
                logger.debug(`streamed chunk scan failed: ${describeError(e)}`);
              }
              controller.enqueue(chunk.value);
            }
          } catch (e) {
            controller.error(e);
            finish(e instanceof Error ? e : new Error(String(e)));
          }
        },
        cancel(reason) {
          finish(null);
          return reader ? reader.cancel(reason) : source.cancel(reason);
        },
      },
      // Read the source only when the consumer asks: nothing is buffered.
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (e) {
    logger.debug(`could not follow the response body: ${describeError(e)}`);
    return null;
  }
}

let recordBeforeResponse = false;

/**
 * Test-only. Records each request before its response returns, so a test
 * reads its events right after the call (the work itself is unchanged).
 */
export function _setRecordBeforeResponseForTests(value: boolean): void {
  recordBeforeResponse = value;
}

/**
 * Sends a request's event without holding up its response. The work starts
 * here, inside the request's async context (correlation, actor, dedup
 * scope), and is not awaited. Callers resolve the actor before calling
 * this: a Supabase lookup may refresh the session, whose cookies must
 * reach the response.
 * Serverless: the process may freeze once the response is sent, so the
 * platform's `waitUntil` keeps it alive; without one the request waits
 * at most SERVERLESS_INLINE_FLUSH_MS. Never throws.
 */
async function offTheResponse(
  work: () => Promise<void>,
  waitUntil: ((promise: Promise<unknown>) => void) | null = null,
): Promise<void> {
  const done = work().catch((e) => logger.debug(`capture failed: ${describeError(e)}`));
  if (recordBeforeResponse) await done;
  if (!isServerless()) return;
  try {
    const keepAlive = waitUntil ?? platformWaitUntil();
    if (keepAlive) {
      keepAlive(done);
      return;
    }
  } catch (e) {
    logger.debug(`waitUntil unavailable, recording inline: ${describeError(e)}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SERVERLESS_INLINE_FLUSH_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Longest a serverless request waits for its events to ship when the platform has no `waitUntil`. */
export const SERVERLESS_INLINE_FLUSH_MS = 2_000;

/**
 * Serverless only: ship this request's events without holding up the
 * response. The process may freeze once the response is sent, so the
 * periodic scheduler can't be trusted. With the platform's `waitUntil`
 * (Vercel, Next 15+ request context) the send runs after the response.
 * Without it the request waits at most SERVERLESS_INLINE_FLUSH_MS;
 * whatever has not shipped by then is best-effort (sent only if the
 * process stays warm). Never throws.
 */
async function flushOnServerless(): Promise<void> {
  if (!isServerless()) return;
  try {
    const waitUntil = platformWaitUntil();
    if (waitUntil) {
      waitUntil(flushScheduler.flushNow());
      return;
    }
  } catch (e) {
    logger.debug(`waitUntil unavailable, flushing inline: ${describeError(e)}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushScheduler.flushNow(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SERVERLESS_INLINE_FLUSH_MS);
      }),
    ]);
  } catch {
    // flushNow swallows its own errors; never break the host request
  } finally {
    clearTimeout(timer);
  }
}

/** The hosting platform's `waitUntil` for this request (Vercel / Next request context). */
function platformWaitUntil(): ((promise: Promise<unknown>) => void) | null {
  for (const key of ["@next/request-context", "@vercel/request-context"]) {
    try {
      const holder = (globalThis as Record<symbol, { get?: () => unknown } | undefined>)[Symbol.for(key)];
      const ctx = holder?.get?.() as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
      if (typeof ctx?.waitUntil === "function") return ctx.waitUntil.bind(ctx);
    } catch {
      // no request context here
    }
  }
  return null;
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
  // Reading the rows is a database round trip: keep it off the
  // response. The work starts here, inside the request's async context
  // (correlation, actor, dedup scope), and is not awaited. Event order
  // doesn't matter: the server groups by correlation id.
  const work = flushAuditLog(reader).catch((e) =>
    logger.debug(`trigger audit flush failed: ${describeError(e)}`),
  );
  if (!isServerless()) return;
  // Serverless: the process may freeze after the response. Keep it alive
  // until the rows are read and sent; without waitUntil, wait inline.
  const waitUntil = platformWaitUntil();
  if (waitUntil) {
    waitUntil(work.then(() => flushScheduler.flushNow()));
    return;
  }
  // No waitUntil: wait, but never longer than the serverless send cap.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SERVERLESS_INLINE_FLUSH_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wrap a handler in (actor scope) + optional (audit-emit-dedup scope)
 * for capturers. Replaces the bare `runWithActorScope` calls so the
 * trigger plumbing is wired in one place rather than at every entry
 * point. Capturers do:
 *
 *   return runWithCorrelation(correlationId, () =>
 *     runWithActorAndAuditScope(async () => {
 *       ... handler body, including any maybeRunActorHook(...) ...
 *     }),
 *   );
 *
 * Scope layers:
 *   - actor scope: always (the agent needs `getCurrentActor()` everywhere).
 *   - audit-emit-dedup scope: whenever a `databaseReader` is configured.
 *     The trigger reader can be flushed more than once per request
 *     (middleware page-nav, server-action exit, generic capture). The
 *     dedup scope holds the ids already emitted so re-reads no-op.
 */
function runWithActorAndAuditScope<R>(callback: () => Promise<R>): Promise<R> {
  if (configuration().databaseReader == null) {
    return runWithActorScope(callback);
  }
  return runWithActorScope(() => runWithEmittedAuditIdsScope(callback));
}

// The request URL (absolute, or path-relative for the Pages Router) is on an excluded path.
function pathExcluded(url: string, method?: string | null): boolean {
  try {
    return isExcludedPath(new URL(url, "http://internal.localhost").pathname, method);
  } catch {
    return false;
  }
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

function extractRemoteIp(headers: { get(name: string): string | null }): string | null {
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

async function readRouteParams(routeContext: unknown): Promise<Record<string, unknown> | null> {
  try {
    const params: unknown = await (routeContext as { params?: unknown } | null | undefined)?.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    return Object.keys(params).length > 0 ? (params as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mergeRouteParams(
  rawParams: unknown,
  routeParams: Record<string, unknown> | null,
): unknown {
  if (!routeParams) return rawParams;
  if (rawParams === null || rawParams === undefined) return { ...routeParams };
  if (typeof rawParams !== "object" || Array.isArray(rawParams)) return rawParams;
  // Body / query keys win over a same-named path param.
  return { ...routeParams, ...(rawParams as Record<string, unknown>) };
}

const MAX_ERROR_BODY_LENGTH = 16_384;

/**
 * The reason a route handler gave for refusing a request: `error` /
 * `message` (or `error.message`) from a small JSON error body.
 * Truncated to 200 chars, card numbers and tokens masked. Null when
 * there is none or the body isn't small JSON.
 */
/**
 * Auth.js / NextAuth answer a failed sign-in with a redirect whose target
 * carries the reason (`/login?error=CredentialsSignin`). On an auth route
 * that redirect is the failure; anywhere else a redirect stays a success.
 */
function authRedirectError(url: URL, status: number | null | undefined, location: unknown): string | null {
  try {
    if (typeof status !== "number" || status < 300 || status >= 400 || !isAuthPath(url.pathname)) return null;
    if (typeof location !== "string" || !location) return null;
    const reason = new URL(location, url).searchParams.get("error");
    return reason ? capErrorText(reason) : null;
  } catch {
    return null;
  }
}

async function readResponseErrorMessage(response: Response, trpcRoute = false): Promise<string | null> {
  try {
    // 207 Multi-Status: a tRPC batch where some calls failed. Read only
    // as a tRPC body; any other 207 (WebDAV) stays a success.
    if (response.status < 400 && response.status !== 207) return null;
    // tRPC answers some errors (a mixed query/mutation batch) as text/plain.
    if (!trpcRoute && !(response.headers.get("content-type") ?? "").includes("json")) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_ERROR_BODY_LENGTH) return null;
    const text = await response.clone().text();
    if (!text || text.length > MAX_ERROR_BODY_LENGTH) return null;
    const parsed = safeJsonParse(text);
    const trpc = trpcErrorMessage(parsed, configuration().excludedGraphqlVariableKeys);
    if (trpc) return trpc;
    if (response.status === 207) return null;
    const body = parsed as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return null;
    const nested = body.error as { message?: unknown } | null | undefined;
    const raw = [body.error, body.message, nested?.message].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    // `{ error: "Validation error", details: [...] }`: the issue says why.
    const specific =
      !raw || isGenericErrorText(raw)
        ? specificErrorMessage(body, configuration().excludedGraphqlVariableKeys)
        : null;
    if (specific) return capErrorText(specific);
    return raw ? truncate(scrubSecretsInText(raw.trim(), { emails: true })) : null;
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
/**
 * A sign-in: the actor hook ran before the handler, when the session cookie did not exist yet,
 * so the request read "Signed in" by nobody. When the hook found nobody, the request changes
 * something (not GET/HEAD) and the handler set cookies, the hook runs once more with the
 * request's cookies plus those, so the app's own hook names who signed in. It never replaces an
 * actor already set and never guesses: no answer from the hook leaves the request as it was.
 */
async function retryActorHookWithNewCookies(
  base: Headers | null,
  newCookies: Array<[string, string]>,
  method: string,
  url: string,
): Promise<void> {
  const hook = configuration().actorFromRequest;
  if (!hook || getCurrentActor() || newCookies.length === 0) return;
  if (method === "GET" || method === "HEAD") return;

  const jar = new Map<string, string>();
  for (const part of (base?.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const before = new Map(jar);
  for (const [name, value] of newCookies) {
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  // Nothing new or changed: the hook would give the same answer as before.
  if (jar.size === before.size && [...jar].every(([n, v]) => before.get(n) === v)) return;
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");

  try {
    const headers = new Headers(base ?? undefined);
    headers.set("cookie", cookie);
    const result = await Promise.resolve(hook({ headers, method, url } as unknown as Request));
    if (result) applyActorFromHookAndUa(result, headers.get("user-agent"));
  } catch (error) {
    logger.debug(`actorFromRequest hook (after the handler) failed: ${describeError(error)}`);
  }
}

/** `name=value` pairs a response sets; a cookie being cleared (Max-Age=0 / expired) reads "". */
function cookiesSetBy(setCookies: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of setCookies) {
    const [pair = "", ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const cleared = attrs.some((a) => {
      const [k = "", v = ""] = a.trim().split("=");
      const key = k.toLowerCase();
      if (key === "max-age") return Number(v) <= 0;
      if (key === "expires") return Date.parse(v) <= Date.now();
      return false;
    });
    out.push([pair.slice(0, eq).trim(), cleared ? "" : pair.slice(eq + 1).trim()]);
  }
  return out;
}

/** Set-Cookie lines of a fetch Response (one entry per cookie). */
function setCookieLines(headers: Headers | null | undefined): string[] {
  if (!headers) return [];
  const getAll = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getAll === "function") return getAll.call(headers);
  const joined = headers.get("set-cookie");
  return joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

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
