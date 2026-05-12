// Upstash Workflow / QStash jobs adapter.
//
// Upstash Workflow is HTTP-callback driven: each workflow step is a
// separate signed POST from QStash to a Next.js route. Without an
// adapter those step requests look like ordinary inbound HTTP. This
// adapter reclassifies them as background_job events and propagates
// correlation through the QStash header chain.
//
// Two surfaces:
//
// 1. wrapQStashClient(client):
//    Patches `client.publishJSON` (and `publish`) so each outbound
//    request seeds the current correlation id under `headers["upstash-
//    forward-x-correlation-id"]`. QStash forwards headers prefixed
//    with `Upstash-Forward-` to the destination, so our captured
//    handler sees `x-correlation-id` on the inbound request.
//
//    Use:
//      import { Client } from "@upstash/qstash"
//      import { wrapQStashClient } from "@ezlogs/nextjs/upstash-workflow"
//      const qstash = wrapQStashClient(new Client({ token }))
//
// 2. captureWorkflowRequest({ request, workflowName, ...}, work):
//    Worker-side wrapper called inside a Next.js route that's
//    serving an Upstash Workflow step. Reads correlation back from
//    the request headers (or generates a new id), scopes the work,
//    emits a background_job event with the runtime metadata Upstash
//    surfaces in headers (`Upstash-Workflow-Runid`,
//    `Upstash-Retried`, etc.).
//
//    Use:
//      import { serve } from "@upstash/workflow/nextjs"
//      import { captureWorkflowRequest } from "@ezlogs/nextjs/upstash-workflow"
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

// QStash forwards any header with this prefix to the destination URL.
const FORWARD_PREFIX = "upstash-forward-";

interface QStashClientLike {
  publishJSON?: (request: QStashPublishRequest) => Promise<unknown>;
  publish?: (request: QStashPublishRequest) => Promise<unknown>;
}

interface QStashPublishRequest {
  url?: string;
  topic?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const WRAPPED_FLAG = "__ezlogsUpstashQStashWrapped";

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

  if (typeof client.publishJSON === "function") {
    const original = client.publishJSON.bind(client);
    const wrapped: NonNullable<QStashClientLike["publishJSON"]> = (request) =>
      original(stampPublishRequest(request));
    (client as { publishJSON?: typeof wrapped }).publishJSON = wrapped;
  }

  if (typeof client.publish === "function") {
    const original = client.publish.bind(client);
    const wrapped: NonNullable<QStashClientLike["publish"]> = (request) =>
      original(stampPublishRequest(request));
    (client as { publish?: typeof wrapped }).publish = wrapped;
  }

  Object.defineProperty(client, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return client;
}

function stampPublishRequest(
  request: QStashPublishRequest,
): QStashPublishRequest {
  const id = currentCorrelation();
  if (!id) return request;

  const headerKey = `${FORWARD_PREFIX}x-correlation-id`;
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  // Caller-supplied id wins.
  const lower = Object.keys(headers).reduce<Record<string, string>>(
    (acc, key) => {
      acc[key.toLowerCase()] = key;
      return acc;
    },
    {},
  );
  if (lower[headerKey]) return request;
  headers[headerKey] = id;
  return { ...request, headers };
}

/**
 * Worker-side capture for a single Upstash Workflow step / QStash
 * delivery. Wraps your handler body so each invocation produces
 * one background_job event.
 *
 * Reads runtime metadata from Upstash's request headers:
 *   - Upstash-Workflow-Runid     -> job_id
 *   - Upstash-Retried            -> retry_count
 *   - the wrapped X-Correlation-ID (forwarded by QStash) -> correlation_id
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

  return runJobWithCapture(
    {
      jobClass: meta.workflowName,
      jobId: runId,
      queue: meta.stepName ?? meta.workflowName,
      retryCount: retried,
      correlationId,
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

function readHeader(headers: Headers, name: string): string | null {
  try {
    const value = headers.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readCorrelationFromHeaders(headers: Headers): string | null {
  // QStash forwards `Upstash-Forward-X-Correlation-ID` to the
  // destination, where it lands as either `x-correlation-id` (Upstash
  // strips the prefix) or — depending on configuration — the
  // prefixed name itself. We try both for safety.
  return (
    readHeader(headers, "x-correlation-id") ??
    readHeader(headers, "upstash-forward-x-correlation-id")
  );
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
