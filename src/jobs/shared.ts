// Shared job-capture helpers.
//
// All five job adapters (BullMQ, Inngest, Trigger.dev, Supabase Queues,
// Upstash Workflow) emit events with the same wire shape:
//   source_type: "background_job"
//   source_data: { job_class, job_id, queue, retry_count }
// The differences live in HOW each runner exposes lifecycle events
// and where it stores the correlation id during enqueue.
//
// emitJobEvent is the single emit path. Each adapter calls it with
// runner-normalized values.
//
// Correlation propagation pattern (matches the Ruby Sidekiq+ActiveJob
// capturers): on enqueue, stamp the current correlation id into the
// job payload at a stable key. On execution, restore that id into
// AsyncLocalStorage scope for the lifetime of the job. After the job
// resolves (or rejects), the previous scope is restored — important
// for inline runners that execute in the caller's context.

import { logger } from "../logger.js";
import { build as buildEvent } from "../event-builder.js";
import { pushEvent } from "../pipeline/buffer.js";
import {
  current as currentCorrelation,
  generate as generateCorrelation,
  runWithCorrelation,
} from "../correlation.js";
import { configuration } from "../configuration.js";

/**
 * Stable key for embedding the correlation id in a job payload. All
 * job adapters use this single key so events are uniformly stamped
 * regardless of runner.
 */
export const CORRELATION_PAYLOAD_KEY = "ezlogs_correlation_id";

export interface JobSourceData {
  job_class: string;
  /** May be unknown for some runners (e.g. updateMany-style batches). */
  job_id?: string | null;
  /** Queue name. Some runners (Inngest) have no queue concept — pass null. */
  queue?: string | null;
  /** 0-indexed retry count. Sidekiq's "retry_count": 0, 1, 2, ... */
  retry_count?: number | null;
}

export interface JobEmitInput {
  jobClass: string;
  jobId?: string | null;
  queue?: string | null;
  retryCount?: number | null;
  /** Correlation id for the event. If null, the current scope's id is used. */
  correlationId?: string | null;
  outcome: "success" | "failure";
  errorMessage?: string | null;
  durationMs?: number | null;
  startedAt: Date;
}

/**
 * Emit a background_job event. Builds the source_data shape, applies
 * the configured exclude list, pushes to the buffer. Never throws.
 */
export function emitJobEvent(input: JobEmitInput): void {
  try {
    const config = configuration();
    if (!config.captureJobs) return;
    if (config.allExcludedJobClasses().includes(input.jobClass)) return;

    const sourceData: JobSourceData = compactJobSourceData({
      job_class: input.jobClass,
      job_id: input.jobId ?? null,
      queue: input.queue ?? null,
      retry_count: input.retryCount ?? null,
    });

    const event = buildEvent({
      source_type: "background_job",
      source_data: sourceData as unknown as Record<string, unknown>,
      outcome: input.outcome,
      correlation_id: input.correlationId ?? currentCorrelation(),
      resource_ids: [],
      context: null,
      duration_ms: input.durationMs ?? null,
      error_message: input.errorMessage ?? null,
      timestamp: input.startedAt,
    });

    pushEvent(event);
  } catch (error) {
    logger.debug(`job emit failed: ${describeError(error)}`);
  }
}

/**
 * Wrap a job-execution function so events are produced on success and
 * failure, exceptions are re-raised, and correlation flows through.
 *
 * Used by every job adapter. Adapters are responsible for extracting
 * the correlation id from the runner-specific payload before calling
 * this — see e.g. bullmq.ts wrapWorker.
 */
export async function runJobWithCapture<T>(
  meta: {
    jobClass: string;
    jobId?: string | null;
    queue?: string | null;
    retryCount?: number | null;
    correlationId: string | null;
  },
  work: () => Promise<T>,
): Promise<T> {
  // Use the propagated correlation, or generate a new one if absent.
  // Mirrors Sidekiq server middleware: `job["correlation_id"] || Correlation.generate`.
  const correlationId = meta.correlationId ?? generateCorrelation();

  return runWithCorrelation(correlationId, async () => {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const baseMeta = {
      jobClass: meta.jobClass,
      jobId: meta.jobId ?? null,
      queue: meta.queue ?? null,
      retryCount: meta.retryCount ?? null,
      correlationId,
      startedAt,
    };
    try {
      const result = await work();
      emitJobEvent({
        ...baseMeta,
        outcome: "success",
        durationMs: Date.now() - startMs,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      emitJobEvent({
        ...baseMeta,
        outcome: "failure",
        errorMessage: message,
        durationMs: Date.now() - startMs,
      });
      throw error;
    }
  });
}

/**
 * Try to read a correlation id from a job payload. Returns null if the
 * payload doesn't carry one. Adapters that store the id under a
 * different key can pass an alternate `key` argument.
 */
export function extractCorrelationFromPayload(
  payload: unknown,
  key: string = CORRELATION_PAYLOAD_KEY,
): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Stamp the current correlation id into a payload object (mutating).
 * No-op if there's no active correlation scope or the payload already
 * carries one (caller intent wins, parity with Sidekiq client middleware).
 */
export function stampCorrelationOnPayload(
  payload: Record<string, unknown> | null | undefined,
  key: string = CORRELATION_PAYLOAD_KEY,
): void {
  if (!payload || typeof payload !== "object") return;
  if (typeof payload[key] === "string" && payload[key]) return;
  const id = currentCorrelation();
  if (!id) return;
  payload[key] = id;
}

/**
 * Strip null/undefined keys before they hit the wire. Mirrors the
 * Ruby JobCapturer's `.compact`. Done here so each adapter only has
 * to provide the keys it knows about.
 */
function compactJobSourceData(data: JobSourceData): JobSourceData {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data) as Array<keyof JobSourceData>) {
    const value = data[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as unknown as JobSourceData;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
