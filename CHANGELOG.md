# Changelog

All notable changes to `ezlogs-nextjs` are documented here.
Earlier releases (0.1.x) were not tracked in a changelog.

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
