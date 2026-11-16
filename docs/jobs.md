# Background job adapters

Five runners. Pick the one(s) your app uses. All emit the same
`background_job` event shape with `job_class`, `job_id`, `queue`,
`retry_count` and the job's sanitized `arguments` (same redaction as
request params: `password`, `token`, … become `"[FILTERED]"`).

DB writes made by the job body run inside the job's correlation, so
with the trigger path they appear in the same action as the request
that enqueued the job (BullMQ, Trigger.dev, Supabase Queues, Upstash
Workflow; Inngest via `runInsideInngestCorrelation`).

| Runner | Import |
|---|---|
| BullMQ | `ezlogs-nextjs/bullmq` |
| Inngest | `ezlogs-nextjs/inngest` |
| Trigger.dev | `ezlogs-nextjs/trigger` |
| Supabase Queues (pgmq) | `ezlogs-nextjs/supabase-queues` |
| Upstash Workflow / QStash | `ezlogs-nextjs/upstash-workflow` |

All adapters lazy-import their host package; apps that don't use a
given runner pay zero at runtime.

## BullMQ

```ts
import { Queue, Worker } from "bullmq";
import { wrapBullQueue, wrapBullWorker } from "ezlogs-nextjs/bullmq";

export const queue = wrapBullQueue(new Queue("emails"));
export const worker = wrapBullWorker(new Worker("emails", processor));
```

`wrapBullQueue` stamps the current correlation into every job payload
at enqueue (pass `data` as a plain object). `wrapBullWorker` wraps the
Worker's processor so the job body runs inside that correlation, emits
one event per run, and sends the DB writes the job made. Call it right
after `new Worker(...)`. Sandboxed processors (a file path instead of a
function) run in a child process: the job event is captured, their DB
writes are not linked to it. BullMQ's own control flow (`DelayedError`,
`WaitingChildrenError`, rate limiting) is not reported as a failure.
Verified on BullMQ 5.76 and 6.7 (with BullMQ 6, install `ioredis` or
pass a client). If a future BullMQ changes the Worker internals the
wrapper relies on, it falls back to job events only (no linked DB
writes) and logs that once at debug level.

## Inngest

```ts
import { Inngest } from "inngest";
import { ezlogsInngestMiddleware } from "ezlogs-nextjs/inngest";

export const inngest = new Inngest({
  id: "my-app",
  middleware: [ezlogsInngestMiddleware()],
});
```

Inngest middleware can't wrap the function body, so to link the body's
DB writes to the action that sent the event, wrap it:

```ts
import { runInsideInngestCorrelation } from "ezlogs-nextjs/inngest";

inngest.createFunction({ id: "send-invoice" }, { event: "invoice/created" },
  ({ event }) => runInsideInngestCorrelation(event, async () => {
    /* ... */
  }),
);
```

## Trigger.dev

```ts
// trigger/init.ts — call once at task-runtime startup
import { tasks } from "@trigger.dev/sdk/v3";
import { registerTriggerHooks } from "ezlogs-nextjs/trigger";

registerTriggerHooks(tasks);
```

## Supabase Queues (pgmq)

```ts
import { createClient } from "@supabase/supabase-js";
import {
  wrapSupabaseQueueClient,
  captureQueueMessage,
} from "ezlogs-nextjs/supabase-queues";

const supabase = wrapSupabaseQueueClient(createClient(url, key));

// Enqueue: correlation stamped automatically
await supabase.schema("pgmq_public").rpc("send", {
  queue_name: "emails",
  message: { to: "alice@example.com" },
});

// Worker: wrap each message
await captureQueueMessage(
  { queueName: "emails", messageId: row.msg_id, message: row.message },
  async () => {
    /* ... process the message ... */
  },
);
```

## Upstash Workflow / QStash

```ts
import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { serve } from "@upstash/workflow/nextjs";
import {
  wrapQStashClient,
  wrapWorkflowClient,
  captureWorkflowRequest,
} from "ezlogs-nextjs/upstash-workflow";

// Starting runs with `workflows.trigger({ url, body })`:
export const workflows = wrapWorkflowClient(
  new WorkflowClient({ token: process.env.QSTASH_TOKEN! }),
);
// Publishing with QStash directly:
export const qstash = wrapQStashClient(
  new QStashClient({ token: process.env.QSTASH_TOKEN! }),
);

export const { POST } = serve(async (context) => {
  await captureWorkflowRequest(
    { request: context.request, workflowName: "send-welcome" },
    async () => {
      await context.run("send-email", async () => {
        /* ... */
      });
    },
  );
});
```

The wrapped clients send the current correlation id with the run, so
each step's job event and DB writes join the action of the request
that started the workflow, instead of one separate action per step.
`wrapWorkflowClient` puts it in a header (first delivery) and in the
run id (`wfr_<correlation id>_<24 hex>`), because the SDK sends later
step deliveries without your trigger headers while the run id comes
with every delivery. If you pass your own `workflowRunId`, it is kept
and only the first delivery joins the request. Wrap the client you actually
call (`trigger()` vs `publish()`); unwrapped runs still show up, each
step as its own action.
