// Upstash Workflow / QStash jobs adapter.
//
// Upstash Workflow is HTTP-callback driven: each workflow step is a
// separate signed POST from QStash to a Next.js route. Without an
// adapter those step requests look like ordinary inbound HTTP. This
// adapter reclassifies them as background_job events and propagates
// correlation through the QStash header chain.
//
// Three surfaces:
//
// 1. wrapQStashClient(client):
//    Patches `client.publishJSON` (and `publish`) so each outbound
//    request seeds the current correlation id under `headers["upstash-
//    forward-x-ezlogs-correlation-id"]`. QStash forwards headers
//    prefixed with `Upstash-Forward-` to the destination, so our
//    captured handler sees `x-ezlogs-correlation-id` on the inbound
//    request.
//
//    Use:
//      import { Client } from "@upstash/qstash"
//      import { wrapQStashClient } from "ezlogs-nextjs/upstash-workflow"
//      const qstash = wrapQStashClient(new Client({ token }))
//
// 2. wrapWorkflowClient(client):
//    Patches `@upstash/workflow`'s `Client.trigger()` so the workflow
//    run carries the current correlation id, so each step joins the
//    action of the request that started the run (instead of one
//    URL-titled action per step). Two carriers:
//      - a user header, which reaches the first delivery only: the SDK
//        (1.3.x) publishes later steps, context.call results and
//        parallel steps without the trigger's user headers;
//      - the run id (`wfr_<correlation id>_<24 hex>`), which Upstash
//        sends as `Upstash-Workflow-RunId` on every delivery. Only
//        when the caller didn't pick a `workflowRunId`.
//
//    Use:
//      import { Client } from "@upstash/workflow"
//      import { wrapWorkflowClient } from "ezlogs-nextjs/upstash-workflow"
//      const workflows = wrapWorkflowClient(new Client({ token }))
//
// 3. captureWorkflowRequest({ request, workflowName, ...}, work):
//    Worker-side wrapper called inside a Next.js route that's
//    serving an Upstash Workflow step. Reads correlation back from
//    the request headers (or generates a new id), scopes the work,
//    emits a background_job event with the runtime metadata Upstash
//    surfaces in headers (`Upstash-Workflow-Runid`,
//    `Upstash-Retried`, etc.).
//
//    Use:
//      import { serve } from "@upstash/workflow/nextjs"
//      import { captureWorkflowRequest } from "ezlogs-nextjs/upstash-workflow"
//
//      export const { POST } = serve(async (context) => {
//        await captureWorkflowRequest(
//          { request: context.request, workflowName: "send-welcome" },
//          async () => {
//            await context.run("send-email", async () => {/* ... */})
//          },
//        )
//      })

import { logger } from "../logger.js";
import {
  emitJobEvent,
  runJobWithCapture,
} from "./shared.js";
import { current as currentCorrelation } from "../correlation.js";
import { configuration } from "../configuration.js";
import {
  getCurrentActor,
  maybeExtractSupabaseActor,
  type ActorContext,
} from "../actor.js";

// QStash forwards any header with this prefix to the destination URL.
const FORWARD_PREFIX = "upstash-forward-";
// The header every agent entry point (captureRoute, captureServerAction,
// middleware) reads the inbound correlation id from.
const CORRELATION_HEADER = "x-ezlogs-correlation-id";
// Pre-0.3.0 QStash stamping used this one; still read for queued messages.
const LEGACY_CORRELATION_HEADER = "x-correlation-id";
// Agent id format, at most 24 hours old (other inbound ids: 1 hour). A
// workflow step can run hours after the run started (sleeps, retries);
// `captureWorkflowRequest` runs inside `serve()`, which has already
// verified the QStash signature, so the longer window only applies to
// signed step deliveries.
const AGENT_CORRELATION_ID = /^ezl_(\d{13})_[0-9a-f]{8}$/;
// Run ids minted by wrapWorkflowClient: `wfr_` (added by the SDK) +
// correlation id + a 96-bit random suffix. Upstash treats a reused run
// id as a duplicate and silently starts no run, so one request fanning
// out many runs needs a collision-free suffix. (No length / charset
// limit in the SDK 1.3.3 source or the docs; the default id is a
// 21-char nanoid, this one is 55 chars of [a-z0-9_].)
// Optionally followed by `_<actor token>` (see actorToken).
const AGENT_RUN_ID = /^wfr_(ezl_\d{13}_[0-9a-f]{8})_[0-9a-f]{24}(?:_(a[0-9a-f]{2,128}_[0-9a-f]{16}))?$/;
// Header carrying the actor token next to the correlation id.
const ACTOR_HEADER = "x-ezlogs-actor";
// `a<hex of the actor id>_<HMAC tag>`. The tag (HMAC-SHA256 keyed with
// the project token over correlation id + actor id, 64 bits) means a
// forged delivery can't name an actor. Hex keeps the run id in
// [a-z0-9_] like the rest of it.
const ACTOR_TOKEN = /^a([0-9a-f]{2,128})_([0-9a-f]{16})$/;
// Longer actor ids are not carried (the run id would get long); their
// post-response writes keep an empty actor, as before.
const ACTOR_ID_MAX_BYTES = 64;
const RUN_ID_SUFFIX_BYTES = 12;
const STEP_ID_MAX_AGE_MS = 24 * 60 * 60_000;
const STEP_ID_MAX_SKEW_MS = 5 * 60_000;

function isAcceptableStepId(value: string): boolean {
  const match = AGENT_CORRELATION_ID.exec(value);
  if (!match) return false;
  const age = Date.now() - Number(match[1]);
  return age <= STEP_ID_MAX_AGE_MS && age >= -STEP_ID_MAX_SKEW_MS;
}

// Loose on purpose: @upstash/qstash's generic `publishJSON<TBody,
// TRequest>` is not assignable to any concrete signature, and the
// wrapper returns the caller's own client type.
interface QStashClientLike {
  // eslint-disable-next-line @typescript-eslint/ban-types
  publishJSON?: Function;
  // eslint-disable-next-line @typescript-eslint/ban-types
  publish?: Function;
}

interface QStashPublishRequest {
  headers?: unknown;
  [key: string]: unknown;
}

const WRAPPED_FLAG = "__ezlogsUpstashQStashWrapped";
const WORKFLOW_WRAPPED_FLAG = "__ezlogsUpstashWorkflowWrapped";

interface WorkflowClientLike {
  // eslint-disable-next-line @typescript-eslint/ban-types
  trigger?: Function;
}

interface WorkflowTriggerOptions {
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Patches `trigger` on the user's `@upstash/workflow` Client so each
 * started run (single or batch) carries the current correlation id to
 * every step. A caller-supplied `x-ezlogs-correlation-id` header wins.
 * No-op outside a captured request. Idempotent.
 */
export function wrapWorkflowClient<T extends WorkflowClientLike>(client: T): T {
  if ((client as unknown as Record<string, unknown>)[WORKFLOW_WRAPPED_FLAG]) return client;
  if (typeof client.trigger === "function") {
    const original = client.trigger.bind(client) as (params: unknown) => unknown;
    (client as { trigger?: unknown }).trigger = async (params: unknown) => {
      // Once per call, not per run of a batch (it may call Supabase auth).
      if (currentCorrelation()) await maybeExtractSupabaseActor();
      return original(
        Array.isArray(params)
          ? await Promise.all(params.map(stampTriggerOptions))
          : await stampTriggerOptions(params),
      );
    };
  }
  Object.defineProperty(client, WORKFLOW_WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return client;
}

async function stampTriggerOptions(options: unknown): Promise<unknown> {
  const current = currentCorrelation();
  if (!current || !options || typeof options !== "object") return options;
  const opts = options as WorkflowTriggerOptions;
  const headers = { ...(opts.headers ?? {}) };
  const supplied = Object.keys(headers).find((k) => k.toLowerCase() === CORRELATION_HEADER);
  const id = supplied ? headers[supplied]! : current;
  if (!supplied) headers[CORRELATION_HEADER] = id;
  const token = AGENT_CORRELATION_ID.test(id) ? await actorToken(id) : null;
  if (token && !Object.keys(headers).some((k) => k.toLowerCase() === ACTOR_HEADER)) {
    headers[ACTOR_HEADER] = token;
  }
  const stamped: WorkflowTriggerOptions = { ...opts, headers };
  // The run id is the only value Upstash repeats on every delivery.
  // Only the agent's own id format goes in (the worker side accepts
  // nothing else); a caller-chosen run id is kept.
  if (opts.workflowRunId == null && AGENT_CORRELATION_ID.test(id)) {
    stamped.workflowRunId = `${id}_${randomHex(RUN_ID_SUFFIX_BYTES)}${token ? `_${token}` : ""}`;
  }
  return stamped;
}

/**
 * Patches `publishJSON` and `publish` on the user's QStash client so
 * outbound requests carry the current correlation id forward to the
 * destination handler.
 *
 * Idempotent. Safe to call from a top-level module that may be
 * re-imported during dev hot reload.
 */
export function wrapQStashClient<T extends QStashClientLike>(client: T): T {
  if ((client as unknown as Record<string, unknown>)[WRAPPED_FLAG]) return client;

  for (const method of ["publishJSON", "publish"] as const) {
    if (typeof client[method] !== "function") continue;
    const original = client[method]!.bind(client) as (request: unknown) => Promise<unknown>;
    (client as QStashClientLike)[method] = async (request: QStashPublishRequest) =>
      original(await stampPublishRequest(request));
  }

  Object.defineProperty(client, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return client;
}

async function stampPublishRequest(
  request: QStashPublishRequest,
): Promise<QStashPublishRequest> {
  const id = currentCorrelation();
  if (!id || !request || typeof request !== "object") return request;

  const headerKey = `${FORWARD_PREFIX}${CORRELATION_HEADER}`;
  const raw = request.headers;
  // A Headers instance or [name, value][] spreads to {}: copy its entries.
  const headers: Record<string, string> =
    raw instanceof Headers || Array.isArray(raw)
      ? Object.fromEntries(new Headers(raw as [string, string][]))
      : { ...((raw as Record<string, string> | undefined) ?? {}) };
  // Caller-supplied id wins.
  if (Object.keys(headers).some((key) => key.toLowerCase() === headerKey)) return request;
  headers[headerKey] = id;
  await maybeExtractSupabaseActor();
  const token = await actorToken(id);
  if (token) headers[`${FORWARD_PREFIX}${ACTOR_HEADER}`] = token;
  return { ...request, headers };
}

/**
 * The current actor's id as a signed token for post-response work
 * (workflow steps, QStash deliveries), bound to `correlationId`.
 * Callers first run the late Supabase actor fallback, so a run started
 * before the request's end still gets the actor the request resolves.
 * Null when there is no actor, the actor is not a plain human (kind or
 * principal can't travel), no project token, or the id is too long.
 * Never throws.
 */
async function actorToken(correlationId: string): Promise<string | null> {
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
    return `a${toHex(bytes)}_${await actorTag(key, correlationId, actorId)}`;
  } catch (error) {
    logger.debug(`upstash actor stamp failed: ${describeError(error)}`);
    return null;
  }
}

/** The actor a verified token names, or null. Never throws. */
async function readActorToken(
  token: string | null | undefined,
  correlationId: string,
): Promise<ActorContext | null> {
  try {
    const match = token ? ACTOR_TOKEN.exec(token) : null;
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

/**
 * Worker-side capture for a single Upstash Workflow step / QStash
 * delivery. Wraps your handler body so each invocation produces
 * one background_job event.
 *
 * Reads runtime metadata from Upstash's request headers:
 *   - Upstash-Workflow-Runid     -> job_id
 *   - Upstash-Retried            -> retry_count
 *   - x-ezlogs-correlation-id (stamped by wrapWorkflowClient /
 *     wrapQStashClient, agent id format only), else the correlation
 *     id inside a run id minted by wrapWorkflowClient -> correlation_id
 *
 * DB writes inside `work` are tagged with that correlation id and
 * emitted when it finishes, so they join the same action.
 *
 * Returns the result of `work()`. Re-throws on failure so the user's
 * Workflow retry / failure-routing semantics still work.
 */
export async function captureWorkflowRequest<T>(
  meta: {
    request: Request | { headers: Headers };
    workflowName: string;
    /** Optional explicit step name; defaults to workflowName. */
    stepName?: string;
  },
  work: () => Promise<T>,
): Promise<T> {
  const headers = meta.request.headers;
  const correlationId = readCorrelationFromHeaders(headers);
  const runId = readHeader(headers, "upstash-workflow-runid");
  const retried = parseRetried(readHeader(headers, "upstash-retried"));
  // The actor that started the run, when its token verifies against
  // this correlation id. Otherwise the step's writes have no actor.
  const actor = correlationId
    ? ((await readActorToken(
        readHeader(headers, ACTOR_HEADER) ?? readHeader(headers, `${FORWARD_PREFIX}${ACTOR_HEADER}`),
        correlationId,
      )) ??
      (await readActorToken(runId ? AGENT_RUN_ID.exec(runId)?.[2] : null, correlationId)))
    : null;

  return runJobWithCapture(
    {
      jobClass: meta.workflowName,
      jobId: runId,
      queue: meta.stepName ?? meta.workflowName,
      retryCount: retried,
      correlationId,
      actor,
    },
    work,
  );
}

/**
 * Standalone capture entry — for users who already have a finished
 * request/response pair and just want an event recorded (e.g.
 * end-of-handler in a custom serve() wrapper).
 */
export function emitUpstashWorkflowEvent(input: {
  workflowName: string;
  request: Request | { headers: Headers };
  outcome: "success" | "failure";
  errorMessage?: string | null;
  durationMs?: number | null;
  startedAt?: Date;
}): void {
  try {
    const headers = input.request.headers;
    emitJobEvent({
      jobClass: input.workflowName,
      jobId: readHeader(headers, "upstash-workflow-runid"),
      queue: input.workflowName,
      retryCount: parseRetried(readHeader(headers, "upstash-retried")),
      correlationId: readCorrelationFromHeaders(headers),
      outcome: input.outcome,
      errorMessage: input.errorMessage ?? null,
      durationMs: input.durationMs ?? null,
      startedAt: input.startedAt ?? new Date(),
    });
  } catch (error) {
    logger.debug(`upstash workflow capture failed: ${describeError(error)}`);
  }
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return toHex(buf);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readHeader(headers: Headers, name: string): string | null {
  try {
    const value = headers.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readCorrelationFromHeaders(headers: Headers): string | null {
  // QStash strips the `Upstash-Forward-` prefix on delivery; the
  // prefixed names are read too for safety. Only the agent's own id
  // format is honored (anything else would let a caller pick which
  // action its writes join).
  for (const name of [CORRELATION_HEADER, LEGACY_CORRELATION_HEADER]) {
    const value =
      readHeader(headers, name) ?? readHeader(headers, `${FORWARD_PREFIX}${name}`);
    if (value && isAcceptableStepId(value)) return value;
  }
  // Later step deliveries carry no user headers; a run started by
  // wrapWorkflowClient has the correlation id in its run id.
  const runId = readHeader(headers, "upstash-workflow-runid");
  const fromRunId = runId ? AGENT_RUN_ID.exec(runId)?.[1] : undefined;
  return fromRunId && isAcceptableStepId(fromRunId) ? fromRunId : null;
}

function parseRetried(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
