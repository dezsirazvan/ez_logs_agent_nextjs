# ezlogs-nextjs

**Drop-in activity logging for Next.js.** Captures HTTP requests, database changes, Server Actions, and background jobs. Ships them to the EZLogs server as plain-English Action cards your whole team can read.

App Router, Pages Router, Server Actions (file-level and inline), Edge runtime — all supported.

---

## The Problem

When someone clicks "Reset Password" in your app, a cascade of events unfolds:

- HTTP requests hit your server
- Database rows get updated
- Background jobs are queued
- Emails are sent
- Sessions are invalidated

Today, understanding what happened requires opening four tools, piecing together timestamps, and asking an engineer to translate stack traces into plain English.

**EZLogs solves this.** Instead of scattered technical logs, you see:

```
Password Reset — jessica@example.com
2:23 PM, January 15, 2026

  ✓ Reset link created (expires in 1 hour)
  ✓ Email sent to jessica@example.com
  ✓ All active sessions logged out (2 devices)

Status: Completed successfully
```

Your support team, PM, and CEO can read that without an engineer.

---

## What EZLogs Is (and Is NOT)

**EZLogs is:**

- An application-level activity log
- A bridge between technical events and business understanding
- Best-effort and non-blocking — never impacts your app's performance
- Safe in production — fails gracefully if anything goes wrong

**EZLogs is NOT:**

- A monitoring tool — use Datadog, New Relic, or Vercel Analytics
- A metrics platform — use your APM for request rates, p99s, etc.
- An audit log — use compliance-grade tooling (PaperTrail-style) for legal requirements
- A guaranteed delivery system — events may be dropped if the server is unreachable (intentional)
- A replacement for debuggers — use Sentry, Bugsnag, or your IDE for code-level debugging

---

## Install

```bash
pnpm add ezlogs-nextjs
# or
npm install ezlogs-nextjs
# or
bun add ezlogs-nextjs
```

**Requirements:**

- Node 18.17+
- Next.js 14+ (App Router and Pages Router both supported)

---

## Quick Start

Five steps, ~5 minutes. After Step 5 you'll see HTTP requests, Server Actions, and background jobs flowing into the dashboard. Database `from → to` diffs are an opt-in upgrade documented in [What Gets Captured → Database Changes](#3-database-changes).

### 1. Get your API key

Sign in to your EZLogs dashboard → **Settings → API Keys → Create API key**. Copy the `ezl_...` token.

### 2. Wire up `instrumentation.ts`

Create `instrumentation.ts` at your project root (or `src/instrumentation.ts` if you use the `src/` layout):

```ts
import { ezlogs } from "ezlogs-nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    ezlogs.init({
      serverUrl: process.env.EZLOGS_SERVER_URL!,
      projectToken: process.env.EZLOGS_PROJECT_TOKEN!,
    });
  }
}
```

### 3. Add the build plugin to your Next config

`withEzlogsConfig(...)` is a wrapper around your existing Next.js config object. You don't add any EZLogs-specific *settings* to your Next config — every EZLogs option goes in `ezlogs.init({...})` from Step 2. The wrapper's only job is to register the build-time loaders that auto-wrap your routes and Server Actions.

If you already have a `next.config.*` file, keep everything that's there. The placeholder comment below is where your existing options stay; if you don't have any, leave the object empty. Pick the snippet that matches the file extension you already use:

**`next.config.ts` (TypeScript — Next 14+ default scaffold):**

```ts
import type { NextConfig } from "next";
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

const nextConfig: NextConfig = {
  // ⬇ Anything you had before (or leave empty {} if this is a fresh project).
  // Examples: experimental: { ppr: true }, images: { domains: [...] }, etc.
};

export default withEzlogsConfig(
  nextConfig as unknown as Parameters<typeof withEzlogsConfig>[0],
) as NextConfig;
```

The cast is harmless: `withEzlogsConfig` declares a stricter `NextConfig` shape than Next.js exports. Both are runtime-compatible.

<details>
<summary><strong>Using <code>next.config.mjs</code> or <code>next.config.js</code> instead?</strong></summary>

**`next.config.mjs` (ESM):**

```js
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ⬇ Anything you had before (or leave empty {} if this is a fresh project).
};

export default withEzlogsConfig(nextConfig);
```

**`next.config.js` (CommonJS):**

```js
const { withEzlogsConfig } = require("ezlogs-nextjs/plugin");

module.exports = withEzlogsConfig({
  // ⬇ Anything you had before (or leave empty {} if this is a fresh project).
});
```

</details>

This is what makes capture **zero-touch.** The plugin auto-wraps:

- App Router route handlers (`app/**/route.{ts,tsx,js,jsx}`)
- Pages Router API routes (`pages/api/**/*.{ts,tsx,js,jsx}`)
- File-level Server Actions (`actions.ts`, `app/**/actions.{ts,tsx}`, `actions/**/*`)
- **Inline `"use server"` actions** declared inside RSC components (page/layout/etc.)
- NextAuth-style local-aliased re-export routes (`export { handler as GET, POST }`)
- Your root `middleware.ts` (for correlation seeding)

No per-route opt-in. No source file edits.

### 4. Set environment variables

```bash
# .env.local (or your platform's secret manager)
EZLOGS_PROJECT_TOKEN=ezl_your_api_key_here
# EZLOGS_SERVER_URL defaults to https://app.ezlogs.io — set only if self-hosting.
```

### 5. Restart and verify

Restart your dev server. Hit any route. Within seconds, the activity appears in your EZLogs dashboard.

You'll also see startup logs in the terminal:

```
[ezlogs] FlushScheduler started (interval 3000ms)
```

---

## What Gets Captured

Four event sources. All four carry a shared `correlation_id` when they happen inside the same inbound request, so the EZLogs server stitches them into a single Action card.

### 1. HTTP Requests

Every Route Handler call, with intelligent noise filtering.

**What's captured:**

- Method, path, status code, duration
- GraphQL operation name + type (queries, mutations, subscriptions)
- Request parameters (sanitized automatically)
- Correlation ID

**Automatic exclusions (no config needed):**

- `/_next/*`, `/_vercel/*`, `/__nextjs_*` — bundler / platform internals
- `GET /api/auth/*` — NextAuth session-refresh polls (POSTs are captured)
- `/health*`, `/api/health`, `/up`, `/alive`, `/ready`, `/metrics`
- `/favicon.ico`, `/.well-known*`, `/robots.txt`, `/sitemap.xml`
- `*/login*`, `*/logout*`, `*/sign-in*`, `*/sign-out*`, `*/session*`
- Static assets (`.js`, `.css`, `.png`, …)

### 2. Server Actions

Both file-level and inline declarations. **Auto-wrapped at build time** by the loader — no manual `captureServerAction` calls required.

**File-level** (file starts with `"use server"`):

```ts
// app/actions.ts
"use server";

export async function updateProfile(formData: FormData) {
  await db.users.update(/* ... */);
}
```

**Inline** (declared inside an RSC component):

```tsx
// app/posts/[id]/page.tsx
export default async function Post({ params }) {
  const { id } = await params;

  async function deletePost() {
    "use server";
    await db.posts.delete({ where: { id } });
    redirect("/posts");
  }

  return <form action={deletePost}>{/* ... */}</form>;
}
```

Both produce the same `Server Action` event with actor, correlation, and `redirect()` / `notFound()` handled as success.

If you need manual control (e.g., aliased imports, non-standard file layouts):

```ts
import { captureServerAction } from "ezlogs-nextjs";

export const updateProfile = captureServerAction(
  async (formData: FormData) => {
    /* ... */
  },
  "updateProfile",
);
```

### 3. Database Changes

Two paths. Pick the one that fits your stack. Both emit the same `database_callback` event.

**Recommended: row triggers (Postgres).** If your app talks to Postgres directly (Prisma with `@prisma/adapter-pg`, Drizzle node-postgres, raw `pg`), this gives you **real from→to diffs** without per-mutation boilerplate.

```bash
# One-time install (per database). Reads DATABASE_URL from env.
npx ezlogs-nextjs install-triggers
```

That single command introspects your schema and tracks every business table automatically. Migration tables (`_prisma_migrations`, `schema_migrations`), session tables (`Session`, `sessions`), and the agent's own audit table are skipped — you'll see exactly what's tracked in the output. Pass `--tables=<a,b,c>` for an explicit list, `--tables=none` to install infrastructure only, or `--print` to dump the SQL without applying.

Wire it up in `instrumentation.ts`:

```ts
import { ezlogs } from "ezlogs-nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const pg = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  ezlogs.init({
    serverUrl: process.env.EZLOGS_SERVER_URL!,
    projectToken: process.env.EZLOGS_PROJECT_TOKEN!,
    databaseReader: (sql, params) => pool.query(sql, params),
    patchDatabaseClient: pg, // auto-injects SET LOCAL on every query
  });
}
```

Your existing `prisma.post.create(...)` / `db.update(users)...` / `pool.query("INSERT ...")` calls now produce full-fidelity events with actor + correlation + diffs.

**Fallback: per-ORM adapters.** When the trigger path isn't viable (PlanetScale, supabase-js, customers who can't run the migration), adapters keep working with reduced fidelity (writes captured, but Drizzle gives no pre-state, Prisma's `$extends` gives only `to`, and supabase-js multi-`.eq()` filters drop `from`):

- **Prisma** — `import { ezlogsPrisma } from "ezlogs-nextjs/prisma"`
- **Drizzle** — `import { ezlogsDrizzleLogger } from "ezlogs-nextjs/drizzle"`
- **Supabase** — `import { wrapSupabase } from "ezlogs-nextjs/supabase"`

### 4. Background Jobs

Five runners. Pick the one(s) you use. All emit the same `background_job` event.

| Runner | Import |
|---|---|
| BullMQ | `ezlogs-nextjs/bullmq` |
| Inngest | `ezlogs-nextjs/inngest` |
| Trigger.dev | `ezlogs-nextjs/trigger` |
| Supabase Queues (pgmq) | `ezlogs-nextjs/supabase-queues` |
| Upstash Workflow / QStash | `ezlogs-nextjs/upstash-workflow` |

Example (BullMQ):

```ts
import { Queue, Worker } from "bullmq";
import { wrapBullQueue, wrapBullWorker } from "ezlogs-nextjs/bullmq";

export const queue = wrapBullQueue(new Queue("emails"));
export const worker = wrapBullWorker(new Worker("emails", processor));
```

See the [adapter sections below](#background-job-adapters) for the full surface.

---

## Auth (Actor Extraction)

EZLogs tracks **who** triggered each action. Built-in extractors for the four most common Next.js auth providers, lazy-imported so apps that don't use a given provider pay nothing at runtime.

### Clerk

```ts
import { clerkActor } from "ezlogs-nextjs/actors";

ezlogs.init({
  // ...
  actorFromRequest: clerkActor(),
});
```

### NextAuth.js (v4)

```ts
import { nextAuthActor } from "ezlogs-nextjs/actors";
import { authOptions } from "@/lib/auth";

ezlogs.init({
  // ...
  actorFromRequest: nextAuthActor({ authOptions }),
});
```

### Auth.js (v5)

```ts
import { authJsActor } from "ezlogs-nextjs/actors";
import { auth } from "@/auth";

ezlogs.init({
  // ...
  actorFromRequest: authJsActor({ auth }),
});
```

### Supabase Auth

No opt-in needed. The agent resolves the current user via `auth.getUser()` automatically once any Supabase client is wrapped.

### Custom / Composing

```ts
actorFromRequest: async (request) => {
  // Try multiple providers, return first match
  return (
    (await clerkActor()(request)) ??
    (await nextAuthActor({ authOptions })(request))
  );
}
```

The hook returns `{ id: string, label?: string }` or `null`. **Missing data is acceptable; wrong data is not** — the agent never guesses.

---

## Configuration Reference

All options have sensible defaults. **Only `serverUrl` and `projectToken` are required.**

### Minimal

```ts
ezlogs.init({
  projectToken: "ezl_your_api_key_here",
  // serverUrl defaults to "https://app.ezlogs.io" — set only when self-hosting.
});
```

### Full surface

```ts
ezlogs.init({
  // ==========================================
  // Required
  // ==========================================
  projectToken: "ezl_your_api_key_here",

  // ==========================================
  // Optional — defaults to the hosted EZLogs service
  // ==========================================
  serverUrl: "https://app.ezlogs.io",

  // ==========================================
  // Event capture toggles (all default true)
  // ==========================================
  captureHttp: true,
  captureDb: true,
  captureJobs: true,

  // ==========================================
  // Pipeline tuning (defaults match the Ruby agent)
  // ==========================================
  bufferSize: 10_000,          // events held in memory (drop-oldest when full)
  sendInterval: 3_000,         // ms between automatic flushes
  retryAttempts: 3,            // exponential backoff: 0.5s → 1s → 2s → 4s (capped at 5s), with ±20% jitter

  // ==========================================
  // Exclusion lists (MERGED with built-in defaults)
  // ==========================================
  excludedPaths: ["/admin/preview*", "/internal/*"],
  excludedTables: ["audit_logs", "versions"],
  excludedJobClasses: ["app/internal/heartbeat"],
  excludedGraphqlOperations: ["IntrospectionQuery"],
  excludedGraphqlVariableKeys: ["password", "creditCard"],

  // ==========================================
  // Actor (who triggered the event)
  // ==========================================
  actorFromRequest: clerkActor(), // or custom (request) => {...}

  // ==========================================
  // Display names (human-readable resource labels)
  // ==========================================
  displayNameFor: {
    User: "email",     // "User created 'jessica@example.com'"
    Order: "number",   // "Order updated '#ORD-1234'"
    Product: "name",   // "Product deleted 'Premium Plan'"
  },

  // ==========================================
  // Database triggers (Postgres only, recommended)
  // ==========================================
  databaseReader: (sql, params) => pool.query(sql, params),
  patchDatabaseClient: pg,  // require('pg') module

  // ==========================================
  // Server Action failure classification
  // ==========================================
  isServerActionError: (result) => {
    // Built-ins handle next-safe-action, zsa, Conform, Zod safeParse,
    // and `{success: false}` shapes. Override here if needed.
    if (result?.code === "VALIDATION_FAILED") return { errorMessage: result.message };
    return null;
  },

  // ==========================================
  // Outgoing fetch correlation injection (default true)
  // ==========================================
  patchGlobalFetch: true, // patches globalThis.fetch to add X-Correlation-ID

  // ==========================================
  // Logging
  // ==========================================
  logLevel: "info", // "debug" | "info" | "warn" | "error" | "silent"
});
```

Defaults and recommended overrides are covered in [Configuration Reference](#configuration-reference) above and [Troubleshooting](#troubleshooting) below.

---

## How Correlation Works

Events are linked together using a `correlation_id`, so EZLogs can reconstruct the complete chain triggered by a single user action:

```
HTTP Request
  └─ generates correlation_id: "ezl_1736812345_8a3f9b2c"
     ├─ Database INSERT (inherits "ezl_...")
     ├─ Server Action: createPost (inherits "ezl_...")
     │  └─ Database INSERT (inherits "ezl_...")
     └─ Background Job enqueue (inherits "ezl_...")
        └─ Job execution (inherits "ezl_...")
           └─ Database UPDATE (inherits "ezl_...")
```

**Zero configuration required.** Propagation works via:

- Request headers (`X-Ezlogs-Correlation-ID`)
- AsyncLocalStorage (Node runtime)
- Platform fallbacks (`x-vercel-id`, `cf-ray`, `x-request-id`) for apps without `middleware.ts`
- Postgres `SET LOCAL` on the wrapped connection (when using `patchDatabaseClient`)
- Job-runner metadata for BullMQ / Inngest / Trigger.dev / QStash

**Best-effort, not guaranteed.** Some events have no correlation:

- Cron-triggered jobs
- Console operations
- Cross-process job chains across cold-started serverless functions (unless platform IDs match)

That's fine. Events still get captured — they just appear as separate Actions.

---

## Auto-Wrap Coverage (Build Plugin)

The build plugin (`withEzlogsConfig`) auto-wraps these file patterns at build time. Both Webpack and Turbopack are supported.

| Pattern | Loader kind | What it wraps |
|---|---|---|
| `app/**/route.{ts,tsx,js,jsx}` | `app-route-handler` | App Router route handlers (GET/POST/etc.) |
| `pages/api/**/*.{ts,tsx,js,jsx}` | `pages-api` | Pages Router API routes |
| `middleware.{ts,tsx,js,jsx}` (root + `src/`) | `middleware` | Your `middleware.ts` (correlation seeding) |
| `actions/**/*`, `app/**/actions.{ts,tsx}`, `app/**/actions/**/*` | `server-action` | File-level `"use server"` modules |
| `app/**/{page,layout,template,loading,error,default,not-found}.{ts,tsx,js,jsx}` | `inline-server-action` | Inline `"use server"` actions inside RSC components (gated on content) |
| `lib/supabase/**`, `utils/supabase/**` (+ `src/` variants) | `supabase-factory` | Rewrites Supabase factory imports to auto-instrument every client |

**Files outside these conventional locations** that use `"use server"` won't be auto-wrapped. Wrap manually with `captureServerAction(fn, "name")` or move the file under `actions/`.

The plugin is idempotent and safe to re-run. The loader fast-paths files that don't contain `"use server"` so unrelated route files pay zero overhead.

---

## Background Job Adapters

### BullMQ

```ts
import { Queue, Worker } from "bullmq";
import { wrapBullQueue, wrapBullWorker } from "ezlogs-nextjs/bullmq";

export const queue = wrapBullQueue(new Queue("emails"));
export const worker = wrapBullWorker(new Worker("emails", processor));
```

### Inngest

```ts
import { Inngest } from "inngest";
import { ezlogsInngestMiddleware } from "ezlogs-nextjs/inngest";

export const inngest = new Inngest({
  id: "my-app",
  middleware: [ezlogsInngestMiddleware()],
});
```

### Trigger.dev

```ts
// trigger/init.ts — call once at task-runtime startup
import { tasks } from "@trigger.dev/sdk/v3";
import { registerTriggerHooks } from "ezlogs-nextjs/trigger";

registerTriggerHooks(tasks);
```

### Supabase Queues (pgmq)

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

### Upstash Workflow / QStash

```ts
import { Client } from "@upstash/qstash";
import { serve } from "@upstash/workflow/nextjs";
import {
  wrapQStashClient,
  captureWorkflowRequest,
} from "ezlogs-nextjs/upstash-workflow";

export const qstash = wrapQStashClient(new Client({ token: process.env.QSTASH_TOKEN! }));

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

---

## Serverless / Vercel

The agent auto-detects Vercel, AWS Lambda, Netlify Functions, and Cloudflare Pages. In serverless mode, `captureRoute` flushes synchronously after each handler resolves so events ship before the function freezes.

For runtimes the auto-detect doesn't recognize, call `await ezlogs.flush()` before your handler returns:

```ts
import { ezlogs, captureRoute } from "ezlogs-nextjs";

export const POST = captureRoute(async (request) => {
  /* ... your handler ... */
  await ezlogs.flush();
  return Response.json({ ok: true });
});
```

---

## Safety Guarantees

The agent is designed to be **invisible** to your application. It will never be the reason your app fails.

- **Never throws** into the host application — every public surface wraps its work in `try/catch`
- **Never blocks** requests, Server Actions, or jobs — sending is async on a background flush scheduler
- **Buffer overflow** — drops oldest events when full (default `bufferSize: 10000`)
- **Network failures** — exponential backoff with jitter, gives up gracefully after `retryAttempts`
- **Build failures** — the loader try-catches the entire parse + transform; any error returns source unchanged with a `console.warn`
- **Graceful shutdown** — flushes remaining events on `beforeExit` (Node) and Vercel `after()` (serverless)

**Design principle:** Your application's reliability is more important than capturing every event. EZLogs is best-effort, not guaranteed delivery.

---

## Troubleshooting

### No events showing up

1. **Confirm the agent initialized.** Look for this in your dev-server logs:

   ```
   [ezlogs] FlushScheduler started (interval 3000ms)
   ```

   If absent, `ezlogs.init` didn't run — check `instrumentation.ts` is at the project root (or `src/`) and that `process.env.NEXT_RUNTIME === "nodejs"` is true.

2. **Enable debug logging:**

   ```ts
   ezlogs.init({
     // ...
     logLevel: "debug",
   });
   ```

   Restart and watch for `[ezlogs] Transport send succeeded (202)` after each request.

3. **Verify network connectivity:**

   ```bash
   curl -I $EZLOGS_SERVER_URL
   ```

### `Module not found: Can't resolve './page.tsx.tsx'`

Turbopack path-doubling bug. The agent guards against this on its own rules, but if you've customized `next.config.js` with your own `turbopack.rules`, narrow your rule's content condition or scope.

### Auth events not captured

`/api/auth/*` is excluded by default for **GET / HEAD only** (NextAuth's session-refresh polls would flood your dashboard). POST callbacks — sign-in, sign-out, register — are captured. If you've added your own exclusion that covers `POST`, remove it.

### Inline `"use server"` action not captured

The auto-wrap only fires on Next's conventional route filenames: `page`, `layout`, `template`, `loading`, `error`, `default`, `not-found`. If your inline action lives elsewhere, either move it or wrap manually with `captureServerAction`.

### Authentication errors (HTTP 401)

1. Verify your API key in the EZLogs dashboard under **Settings → API Keys**.
2. Check for extra whitespace in `projectToken`: `"ezl_abc123"` not `" ezl_abc123 "`.
3. Confirm the key hasn't been revoked.

### Events appearing late

Normal. Events flush every 3 seconds by default. To reduce latency at the cost of more network calls, set `sendInterval: 1000`.

### Buffer warnings

```
[ezlogs] Buffer full, dropping oldest event
```

Your app generates events faster than they can be sent. Increase `bufferSize` or `sendInterval`, or disable a noisy capture type (`captureDb: false` in a write-heavy app).

---

## How It Works

```
Your Next.js Application
  │
  ├─ HTTP Request → Route Handler (auto-wrapped at build time)
  │     └─ captureRoute opens correlation + actor scope
  │             └─ event added to Buffer
  │
  ├─ Server Action → file-level or inline (auto-wrapped at build time)
  │     └─ captureServerAction opens correlation + actor scope
  │             └─ event added to Buffer
  │
  ├─ Database mutation → Prisma / Drizzle / supabase-js / raw pg
  │     └─ Postgres trigger writes ezlogs_audit_log row
  │             └─ flushAuditLog reader emits database_callback events
  │                     └─ events added to Buffer
  │
  └─ Background job → BullMQ / Inngest / Trigger.dev / pgmq / QStash
        └─ adapter middleware captures job lifecycle
                └─ event added to Buffer
                              │
                              ▼
                    ┌──────────────────┐
                    │      Buffer      │  thread-safe, in-memory, drop-oldest
                    │   10,000 events  │
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  FlushScheduler  │  background, every 3s
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │    Transport     │  POST /api/events with bearer auth
                    │                  │  retry: 0.5s → 1s → 2s → 4s (capped at 5s), jittered
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   EZLogs Server  │  groups events into Action cards
                    └──────────────────┘
```

**Key points:**

- Capture is **synchronous and microsecond-cheap** — no blocking on the request path
- Sending is **asynchronous** via the FlushScheduler
- Buffer is **circular** — oldest events are dropped when full
- Transport uses **exponential backoff with jitter** (1 initial + 3 retries by default, then drops) — safe for serverless thundering-herd

---

## Status

- **671 unit + integration tests**, all green
- **Wire-format parity-tested** against the Ruby agent's fixtures (every event shape byte-for-byte identical)
- **Live-validated** on 3 production-shaped Next.js stacks: Next 16 + supabase-js, Next 15 + Drizzle (postgres-js), Next 16 + Prisma + NextAuth
- **Defensive:** every public surface wraps its work in `try/catch` and logs failures — the agent never throws back into your code

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Support

- **Issues:** [github.com/dezsirazvan/ez_logs_agent_nextjs/issues](https://github.com/dezsirazvan/ez_logs_agent_nextjs/issues)
- **Email:** support@ezlogs.io

**Made for everyone on your team, not just engineers.**
