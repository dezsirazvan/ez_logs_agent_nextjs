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
// What's captured:
//   - onFunctionRun: snapshot start time, fn id, run id, attempt
//   - transformInput: extract correlation id from event.data
//   - transformOutput: emit success/failure event with duration
//
// Inngest's runtime model is event-driven, so:
//   - "queue" maps to event name (best stable identifier)
//   - "job_class" maps to fn id (function name)
//   - "job_id" maps to run id (one per execution)
//   - "retry_count" maps to ctx.attempt (0-indexed)
//
// Documented in AGENT_PARITY_NOTES.md.

import { logger } from "../logger.js";
import {
  emitJobEvent,
  extractCorrelationFromPayload,
  flushJobAuditLog,
} from "./shared.js";
import {
  current as currentCorrelation,
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

/**
 * Returns an Inngest middleware object. Pass it via:
 *   new Inngest({ middleware: [ezlogsInngestMiddleware()] })
 *
 * Returned `unknown` because Inngest's `Middleware` type is parameterized
 * over the client and we don't want to take a hard type dep.
 */
export function ezlogsInngestMiddleware(): unknown {
  return {
    name: "ezlogs-nextjs",
    init() {
      return {
        // Hook called once per function run (e.g. one trigger fires
        // one function). Returns per-run hooks that fire as the run
        // proceeds. We track the run via closure-scoped state.
        onFunctionRun(args: InngestRunContext) {
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
            transformOutput(args: { result?: { data?: unknown; error?: unknown } }) {
              try {
                const result = args.result;
                const error = result?.error;
                const outcome: "success" | "failure" = error ? "failure" : "success";
                const errorMessage = error ? formatError(error) : null;

                emitJobEvent({
                  jobClass: fnId,
                  jobId: runId,
                  queue: eventName,
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
            transformInput(args: InngestSendContext) {
              try {
                const id = currentCorrelation();
                if (!id) return;
                if (!Array.isArray(args.payloads)) return;
                for (const payload of args.payloads) {
                  if (!payload || typeof payload !== "object") continue;
                  const data = (payload.data ?? {}) as Record<string, unknown>;
                  if (typeof data !== "object" || data === null || Array.isArray(data)) {
                    continue;
                  }
                  if (
                    typeof (data as Record<string, unknown>).ezlogs_correlation_id ===
                    "string"
                  ) {
                    continue;
                  }
                  (data as Record<string, unknown>).ezlogs_correlation_id = id;
                  // Re-attach in case the data slot was newly created.
                  (payload as Record<string, unknown>).data = data;
                }
              } catch (error) {
                logger.debug(`inngest send-stamp failed: ${describeError(error)}`);
              }
            },
          };
        },
      };
    },
  };
}

/**
 * Run an Inngest function body (or a step) inside the run's
 * correlation scope, so its DB writes are tagged and emitted under the
 * action that sent the event. Inngest middleware can't wrap the body
 * itself, so without this the job event is captured but the body's DB
 * writes ship as their own actions:
 *
 *   inngest.createFunction({ id: "send-invoice" }, { event: "invoice/created" },
 *     ({ event, step }) => runInsideInngestCorrelation(event, async () => { ... }))
 */
export async function runInsideInngestCorrelation<T>(
  event: { data?: unknown } | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const id = extractCorrelationFromPayload(event?.data) ?? generateCorrelation();
  const startedAt = new Date();
  return runWithCorrelation(id, async () => {
    try {
      return await callback();
    } finally {
      await flushJobAuditLog(startedAt);
    }
  });
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
