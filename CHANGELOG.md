# Changelog

All notable changes to `ezlogs-nextjs` are documented here.
Earlier releases (0.1.x) were not tracked in a changelog.

## [0.4.0] — 2026-11-16

Wire format unchanged; one new optional `source_data` field
(`redirect_to`). **Upgrade steps:** none required. postgres.js /
Drizzle-on-postgres-js apps: wrap the `sql` instance (`wrapPostgresJs`,
below) so DB writes join their request. Optional: re-run
`npx ezlogs-nextjs install-triggers` to start tracking session-named
business tables the old name rule skipped. Behavior change: auth POSTs
(sign-in, sign-up, sign-out, login, logout) are now captured; add them
to `excludedPaths` if you don't want them. Behavior change:
`stampPayloadForTrigger` and `stampPgmqPayload` return a stamped copy
and no longer modify their argument; send the returned value.

### Added
- **`wrapPostgresJs` (`ezlogs-nextjs/postgres`).** postgres.js writes
  reached the audit log untagged, so each one became its own
  actor-less action (0 of 56 linked in `nextjs/saas-starter`).
  `wrapPostgresJs(postgres(url))`, also passed to Drizzle's
  postgres-js driver, runs each write made inside a captured request
  as BEGIN; set_config (correlation id, actor); write; COMMIT, and
  applies the setting at the start of your own `sql.begin` /
  `db.transaction`. The caller's query resolves after COMMIT (a COMMIT
  error rejects it). Reads, cursors, COPY, `sql.file` and
  `sql.reserve()` connections are left untagged (own actions, never on
  another request). `query.cancel()` reaches the running statement.
  Each tagged write is a transaction (BEGIN, set_config, write,
  COMMIT): write latency grows with the database round trip.
- **Next 16 `proxy.ts` is auto-wrapped** like `middleware.ts` (root or
  `src/`, named `proxy` or default export), so page views and the
  correlation seed work on Next 16. Only when the project's `next` is
  16 or newer (before that `proxy.ts` is an ordinary module); other
  files named `proxy.ts` are left alone.
- **Startup line** at the default log level, once per process:
  `[ezlogs] capturing → <host> (project …last4)` (the suffix only for
  tokens of 12+ characters), or `[ezlogs] not capturing: … missing`.
  The README verify step uses it.
- **`redirect_to`** on Server Action events: the same-origin path a
  `redirect()` sent the user to (no query; token-like segments,
  emails and secrets masked). External redirects are not recorded.
  Not used to reclassify.
- **"Name your records"** README step: person names come only from
  `displayNameFor` (e.g. `users: (row) => row.full_name ?? row.username`);
  its function form may now return any value (stringified). The
  installer points at it.

### Fixed
- **Streamed responses lost their DB changes.** tRPC's default
  `httpBatchStreamLink`, AI SDK and SSE routes do their work after the
  handler returns; the agent drained audit rows at return, so the card
  said "no data change" and the rows arrived 5+ minutes later without
  an actor. A route's body is now passed through unchanged (chunk by
  chunk, no buffering) and the request is recorded when the body ends,
  errors (failure) or is cancelled, with the writes made while it
  streamed and the actor. `duration_ms` stays the handler's time.
  On serverless this needs the platform's
  `waitUntil` (Vercel); without it the event ships before the
  response, as before.
- **`<Link>` prefetches were recorded as page views** (123 of 136
  actions in one production app). Next strips its prefetch / RSC
  markers before middleware runs; the agent now counts only page
  loads (`Sec-Fetch-Mode: navigate`, or no Fetch Metadata), and drops
  requests with `Next-Url`, `Sec-Purpose: prefetch`, or the router
  headers. Client-side navigations are no longer page views either:
  in middleware they can't be told apart from prefetches.
- **Leftover audit rows waited for the next request.** The throttled
  sweep (untagged rows, tagged rows older than 5 minutes) now also
  runs on the flush timer for about 5 minutes after the last request,
  so they ship within seconds; an idle app stops querying its database.
- **Server Action failures recorded as success.** A returned
  `{ error: "Invalid email or password" }` (no truthy `success` / `ok`,
  no `data`) and the Next.js docs' form state `{ errors: { field: [...] },
  message }` / `{ errors: [...] }` are now failures. The message is the
  first safe field error, else the state's `message`, with the 0.3.3
  masking (emails and secrets masked, sensitive fields skipped).
  `{ message: "Saved" }`, empty `errors`, `error` beside
  `success: true` / `ok: true` / `data`, a database row (an `id` /
  `created_at` / `updatedAt` key) with an `error` column, and a
  partial success (`{ imported: 97, errors: [...] }`: `errors` counts
  only in a pure form state) stay successes. A returned
  `{ success: false, error }` message is now masked the same way.
- **`next build` failed with the documented install on strict
  TypeScript** (create-t3-app). `ezlogsPrisma()` returned `unknown`
  (TS2345 at `$extends`); it now returns a Prisma extension type that
  works on Prisma 5, 6 and 7 without importing `@prisma/client` types,
  and the extended client keeps its model types. `withEzlogsConfig` is
  generic over the config you pass and returns the same type, so a
  `checkJs` ESM `next.config.js` (`webpack: null` in Next's type) and
  other config wrappers type-check. Type-level regression fixtures run
  in CI (`strict`, `checkJs`; Prisma per major).
- **tRPC errors said only "HTTP 400".** Batch and single tRPC error
  bodies (superjson or plain) now give the zod field error
  (`name: String must contain at least 1 character(s)`) or the error
  message, never the raw zod JSON. "What was sent" no longer shows the
  superjson envelope (`Json name: …`): the input is unwrapped from
  `{ json, meta }`, `{"0":{json}}` and `?input=` (on tRPC routes
  only; a plain JSON `?input=` is parsed too, so its `password` is
  filtered); the `trpc` procedure param is kept. The reason names the
  failing procedure (`post.delete: Not allowed`), and a batch where
  some calls failed (HTTP 207 with a tRPC body) is now a failure; any
  other 207 stays a success. A tRPC error body sent as `text/plain`
  (a batch mixing queries and mutations) keeps its reason instead of
  `HTTP 400`.
- **`install-triggers` ignored `.env`.** It now loads `.env`,
  `.env.local` and `.env.[mode]` like Next.js: the app's `@next/env`
  when present, else dotenv's grammar (quoted values with trailing
  comments, multiline quoted values) with dotenv-expand style
  `${VAR}` expansion. Variables already set win. The connection error
  no longer prints the database password.
- **Sign-in, sign-out and failed logins were invisible.** Login /
  logout / sign-in / sign-out / `/session*` paths are now excluded for
  GET / HEAD only, so the POSTs are captured with params sanitized;
  `/api/auth/session`, `/csrf`, `/providers`, `/_log` stay excluded.
  On auth routes and auth Server Actions, `code`, `state`,
  `verification_code`, `otp*`, `pin`, `token*` are filtered (`code` is
  not globally sensitive); secret query params inside `callbackUrl` /
  `redirect` / `from_page` values are masked everywhere. The Auth.js
  v5 route shape `export const { GET, POST } = handlers` is now
  auto-wrapped, also several such statements or one beside
  `export async function POST`.
- **The installer skipped business tables by name.** A `session(s)`-
  style table is skipped only when it also has a session-store column
  (token, expiry, `sess`, `data`, `payload`, `last_activity`: Auth.js,
  Lucia, Rails, Laravel, connect-pg-simple); verification-token tables
  are always skipped. Every skipped table is printed with the reason.
  At runtime, trigger rows from a session-named table ship only when
  the row has none of those columns, so session stores tracked by an
  older install stay dropped.
- **Failed calls in a tRPC `httpBatchStreamLink` batch were recorded
  as success.** create-t3-app's default link answers 200 with a JSON
  Lines stream; a failed call's error arrives in a later line. On tRPC
  routes (a `trpc` param or a `[trpc]` route path) the agent now reads
  the lines as they pass through (no buffering, no delay, one line of
  at most 16 KB kept) and records the first failed call as a failure
  (a call's own chunk, from the head line's chunk ids, or a rejected
  promise / failed iterable; error-shaped data stays a success),
  named after its procedure (`post.create: UNAUTHORIZED`). Needs the
  body to be followed (see above); otherwise it stays a success.
- **Audit rows older than 24 hours were deleted unsent.** The agent
  pruned rows older than 24 hours, and the sweep skipped them, so rows
  written while no request ran for a day (a cron, another process)
  were lost. The cutoff is now 7 days for both: the sweep sends rows
  up to 7 days old (100 per sweep, oldest first, timestamped with when
  the write happened); older rows are still pruned unsent (2k rows
  every 10 minutes per process), so the table stays bounded. A prune
  that deletes a full batch logs one warning.
- **Wrong request or actor on DB writes and jobs (correlation audit).**
  Four cases put a write or a job on another request, or gave it
  another actor. Each now links correctly or stays unlinked (its own
  action, no actor):
  - *One `pg.Client` shared by concurrent requests.* A tagged write is
    BEGIN, set_config, the write and COMMIT; on a shared client
    another request's queries ran in between, inside that
    transaction, with its id and actor. A query issued on a client
    while the agent's BEGIN..COMMIT runs there now waits for it, as pg
    queues behind any single query (same order). Pools were not
    affected.
  - *A job with no carried actor got its worker's actor.* A BullMQ
    `Worker` created inside a request gave every later job that
    request's actor, and `setActor` in such a job changed the
    request's actor. Every job runner (BullMQ, Inngest, Trigger.dev,
    pgmq, Upstash Workflow) now runs the body in a fresh actor scope:
    only the actor the job carried, or none.
  - *A reused job payload kept the first request's id and actor.* The
    agent wrote the correlation id and signed actor into the caller's
    payload object, so a module-level constant enqueued from later
    requests ran on the first one. BullMQ, Inngest, pgmq and the
    Trigger.dev helper now stamp a copy; the caller's object is never
    written. A correlation id the caller set is still kept.
  - *Async work a request started kept its id forever.* A
    `setInterval` or long-lived object started inside a request tagged
    its writes (and enqueued jobs, outgoing fetches) with that request
    long after it ended. A request's scope now links work for 60 s
    after the request's events are flushed (`after()` / `waitUntil`
    work stays linked); later work runs unlinked.

### Docs
- `$extends(ezlogsPrisma())` is the recommended Prisma path, with or
  without a driver adapter; `patchPrismaPgAdapter` is marked legacy.
- `next.config` type fixture: CI checks a typedef mirroring Next's
  `NextConfig` (`next` is not a devDependency); the real-type fixture
  runs where `next` is installed (checked locally against Next 15.5).
- Custom JWT / bearer actor hook recipe (what `id` and `label` mean).
- Merging into an existing `instrumentation.ts` and an already-wrapped
  `next.config` (next-intl, Sentry).
- Supabase `auth.*` / `storage.*` are not tracked; browser-side
  Supabase writes can't be linked to a server request.

## [0.3.4] — 2026-11-16

Wire format unchanged. **Upgrade steps:** none.

### Fixed
- **Plain Node ESM processes had no request scope.** The ESM build
  loaded `node:async_hooks` through `require`, which does not exist
  there, so a `"type": "module"` process (a BullMQ worker, a script)
  fell back to one shared variable: jobs and requests running at the
  same time could lose or swap their correlation id and actor. The
  agent now gets `AsyncLocalStorage` from `process.getBuiltinModule`
  first (Node >= 20.16 / 22.3), then `require`. Inside Next.js and in
  CommonJS nothing changes. If neither works on Node, it warns once
  instead of silently sharing; Edge stays quiet as before.

## [0.3.3] — 2026-11-16

Wire format unchanged. **Upgrade steps:** none (no SQL changed, no
usage change). BullMQ / Inngest workers need the same
`EZLOGS_PROJECT_TOKEN` as the app to verify the actor.

### Added
- **Actor for BullMQ jobs and Inngest functions.** The signed actor
  token Upstash Workflow uses since 0.3.2 now also travels in BullMQ
  `job.data` and Inngest `event.data` (`ezlogs_actor`), after the late
  Supabase actor fallback, and the worker runs the body as that person
  only when it verifies. Human actors only; stripped from the job's
  `arguments`. BullMQ adds on a queue keep their call order.

### Fixed
- **Pooled `pg` writes could carry another request's correlation.**
  With every pool client busy, pg-pool ran a queued `pool.query` from
  the request that released a client, so the write was tagged with
  that request's correlation id and actor (Drizzle node-postgres,
  `@prisma/adapter-pg`). `Pool.connect` callbacks now run in their
  caller's async context.
- **"Validation error" hid the real reason.** A 4xx body or a Server
  Action result like `{ error: "Validation error", details: [...] }`
  now reports the first specific message (zod / valibot issues,
  `fieldErrors`, `formErrors`) as `"name: Name is required"`. A thrown
  ZodError reports its first issue, or "Validation failed", never the
  raw JSON issue list. Messages only, never input values: quoted
  `received` values are masked, issues on sensitive-looking fields and
  field-less messages naming a secret are skipped; masked and capped at
  200 characters.

## [0.3.2] — 2026-11-16

Wire format unchanged. **Upgrade steps:** none (no SQL changed, no
usage change).

### Fixed
- **`next build` fails with the documented `wrapQStashClient`.** Its
  parameter type rejected `@upstash/qstash` 2.12's generic
  `publishJSON<TBody, TRequest>` (TS2345 / TS2740), so any app with a
  typed QStash getter failed the build's type check (`next dev` skips
  it). The wrapper now accepts any client and returns the caller's own
  client type. A `tsc --noEmit` fixture against the real
  `@upstash/qstash` and `@upstash/workflow` types runs in the test suite.
  The wrapper also keeps headers passed as a `Headers` instance or an
  entry list (they were dropped when the correlation id was added).
- **Upstash Workflow steps lose the actor.** Writes made in workflow
  steps after the response (production, where QStash delivers the
  steps) had the right correlation but no actor: only the correlation
  id travelled with the run, and job scopes never had an actor. The
  wrappers now carry the actor id next to the correlation id (header +
  run id, signed with the project token and bound to the correlation
  id). `captureWorkflowRequest` runs the step as that actor only when
  the signature verifies. The late Supabase actor fallback runs before
  the run starts, so it is known in time. With no verified actor the
  writes keep an empty actor, as before. Only the id travels, so an
  agent / hybrid actor or one with a `principal` is not carried (it
  would arrive looking human); those steps keep an empty actor.
- **Supabase actor fallback could read another request's user.** The
  "current Supabase client" used for `actorFromSupabase` was one
  process-wide slot, so under concurrency request A could resolve
  request B's user. A client created inside a request is now kept in
  that request's scope and only that scope reads it (the process-wide
  slot is used only outside any scope). A "no user" answer is
  remembered per request until a new client is created, so `getUser()`
  is not called again on every publish / trigger.
- **Inngest job events had no `job_class`.** In inngest v3 `fn.id` is a
  method, so a function was sent and dropped by JSON. The middleware
  now calls it, falls back to `fn.opts.id`, and still reads the older
  string shape.

## [0.3.1] — 2026-11-16

Wire format unchanged. **Upgrade steps:** none (no SQL changed).

### Fixed
- **jsonb bookkeeping no longer buries the real change.** Nested
  leaves whose key only records a write (`created_at` / `updated_at`
  style keys, `synced_at` / `last_updated_at` / `modified_at` stamps,
  numeric `version` / `lock_version` / `__v` counters) are
  dropped, so `field_sources.job_title.updated_at` is never sent and a
  touch-only jsonb update sends no event. Within a column, value
  changes rank before keys that were added or removed (the 20-leaf cap
  applies after ranking), and the record's own columns come before any
  dotted leaf. Soft-delete style names (`deleted_at`, `archived_at`),
  nested `id`s and other business keys (`subscription.expires`) are
  kept.
- **Upstash Workflow: every step delivery joins the request.**
  `@upstash/workflow` (1.3.x) sends the trigger's headers with the
  first delivery only; later steps, `context.call` results and parallel
  steps arrive without them, so each run's last delivery became its own
  action. `wrapWorkflowClient` now also mints the run id as
  `wfr_<correlation id>_<24 hex>` (only when you don't pass a
  `workflowRunId`; 96 random bits, because Upstash silently starts no
  run for a reused run id), and `captureWorkflowRequest` reads the correlation
  from `Upstash-Workflow-RunId` when the header is missing. Same rules
  as the header: agent id format only, at most 24 hours old, inside
  `serve()` after the signature check. Tested against the real SDK and
  a fake QStash server delivering every step.

### Added
- **Self-check for untagged database writes.** With the trigger path,
  a client the agent can't tag (a plain `new PrismaClient()` without
  `$extends(ezlogsPrisma())`, a worker process that never called
  `ezlogs.init`, a second copy of `pg`) splits each action in two: the
  request without record names, and its DB rows as an actor-less
  action. When a request or job claims none of its own rows while
  untagged rows were written during it, five times over at least two
  minutes, and the process has never claimed a tagged row, the agent
  logs one warning naming the likely fix (worded for jobs in a worker;
  another process writing at the same time can also cause it). At most
  one check per 10 seconds and 50 per process. Rows are still never attributed to a request by guessing.
  (`pg` used directly was already auto-tagged when `DATABASE_URL` is
  set; the warning also covers an app that loads its own `pg` copy.)

### Install
- When `npx` / `bunx` run a downloaded copy although the project has
  `ezlogs-nextjs` installed (lockfile bin entries older than 0.3.0,
  seen with bun and a `file:` dependency), the CLI says so and prints
  the command that runs the project's copy
  (`node node_modules/ezlogs-nextjs/bin/install-triggers.cjs install-triggers`),
  also when it then fails for a missing `pg`.

### Package
- tsup now splits shared code into chunks instead of copying it into
  every subpath bundle: 2.09 MB -> 1.3 MB unpacked. Every subpath was
  checked with `require` and `import` from the packed tarball.

## [0.3.0] — 2026-11-16

Wire format unchanged: new information rides on existing optional
fields (`arguments`, `display_name`, `error_message`, `resource_ids`,
dotted attribute names).

**Upgrade steps:** none from 0.2.x — no SQL changed, so
`install-triggers` does not need a re-run. From 0.1.x follow the 0.2.0
steps below. Three behavior changes to know about:
- Soft-delete columns (`deleted_at`, `deletedAt`, `archived_at`, …) are
  now sent as changes.
- Upstash: `wrapQStashClient` now forwards `x-ezlogs-correlation-id`
  (was `x-correlation-id`); the worker side reads both, so messages
  queued by 0.2.x still link.
- A Server Action that returns a failure (`{ success: false, error }`)
  no longer reports `status_code: 500`; it has no status code, the
  failure is in `outcome` + `error_message`.

### Fixed — capture gaps
- **DB writes inside background jobs are captured under the job's
  action** (the request that enqueued it). `wrapBullWorker` now wraps
  the Worker's processor (BullMQ 4/5 `processFn`) instead of only
  listening to `completed` / `failed`; Trigger.dev, Supabase Queues and
  Upstash Workflow already ran the body in scope. Every job runner now
  sends the job's audit rows when the job finishes (before, nothing in
  a job process ever read them), claiming only rows written since the
  job started, so the enqueuing request keeps its own rows and nothing
  is sent twice when the reader can't DELETE. Inngest middleware can't
  wrap the body: `runInsideInngestCorrelation(event, fn)` now does, and
  flushes. BullMQ control flow (`DelayedError`, `WaitingError`,
  `WaitingChildrenError`, rate limiting) is re-thrown without a failure
  event; failures where the processor never ran (`maxStartedAttempts`)
  are still reported via the `failed` event, once. Verified against
  real Redis on BullMQ 5.76 and 6.7 (CI runs both): processor swap,
  abort-signal passing, control-flow errors, rate limiting, sandboxed
  processors, concurrency isolation. A Worker without BullMQ's
  `processFn` / `callProcessJob` internals falls back to the 0.2.x
  `completed` / `failed` listeners (job events only), with one debug
  log.
- **Upstash Workflow runs started with `Client.trigger()`** join the
  request that started them: new `wrapWorkflowClient(client)` sends
  the correlation id as a user header, which Upstash re-sends on every
  step. Before, each step delivery became its own URL-titled action.
  `captureWorkflowRequest` accepts only the agent's id format, at most
  24 hours old (it runs inside `serve()`, after the QStash signature
  check; other inbound ids keep the 1-hour limit).
- **json/jsonb changes** are sent per changed leaf as dotted keys
  (`settings.integration_testing_mode: false → true`, depth ≤ 3, ≤ 20
  leaves per column, ≤ 5 when the old value is unknown) instead of
  being dropped. Sensitive nested keys are dropped; secret-shaped
  string values (JWTs, API keys, private keys, card numbers) are
  masked.
- **Record names on DB events.** `display_name` falls back from `name`
  / `title` / `number` to `label` and the record's own number column
  (`invoice_number` on `invoices`), so updates and deletes can name the
  record. Person columns (email, first / last / full name) are never
  used: `display_name` becomes the record name on default (redacted)
  shares and embeds, which mask people. Use `displayNameFor` to opt a
  model in. Never a sensitive column.
- **Prisma extension without triggers:** updates no longer send
  `from: null` (rendered as "changed from empty"); `from` is omitted
  when unknown. Creates send the returned row (DB defaults such as
  `status: "draft"`) over `args.data` (columns a `select` left out),
  deletes the deleted row.
- **Prisma `@@map` duplicates:** with the trigger path wired, the
  extension compared the model name (`Project`) with tracked table
  names (`projects`) and emitted a second, thinner event. It now uses
  the model's table name from Prisma's runtime data model.
- **Soft deletes** were ignored, so a soft delete produced no DB event.
- **Trigger timestamps** from `timestamp without time zone` columns
  (read from the catalog once per table; `*_at` / `*At` names if the
  catalog can't be read) are sent as UTC (`…Z`); they were read as
  local time. Assumes the database session time zone is UTC for values
  Postgres fills in itself (`DEFAULT now()`), the hosted default.
- **Join tables** with a composite primary key get one resource id per
  single-column foreign key (looked up once per table), so the event
  says which records were linked. Such events carry no `display_name`
  (a join row's name must not label the linked record). The catalog
  lookup is retried after a minute if it fails.
- **HTTP:** a thrown route error reports `status_code: 500` (was
  missing); `redirect()` / `notFound()` / `forbidden()` thrown from a
  route or Server Action keep Next's status (307 / 308 / 404 / 403)
  and are not exceptions; a 4xx/5xx JSON response's `error` /
  `message` becomes `error_message` (≤ 200 chars; emails, card
  numbers, JWTs, bearer tokens, private keys and common API key
  prefixes masked) instead of "HTTP 403"; route params (`[id]`) are
  merged into `request_params`; Server Actions report `remote_ip`.
- **Background job `arguments`** (Rails gem parity): the job payload,
  sanitized with the Rails gem's rules, minus the agent's correlation
  key.

### Install
- `npx ezlogs-nextjs install-triggers` / `bunx ezlogs-nextjs …` now run
  the locally installed package (new `ezlogs-nextjs` bin; the old
  `install-triggers` bin still works). Before, npx / bunx found no
  `ezlogs-nextjs` bin locally and downloaded the published package.
  The CLI warns when it runs from outside your project's
  `node_modules`, resolves `pg` from your project, and explains how to
  install it when it is missing.
- README: "which database setup?" table (Supabase, Prisma, Drizzle,
  others), `allowInsecureTransport` for `http://` dev servers, dropped
  vs `"[FILTERED]"` wording.

### Not changed
- RSC / prefetch / `_next` requests stay excluded. Telemetry routes
  (analytics, beacon, vitals, heartbeat…) are still captured and left
  to the server's significance classifier, which already treats them as
  background.

## [0.2.0] — 2026-11-16

Wire format unchanged.

**Upgrade steps (Postgres trigger path), in this order:**
1. `npx ezlogs-nextjs install-triggers --tables=none` **before** deploying
   the new agent. Functions + `ezlogs_audit_log` only: it takes a brief
   lock on `ezlogs_audit_log` alone (writes to tracked tables wait for
   it for that moment), never on your own tables. It empties
   `ezlogs_audit_log` once (0.1.x never deleted rows; they were already
   sent) so the new agent doesn't re-send them — a table comment
   (`ezlogs:0.2`) marks it so later runs never empty it again — and
   locks the table down (RLS, revokes). Behavior is fully 0.2.0 from
   here.
2. Deploy the new agent right after. Rows the old agent already sent in
   between can appear twice.
3. Later, at a quiet moment: `npx ezlogs-nextjs install-triggers`
   (default) re-attaches each pre-0.2.0 trigger once, one table at a
   time (5s lock timeout), to get the fast sensitive-column path. Until
   then those triggers use the slower per-key check.

### Security
- **`ezlogs_audit_log` locked down.** Row-level security on, all
  privileges revoked from `PUBLIC` and Supabase's `anon` /
  `authenticated` (it was readable, writable and deletable through
  PostgREST with the anon key). `ezlogs_track` / `ezlogs_untrack` and
  the trigger function itself are no longer executable by them or
  `PUBLIC` (so no role can attach it to its own table and forge rows;
  already-tracked tables keep auditing). The trigger still writes
  (SECURITY DEFINER, owner bypasses RLS). A reader connecting as a
  different role than the installer needs `GRANT SELECT, DELETE` plus a
  policy; the agent logs one warning with the exact statements when it
  detects that case.
- **Inbound correlation ids are validated.** `x-ezlogs-correlation-id`
  from a request is honored only in the agent's own format
  (`ezl_<13-digit ms>_<8 hex>`) and only if under an hour old; anything
  else gets a fresh id.
- **Card numbers and PINs in positional args.** Luhn-valid 15-16 digit
  values are always masked, other card lengths (13-19) only for
  payment-named actions (`chargeCard`, `checkout`…), so 13-digit
  timestamps and long snowflake ids elsewhere stay visible; 4-8 digit
  values are masked when the action name has a secret word (`setPin`,
  `verifyOtp`, `verify2FA`, `addCard`).
- **Server Action positional arguments are masked.** Unnamed string
  arguments (`signIn(email, password)`) were sent as plaintext `arg0..n`.
  They are now `"[FILTERED]"` unless they have a strict id shape
  (integer, UUID, cuid, cuid2, ULID, nanoid-21).
  Numbers and booleans are kept. Object and FormData arguments keep
  their field names and go through key-based redaction.
- **More sensitive names.** New substring patterns: `passcode`,
  `cardnumber` (HTTP), and `credential`, `passwd`, `passcode`, `apikey`,
  `card_number`, `cardnumber`, `cvv`, `cvc` (DB). New whole-word
  patterns for both: `pin`, `otp`, `totp`, `iban`, `mfa`, `passphrase`.
  camelCase keys are now matched (`apiKey`, `mdmUnlockPin`).
- **Secret columns never reach `ezlogs_audit_log`.** The trigger drops
  sensitive columns before storing a row, and skips updates that only
  touch them.

### Fixed
- **Wrong actor / duplicated DB events under concurrency.** The
  snapshot fallback attributed untagged audit rows to whichever request
  was open (8 concurrent requests produced 35 DB events, each with the
  wrong user). Removed. A request now only emits rows tagged with its
  own correlation id; untagged rows are sent as their own actions, one
  per database transaction, without an actor.
- **Exact correlation for supabase-js / PostgREST writes.** The trigger
  reads the agent's `x-correlation-id` from PostgREST's
  `request.headers`, so `.from()` and `.rpc()` writes join the right
  request. Only the agent's own id format is accepted.
- **`ezlogs_audit_log` no longer grows forever.** Rows are deleted when
  sent; untagged / stale rows (under 24 hours old) are drained by a
  throttled sweep, as their own actions, timestamped with when the write
  happened (`captured_at`); rows older than 24 hours are deleted unsent
  (2k rows every 10 minutes, before the sweep), never re-sent.
- **Startup self-check.** If a Postgres URL is configured but `pg` is
  not installed, or `ezlogs_audit_log` does not exist, the agent logs
  one warning at init and does not run audit-log queries per request.
- **install-triggers no longer locks every table at once.** Each table
  is attached in its own transaction with a 5s lock timeout, and tables
  whose trigger is already current are skipped (no DROP TRIGGER).
- **Trigger cost.** Sensitive column names, the full column-name set
  and a pattern version are precomputed per table at attach time; the
  trigger uses them only while the row's column names still match
  exactly (else it checks every key by name, so renamed or added secret
  columns are still dropped). A 100k-row UPDATE takes ~3.3s with the
  trigger vs ~3.9s on 0.1.x (0.6s with no trigger), instead of ~19s
  with the per-key check.
- **Plain `PrismaClient` writes join the right request.** With
  `new PrismaClient().$extends(ezlogsPrisma())` + triggers, each write
  inside a captured request runs as
  `$transaction([set_config('ezlogs.correlation_id', …), query])`
  (Prisma's RLS-extension pattern), so trigger rows carry the request's
  correlation id. Reads are untouched. Only when the trigger reader is
  wired and the client is Postgres: MySQL / SQLite / SQL Server /
  MongoDB clients and setups without triggers are untouched (no extra
  round trip). An adapter without transactions (e.g. Neon HTTP) is
  detected on the first write, which still succeeds untagged; tagging
  then stays off with one warning. Writes inside a user
  `$transaction` are not tagged (shown as their own actions).
  `ezlogsPrisma()` now returns Prisma's callback-form extension;
  `prisma.$extends(ezlogsPrisma())` usage is unchanged. Verified on
  Prisma 5.22, 6.19 and 7.10 (7 with `@prisma/adapter-pg`).
- **Server Action ids kept.** Positional cuid / cuid2 / ULID / nanoid
  ids (strict shapes, with digit and case checks) are no longer masked.

### Removed
- `databaseSnapshotMode` is ignored (kept in the types, deprecated).
- `takeAuditSnapshot`, `runWithAuditSnapshotScope`,
  `currentAuditSnapshot` exports from `ezlogs-nextjs/triggers`.
  `readAuditRows` no longer takes a snapshot argument and now claims
  (deletes) the rows it returns.

### Added
- `sweepAuditLog`, `pruneAuditLog` exports from `ezlogs-nextjs/triggers`.
