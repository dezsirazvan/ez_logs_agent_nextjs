# Changelog

All notable changes to `ezlogs-nextjs` are documented here.
Earlier releases (0.1.x) were not tracked in a changelog.

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
