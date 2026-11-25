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

## Install: paste the prompt into your coding AI, or do it by hand

**1. Fastest: let your coding AI do it.** Paste this into Cursor,
Claude Code, v0, Replit or any coding AI:

```text
Install EZLogs in this app by following https://app.ezlogs.io/install/nextjs.md
```

The AI does every step below (package, `instrumentation.ts`, config,
key, database, jobs) and then checks that capture works. It asks you for
your API key. Signed in at [app.ezlogs.io](https://app.ezlogs.io), the
prompt shown under a new key in **Install & keys** already has your
key in it.

**2. By hand:** follow the [quick start](#quick-start-by-hand) below.
Steps 1-4 take a few minutes; steps 5-7 depend on your stack.

## Quick start (by hand)

Requires Node 18.17+ and Next.js 14+.

### 1. Install the package

```bash
npm install ezlogs-nextjs
# or: pnpm add ezlogs-nextjs / bun add ezlogs-nextjs
```

On a Next.js canary or release candidate, npm stops with `ERESOLVE`
(npm never counts a pre-release as matching the `next >=14` peer range).
Add `--legacy-peer-deps` to that install; pnpm and bun only warn.

### 2. Add `instrumentation.ts`

Starts the agent when your server boots. Put it at the project root
(or `src/instrumentation.ts` if you use the `src/` layout):

```ts
import { ezlogs } from "ezlogs-nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    ezlogs.init({
      projectToken: process.env.EZLOGS_PROJECT_TOKEN!,
    });
  }
}
```

**Pages that crash.** Add one line to the same file, so a page or layout that
fails while rendering reads as a failure (0.4.13 and later):

```ts
export { onRequestError } from "ezlogs-nextjs";
```

`serverUrl` is optional: it defaults to `process.env.EZLOGS_SERVER_URL`
if set, otherwise `https://app.ezlogs.io`. Set it only if you self-host.

**Who did it.** Every action shows the signed-in person. With Supabase
Auth there is nothing to add. Otherwise add one line to `ezlogs.init`:

| Your sign-in | Add to `ezlogs.init({ … })` |
|---|---|
| Auth.js (NextAuth v5) | `actorFromRequest: authJsActor({ auth })` (your `auth` from `auth.ts`) |
| NextAuth v4 | `actorFromRequest: nextAuthActor({ authOptions })` |
| Clerk | `actorFromRequest: clerkActor()` |
| Your own session or JWT | a small function, see [docs/auth.md](./docs/auth.md) |

```ts
import { authJsActor } from "ezlogs-nextjs/actors"; // or nextAuthActor / clerkActor
```

Import your own `auth` / `authOptions` inside the `nodejs` branch, with
`await import`: `instrumentation.ts` is also built for the Edge runtime,
and an auth module that loads your database client (Prisma, `pg`) breaks
that build when imported at the top of the file.

```ts
if (process.env.NEXT_RUNTIME === "nodejs") {
  const { auth } = await import("@/auth"); // or: const { authOptions } = await import("@/lib/auth");
  ezlogs.init({
    projectToken: process.env.EZLOGS_PROJECT_TOKEN!,
    actorFromRequest: authJsActor({ auth }),
  });
}
```

### 3. Wrap your Next config

Registers the build-time loaders that auto-wrap your routes and Server
Actions. It adds no EZLogs settings to your config; every EZLogs option
goes in `ezlogs.init({...})`.

```ts
// next.config.ts
import type { NextConfig } from "next";
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

const nextConfig: NextConfig = {
  // ⬇ Your existing options (or leave empty {} on a fresh project).
};

export default withEzlogsConfig(nextConfig);
```

<details>
<summary><code>next.config.mjs</code> / ESM <code>next.config.js</code> (also type-checks under <code>checkJs</code>, e.g. create-t3-app)</summary>

```js
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

/** @type {import("next").NextConfig} */
const nextConfig = { /* your options */ };
export default withEzlogsConfig(nextConfig);
```

</details>

<details>
<summary><code>next.config.js</code> (CommonJS)</summary>

```js
const { withEzlogsConfig } = require("ezlogs-nextjs/plugin");
module.exports = withEzlogsConfig({ /* your options */ });
```

</details>

<details>
<summary>Already have an <code>instrumentation.ts</code> or a wrapped config?</summary>

Keep yours and add to it:

- `instrumentation.ts`: put the `ezlogs.init({...})` call inside your
  existing `register()`, in the `NEXT_RUNTIME === "nodejs"` branch
  (next to Sentry / OpenTelemetry setup; the order doesn't matter).
  Export only one `register`.
- `next.config`: `withEzlogsConfig` returns the config it was given
  (same type), so it composes with other wrappers in either order:
  `export default withNextIntl(withEzlogsConfig(nextConfig))` or
  `withSentryConfig(withEzlogsConfig(nextConfig), { ... })`.

</details>

### 4. Add your key, restart, check

```bash
# .env.local
EZLOGS_PROJECT_TOKEN=ezl_your_api_key_here
```

Restart your dev server. The terminal shows this line once per server
process:

```
[ezlogs] capturing → app.ezlogs.io (key ezl_a1b2c3d4…)
```

Call an API route or submit a Server Action; events appear in your
EZLogs dashboard within a few seconds. Opening a page is not a reliable
check: page views are recorded only when the app has a `middleware.ts`
(or `proxy.ts` on Next 16).

<details>
<summary>Not seeing the line?</summary>

If `projectToken` is missing you get this instead:

```
[ezlogs] not capturing: projectToken missing in ezlogs.init() (check EZLOGS_PROJECT_TOKEN)
```

Sending to a local EZLogs server over a non-localhost plain `http://`
address? Events are still sent, but the agent warns on every start; pass
`allowInsecureTransport: true` to `ezlogs.init` to silence it. Keep
`https://` in production.

`next dev` keeps reloading the page after you installed or upgraded the
agent? Stop it, delete the `.next` folder, and start it again: a dev
cache built before the change can keep invalidating itself.

More in [docs/troubleshooting.md](./docs/troubleshooting.md).

</details>

### 5. Capture database changes

Steps 1-4 capture requests and Server Actions. This step adds what
changed in your database: which record, each column from → to, and the
request and person that made the change. Pick your stack:

| Your app writes with | Do this |
|---|---|
| **Supabase** (supabase-js), **Drizzle** on node-postgres, raw **`pg`** | [Triggers](#triggers) only |
| **Prisma** on Postgres | [Triggers](#triggers) + [Prisma extension](#prisma) |
| **postgres.js**, or **Drizzle** on postgres-js | [Triggers](#triggers) + [wrap `sql`](#postgresjs) |
| Neon HTTP, scripts | [Triggers](#triggers) (writes show up as their own actions, not linked to the request) |
| MySQL, SQLite, PlanetScale, no trigger access | A per-ORM adapter: `ezlogsPrisma()`, `ezlogsDrizzleLogger`, `wrapSupabase` ([docs/database.md](./docs/database.md)). New values only, no before-values. Drizzle sends a transaction's writes only once it commits; Prisma's extension can't see a `$transaction` end, so a write inside one that later rolls back still shows (the database triggers never do) |

#### Triggers

Set `DATABASE_URL` (or `POSTGRES_URL`) to your Postgres connection
string, then run this once from your app's directory:

```bash
npm i pg                          # the trigger installer and reader need it
npx ezlogs-nextjs install-triggers
```

The trigger path needs Postgres 10 or newer (Supabase, Neon, RDS and
every currently supported Postgres qualify).

Supabase, Drizzle on node-postgres and raw `pg` need nothing else: the
agent tags their writes itself, and the triggers record every write
(supabase-js `.from()`, `.rpc()`, bulk) linked to its request.

<details>
<summary>Trigger details: bun, monorepos, which tables are skipped</summary>

- **Monorepos:** with `DATABASE_URL` set, the agent patches `pg`
  itself. If your app loads its own copy of `pg`, pass it:
  `ezlogs.init({ ..., patchDatabaseClient: pg })`.
- **Run it where the package is installed.** With bun:
  `bunx ezlogs-nextjs install-triggers` or
  `./node_modules/.bin/ezlogs-nextjs install-triggers`. If the package
  isn't installed locally, npx / bunx download whatever version is
  published, and the CLI warns. They also download it when your
  lockfile's bin entries predate 0.3.0 (seen with bun and a `file:`
  dependency); the CLI then prints the command that runs your project's
  copy: `node node_modules/ezlogs-nextjs/bin/install-triggers.cjs install-triggers`.
- **Env files:** the CLI reads `DATABASE_URL` / `POSTGRES_URL` from your
  shell or from `.env`, `.env.local` and `.env.[mode]` (loaded the way
  Next.js loads them, incl. `${VAR}` expansion; a variable already set
  in the shell wins).
- **Skipped tables:** migration tables, database internals, the agent's
  own audit table, verification-token tables and session stores (a
  `session(s)`-style name **and** a token, expiry, `sess`, `data`,
  `payload` or `last_activity` column: Auth.js, Lucia, Rails, Laravel,
  connect-pg-simple). The output lists each skipped table with the
  reason. A `session` table without such columns (analytics visits,
  bookings) is tracked.
- If `pg` or the audit table is missing at runtime, the agent logs one
  warning at startup and leaves the trigger path off.
- **Self-check:** if writes made while requests or jobs run in a
  process keep arriving untagged, and that process has never sent a
  tagged row, the agent logs one warning naming the fix. It never
  guesses which request an untagged row belongs to.

</details>

#### Prisma

Triggers **plus** this extension (plain `new PrismaClient()`, or with a
driver adapter such as `@prisma/adapter-pg`). It tags each write with
the request, so the change joins the right action and person. Add
`.$extends(ezlogsPrisma())` where your app creates its client, and keep
your own import path (T3 apps import from `generated/prisma`).

```ts
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { ezlogsPrisma } from "ezlogs-nextjs/prisma";

export const prisma = new PrismaClient().$extends(ezlogsPrisma());
```

<details>
<summary>How the Prisma extension works</summary>

Each write inside a captured request runs as
`$transaction([set_config(correlation id, actor id), your query])` (Prisma's
documented RLS-extension pattern); reads are untouched. Writes inside
your own `prisma.$transaction(...)` are not tagged: they still show up,
as separate actions without an actor. Without the extension, a plain
PrismaClient's writes are never tagged.

Without triggers, the extension still sends Prisma writes itself (new
values only — Prisma doesn't expose the old row). With triggers it
sends nothing for tracked tables; the trigger rows are the single
source, so there are no duplicates (also for `@@map`-ed models).

`patchPrismaPgAdapter` / `patchPrismaClient` are legacy; see
[docs/database.md](./docs/database.md).

</details>

#### postgres.js

For postgres.js and Drizzle on postgres-js (Vercel Postgres templates,
`nextjs/saas-starter`): triggers **plus** wrap the `sql` instance once.

```ts
// lib/db.ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { wrapPostgresJs } from "ezlogs-nextjs/postgres";

export const sql = wrapPostgresJs(postgres(process.env.DATABASE_URL!));
export const db = drizzle(sql); // Drizzle: pass the wrapped instance
```

<details>
<summary>How the postgres.js wrapper works (and its latency cost)</summary>

Each write inside a captured request (``sql`insert …` ``, `sql.unsafe`,
Drizzle inserts / updates / deletes) runs as BEGIN; set_config
(correlation id, actor); your write; COMMIT on one pooled connection,
and resolves after COMMIT. Inside your own `sql.begin` / Drizzle
`db.transaction`, the setting is applied once at the start. Reads,
cursors, `sql.file`, COPY and `sql.reserve()` connections are not
tagged: those writes show up as their own actions. Each tagged write
is its own transaction (4 round trips instead of 1), so write latency
grows with your database round-trip time.

</details>

<details>
<summary>Upgrading from an older version</summary>

From 0.2.x or 0.3.x there is nothing to re-run before deploying. From
0.1.x, run `npx ezlogs-nextjs install-triggers --tables=none`
**before** deploying the new agent (functions only, no table locks),
deploy right after, and later re-run `npx ezlogs-nextjs install-triggers`
at a quiet moment. Details in [CHANGELOG.md](./CHANGELOG.md).

</details>

### 6. Capture background jobs

Nothing to add for the runners below. The Next config wrapper from step 3
instruments them where your server code imports them (aliases such as
`Client as WorkflowClient` included). Each job then shows up in the same
action as the request that started it, with the database changes the job
made:

| Runner | Instrumented imports |
|---|---|
| Upstash Workflow | `serve`, `servePagesRouter`, `createWorkflow`, `serveMany` from `@upstash/workflow/nextjs`; `Client` from `@upstash/workflow` |
| QStash | `Client` from `@upstash/qstash` |
| BullMQ | `Queue`, `Worker` from `bullmq` |
| Inngest (v3, v4) | `Inngest` from `inngest` (gets `ezlogsInngestMiddleware()`); on v3, wrap a function body in `runInsideInngestCorrelation` to link its writes |

A workflow step or QStash delivery is one job event: the agent does not
also record the POST that delivered it.

Add these by hand ([docs/jobs.md](./docs/jobs.md)):

| Runner | Add |
|---|---|
| Trigger.dev | `registerTriggerHooks(tasks)` from `ezlogs-nextjs/trigger` |
| Supabase Queues (pgmq) | `wrapSupabaseQueueClient` + `captureQueueMessage` from `ezlogs-nextjs/supabase-queues` |
| Code Next doesn't build (a worker started with `node worker.js`), or `import * as` / `require()` | the same runner's wrapper: `wrapBullWorker`, `wrapWorkflowClient`, … (listed in [docs/jobs.md](./docs/jobs.md)) |

Wrapping by hand where the agent already instruments is harmless: each
job is still recorded once.

**Jobs that run in a separate worker process** (for example a BullMQ
worker you start with `node worker.js`) don't load `instrumentation.ts`.
In that worker's entry file, start the agent before the worker starts,
and create the database client the same way as in step 5:

```ts
// worker.ts (your worker's entry file)
import { ezlogs } from "ezlogs-nextjs";

ezlogs.init({ projectToken: process.env.EZLOGS_PROJECT_TOKEN! });
// ...then create your Worker as usual
```

Otherwise the job's database changes show up as separate actions,
without who made them.

### 7. Name your records

Database changes are titled with the record's `name`, `title`,
`number` or `label` column. Records of people (users, members,
customers) are never named automatically: an email or a person's name
would show up on shared links. To name them, say how in `ezlogs.init`:

```ts
ezlogs.init({
  // ...
  displayNameFor: {
    users: (row) => row.full_name ?? row.username, // a column name also works: users: "username"
  },
});
```

The key is the database table name (`users`) and the row has the
database column names; only the Prisma adapter used without triggers
keys by the model name (`User`). Without it, the
record shows by its id.

---

## What gets captured

| Source | What | Where it comes from |
|---|---|---|
| HTTP | Method, path, status, duration, sanitized params (incl. route params like `[id]`), GraphQL op, the `error` / `message` of a JSON error response; tRPC: the procedure (`trpc` param), its input without the superjson / batch envelope, and the zod field error or message of a failed call, named after the procedure (`post.delete: Not allowed`); a batch where some calls failed (HTTP 207), or a failed call in an `httpBatchStreamLink` stream (create-t3-app's default, HTTP 200), is a failure. A streamed response (tRPC's `httpBatchStreamLink`, AI SDK, SSE) is recorded when its body ends, with the DB writes made while it streamed | App Router + Pages Router (auto-wrapped, incl. Auth.js `export const { GET, POST } = handlers`) |
| Page views | Page loads (the browser loading a page's HTML). `<Link>` prefetches and client-side navigations are not page views: Next strips their markers before middleware runs, so the two can't be told apart there | `middleware.ts` / Next 16 `proxy.ts` (auto-wrapped) |
| Server Actions | Action name, args, caller IP, outcome, and where a `redirect()` sent the user (`redirect_to`: same-origin path only, no query, token-like segments masked; external redirects are not recorded). A returned failure is a failure with its message: `{ success: false, error }`, `{ error: "…" }` (no truthy `success` / `ok`, no `data`), and a pure form state `{ errors: { field: [...] } \| [...], message? }` (Next.js `useActionState`), next-safe-action, zsa, Conform, zod `safeParse`. Stay successes: `{ message: "Saved" }`, a database row (`id` / `created_at` / `updatedAt` key) with an `error` column, a partial success like `{ imported: 97, errors: [...] }`. `redirect()` / `notFound()` are not failures | File-level + inline `"use server"` (auto-wrapped) |
| Database | `model_class`, `operation`, full from→to diffs incl. json leaves (trigger path), record name | Postgres triggers, Prisma, Drizzle, supabase-js |
| Background jobs | `job_class`, `job_id`, `queue`, `retry_count`, sanitized `arguments`, plus the DB writes the job made | BullMQ, Inngest, Trigger.dev, pgmq, Upstash Workflow |
| Calls to outside services | The host's domain (`stripe.com`), method, the path as a pattern (API versions and the first segment when it is a common collection name such as `charges`; everything else `:id`), status, time. Never a body, query string, header, address or internal host name. Not your app's own Supabase project or Upstash Redis (their writes show as data changes), the agent's own calls, or EZLogs itself. At most 50 per action; `captureOutbound: false` turns it off, `excludedHosts` leaves services out | `fetch`, `http`/`https` (stripe-node, axios, the OpenAI and Resend SDKs) through Node's diagnostics channels: nothing is wrapped or awaited, about the cost of a clock read per call; on Edge, the `fetch` wrapper |

Every event in one inbound request shares a `correlation_id` so the
server stitches them into a single Action card.

**Automatic exclusions** (no config needed):
`_next`, `_vercel`, `__nextjs_*`, health-checks, static assets, and
auth plumbing: `GET` / `HEAD` on `/api/auth/*` and on any login /
sign-in / signin / `/session*` path (page loads, session polls, OAuth
and email-link callbacks; a sign-out route is never excluded, a
`GET /logout` link included), plus
`/api/auth/session`, `/api/auth/csrf`, `/api/auth/providers` and
`/api/auth/_log` on every method.

**Auth events are captured:** `POST`s to sign-in, sign-up, sign-out,
login and logout routes (NextAuth / Auth.js `/api/auth/*`, custom
`/api/login`, …) and auth Server Actions, including failed attempts
(a 4xx response, a returned error, or a redirect whose target carries
`error=`, which is how Auth.js and NextAuth report a failed sign-in
from their API routes). Passwords, tokens and other
sensitive params are sent as `"[FILTERED]"`; on auth routes and auth
Server Actions (`signIn`, `verifyOtp`, …) one-time codes and OAuth
state are too (`code`, `state`, `verification_code`, `otp*`, `pin`,
`token*`; `code` stays visible on other routes). A full URL in any
value, or a value that is a relative link, loses its query and fragment.

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
- **Doesn't hold up responses** — on a long-running server, events are
  sent by a background flush scheduler, never on the request path. On
  serverless hosts (Vercel, AWS Lambda, Netlify, Cloudflare Pages) the
  function can freeze once the response is sent, so each request's
  events are sent as it finishes: through the platform's `waitUntil`
  when there is one (Vercel, and Next.js runtimes that provide it), after the response; without
  it, the request waits at most 2 seconds, and events not sent by then
  are best-effort (sent only if the function stays warm).
- **Build-safe** — the build-time loader wraps every transform in
  try/catch and returns source unchanged on any error, so a regression
  in the loader can't break `next build`.
- **Bounded** — buffer drops oldest events when full (default 10k).
- **Read-only by design** — the agent never writes back into your app.
  No webhooks, no quotas enforced from EZLogs settings, no MCP
  write-tools.

Your application's reliability is more important than capturing every
event. EZLogs is best-effort, not guaranteed delivery.

## Security: what is captured and redacted

- **Secrets inside values.** Every string and key the agent sends (params,
  job payloads, row values, display names, error messages) is checked by
  its shape, whatever its key:
  - **URLs:** a URL (`scheme://…`, alone or inside a text, also URL-encoded as `https%3A%2F%2F…`) keeps its scheme, host and path; its `user:pass@` and everything from `?` or `#` (or `%3F`, `%23`) are removed. A value that is a path on its own (`/first_password/edit?reset_password_token=…`, `//cdn/x.png?sig=…`) loses its query and fragment too. Inside such a URL or path, a segment that looks generated (16+ characters with a lowercase letter, an uppercase letter and a digit, never a file name with a `.`: Slack and Discord webhook tokens, `/reset/<token>`) and a Telegram `bot<digits>:<token>` segment become `[FILTERED]`. The event's own request or outbound `path` keeps its segments (its query and card numbers still go): titles read the ids there.
  - **Known shapes:** JWTs, private keys, Stripe / Stripe webhook / OpenAI-style (`sk-` with a digit) / GitHub / Slack / AWS keys, and any 15-16 digit number that passes the Luhn check (card numbers, wherever they sit) become `[FILTERED]`.
  - **Bearer / Basic:** the word after `Bearer` is masked when it has a digit or symbol, a lowercase-then-uppercase pair (base64) or 16+ characters; after `Basic`, the same with 8+ characters.
  - **Mailer jobs:** in an ActionMailer job (mailer class, method, then `deliver_now` / `deliver_later`) whose method has a secret word (`reset_password_instructions`, `confirmation_instructions`, `unlock_instructions`, `invitation_instructions`, …), every positional string is masked except method names, GlobalIDs, numbers and UUIDs, so the token Devise passes is never sent. Any other job's arguments are left to the rules above (`["card_declined", "Order 42 for Alice"]` stays).
  - Keys are checked the same way (two keys masked alike both stay: `[FILTERED]`, `[FILTERED] 2`), and anything nested deeper than 8 levels is sent as `[Object]`. Error messages are cut to 4 KB like every other string.
  What this costs, on purpose: a URL's query and fragment are dropped even when they are ordinary data (`youtube.com/watch?v=…` reads as `youtube.com/watch`); any 15-16 digit number that passes Luhn is masked, so are some order ids and IMEIs; a slug, username or random id of 16+ characters with mixed case and digits inside a link in a value (a nanoid, `github.com/JohnDoe2024Developer`) is masked; file names are not. Not masked: a token in the request's own route path (`GET /reset/<token>`), a known limit until the agents send the route pattern; a link without `scheme://` inside a sentence (`see /reset?token=…`), a text that is not a URL (`reset_password_token=abc`; its key is still filtered by name), and a short lowercase or letters-only word after `Bearer` / `Basic` (`Bearer of bad news`, `Basic Monthly`, `Basic 2`; this also lets through a real but unusual credential such as `Bearer abcdef`).
- **Request params / Server Action args.** Keys matching a sensitive
  name are sent as `"[FILTERED]"`: password, token, secret, api key,
  credential, auth, signature, card number / cvv, ssn, … (substring),
  and the short words `pin`, `otp`, `totp`, `iban`, `mfa`,
  `passphrase` (whole word, so `shipping` / `options` are kept).
  camelCase keys are covered (`apiKey`, `mdmUnlockPin`). Add your own
  fragments with `excludedGraphqlVariableKeys`.
- **Unnamed Server Action arguments** (`signIn(email, password)`) have
  no key to judge by, so every positional string is sent as
  `"[FILTERED]"` unless it has a strict generated-id shape (integer,
  UUID, cuid, cuid2, ULID, nanoid — with digit / mixed-case checks, so
  words like `inactive` stay masked). Numbers and booleans are kept,
  except Luhn-valid card numbers (15-16 digits always, 13-19 for payment-named actions) and 4-8
  digit values when the action name has a secret word (`setPin`,
  `verifyOtp`, `addCard`). Residual risk: a PIN passed to an innocently
  named action (`update(4821)`) is shown. Object / FormData arguments
  keep their field names and get the key rule above — pass an object
  if you want values shown.
- **Database rows (trigger path).** Columns with sensitive names are
  removed by the trigger itself, so they are never written to
  `ezlogs_audit_log`. An update that only touches such columns writes
  no audit row. Sensitive keys inside json/jsonb columns are dropped
  by the agent before sending. DB values are dropped, not sent as
  `"[FILTERED]"` (that placeholder is for request params and job
  arguments).
- **Retention of `ezlogs_audit_log`.** Rows are deleted when the agent
  claims them, before it sends them (best-effort: a rejected token or a
  full buffer loses them). Rows nobody claimed (untagged writes, or
  tagged rows older than 5 minutes) are sent as their own actions by a
  throttled sweep, up to 7 days old. Rows older than 7 days are deleted
  unsent (one warning when a backlog remains). The agent's role needs
  `DELETE` on the table; without it the agent warns once and you must
  schedule
  `DELETE FROM ezlogs_audit_log WHERE captured_at < now() - interval '7 days'`.
- **Access to `ezlogs_audit_log`.** Row-level security is on and all
  privileges are revoked from `PUBLIC` and Supabase's `anon` /
  `authenticated`, so the table is not reachable through PostgREST.
  The installing role (owner) and the trigger are unaffected; a reader
  connecting as another role gets one startup warning with the GRANT +
  CREATE POLICY it needs.
- **Correlation is never guessed.** A DB write is grouped with a
  request only when it carries that request's id (set by the agent on
  `pg` connections, or via the `x-correlation-id` header PostgREST
  exposes for supabase-js). Untagged writes show up as their own
  actions without an actor. An inbound `x-ezlogs-correlation-id` is
  honored only in the agent's own format and if under an hour old.
- **A DB change's actor is the one its writer stored.** The agent sets
  the actor id next to the correlation id on tagged writes (`pg`,
  postgres.js, Prisma), so a row keeps its writer's actor even when
  another scope with the same correlation id sends it. supabase-js
  writes store no actor: they join their request, and the request's
  own event carries the actor.
- **Work that outlives a request.** Async work started inside a
  request (`after()`, `waitUntil`, an un-awaited write) keeps its
  correlation id and actor for 60 seconds after the request's events
  are flushed. After that (a `setInterval`, a long-lived object
  created lazily inside a request) its writes, jobs and fetches are
  unlinked: their own actions, never the old request's. Work a
  background job started ends the same way, 60 seconds after the job.
- **Don't share one `pg.Client` across concurrent requests.** Use a
  `pg.Pool`. While one request has its own transaction open on a
  shared client, another request's write on it runs inside that
  transaction in Postgres and is recorded under the first request.
- **Cursors and streams** (`pg-cursor`, `pg-query-stream`, COPY) are
  passed to `pg` untouched; writes made through them are untagged.

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
