# ezlogs-nextjs

[Website](https://ezlogs.io/) · [Documentation](https://ezlogs.io/nextjs/) · [Ruby sister agent](https://github.com/dezsirazvan/ez_logs_agent)

**Drop-in activity logging for Next.js.** Captures HTTP requests,
database changes, Server Actions, and background jobs. Ships them to
the EZLogs server as plain-English Action cards your whole team can
read.

Wire-format identical to the Ruby agent (`ez_logs_agent`). Same
server ingests both. App Router, Pages Router, Server Actions
(file-level and inline), Edge runtime — all supported.

```
Password Reset — jessica@example.com
2:23 PM, January 15, 2026

  ✓ Reset link created (expires in 1 hour)
  ✓ Email sent to jessica@example.com
  ✓ All active sessions logged out (2 devices)

Status: Completed successfully
```

---

## Install

```bash
npm install ezlogs-nextjs
# or: pnpm add ezlogs-nextjs / bun add ezlogs-nextjs
```

Requires Node 18.17+ and Next.js 14+.

## Quick start

### 1. Create `instrumentation.ts`

At your project root (or `src/instrumentation.ts` if you use the
`src/` layout):

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

### 2. Wrap your Next config

`withEzlogsConfig(...)` is a transparent wrapper around your existing
config object. It doesn't add EZLogs-specific settings to your Next
config — every EZLogs option goes in `ezlogs.init({...})`. The wrapper
just registers the build-time loaders that auto-wrap your routes and
Server Actions.

Pick the snippet matching your config file:

**`next.config.ts`** (TypeScript — Next 14+ default):

```ts
import type { NextConfig } from "next";
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

const nextConfig: NextConfig = {
  // ⬇ Your existing options (or leave empty {} on a fresh project).
};

export default withEzlogsConfig(
  nextConfig as unknown as Parameters<typeof withEzlogsConfig>[0],
) as NextConfig;
```

**`next.config.mjs`** (ESM):

```js
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";
const nextConfig = { /* your options */ };
export default withEzlogsConfig(nextConfig);
```

**`next.config.js`** (CommonJS):

```js
const { withEzlogsConfig } = require("ezlogs-nextjs/plugin");
module.exports = withEzlogsConfig({ /* your options */ });
```

### 3. Set env vars, restart, verify

```bash
# .env.local
EZLOGS_SERVER_URL=https://app.ezlogs.io
EZLOGS_PROJECT_TOKEN=ezl_your_api_key_here
```

Restart your dev server, hit any route, and watch for
`[ezlogs] FlushScheduler started` in the terminal. Events appear in
your EZLogs dashboard within a few seconds.

### 4. (Optional) Full DB diffs on Postgres

One command installs Postgres triggers that capture every business-
table write with full from→to change diffs:

```bash
npx ezlogs-nextjs install-triggers
```

Migration tables, sessions, and the agent's own audit table are
skipped automatically. Without this, the agent still captures DB
writes via per-ORM adapters — you just lose the from-value half of
each change. See [docs/database.md](./docs/database.md) for trade-offs.

---

## What gets captured

| Source | What | Where it comes from |
|---|---|---|
| HTTP | Method, path, status, duration, sanitized params, GraphQL op | App Router + Pages Router (auto-wrapped) |
| Server Actions | Action name, args, outcome, redirect/notFound handled as success | File-level + inline `"use server"` (auto-wrapped) |
| Database | `model_class`, `operation`, full from→to diffs (trigger path) | Postgres triggers, Prisma, Drizzle, supabase-js |
| Background jobs | `job_class`, `job_id`, `queue`, `retry_count` | BullMQ, Inngest, Trigger.dev, pgmq, Upstash Workflow |

Every event in one inbound request shares a `correlation_id` so the
server stitches them into a single Action card.

**Automatic exclusions** (no config needed):
`_next`, `_vercel`, `__nextjs_*`, `GET /api/auth/*` (NextAuth session
polls), health-checks, login / logout / session paths, static assets.
POSTs on `/api/auth/*` are captured (sign-in, sign-out, register).

## Per-area docs

- [docs/auth.md](./docs/auth.md) — actor extraction (Clerk, NextAuth,
  Auth.js, Supabase)
- [docs/database.md](./docs/database.md) — trigger path, per-ORM
  adapters, sensitive-column filter
- [docs/jobs.md](./docs/jobs.md) — five background-job runners
- [docs/configuration.md](./docs/configuration.md) — every option,
  defaults, auto-wrap coverage, correlation flow
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common
  failures and how to diagnose them
- [AGENT_PARITY_NOTES.md](./AGENT_PARITY_NOTES.md) — every intentional
  deviation between this agent and the Ruby agent (`ez_logs_agent`)

## Safety guarantees

The agent is designed to be **invisible** to your application.

- **Never throws** into the host — every public surface wraps its work
  in `try/catch`.
- **Never blocks** requests — sending is asynchronous on a background
  flush scheduler.
- **Build-safe** — the build-time loader wraps every transform in
  try/catch and returns source unchanged on any error, so a regression
  in the loader can't break `next build`.
- **Bounded** — buffer drops oldest events when full (default 10k).
- **Read-only by design** — the agent never writes back into your app.
  No webhooks, no quotas enforced from EZLogs settings, no MCP
  write-tools.

Your application's reliability is more important than capturing every
event. EZLogs is best-effort, not guaranteed delivery.

## Wire-format parity

The Node agent emits byte-identical events to the Ruby agent
(`ez_logs_agent`). The parity test
(`tests/parity/event-builder.parity.test.ts`) is the contract — see
[AGENT_PARITY_NOTES.md](./AGENT_PARITY_NOTES.md) for the full list of
guarantees and the few intentional deviations (different default
exclusion lists, Node-only serverless flush mode).

## License

MIT.

## Support

Issues and questions: [github.com/dezsirazvan/ez_logs_agent_nextjs/issues](https://github.com/dezsirazvan/ez_logs_agent_nextjs/issues)

Email: support@ezlogs.io
