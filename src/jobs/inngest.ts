// Inngest jobs adapter.
//
// Inngest exposes a stable middleware API. Users register middleware
// on the client, which gives us per-function-run lifecycle hooks:
//
//   import { Inngest } from "inngest"
//   import { ezlogsInngestMiddleware } from "ezlogs-nextjs/inngest"
//
//   export const inngest = new Inngest({
//     id: "my-app",
//     middleware: [ezlogsInngestMiddleware()],
//   })
//
// What's captured (v3):
//   - onFunctionRun: snapshot start time, fn id, run id, attempt
//   - transformInput: extract correlation id from event.data
//   - transformOutput: emit success/failure event with duration
// On v4 (a class Inngest calls `new` on), `wrapRequest` runs the whole
// run request inside the event's correlation and emits the event; see
// inngestV4Hooks.
//
// Inngest's runtime model is event-driven, so:
//   - "queue" maps to event name (best stable identifier)
//   - "job_class" maps to fn id (function name)
//   - "job_id" maps to run id (one per execution)
//   - "retry_count" maps to ctx.attempt (0-indexed)
//
// Documented in AGENT_PARITY_NOTES.md.

import { logger } from "../logger.js";
import { instrumentClass, instrumentFrom } from "../instrument.js";
import {
  emitJobEvent,
  extractCorrelationFromPayload,
  flushJobAuditLog,
  signedActorToken,
  readActorToken,
  ACTOR_PAYLOAD_KEY,
  CORRELATION_PAYLOAD_KEY,
} from "./shared.js";
import { createScopedStorage } from "../edge-fallback.js";
import { runWithActorScope } from "../actor.js";
import { markJobDelivery } from "../job-delivery.js";
import {
  current as currentCorrelation,
  endCorrelationScope,
  runWithCorrelation,
  generate as generateCorrelation,
} from "../correlation.js";

interface InngestRunContext {
  // v3: `id(prefix?)` is a method and the plain id lives in `opts.id`;
  // older shapes expose `id` as a string.
  fn?: { id?: string | ((prefix?: string) => string); opts?: { id?: string } };
  ctx?: {
    runId?: string;
    attempt?: number;
    event?: { name?: string; data?: unknown };
  };
}

interface InngestSendContext {
  payloads?: Array<{ name?: string; data?: unknown }>;
}

interface InngestV4FunctionInput {
  ctx?: { event?: unknown; events?: unknown } & Record<string, unknown>;
  steps?: Record<string, { type?: string; data?: unknown } | undefined>;
}

// True inside a v4 run the middleware wraps.
const insideV4Run = createScopedStorage<boolean>(Symbol.for("ezlogs-nextjs:inngest-v4-run"));

interface InngestV4RequestBody {
  event?: { name?: string; data?: unknown };
  ctx?: { run_id?: string; attempt?: number } | null;
}

/**
 * Returns an Inngest middleware for v3 and v4. Pass it via:
 *   new Inngest({ middleware: [ezlogsInngestMiddleware()] })
 *
 * Returned `unknown` because Inngest's `Middleware` type is parameterized
 * over the client and we don't want to take a hard type dep.
 *
 * v3 reads `name` and calls `init()`. v4 calls `new` on it (one
 * instance per request or send), which returns the v4 hooks.
 */
export function ezlogsInngestMiddleware(): unknown {
  const middleware = function ezlogsInngestV4() {
    return inngestV4Hooks();
  };
  Object.defineProperty(middleware, "name", { value: "ezlogs-nextjs" });
  return Object.assign(middleware, {
    init() {
      return {
        // Hook called once per function run (e.g. one trigger fires
        // one function). Returns per-run hooks that fire as the run
        // proceeds. We track the run via closure-scoped state.
        onFunctionRun(args: InngestRunContext) {
          // The request (Inngest calling the serve route) delivers this run: its job event stands for it.
          markJobDelivery();
          const fnId = functionId(args.fn) ?? "inngest-function";
          const runId = args.ctx?.runId ?? null;
          const attempt = typeof args.ctx?.attempt === "number" ? args.ctx.attempt : 0;
          const eventName = args.ctx?.event?.name ?? null;
          const eventData = args.ctx?.event?.data;
          const correlationId =
            extractCorrelationFromPayload(args.ctx?.event?.data) ?? generateCorrelation();
          const startedAt = new Date();
          const startMs = startedAt.getTime();

          // Inngest's middleware lifecycle returns hooks; these aren't
          // wrapped in any user-runnable callback. We can't run the
          // entire fn body inside `runWithCorrelation` from here —
          // instead we emit at transformOutput, which is called once
          // with `{ result }` and which we use as the "run finished"
          // signal.

          return {
            // Inngest calls this once after the function body returns
            // (success) or throws (failure surfaces via result.error).
            // `step`: the step this execution ran (none on the one where the function returns).
            transformOutput(args: {
              result?: { data?: unknown; error?: unknown };
              step?: { name?: unknown; displayName?: unknown };
            }) {
              try {
                const result = args.result;
                const error = result?.error;
                const outcome: "success" | "failure" = error ? "failure" : "success";
                const errorMessage = error ? formatError(error) : null;

                const ranStep = args.step?.displayName ?? args.step?.name;
                emitJobEvent({
                  jobClass: fnId,
                  jobId: runId,
                  queue: eventName,
                  step: typeof ranStep === "string" && ranStep ? ranStep : null,
                  retryCount: attempt,
                  correlationId,
                  outcome,
                  errorMessage,
                  durationMs: Date.now() - startMs,
                  startedAt,
                  payload: eventData,
                });
              } catch (error) {
                logger.debug(`inngest capture failed: ${describeError(error)}`);
              }
            },
          };
        },

        // Hook called when a user calls inngest.send(...). Stamp the
        // current correlation id on the event payload so the
        // downstream function's onFunctionRun can read it back.
        onSendEvent() {
          return {
            // Inngest awaits this hook (MaybePromise) and sends the
            // payloads it returns. Stamped copies: the caller's event
            // objects are never written (one reused across requests
            // would carry the first request's id and actor).
            transformInput(args: InngestSendContext) {
              return stampSendEvents(args.payloads, (payloads) => ({ payloads }));
            },
          };
        },
      };
    },
  });
}

// Inngest v4 hooks, one object per request (or send). `wrapRequest`
// wraps the whole serve-route POST for one function run: the function
// body and the steps it runs execute inside the event's correlation
// scope, then one job event is emitted for the request.
function inngestV4Hooks() {
  let runError: unknown = null;
  let ranStep: string | null = null;
  // Set once the run starts executing, which Inngest does only after the
  // request's signature checked out: an unsigned POST emits nothing.
  let executed = false;
  return {
    id: "ezlogs-nextjs",
    // Before the function sees (and Inngest validates) its events: our keys
    // are removed, so a trigger or `waitForEvent` with a strict schema
    // still accepts them. The scope was opened from the request body.
    transformFunctionInput(arg: InngestV4FunctionInput) {
      executed = true;
      try {
        return withoutCarriedKeysInInput(arg);
      } catch (error) {
        logger.debug(`inngest input strip failed: ${describeError(error)}`);
        return arg;
      }
    },
    // Called for `inngest.send` and `step.sendEvent`; returns the arg with stamped copies.
    transformSendEvent(args: { events?: unknown }) {
      return stampSendEvents(args?.events, (events) => ({ ...args, events })) ?? args;
    },
    // Only for steps that run in this request (`step.run`, `step.sendEvent`), not memoized ones.
    onStepStart(args: { stepInfo?: { options?: { id?: unknown; name?: unknown } } }) {
      const options = args?.stepInfo?.options;
      const name = options?.name ?? options?.id;
      ranStep = typeof name === "string" && name ? name : null;
    },
    onStepError(args: { error?: unknown }) {
      runError = args?.error ?? runError;
    },
    onRunError(args: { error?: unknown }) {
      runError = args?.error ?? runError;
    },
    async wrapRequest(args: {
      fn?: InngestRunContext["fn"];
      next: () => Promise<unknown>;
      requestInfo?: { body?: () => Promise<unknown> };
      runId?: string;
    }): Promise<unknown> {
      let nextCalled = false;
      const next = () => {
        nextCalled = true;
        return args.next();
      };
      try {
        // No function: not a run (Inngest only calls this hook on POSTs).
        const body = args.fn ? ((await args.requestInfo?.body?.()) as InngestV4RequestBody | null) : null;
        if (!body || typeof body !== "object") return await next();
        const fnId = functionId(args.fn) ?? "inngest-function";
        const event = body.event;
        const attempt = typeof body.ctx?.attempt === "number" ? body.ctx.attempt : 0;
        const runId = args.runId || body.ctx?.run_id || null;
        return await runInsideInngestCorrelation(event, () => insideV4Run.run(true, async () => {
          const startedAt = new Date();
          try {
            return await next();
          } catch (error) {
            runError = error;
            throw error;
          } finally {
            if (executed) {
              // The request (Inngest calling the serve route) delivers this run: its job event stands for it.
              markJobDelivery();
              emitJobEvent({
              jobClass: fnId,
              jobId: runId,
              queue: event?.name ?? null,
              step: ranStep,
              retryCount: attempt,
              outcome: runError ? "failure" : "success",
              errorMessage: runError ? formatError(runError) : null,
              durationMs: Date.now() - startedAt.getTime(),
              startedAt,
              payload: event?.data,
              });
            }
          }
        }));
      } catch (error) {
        if (nextCalled) throw error;
        logger.debug(`inngest capture failed: ${describeError(error)}`);
        return args.next();
      }
    },
  };
}

// The function input with our keys removed from its events and from
// memoized `waitForEvent` results; the same object when none carry them.
function withoutCarriedKeysInInput(arg: InngestV4FunctionInput): InngestV4FunctionInput {
  const ctx = arg?.ctx;
  if (!ctx) return arg;
  let changed = false;
  const strip = <T>(value: T): T => {
    const out = withoutCarriedKeys(value);
    if (out !== value) changed = true;
    return out;
  };
  const event = strip(ctx.event);
  const events = Array.isArray(ctx.events) ? ctx.events.map(strip) : ctx.events;
  const steps: InngestV4FunctionInput["steps"] = {};
  for (const [id, step] of Object.entries(arg.steps ?? {})) {
    steps[id] = step?.type === "data" ? { ...step, data: strip(step.data) } : step;
  }
  return changed ? { ...arg, ctx: { ...ctx, event, events }, steps } : arg;
}

function withoutCarriedKeys<T>(event: T): T {
  const data = (event as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return event;
  if (!(CORRELATION_PAYLOAD_KEY in data) && !(ACTOR_PAYLOAD_KEY in data)) return event;
  const rest: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  delete rest[CORRELATION_PAYLOAD_KEY];
  delete rest[ACTOR_PAYLOAD_KEY];
  return { ...event, data: rest };
}

/**
 * Outgoing events with the current correlation id (and the sender's
 * signed actor) stamped on `data`, passed to `wrap`. Stamped copies:
 * the caller's event objects are never written (one reused across
 * requests would carry the first request's id and actor). Undefined
 * when there is nothing to stamp. Never throws.
 */
function stampSendEvents<R>(events: unknown, wrap: (events: unknown[]) => R): R | Promise<R> | undefined {
  try {
    const id = currentCorrelation();
    if (!id) return;
    if (!Array.isArray(events)) return;
    const stamped: Array<Record<string, unknown>> = [];
    const payloads = events.map((payload: { data?: unknown; validate?: unknown } | null) => {
      if (!payload || typeof payload !== "object") return payload;
      // An `eventType().create()` event keeps its `validate()` through the
      // spread: it checks the caller's original data (a closure), not this
      // stamped copy, so a strict schema still passes.
      const data = payload.data ?? {};
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return payload;
      }
      if (typeof (data as Record<string, unknown>).ezlogs_correlation_id === "string") {
        return payload;
      }
      const copy: Record<string, unknown> = { ...data, ezlogs_correlation_id: id };
      if (!(ACTOR_PAYLOAD_KEY in copy)) stamped.push(copy);
      return { ...payload, data: copy };
    });
    const pending = stamped.length > 0 ? signedActorToken(id) : null;
    if (!pending) return wrap(payloads);
    // The sender's human actor, verified by runInsideInngestCorrelation.
    return pending.then((token) => {
      if (token) for (const data of stamped) data[ACTOR_PAYLOAD_KEY] = token;
      return wrap(payloads);
    });
  } catch (error) {
    logger.debug(`inngest send-stamp failed: ${describeError(error)}`);
  }
}

/**
 * Run an Inngest function body (or a step) inside the run's
 * correlation scope, so its DB writes are tagged and emitted under the
 * action that sent the event. Inngest v3 middleware can't wrap the body
 * itself, so without this the job event is captured but the body's DB
 * writes ship as their own actions. Not needed on v4 (the middleware
 * wraps the run), where it is harmless:
 *
 *   inngest.createFunction({ id: "send-invoice" }, { event: "invoice/created" },
 *     ({ event, step }) => runInsideInngestCorrelation(event, async () => { ... }))
 */
export async function runInsideInngestCorrelation<T>(
  event: { data?: unknown } | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  // v4: the middleware already runs this in the event's scope (and the
  // function's event no longer carries the id).
  if (insideV4Run.read()) return callback();
  const carried = extractCorrelationFromPayload(event?.data);
  const id = carried ?? generateCorrelation();
  // The sending request's human actor, when its signed token verifies.
  const token = (event?.data as Record<string, unknown> | null | undefined)?.[ACTOR_PAYLOAD_KEY];
  const actor = carried && token !== undefined ? await readActorToken(token, carried) : null;
  const startedAt = new Date();
  const body = async () => {
    try {
      return await callback();
    } finally {
      await flushJobAuditLog(startedAt);
    }
  };
  // Fresh actor scope: never the actor of the scope that called us.
  // Ended after the body, like a job's (see runJobWithCapture).
  const scoped = () => body().finally(endCorrelationScope);
  return runWithCorrelation(id, () => runWithActorScope(scoped, actor));
}

function functionId(fn: InngestRunContext["fn"]): string | null {
  try {
    const id = typeof fn?.id === "function" ? fn.id() : fn?.id;
    if (typeof id === "string" && id) return id;
  } catch {
    // fall through to opts.id
  }
  const optsId = fn?.opts?.id;
  return typeof optsId === "string" && optsId ? optsId : null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
  }
  if (typeof error === "object" && error !== null) {
    const err = error as { name?: string; message?: string };
    return `${err.name ?? "Error"}: ${err.message ?? JSON.stringify(error)}`;
  }
  return String(error);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// The client options with the agent's middleware added, unless the app already passes it.
function withEzlogsMiddleware(args: unknown[]): unknown[] {
  const [options, ...rest] = args;
  if (!options || typeof options !== "object" || Array.isArray(options)) return args;
  const opts = options as { middleware?: unknown };
  const existing = Array.isArray(opts.middleware) ? opts.middleware : opts.middleware == null ? [] : null;
  if (existing === null) return args; // a shape we don't know: leave it alone
  if (existing.some((m) => (m as { name?: unknown } | null)?.name === "ezlogs-nextjs")) return args;
  return [{ ...opts, middleware: [...existing, ezlogsInngestMiddleware()] }, ...rest];
}

/**
 * Replacements for the plugin's instrumented imports (instrument.ts):
 * every Inngest client the app's server code constructs gets
 * ezlogsInngestMiddleware. Internal: called by build-time generated code.
 */
export const __ezlogsInstrument = instrumentFrom({
  "inngest#Inngest": (original) => instrumentClass(original, (client) => client, withEzlogsMiddleware),
});
