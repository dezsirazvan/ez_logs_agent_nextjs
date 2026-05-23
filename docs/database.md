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

## Fallback: per-ORM adapters

When the trigger path isn't viable (PlanetScale, supabase-js, customers
who can't run the migration), per-ORM adapters keep working. They produce
`{ operation, model_class }` events without from-value diffs (Prisma /
Drizzle) or with single-id `resource_id` extraction (supabase-js
single-eq mutations).

| ORM | Import |
|---|---|
| Prisma | `import { ezlogsPrisma } from "ezlogs-nextjs/prisma"` |
| Drizzle | `import { ezlogsDrizzleLogger } from "ezlogs-nextjs/drizzle"` |
| supabase-js | `import { wrapSupabase } from "ezlogs-nextjs/supabase"` |

Trade-offs and known limitations are documented in
[../AGENT_PARITY_NOTES.md](../AGENT_PARITY_NOTES.md#database-capture--prisma-vs-activerecord).

## Sensitive-column filter

Any DB event shipped by the agent runs through a substring filter
against 18 patterns: `password`, `token`, `secret`, `api_key`,
`credit_card`, `ssn`, `social_security`, `encrypted`, `private_key`,
`public_key`, `signing_key`, `pem`, `cipher`, `nonce`, `salt`,
`digest`, `signature`, `hmac`. Columns matching any pattern (case-
insensitive substring) ship as `"[FILTERED]"`. The server applies the
same 18 patterns at ingest as a backstop.

Customers add their own column-name fragments via `excludedTables`
(coarse-grained) or a future column-level filter (planned).
