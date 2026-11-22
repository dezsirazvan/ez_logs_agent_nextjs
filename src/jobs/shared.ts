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
  endCorrelationScope,
  generate as generateCorrelation,
  runWithCorrelation,
} from "../correlation.js";
import { configuration } from "../configuration.js";
import { sanitizeArgs } from "../http/sanitize.js";
import { describeEventError } from "../http/source-data.js";
import { flushAuditLog } from "../triggers/reader.js";
import {
  getCurrentActor,
  maybeExtractSupabaseActor,
  runWithActorScope,
  type ActorContext,
} from "../actor.js";

/**
 * Stable key for embedding the correlation id in a job payload. All
 * job adapters use this single key so events are uniformly stamped
 * regardless of runner.
 */
export const CORRELATION_PAYLOAD_KEY = "ezlogs_correlation_id";

/**
 * Payload key for the signed actor token (BullMQ `job.data`, Inngest
 * `event.data`), next to the correlation id. See `actorToken`.
 */
export const ACTOR_PAYLOAD_KEY = "ezlogs_actor";

// `a<hex of the actor id>_<HMAC tag>`. The tag (HMAC-SHA256 keyed with
// the project token over correlation id + actor id, 64 bits) means a
// forged delivery can't name an actor. Hex keeps an Upstash run id in
// [a-z0-9_] like the rest of it.
const ACTOR_TOKEN = /^a([0-9a-f]{2,128})_([0-9a-f]{16})$/;
// Longer actor ids are not carried (an Upstash run id would get long);
// their post-response writes keep an empty actor.
const ACTOR_ID_MAX_BYTES = 64;

export interface JobSourceData {
  job_class: string;
  /** May be unknown for some runners (e.g. updateMany-style batches). */
  job_id?: string | null;
  /** Queue name. Some runners (Inngest) have no queue concept — pass null. */
  queue?: string | null;
  /** Earlier failed attempts: 0 on a first run, 1 on the first retry (the Ruby agent sends Sidekiq's retry_count + 1). */
  retry_count?: number | null;
  /**
   * The step of a multi-step job this run executed (an Upstash Workflow
   * `context.run` / Inngest `step.run` name). Optional; absent when the run
   * executed none (the call that ends a run) or the runner has no steps.
   */
  step?: string | null;
  /** Sanitized job payload (Rails gem `arguments`). */
  arguments?: unknown;
}

export interface JobEmitInput {
  jobClass: string;
  jobId?: string | null;
  queue?: string | null;
  step?: string | null;
  retryCount?: number | null;
  /** Correlation id for the event. If null, the current scope's id is used. */
  correlationId?: string | null;
  outcome: "success" | "failure";
  errorMessage?: string | null;
  durationMs?: number | null;
  startedAt: Date;
  /** Raw job payload; sanitized here before it ships as `arguments`. */
  payload?: unknown;
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
      step: input.step ?? null,
      arguments: jobArguments(input.payload),
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
    /** The step this run executed, or a function read when it ends (known only once it ran). */
    step?: string | null | (() => string | null);
    retryCount?: number | null;
    correlationId: string | null;
    /**
     * Actor carried from the request that started the job (verified by
     * the adapter). Its DB writes are attributed to it; omitted, the
     * job keeps whatever actor scope it runs in.
     */
    actor?: ActorContext | null;
    /** Raw job payload, shipped sanitized as `arguments`. */
    payload?: unknown;
    /**
     * Runner control flow thrown through the body (BullMQ's
     * `DelayedError`, `WaitingChildrenError`…): re-thrown with no job
     * event, since the job did not finish.
     */
    isControlFlow?: (error: unknown) => boolean;
    /**
     * Thrown when the body finished normally (Upstash Workflow ends each
     * step by throwing WorkflowAbort): recorded as success, re-thrown.
     */
    isSuccessfulExit?: (error: unknown) => boolean;
  },
  work: () => Promise<T>,
): Promise<T> {
  // Use the propagated correlation, or generate a new one if absent.
  // Mirrors Sidekiq server middleware: `job["correlation_id"] || Correlation.generate`.
  const correlationId = meta.correlationId ?? generateCorrelation();

  const body = async (): Promise<T> => {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const step = meta.step;
    const baseMeta = {
      jobClass: meta.jobClass,
      jobId: meta.jobId ?? null,
      queue: meta.queue ?? null,
      // Read when the event is built (after the run): the step it executed.
      get step() {
        return (typeof step === "function" ? step() : step) ?? null;
      },
      retryCount: meta.retryCount ?? null,
      correlationId,
      startedAt,
      payload: meta.payload,
    };
    try {
      const result = await work();
      await flushJobAuditLog(startedAt);
      emitJobEvent({
        ...baseMeta,
        outcome: "success",
        durationMs: Date.now() - startMs,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? describeEventError(error.name, error.message)
          : String(error);
      await flushJobAuditLog(startedAt);
      if (meta.isControlFlow?.(error)) throw error;
      if (meta.isSuccessfulExit?.(error)) {
        emitJobEvent({ ...baseMeta, outcome: "success", durationMs: Date.now() - startMs });
        throw error;
      }
      emitJobEvent({
        ...baseMeta,
        outcome: "failure",
        errorMessage: message,
        durationMs: Date.now() - startMs,
      });
      throw error;
    }
  };
  // Always a fresh actor scope: the job's actor is only the one it
  // carried, never the scope its worker was created in. The scope ends
  // like a request's: work the job started keeps its id for the grace
  // window, then runs unlinked.
  const scoped = () => body().finally(endCorrelationScope);
  return runWithCorrelation(correlationId, () => runWithActorScope(scoped, meta.actor ?? null));
}

// Clock skew allowance between the app and the database when matching
// audit rows (`captured_at`, database clock) to a job's start (app clock).
const JOB_FLUSH_SKEW_MS = 500;

/**
 * Emit the trigger audit rows the job body wrote (tagged with the job's
 * correlation id because the body ran inside its scope). Only rows
 * written since the job started: the enqueuing request (same
 * correlation id) emits its own rows, so they are neither taken from it
 * nor sent twice when the reader can't DELETE. Never throws.
 */
export async function flushJobAuditLog(startedAt: Date): Promise<void> {
  try {
    await flushAuditLog(configuration().databaseReader, {
      since: new Date(startedAt.getTime() - JOB_FLUSH_SKEW_MS),
    });
  } catch (error) {
    logger.debug(`job audit flush failed: ${describeError(error)}`);
  }
}

/**
 * Sanitized `arguments` for a job payload (Rails `arguments` field):
 * an object keeps its keys (minus the agent's correlation key), a list
 * stays positional. Same redaction as the Rails gem.
 */
function jobArguments(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  const patterns = configuration().excludedGraphqlVariableKeys;
  if (Array.isArray(payload)) return payload.length === 0 ? null : sanitizeArgs(payload, patterns);
  if (typeof payload === "object" && Object.getPrototypeOf(payload) === Object.prototype) {
    const rest: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    delete rest[CORRELATION_PAYLOAD_KEY];
    delete rest[ACTOR_PAYLOAD_KEY];
    if (Object.keys(rest).length === 0) return null;
    return (sanitizeArgs([rest], patterns) as unknown[])[0];
  }
  return sanitizeArgs([payload], patterns);
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
 * The payload with the current correlation id stamped, as a shallow
 * copy: the caller's object is never written, so one reused across
 * requests (a module constant) can't carry an earlier request's id.
 * Returns the payload itself when there's no active correlation scope
 * or it already carries an id (caller intent wins, parity with Sidekiq
 * client middleware).
 */
export function stampCorrelationOnPayload<T extends Record<string, unknown> | null | undefined>(
  payload: T,
  key: string = CORRELATION_PAYLOAD_KEY,
): T {
  if (!payload || typeof payload !== "object") return payload;
  if (typeof payload[key] === "string" && payload[key]) return payload;
  const id = currentCorrelation();
  if (!id) return payload;
  return { ...payload, [key]: id };
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

/**
 * The current actor's id as a signed token for work that runs after
 * the request (workflow steps, QStash deliveries, BullMQ jobs, Inngest
 * functions), bound to `correlationId`. Null (synchronously) when there
 * is no actor, the actor is not a plain human (kind or principal can't
 * travel), no project token, or the id is too long. Same correlation +
 * actor share one pending promise, so callers awaiting it in order
 * resume in order (BullMQ `add` keeps its enqueue order). Never throws.
 */
export function pendingActorToken(correlationId: string): Promise<string | null> | null {
  try {
    const actor = getCurrentActor();
    // Only the id travels: an agent / hybrid actor or one with a
    // principal would arrive looking human, so it is not carried.
    if (!actor || (actor.kind && actor.kind !== "human") || actor.principal) return null;
    const actorId = actor.id;
    const key = configuration().projectToken;
    if (!actorId || !key) return null;
    const bytes = new TextEncoder().encode(actorId);
    if (bytes.length > ACTOR_ID_MAX_BYTES) return null;
    const memoKey = `${key}\n${correlationId}\n${actorId}`;
    let pending = tokenMemo.get(memoKey);
    if (!pending) {
      if (tokenMemo.size >= 1000) tokenMemo.clear();
      pending = actorTag(key, correlationId, actorId).then(
        (tag) => `a${toHex(bytes)}_${tag}`,
        (error) => {
          logger.debug(`actor stamp failed: ${describeError(error)}`);
          return null;
        },
      );
      tokenMemo.set(memoKey, pending);
    }
    return pending;
  } catch (error) {
    logger.debug(`actor stamp failed: ${describeError(error)}`);
    return null;
  }
}

const tokenMemo = new Map<string, Promise<string | null>>();

/**
 * `pendingActorToken` after the late Supabase actor fallback (as the
 * Upstash wrappers do), so a job enqueued before the request resolved
 * its user still carries it. Null (synchronously) when no actor can
 * appear: one is already set, or the fallback is off.
 */
export function signedActorToken(correlationId: string): Promise<string | null> | null {
  const now = pendingActorToken(correlationId);
  if (now || getCurrentActor() || !configuration().actorFromSupabase) return now;
  return maybeExtractSupabaseActor().then(
    () => pendingActorToken(correlationId),
    () => null,
  );
}

/** `pendingActorToken`, awaited. */
export async function actorToken(correlationId: string): Promise<string | null> {
  return (await pendingActorToken(correlationId)) ?? null;
}

/** The actor a verified token names, or null. Never throws. */
export async function readActorToken(
  token: unknown,
  correlationId: string,
): Promise<ActorContext | null> {
  try {
    const match = typeof token === "string" ? ACTOR_TOKEN.exec(token) : null;
    const key = configuration().projectToken;
    if (!match || !key || match[1]!.length % 2 !== 0) return null;
    const bytes = new Uint8Array(match[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
    const actorId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!actorId) return null;
    const expected = await actorTag(key, correlationId, actorId);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ match[2]!.charCodeAt(i);
    return diff === 0 ? { id: actorId } : null;
  } catch {
    return null;
  }
}

async function actorTag(key: string, correlationId: string, actorId: string): Promise<string> {
  const enc = new TextEncoder();
  const hmacKey = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign("HMAC", hmacKey, enc.encode(`${correlationId}\n${actorId}`));
  return toHex(new Uint8Array(mac).subarray(0, 8));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
