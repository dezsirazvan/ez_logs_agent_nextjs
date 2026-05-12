// Supabase Queues (pgmq) jobs adapter.
//
// Supabase Queues is pgmq exposed via two RPC calls on the
// `pgmq_public` schema: `send(queue_name, message)` to enqueue and
// `read(queue_name, sleep_seconds, n)` to pop. There's no built-in
// worker framework — users typically poll `read` from an Edge
// Function or background process. So this adapter has two public
// helpers:
//
//   - wrapSupabaseQueueClient(supabase): patches
//     `.schema('pgmq_public').rpc('send', ...)` so the current
//     correlation id is stamped into `message` before the row hits
//     pgmq's queue table.
//
//   - captureQueueMessage({ queueName, message, work }): the worker-
//     side wrapper. Pulls the correlation id back out of `message`,
//     scopes it for the duration of `work()`, emits a
//     background_job event when work resolves or rejects.
//
// Public API:
//
//   import { createClient } from "@supabase/supabase-js"
//   import {
//     wrapSupabaseQueueClient,
//     captureQueueMessage,
//   } from "ezlogs-nextjs/supabase-queues"
//
//   const supabase = wrapSupabaseQueueClient(createClient(url, key))
//   await supabase.schema("pgmq_public").rpc("send", {
//     queue_name: "emails",
//     message: { to: "alice@example.com" },
//   })
//
//   // worker side
//   const { data: rows } = await supabase
//     .schema("pgmq_public")
//     .rpc("read", { queue_name: "emails", sleep_seconds: 0, n: 10 })
//   for (const row of rows ?? []) {
//     await captureQueueMessage(
//       { queueName: "emails", message: row.message },
//       async () => {
//         await sendEmail(row.message)
//       },
//     )
//   }

import {
  extractCorrelationFromPayload,
  runJobWithCapture,
  stampCorrelationOnPayload,
} from "./shared.js";

interface SupabaseClientLike {
  schema?: (name: string) => SupabaseSchemaLike;
  rpc?: (fn: string, args?: unknown) => unknown;
}

interface SupabaseSchemaLike {
  rpc: (fn: string, args?: unknown) => unknown;
}

const WRAPPED_FLAG = "__ezlogsSupabaseQueuesWrapped";

/**
 * Returns the same client with `.schema('pgmq_public').rpc('send', ...)`
 * instrumented to stamp the current correlation id on the message
 * body. Idempotent.
 */
export function wrapSupabaseQueueClient<T extends SupabaseClientLike>(
  client: T,
): T {
  if ((client as unknown as Record<string, unknown>)[WRAPPED_FLAG]) return client;
  if (typeof client.schema !== "function") return client;

  const originalSchema = client.schema.bind(client);
  const wrappedSchema: NonNullable<SupabaseClientLike["schema"]> = (name) => {
    const schema = originalSchema(name);
    if (name === "pgmq_public") return wrapPgmqSchema(schema);
    return schema;
  };
  (client as { schema?: typeof wrappedSchema }).schema = wrappedSchema;

  Object.defineProperty(client, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return client;
}

function wrapPgmqSchema(schema: SupabaseSchemaLike): SupabaseSchemaLike {
  if (typeof schema.rpc !== "function") return schema;
  const originalRpc = schema.rpc.bind(schema);
  const wrappedRpc: SupabaseSchemaLike["rpc"] = (fn, args) => {
    if ((fn === "send" || fn === "send_batch") && isPlainObject(args)) {
      const stamped = stampPgmqMessage(args as Record<string, unknown>);
      return originalRpc(fn, stamped);
    }
    return originalRpc(fn, args);
  };
  schema.rpc = wrappedRpc;
  return schema;
}

function stampPgmqMessage(
  args: Record<string, unknown>,
): Record<string, unknown> {
  // pgmq.send takes { queue_name, message, sleep_seconds? }
  // pgmq.send_batch takes { queue_name, messages, sleep_seconds? }
  if ("message" in args && isPlainObject(args.message)) {
    stampCorrelationOnPayload(args.message as Record<string, unknown>);
  } else if (Array.isArray(args.messages)) {
    for (const msg of args.messages) {
      if (isPlainObject(msg)) {
        stampCorrelationOnPayload(msg as Record<string, unknown>);
      }
    }
  }
  return args;
}

/**
 * Worker-side wrapper. Call this inside your Edge Function / poller
 * for each message you process. It:
 *   1. Reads the correlation id from `message[CORRELATION_PAYLOAD_KEY]`.
 *   2. Runs your `work()` inside that correlation scope.
 *   3. Emits a background_job event on resolve/reject.
 *   4. Re-throws on failure so your retry/ack logic still works.
 */
export async function captureQueueMessage<T>(
  meta: {
    queueName: string;
    message: unknown;
    /** pgmq message id for the row (becomes job_id). Optional. */
    messageId?: string | number | bigint | null;
    /** Number of times this message has been read+attempted. */
    readCount?: number | null;
  },
  work: () => Promise<T>,
): Promise<T> {
  const correlationId = extractCorrelationFromPayload(meta.message);
  return runJobWithCapture(
    {
      jobClass: meta.queueName,
      jobId: meta.messageId !== undefined && meta.messageId !== null
        ? String(meta.messageId)
        : null,
      queue: meta.queueName,
      retryCount: meta.readCount ?? null,
      correlationId,
    },
    work,
  );
}

/**
 * Imperatively stamp the correlation id onto a pgmq message body
 * before passing it to a non-wrapped client. Available for users
 * who want explicit control.
 */
export function stampPgmqPayload(message: unknown): unknown {
  if (!isPlainObject(message)) return message;
  stampCorrelationOnPayload(message as Record<string, unknown>);
  return message;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  return true;
}
