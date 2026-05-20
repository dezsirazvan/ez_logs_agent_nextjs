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
