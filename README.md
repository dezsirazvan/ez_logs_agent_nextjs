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

export default withEzlogsConfig(nextConfig);
```

**`next.config.mjs`** / ESM **`next.config.js`** (also type-checks
under `checkJs`, e.g. create-t3-app):

```js
import { withEzlogsConfig } from "ezlogs-nextjs/plugin";

/** @type {import("next").NextConfig} */
const nextConfig = { /* your options */ };
export default withEzlogsConfig(nextConfig);
```

**`next.config.js`** (CommonJS):

```js
const { withEzlogsConfig } = require("ezlogs-nextjs/plugin");
module.exports = withEzlogsConfig({ /* your options */ });
```

**Already have an `instrumentation.ts` or a wrapped config?** Keep
yours and add to it:

- `instrumentation.ts`: put the `ezlogs.init({...})` call inside your
  existing `register()`, in the `NEXT_RUNTIME === "nodejs"` branch
  (next to Sentry / OpenTelemetry setup; the order doesn't matter).
  Export only one `register`.
- `next.config`: `withEzlogsConfig` returns the config it was given
  (same type), so it composes with other wrappers in either order:
  `export default withNextIntl(withEzlogsConfig(nextConfig))` or
  `withSentryConfig(withEzlogsConfig(nextConfig), { ... })`.

### 3. Set env vars, restart, verify

```bash
# .env.local
EZLOGS_SERVER_URL=https://app.ezlogs.io
EZLOGS_PROJECT_TOKEN=ezl_your_api_key_here
```

Restart your dev server and look for this line in the terminal (one
per server process, at the default log level):

```
[ezlogs] capturing → app.ezlogs.io (project …1a2b)
```

If `serverUrl` or `projectToken` is missing you get
`[ezlogs] not capturing: … missing` instead. Hit any route; events
appear in your EZLogs dashboard within a few seconds.

Sending to a local EZLogs server over plain `http://` (development)?
Events are still sent, but the agent warns on every start; pass
`allowInsecureTransport: true` to `ezlogs.init` to silence it. Keep
`https://` in production.

### 4. Database changes

Steps 1-3 capture requests, Server Actions and jobs. Database changes
need one more step, depending on your stack:

| Your app writes with | Do this | You get |
|---|---|---|
| **Supabase** (supabase-js) | `npm i pg`, set `DATABASE_URL` to the Postgres connection string, run `npx ezlogs-nextjs install-triggers`. Nothing to wrap: the agent tags supabase-js requests and the trigger reads the tag. | Every write (`.from()`, `.rpc()`, bulk) with from→to diffs, linked to its request |
| **Prisma** on Postgres | triggers (as above) + `new PrismaClient().$extends(ezlogsPrisma())` (below) | Same |
| **Drizzle** (node-postgres) or raw **`pg`** | triggers (as above). With `DATABASE_URL` set, the agent patches `pg` itself; if your app loads its own copy of `pg` (monorepos), pass it: `ezlogs.init({ ..., patchDatabaseClient: pg })`. | Same |
| postgres.js, Neon HTTP, scripts | triggers (as above) | Writes show up as their own actions, not linked to the request |
| MySQL, SQLite, PlanetScale, no trigger access | a per-ORM adapter: `ezlogsPrisma()`, `ezlogsDrizzleLogger`, `wrapSupabase` ([docs/database.md](./docs/database.md)) | New values only, no before-values |

```bash
npm i pg                          # the trigger installer and reader need it
npx ezlogs-nextjs install-triggers
```

Run it from your app's directory with the package installed there
(with bun: `bunx ezlogs-nextjs install-triggers` or
`./node_modules/.bin/ezlogs-nextjs install-triggers`); if the package
isn't installed locally, npx / bunx download whatever version is
published, and the CLI warns. They also download it when your
lockfile's bin entries predate 0.3.0 (seen with bun and a `file:`
dependency); the CLI then prints the command that runs your project's
copy: `node node_modules/ezlogs-nextjs/bin/install-triggers.cjs install-triggers`.
The CLI reads `DATABASE_URL` / `POSTGRES_URL` from your shell or from
`.env`, `.env.local` and `.env.[mode]` (loaded the way Next.js loads
them, incl. `${VAR}` expansion; a variable already set in the shell
wins). Migration tables, database internals, the agent's own audit
table, verification-token tables and session stores (a
`session(s)`-style name **and** a token, expiry, `sess`, `data`,
`payload` or `last_activity` column: Auth.js, Lucia, Rails, Laravel,
connect-pg-simple) are skipped; the output lists each skipped table
with the reason. A `session` table without such columns (analytics
visits, bookings) is tracked. If `pg` or the
audit table is missing at runtime, the agent logs one warning at
startup and leaves the trigger path off.

**Recommended setup for Prisma** (plain `new PrismaClient()`, or with
a driver adapter such as `@prisma/adapter-pg`): triggers **plus** the
extension, which tags each write with the request so DB changes join
the right action and actor. (`patchPrismaPgAdapter` /
`patchPrismaClient` are legacy; see [docs/database.md](./docs/database.md).)

```ts
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { ezlogsPrisma } from "ezlogs-nextjs/prisma";

export const prisma = new PrismaClient().$extends(ezlogsPrisma());
```

Each write inside a captured request runs as
`$transaction([set_config(correlation id), your query])` (Prisma's
documented RLS-extension pattern); reads are untouched. Writes inside
your own `prisma.$transaction(...)` are not tagged: they still show up,
as separate actions without an actor. Without the extension, a plain
PrismaClient's writes are never tagged.

**Background workers** (BullMQ and other job processes) are separate
processes: call `ezlogs.init` there too and build the database client
the same way (extension for Prisma), or the job's writes show up as
separate actions without an actor.

**Self-check:** if writes made while requests or jobs run in a process
keep arriving untagged, and that process has never sent a tagged row,
the agent logs one warning naming the fix. It never guesses which
request an untagged row belongs to.

Without triggers, the extension still sends Prisma writes itself (new
values only — Prisma doesn't expose the old row). With triggers it
sends nothing for tracked tables; the trigger rows are the single
source, so there are no duplicates (also for `@@map`-ed models).

**Upgrading:** from 0.2.x to 0.3.0 there is nothing to re-run (no SQL
changes). From 0.1.x, run `npx ezlogs-nextjs install-triggers --tables=none`
**before** deploying the new agent (functions only, no table locks),
deploy right after, and later re-run `npx ezlogs-nextjs install-triggers`
at a quiet moment. Details in [CHANGELOG.md](./CHANGELOG.md).

### 5. Name your records

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

The key is the table name for trigger-captured changes (`users`) and
the model name for the per-ORM adapters (`User`). Without it, the
record shows by its id.

---

## What gets captured

| Source | What | Where it comes from |
|---|---|---|
| HTTP | Method, path, status, duration, sanitized params (incl. route params like `[id]`), GraphQL op, the `error` / `message` of a JSON error response; tRPC: the procedure (`trpc` param), its input without the superjson / batch envelope, and the zod field error or message of a failed call, named after the procedure (`post.delete: Not allowed`); a batch where some calls failed (HTTP 207) is a failure. Known gap: with `httpBatchStreamLink` (create-t3-app's default) the response is a 200 stream, so a failed call inside it is recorded as success | App Router + Pages Router (auto-wrapped, incl. Auth.js `export const { GET, POST } = handlers`) |
| Server Actions | Action name, args, caller IP, outcome, and where a `redirect()` sent the user (`redirect_to`: same-origin path only, no query, token-like segments masked; external redirects are not recorded). A returned failure is a failure with its message: `{ success: false, error }`, `{ error: "…" }` (no truthy `success` / `ok`, no `data`), and a pure form state `{ errors: { field: [...] } \| [...], message? }` (Next.js `useActionState`), next-safe-action, zsa, Conform, zod `safeParse`. Stay successes: `{ message: "Saved" }`, a database row (`id` / `created_at` / `updatedAt` key) with an `error` column, a partial success like `{ imported: 97, errors: [...] }`. `redirect()` / `notFound()` are not failures | File-level + inline `"use server"` (auto-wrapped) |
| Database | `model_class`, `operation`, full from→to diffs incl. json leaves (trigger path), record name | Postgres triggers, Prisma, Drizzle, supabase-js |
| Background jobs | `job_class`, `job_id`, `queue`, `retry_count`, sanitized `arguments`, plus the DB writes the job made | BullMQ, Inngest, Trigger.dev, pgmq, Upstash Workflow |

Every event in one inbound request shares a `correlation_id` so the
server stitches them into a single Action card.

**Automatic exclusions** (no config needed):
`_next`, `_vercel`, `__nextjs_*`, health-checks, static assets, and
auth plumbing: `GET` / `HEAD` on `/api/auth/*` and on any login /
logout / sign-in / sign-out / signin / signout / `/session*` path
(page loads, session polls, OAuth and email-link callbacks), plus
`/api/auth/session`, `/api/auth/csrf`, `/api/auth/providers` and
`/api/auth/_log` on every method.

**Auth events are captured:** `POST`s to sign-in, sign-up, sign-out,
login and logout routes (NextAuth / Auth.js `/api/auth/*`, custom
`/api/login`, …) and auth Server Actions, including failed attempts
(a 4xx response or a returned error). Passwords, tokens and other
sensitive params are sent as `"[FILTERED]"`; on auth routes and auth
Server Actions (`signIn`, `verifyOtp`, …) one-time codes and OAuth
state are too (`code`, `state`, `verification_code`, `otp*`, `pin`,
`token*`; `code` stays visible on other routes). Secret query params
inside `callbackUrl` / `redirect` / `from_page` values are masked
everywhere.

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

## Security: what is captured and redacted

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
- **Retention of `ezlogs_audit_log`.** Rows are deleted as soon as the
  agent sends them. Rows nobody claimed (untagged writes, or tagged
  rows older than 5 minutes) are sent as their own actions by a
  throttled sweep. Rows older than 24 hours are deleted unsent. The
  agent's role needs `DELETE` on the table; without it the agent warns
  once and you must schedule
  `DELETE FROM ezlogs_audit_log WHERE captured_at < now() - interval '24 hours'`.
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
