# Database capture

Two paths. Pick the one that fits your stack. Both emit the same
`database_callback` event shape, so the EZLogs server treats them
identically.

## Recommended: Postgres triggers

If your app talks to Postgres directly (Prisma with `@prisma/adapter-pg`,
Drizzle node-postgres, raw `pg`), this gives you **real from→to diffs**
without per-mutation boilerplate.

One-time setup:

```bash
npx ezlogs-nextjs install-triggers
```

That command introspects your schema and tracks every business table
automatically. Migration tables (`_prisma_migrations`,
`schema_migrations`), session tables (`Session`, `sessions`), and the
agent's own audit table are skipped — the output lists exactly what
got tracked. Flags:

- `--tables=<a,b,c>` — explicit allowlist.
- `--tables=none` — install infrastructure only, opt rows in later.
- `--print` — dump the SQL without applying.

Wire the reader in `instrumentation.ts`:

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

Your existing `prisma.post.create(...)` / `db.update(users)...` /
`pool.query("INSERT ...")` calls now produce full-fidelity events with
actor + correlation + diffs.

If you've already set `DATABASE_URL` in your environment, the agent
auto-detects it and wires the pool itself — you don't have to supply
the `databaseReader` / `patchDatabaseClient` options at all. Pass them
explicitly only when you need a non-default pool or when you're not on
a conventional connection-string env var.

## Prisma (plain `PrismaClient`, the default) — recommended

Prisma's default engine opens its own connections, so the agent can't
`SET LOCAL` on them. Add the extension next to the triggers:

```ts
import { PrismaClient } from "@prisma/client";
import { ezlogsPrisma } from "ezlogs-nextjs/prisma";

export const prisma = new PrismaClient().$extends(ezlogsPrisma());
```

Inside a captured request, every write (`create`, `createMany`,
`createManyAndReturn`, `update`, `updateMany`, `upsert`, `delete`,
`deleteMany`, `$executeRaw`, `$executeRawUnsafe`) runs as

```ts
client.$transaction([
  client.$executeRawUnsafe("SELECT set_config('ezlogs.correlation_id', $1, TRUE)", id),
  query(args),
]);
```

— Prisma's documented RLS client-extension pattern. The trigger reads
the setting, so the row joins the request's action with its actor.
Reads (`find*`, `count`, `aggregate`, `$queryRaw`) are untouched. Cost:
one extra round trip per write.

**Not tagged:** writes inside your own `prisma.$transaction(...)`
(interactive or batch). Prisma can't nest a transaction there, so the
extension runs the query as-is (detected via Prisma's internal
`__internalParams.transaction`). Those rows still appear, as their own
actions without an actor — never attributed to another request. If a
future Prisma stops exposing `__internalParams`, the extension stops
tagging altogether rather than risk a nested transaction.

Verified against real Postgres on Prisma 5.22, 6.19 and 7.10 (CI runs
all three). Prisma 7 has no Rust engine, so the client needs a driver
adapter (`new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`);
the same `$extends(ezlogsPrisma())` line tags its writes.

With triggers installed and a `databaseReader` wired, the extension's
own event emits are suppressed for tracked tables; the trigger rows
(with real before/after values) are the single source.

## Prisma (`@prisma/adapter-pg`)

Prisma's driver-adapter mode runs queries through a NAPI engine
boundary that breaks AsyncLocalStorage propagation. Without an extra
step the agent's correlation id never reaches the adapter, so audit
rows from `prisma.foo.create(...)` calls land with NULL
`correlation_id` even though the request itself is correctly scoped.

Wire two wrappers at the place you construct your Prisma client:

```ts
// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  patchPrismaClient,
  patchPrismaPgAdapter,
} from "ezlogs-nextjs/prisma";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const adapter = patchPrismaPgAdapter(new PrismaPg(pool));
export const prisma = patchPrismaClient(
  new PrismaClient({ adapter }),
  adapter,
);
```

What each wrapper does:

- **`patchPrismaPgAdapter(adapter)`** replaces the adapter's
  `queryRaw` / `executeRaw` / `transactionContext` methods so each
  one runs the original inside a snapshot stored on the adapter
  instance.

- **`patchPrismaClient(client, adapter)`** wraps the PrismaClient in
  a Proxy that, before each method call, takes an
  `AsyncLocalStorage.snapshot()` of the current request scope,
  deposits it on the adapter, and clears it once the method's
  promise settles.

The Proxy serializes Prisma method calls per-adapter via an internal
Promise mutex so the snapshot deposited for THIS call is what the
adapter wrap reads — not one set by a concurrent call. The cost is
real per-adapter throughput: 10 concurrent Prisma calls on one
adapter become 10 sequential calls. For the v0.1.x line we accept
that cost for correlation correctness; a future version may relax
this to per-tx-context or use an engine-aware approach.

Without `patchPrismaPgAdapter` the `patchPrismaClient` wrap falls
back to a best-effort snapshot-on-the-PrismaClient-call path that
empirically does NOT survive the engine boundary on PrismaPg. Agent
logs `patchPrismaClient: adapter is not the output of
patchPrismaPgAdapter(). Correlation_id will be NULL on concurrent
requests.` in dev.

Drizzle and raw `pg` users do NOT need any wrappers: the agent's
existing `patchPgClient` already handles those paths because there's
no engine boundary between the caller and `pg.Client.prototype.query`.

## What a DB event carries

- **Changes**: from→to per column. json/jsonb columns are diffed per
  leaf and sent as dotted keys (`settings.integration_testing_mode:
  false → true`), up to 3 levels deep and 20 leaves per column (5 when
  the old value is unknown, e.g. the Prisma extension). Secret-shaped
  string values (JWTs, API keys, private keys, card numbers) are
  masked. Bookkeeping leaves are dropped (`created_at` / `updated_at`
  style keys, `synced_at` / `last_updated_at` / `modified_at` stamps,
  numeric `version` / `lock_version` / `__v` counters), so
  `field_sources.name.updated_at` never shows up; value changes come
  before keys that were added or removed, and the record's own columns
  come before any dotted leaf.
- **Soft deletes** (`deleted_at`, `archived_at`, …) are normal changes
  and are sent (they were ignored before 0.3.0). Only `id`,
  `created_at` / `createdAt`, `updated_at` / `updatedAt` and Auth.js'
  `emailVerified` / `expires` are left out.
- **Timestamps** from `timestamp without time zone` columns (looked up
  in the catalog once per table) are sent as UTC (`…Z`), which is how
  Prisma and Drizzle store them. Values Postgres fills in itself
  (`DEFAULT now()`) use the session time zone: UTC on hosted Postgres;
  if your server runs another zone those are off by that offset.
- **Display name** (`display_name`), so updates and deletes can say
  which record: `displayNameFor` from your config, else the first of
  `name`, `title`, `number`, `label`, the record's own `<model>_number`
  (`invoice_number` on `invoices`). Person columns (email, first / last
  / full name) are never used by default, because the record name is
  shown on default (redacted) shares and embeds; opt a model in with
  `displayNameFor`. Sensitive columns are never used.
- **Join tables** with a composite primary key (`asset_tags`) get one
  resource id per single-column foreign key, typed by the referenced
  table, so the event says which records were linked.

## Fallback: per-ORM adapters

When the trigger path isn't viable (PlanetScale, MySQL, customers who
can't run the migration), per-ORM adapters keep working. They produce
`{ operation, model_class }` events without from-value diffs (Prisma /
Drizzle) or with single-id `resource_id` extraction (supabase-js
single-eq mutations). The Prisma extension sends the new value of each
updated column with no `from` (the old value is unknown, not empty),
the full returned row on create (DB defaults included) and the deleted
row on delete.

| ORM | Import |
|---|---|
| Prisma | `import { ezlogsPrisma } from "ezlogs-nextjs/prisma"` |
| Drizzle | `import { ezlogsDrizzleLogger } from "ezlogs-nextjs/drizzle"` |
| supabase-js | `import { wrapSupabase } from "ezlogs-nextjs/supabase"` |

Trade-offs and known limitations are documented in
[../AGENT_PARITY_NOTES.md](../AGENT_PARITY_NOTES.md#database-capture--prisma-vs-activerecord).

## Sensitive-column filter

Sensitive columns are dropped (not sent at all). Patterns, matched
case-insensitively against the column name and its snake_case form
(`apiKey` → `api_key`):

Nested json/jsonb keys get the same check (`settings.api_key` is
dropped). Request params and job arguments use a key rule too, but
there matching values are kept as `"[FILTERED]"` instead of dropped.

- substring: `password`, `token`, `secret`, `api_key`, `credit_card`,
  `ssn`, `social_security`, `encrypted`, `private_key`, `public_key`,
  `signing_key`, `pem`, `cipher`, `nonce`, `salt`, `digest`,
  `signature`, `hmac`, `credential`, `passwd`, `passcode`, `apikey`,
  `card_number`, `cardnumber`, `cvv`, `cvc`
- whole word: `pin`, `otp`, `totp`, `iban`, `mfa`, `passphrase`
  (`mdm_unlock_pin` matches, `shipping` does not)

On the trigger path the filter runs **inside the trigger**
(`ezlogs_is_sensitive_key()` in `00_install.sql`), so these values are
never stored in `ezlogs_audit_log`. The agent applies the same list
again before sending (for the per-ORM adapters too), and the server
redacts at ingest as a backstop.

## Correlation and retention (trigger path)

- A row is grouped with a request only when it carries that request's
  correlation id: set via `SET LOCAL` on `pg` connections, or read from
  PostgREST's `request.headers` (`x-correlation-id`, injected by the
  agent into every outgoing fetch) for supabase-js. Only the agent's
  own id format is trusted.
- Untagged rows (Prisma without `ezlogsPrisma()` or inside your own `$transaction`, postgres.js, scripts) are
  never attributed to an unrelated request. They are sent as their own
  actions, one per database transaction, without an actor. 0.1.x's
  `databaseSnapshotMode` guessed instead and was removed (the option is
  ignored). If writes made while requests (or jobs) run in a process
  keep arriving untagged and that process has never sent a tagged row,
  the agent logs one warning naming the fix (usually
  `$extends(ezlogsPrisma())`, or `ezlogs.init` missing in a worker).
- Rows are deleted when sent. A sweep (≤ once per 10 s per process)
  sends untagged rows and tagged rows older than 5 minutes, but only
  rows under 24 hours old, timestamped with when the write happened;
  rows older than 24 hours are deleted unsent. The audit log does not record which EZLogs
  project a row belongs to: rows left over from before a token switch
  or a restored snapshot are sent by whichever project reads next. Use
  one project per database.
- **Upgrading:** run `npx ezlogs-nextjs install-triggers --tables=none`
  before deploying a new agent version (functions + `ezlogs_audit_log`
  only; a brief lock on that table, none on yours). A plain re-run also
  re-attaches outdated triggers, one table per transaction with a 5s
  lock timeout — do that at a quiet moment. See CHANGELOG.md for the
  0.1.x → 0.2.0 steps.
- **Schema changes after `ezlogs_track`** (a column added, dropped or
  renamed — e.g. `notes` renamed to `password_hash`): the trigger sees
  the column names no longer match what it was attached with and checks
  every key by name (~60µs per row image instead of a few µs), so a new
  secret column is still dropped. Re-running `install-triggers` (or
  `SELECT ezlogs_track('t')`) re-attaches it and restores the fast path.
  The same happens when a new agent version changes the pattern lists
  (`ezlogs_patterns_version()`).

## Access to `ezlogs_audit_log`

The install enables row-level security and revokes everything from
`PUBLIC` and Supabase's `anon` / `authenticated`, so the table is not
reachable through PostgREST. The role that ran the install owns the
table; the trigger (SECURITY DEFINER) and a reader connecting as that
role bypass RLS. If the agent's `DATABASE_URL` uses a different role:

```sql
GRANT SELECT, DELETE ON ezlogs_audit_log TO app_reader;
CREATE POLICY ezlogs_reader ON ezlogs_audit_log TO app_reader USING (true);
```

Exclude whole tables with `excludedTables`.
