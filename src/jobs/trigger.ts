// Trigger.dev jobs adapter.
//
// Trigger.dev v3 exposes global lifecycle hooks via the `tasks` object
// exported from @trigger.dev/sdk/v3. Users register them in an
// `init.ts` at the trigger directory root:
//
//   import { tasks } from "@trigger.dev/sdk/v3"
//   import { registerTriggerHooks } from "@ezlogs/nextjs/trigger"
//   registerTriggerHooks(tasks)
//
// Per Trigger.dev's lifecycle docs, the stable global hooks are:
//   tasks.onStartAttempt / tasks.onSuccess / tasks.onFailure /
//   tasks.onComplete / tasks.middleware
//
// We use:
//   - `tasks.middleware` for the wrap-around lifetime so we can
//     scope correlation across the entire run via runWithCorrelation.
//   - The middleware's `next()` is the user's task body. We catch
//     thrown exceptions to emit failure events, then re-throw.
//
// Trigger.dev-to-canonical mapping (documented in AGENT_PARITY_NOTES.md):
//   job_class    -> ctx.task.id
//   job_id       -> ctx.run.id
//   queue        -> ctx.run.queue.name (when present, else null)
//   retry_count  -> ctx.attempt.number - 1 (Trigger uses 1-indexed attempts)

import { logger } from "../logger.js";
import {
  emitJobEvent,
  extractCorrelationFromPayload,
} from "./shared.js";
import {
  current as currentCorrelation,
  generate as generateCorrelation,
  runWithCorrelation,
} from "../correlation.js";

// Loose structural type for the `tasks` object — we don't take a
// hard dep on @trigger.dev/sdk/v3 because its types vary across
// minor releases.
interface TriggerTasksLike {
  middleware?: (
    name: string,
    handler: (params: TriggerMiddlewareParams) => Promise<unknown>,
  ) => unknown;
}

interface TriggerMiddlewareParams {
  payload: unknown;
  ctx?: TriggerCtx;
  next: () => Promise<unknown>;
}

interface TriggerCtx {
  run?: {
    id?: string;
    queue?: { name?: string };
  };
  task?: { id?: string };
  attempt?: { number?: number };
}

// Idempotency flag — re-registering on the same `tasks` object
// (e.g. hot reload) should not double-wrap.
const REGISTERED_FLAG = "__ezlogsTriggerRegistered";

/**
 * Registers the EZLogs lifecycle hook on the user's `tasks` object.
 *
 * Pass the `tasks` import from `@trigger.dev/sdk/v3`. Idempotent.
 */
export function registerTriggerHooks(tasks: TriggerTasksLike): void {
  if ((tasks as unknown as Record<string, unknown>)[REGISTERED_FLAG]) return;
  if (typeof tasks.middleware !== "function") {
    logger.debug("trigger.dev tasks.middleware not available — adapter not registered");
    return;
  }

  tasks.middleware("ezlogs", async (params) => {
    return runWithEzlogsCapture(params);
  });

  Object.defineProperty(tasks, REGISTERED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
}

async function runWithEzlogsCapture(
  params: TriggerMiddlewareParams,
): Promise<unknown> {
  const ctx = params.ctx ?? {};
  const taskId = ctx.task?.id ?? "trigger-task";
  const runId = ctx.run?.id ?? null;
  const queueName = ctx.run?.queue?.name ?? null;
  const attemptNumber = ctx.attempt?.number ?? 1;
  const retryCount = Math.max(0, attemptNumber - 1);

  const correlationId =
    extractCorrelationFromPayload(params.payload) ?? generateCorrelation();

  return runWithCorrelation(correlationId, async () => {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    try {
      const result = await params.next();
      emitJobEvent({
        jobClass: taskId,
        jobId: runId,
        queue: queueName,
        retryCount,
        correlationId,
        outcome: "success",
        durationMs: Date.now() - startMs,
        startedAt,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      emitJobEvent({
        jobClass: taskId,
        jobId: runId,
        queue: queueName,
        retryCount,
        correlationId,
        outcome: "failure",
        errorMessage: message,
        durationMs: Date.now() - startMs,
        startedAt,
      });
      throw error;
    }
  });
}

/**
 * Imperatively stamp the current correlation id onto a payload before
 * calling tasks.trigger / batchTrigger. Trigger.dev doesn't expose a
 * send-side middleware hook the way Inngest does, so users that want
 * the upstream correlation propagated to a triggered task either:
 *   1. Pass a payload that's a plain object (the agent's outgoing-
 *      fetch patch already injects X-Correlation-ID on the HTTP
 *      call to the Trigger.dev API server, but only the receiving
 *      task's middleware sees that — not the payload's data slot),
 *      OR
 *   2. Call `stampPayloadForTrigger(payload)` themselves before
 *      invoking trigger().
 *
 * This helper exists for case 2.
 */
export function stampPayloadForTrigger(payload: unknown): unknown {
  const id = currentCorrelation();
  if (!id) return payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.ezlogs_correlation_id !== "string" || !obj.ezlogs_correlation_id) {
    obj.ezlogs_correlation_id = id;
  }
  return obj;
}
