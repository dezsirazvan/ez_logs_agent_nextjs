// BullMQ jobs adapter.
//
// BullMQ has no formal middleware API. The reliable pattern is:
//   - Enqueue side: wrap `queue.add(name, data, opts)` so the
//     correlation id is stamped into `data` before Redis sees it.
//   - Worker side: replace the Worker's processor (`processFn`, set by
//     the constructor in BullMQ 4/5) with one that runs the job body
//     inside the job's correlation scope, so DB writes made by the job
//     are tagged and emitted under the job's action, and the job event
//     carries its sanitized `arguments`. Workers without a `processFn`
//     fall back to `completed` / `failed` listeners (job event only).
//
// Public API:
//
//   import { Queue, Worker } from "bullmq"
//   import { wrapBullQueue, wrapBullWorker } from "ezlogs-nextjs/bullmq"
//
//   const queue = wrapBullQueue(new Queue("emails"))
//   const worker = wrapBullWorker(new Worker("emails", processor))
//
// Both wrappers are idempotent.

import { logger } from "../logger.js";
import { current as currentCorrelation } from "../correlation.js";
import type { ActorContext } from "../actor.js";
import {
  emitJobEvent,
  extractCorrelationFromPayload,
  readActorToken,
  signedActorToken,
  runJobWithCapture,
  stampCorrelationOnPayload,
  ACTOR_PAYLOAD_KEY,
  CORRELATION_PAYLOAD_KEY,
} from "./shared.js";

// Loose structural types — we don't take a hard dep on bullmq types
// because the adapter must work across BullMQ 4 and 5, which have
// different type exports.
//
// `add` and `addBulk` are typed as `Function` so a real BullMQ
// `Queue.add(name: string, data: T, opts?: JobsOptions)` is
// assignable to the constraint without a contravariance failure.
// The wrap's internal calls re-cast to the right shape on the way
// in — see the comment on BullWorkerLike below for the deeper TS
// rationale.
interface BullQueueLike {
  // eslint-disable-next-line @typescript-eslint/ban-types
  add: Function;
  // eslint-disable-next-line @typescript-eslint/ban-types
  addBulk?: Function;
  name?: string;
}

/**
 * BullMQ's real Worker type is strictly typed (`on<U extends keyof
 * WorkerListener<…>>`), so a generic `(event: string, listener: …) => …`
 * structural type fails the `T extends BullWorkerLike` constraint
 * with a contravariance error: TypeScript can't prove the typed
 * worker's `on` is assignable to the looser shape, even though
 * we only call it with valid event names.
 *
 * We accept `on` as `Function` instead — looser than `unknown` but
 * still typed enough to read. The wrap's internal calls cast to the
 * right shape on the way in.
 */
interface BullWorkerLike {
  // eslint-disable-next-line @typescript-eslint/ban-types
  on: Function;
  // eslint-disable-next-line @typescript-eslint/ban-types
  off?: Function;
  name?: string;
  /** BullMQ internal: the processor `callProcessJob` invokes. */
  // eslint-disable-next-line @typescript-eslint/ban-types
  processFn?: Function;
  /** BullMQ internal: calls `this.processFn(job, token, signal)`. */
  // eslint-disable-next-line @typescript-eslint/ban-types
  callProcessJob?: Function;
}

interface BullJobLike {
  id?: string | number | null;
  name?: string;
  data?: unknown;
  attemptsMade?: number;
  queueName?: string;
  timestamp?: number;
}

const WRAPPED_FLAG = "__ezlogsBullWrapped";

/**
 * Patches `queue.add` (and `queue.addBulk` when present) so each
 * enqueued job carries the current correlation id on its `data`.
 * If `data` isn't a plain object, we stamp by wrapping it under a
 * `payload` key — but adapters typically expect to read straight
 * from `data`, so callers should pass plain objects when they want
 * propagation to work. Documented in the README.
 */
export function wrapBullQueue<T extends BullQueueLike>(queue: T): T {
  if ((queue as unknown as Record<string, unknown>)[WRAPPED_FLAG]) return queue;

  const originalAdd = queue.add.bind(queue);
  // Resolves once the last deferred add (waiting on a signature) has
  // been handed to BullMQ; later adds queue behind it to keep order.
  let pending: Promise<void> | null = null;
  const inOrder = <R>(token: Promise<string | null> | null, issue: (t: string | null) => R): R | Promise<R> => {
    // Nothing to sign and nothing ahead: enqueue synchronously as before.
    if (!token && !pending) return issue(null);
    let issued!: () => void;
    const done = new Promise<void>((resolve) => (issued = resolve));
    const result = Promise.all([pending, token]).then(([, t]) => {
      try {
        return issue(t ?? null);
      } finally {
        issued();
      }
    });
    pending = done;
    void done.then(() => {
      if (pending === done) pending = null;
    });
    return result;
  };
  queue.add = ((name: string, data: unknown, opts?: unknown) => {
    const stamped = stampPayload(data);
    return inOrder(pendingActorTokenFor(stamped), (t) => originalAdd(name, withActor(stamped, t), opts));
  }) as T["add"];

  if (typeof queue.addBulk === "function") {
    // queue.addBulk is typed as `Function` on BullQueueLike (see the
    // interface's comment for why). Cast through the loose-typed
    // shape so we can call the original safely and re-attach a
    // wrapping function of the same shape.
    type BulkJob = { name: string; data: unknown; opts?: unknown };
    type BulkFn = (jobs: BulkJob[]) => Promise<unknown>;
    const originalAddBulk = (queue.addBulk as BulkFn).bind(queue);
    const wrappedAddBulk: BulkFn = (jobs: BulkJob[]) => {
      const stamped = jobs.map((j) => ({ ...j, data: stampPayload(j.data) }));
      const ours = stamped.map((j) => isOurs(j.data));
      const token = ours.includes(true) ? signedActorToken(currentCorrelation()!) : null;
      return inOrder(token, (t) =>
        originalAddBulk(stamped.map((j, i) => (ours[i] ? { ...j, data: withActor(j.data, t) } : j))),
      );
    };
    (queue as unknown as { addBulk?: BulkFn }).addBulk = wrappedAddBulk;
  }

  Object.defineProperty(queue, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return queue;
}

/**
 * Captures a BullMQ Worker's jobs: one event per run, with the
 * processor running inside the job's correlation scope (see the file
 * header). Sandboxed processors (a file path) run in a child process:
 * the job event is still captured, their DB writes are not tagged.
 *
 * Idempotent — calling on the same worker twice is a no-op.
 */
export function wrapBullWorker<T extends BullWorkerLike>(worker: T): T {
  if ((worker as unknown as Record<string, unknown>)[WRAPPED_FLAG]) return worker;

  // Verified on BullMQ 5.76 and 6.7: the Worker keeps its processor in
  // `processFn` and runs it through `callProcessJob`. If a future
  // version stops doing that, fall back to `completed` / `failed`
  // listeners (job events only, the 0.2.x behavior) instead of
  // patching something BullMQ no longer calls.
  const canWrapProcessor =
    typeof worker.processFn === "function" && typeof worker.callProcessJob === "function";
  if (!canWrapProcessor && !warnedNoProcessor) {
    warnedNoProcessor = true;
    logger.debug(
      "wrapBullWorker: this BullMQ Worker has no processFn/callProcessJob; capturing job " +
        "events from completed/failed only (DB writes inside jobs are not linked).",
    );
  }
  if (canWrapProcessor) {
    const original = worker.processFn!;
    // Jobs whose outcome the processor wrap already reported.
    const reported = new WeakSet<object>();
    worker.processFn = function ezlogsProcess(this: unknown, ...args: unknown[]) {
      const job = (args[0] ?? {}) as BullJobLike;
      if (typeof args[0] === "object" && args[0] !== null) reported.add(args[0]);
      const correlationId = extractCorrelationFromPayload(job.data);
      const run = (actor: ActorContext | null) =>
        runJobWithCapture(
          {
            jobClass: job.name ?? worker.name ?? "BullMQJob",
            jobId: job.id !== undefined && job.id !== null ? String(job.id) : null,
            queue: job.queueName ?? worker.name ?? null,
            // attemptsMade counts finished attempts: 0 on the first run.
            retryCount: typeof job.attemptsMade === "number" ? job.attemptsMade : null,
            correlationId,
            // The enqueuing request's human actor, only when its token verifies.
            actor,
            payload: job.data,
            isControlFlow: isBullControlFlow,
          },
          () => Promise.resolve(original.apply(this, args)),
        );
      const token = (job.data as Record<string, unknown> | null | undefined)?.[ACTOR_PAYLOAD_KEY];
      if (!correlationId || token === undefined) return run(null);
      return readActorToken(token, correlationId).then(run);
    };
    // Failures where the processor never ran (a job started more than
    // `maxStartedAttempts`, a deferred failure) only show up here.
    worker.on("failed", (...args: unknown[]) => {
      const job = args[0] as BullJobLike | undefined;
      if (!job || reported.has(job)) return;
      captureJob(job, worker, "failure", describeFailure(args[1] as Error | undefined));
    });
    markWrapped(worker);
    return worker;
  }

  worker.on("completed", (...args: unknown[]) => {
    const job = args[0] as BullJobLike | undefined;
    if (!job) return;
    captureJob(job, worker, "success", null);
  });

  worker.on("failed", (...args: unknown[]) => {
    const job = args[0] as BullJobLike | undefined;
    if (!job) return;
    captureJob(job, worker, "failure", describeFailure(args[1] as Error | undefined));
  });

  markWrapped(worker);
  return worker;
}

let warnedNoProcessor = false;

function describeFailure(error: Error | undefined): string {
  return error ? `${error.name ?? "Error"}: ${error.message ?? String(error)}` : "Error: job failed";
}

// BullMQ moves the job (delayed, waiting for children, rate-limited)
// instead of failing it when the processor throws one of these.
const BULL_CONTROL_FLOW_ERRORS = new Set(["DelayedError", "WaitingError", "WaitingChildrenError"]);

function isBullControlFlow(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  return (
    (typeof e?.name === "string" && BULL_CONTROL_FLOW_ERRORS.has(e.name)) ||
    e?.message === "bullmq:rateLimitExceeded"
  );
}

function markWrapped(worker: object): void {
  Object.defineProperty(worker, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
}

function captureJob(
  job: BullJobLike,
  worker: BullWorkerLike,
  outcome: "success" | "failure",
  errorMessage: string | null,
): void {
  try {
    const correlationId = extractCorrelationFromPayload(job.data);
    const startedAt =
      typeof job.timestamp === "number" ? new Date(job.timestamp) : new Date();
    const durationMs = job.timestamp ? Date.now() - job.timestamp : null;

    emitJobEvent({
      jobClass: job.name ?? worker.name ?? "BullMQJob",
      jobId: job.id !== undefined && job.id !== null ? String(job.id) : null,
      queue: job.queueName ?? worker.name ?? null,
      retryCount: typeof job.attemptsMade === "number" ? Math.max(0, job.attemptsMade - 1) : null,
      correlationId,
      outcome,
      errorMessage,
      durationMs,
      startedAt,
      payload: job.data,
    });
  } catch (error) {
    logger.debug(`bullmq capture failed: ${describeError(error)}`);
  }
}

/**
 * The pending actor token for a stamped payload, or null when there is
 * nothing to sign: not an object, a caller-chosen correlation id (the
 * token is bound to ours), a caller-set actor key, or no human actor.
 */
function pendingActorTokenFor(data: unknown): Promise<string | null> | null {
  return isOurs(data) ? signedActorToken(currentCorrelation()!) : null;
}

function isOurs(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  const id = currentCorrelation();
  return Boolean(id) && obj[CORRELATION_PAYLOAD_KEY] === id && !(ACTOR_PAYLOAD_KEY in obj);
}

function withActor(data: unknown, token: string | null): unknown {
  if (token) (data as Record<string, unknown>)[ACTOR_PAYLOAD_KEY] = token;
  return data;
}

function stampPayload(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  // Mutate in place to avoid breaking BullMQ's serialization paths.
  stampCorrelationOnPayload(obj, CORRELATION_PAYLOAD_KEY);
  return obj;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
