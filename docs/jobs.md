# Background job adapters

Five runners. Pick the one(s) your app uses. All emit the same
`background_job` event shape with `job_class`, `job_id`, `queue`, and
`retry_count`.

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
at enqueue. `wrapBullWorker` restores it inside the worker so DB
events emitted while processing inherit the correlation.

## Inngest

```ts
import { Inngest } from "inngest";
import { ezlogsInngestMiddleware } from "ezlogs-nextjs/inngest";

export const inngest = new Inngest({
  id: "my-app",
  middleware: [ezlogsInngestMiddleware()],
});
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
import { Client } from "@upstash/qstash";
import { serve } from "@upstash/workflow/nextjs";
import {
  wrapQStashClient,
  captureWorkflowRequest,
} from "ezlogs-nextjs/upstash-workflow";

export const qstash = wrapQStashClient(
  new Client({ token: process.env.QSTASH_TOKEN! }),
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

QStash-signed inbound requests would otherwise look like ordinary
inbound HTTP. The adapter detects the `Upstash-Signature` header and
re-tags them as `background_job` so they don't pollute the HTTP-event
stream.
