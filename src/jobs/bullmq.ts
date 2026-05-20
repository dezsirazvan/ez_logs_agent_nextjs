// BullMQ jobs adapter.
//
// BullMQ has no formal middleware API. The reliable pattern is:
//   - Enqueue side: wrap `queue.add(name, data, opts)` so the
//     correlation id is stamped into `data` before Redis sees it.
//   - Worker side: subscribe to `worker.on("completed" | "failed")`
//     after the user constructs the Worker, and emit events from
//     those listeners. We don't replace the processor function —
//     correlation propagation happens via the stamped payload.
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
import {
  emitJobEvent,
  extractCorrelationFromPayload,
  stampCorrelationOnPayload,
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
  queue.add = ((name: string, data: unknown, opts?: unknown) => {
    return originalAdd(name, stampPayload(data), opts);
  }) as T["add"];

  if (typeof queue.addBulk === "function") {
    // queue.addBulk is typed as `Function` on BullQueueLike (see the
    // interface's comment for why). Cast through the loose-typed
    // shape so we can call the original safely and re-attach a
    // wrapping function of the same shape.
    type BulkJob = { name: string; data: unknown; opts?: unknown };
    type BulkFn = (jobs: BulkJob[]) => Promise<unknown>;
    const originalAddBulk = (queue.addBulk as BulkFn).bind(queue);
    const wrappedAddBulk: BulkFn = (jobs: BulkJob[]) =>
      originalAddBulk(jobs.map((j) => ({ ...j, data: stampPayload(j.data) })));
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
 * Subscribes capture listeners to a BullMQ Worker. Each completed /
 * failed job emits one event. We use `attemptsMade` for retry_count
 * (parity with Sidekiq's `retry_count`).
 *
 * Idempotent — calling on the same worker twice is a no-op.
 */
export function wrapBullWorker<T extends BullWorkerLike>(worker: T): T {
  if ((worker as unknown as Record<string, unknown>)[WRAPPED_FLAG]) return worker;

  worker.on("completed", (...args: unknown[]) => {
    const job = args[0] as BullJobLike | undefined;
    if (!job) return;
    captureJob(job, worker, "success", null);
  });

  worker.on("failed", (...args: unknown[]) => {
    const job = args[0] as BullJobLike | undefined;
    const error = args[1] as Error | undefined;
    if (!job) return;
    const message = error
      ? `${error.name ?? "Error"}: ${error.message ?? String(error)}`
      : "Error: job failed";
    captureJob(job, worker, "failure", message);
  });

  Object.defineProperty(worker, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return worker;
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
    });
  } catch (error) {
    logger.debug(`bullmq capture failed: ${describeError(error)}`);
  }
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
