# Configuration reference

All options have sensible defaults. **Only `projectToken` is required.**
`serverUrl` defaults to `process.env.EZLOGS_SERVER_URL` if set, otherwise
`https://app.ezlogs.io`.

## Minimal

```ts
ezlogs.init({
  projectToken: "ezl_your_api_key_here",
});
```

## Full surface

```ts
ezlogs.init({
  // ==========================================
  // Required
  // ==========================================
  projectToken: "ezl_your_api_key_here",

  // Optional. Default: process.env.EZLOGS_SERVER_URL, else
  // "https://app.ezlogs.io". Set only if you self-host.
  serverUrl: "https://your-ezlogs-server.com",

  // ==========================================
  // Event capture toggles (all default true)
  // ==========================================
  captureHttp: true,
  captureDb: true,
  captureJobs: true,

  // ==========================================
  // Pipeline tuning (defaults match the Ruby agent)
  // ==========================================
  bufferSize: 10_000,    // events held in memory (drop-oldest when full)
  sendInterval: 3_000,   // ms between automatic flushes
  retryAttempts: 3,      // exponential backoff: 0.5s → 1s → 2s → 4s
                         //                       (capped at 5s, ±20% jitter)

  // ==========================================
  // Exclusion lists (MERGED with built-in defaults)
  // ==========================================
  // A request on an excluded path is not captured, and (with captureHttp on)
  // neither are the orphan DB writes its route handler makes while it runs;
  // a job run there keeps its events.
  excludedPaths: ["/admin/preview*", "/internal/*"],
  excludedTables: ["audit_logs", "versions"],
  excludedJobClasses: ["app/internal/heartbeat"],
  excludedGraphqlOperations: ["IntrospectionQuery"],
  excludedGraphqlVariableKeys: ["password", "creditCard"],

  // ==========================================
  // Actor (who triggered the event) — see docs/auth.md
  // ==========================================
  actorFromRequest: clerkActor(),

  // ==========================================
  // Display names (human-readable resource labels)
  // ==========================================
  displayNameFor: {
    User: "email",     // "User created 'jessica@example.com'"
    Order: "number",   // "Order updated '#ORD-1234'"
    Product: "name",   // "Product deleted 'Premium Plan'"
  },

  // ==========================================
  // Database triggers (Postgres, optional) — see docs/database.md
  // ==========================================
  databaseReader: (sql, params) => pool.query(sql, params),
  patchDatabaseClient: pg,

  // ==========================================
  // Server Action failure classification
  // ==========================================
  isServerActionError: (result) => {
    // Built-ins handle next-safe-action, zsa, Conform, Zod safeParse,
    // `{success: false, error}`, `{error: "…"}` and `{errors: …}`
    // form-state shapes. Override here only when needed.
    if (result?.code === "VALIDATION_FAILED") {
      return { errorMessage: result.message };
    }
    return null;
  },

  // ==========================================
  // Outgoing fetch correlation injection (default true)
  // ==========================================
  patchGlobalFetch: true,

  // ==========================================
  // Transport
  // ==========================================
  allowInsecureTransport: false, // suppress the HTTP-not-HTTPS warning

  // ==========================================
  // Logging
  // ==========================================
  logLevel: "info", // "debug" | "info" | "warn" | "error" | "silent"
});
```

## Auto-wrap coverage

The build plugin (`withEzlogsConfig`) auto-wraps these file patterns
at build time. Both Webpack and Turbopack are supported.

| Pattern | Loader kind | What it wraps |
|---|---|---|
| `app/**/route.{ts,tsx,js,jsx}` | `app-route-handler` | App Router route handlers (GET / POST / …): `export async function GET`, `export const GET =`, `export { handler as GET }` and `export const { GET, POST } = handlers` (Auth.js v5) |
| `pages/api/**/*.{ts,tsx,js,jsx}` | `pages-api` | Pages Router API routes |
| `middleware.{ts,tsx,js,jsx}` (root + `src/`) | `middleware` | Your `middleware.ts` (correlation seeding) |
| `proxy.{ts,tsx,js,jsx}` (root + `src/` only) | `proxy` | Next 16's `proxy.ts` (`export function proxy` or a default export), same as middleware |
| `actions/**/*`, `app/**/actions.{ts,tsx}`, `app/**/actions/**/*` | `server-action` | File-level `"use server"` modules |
| `app/**/{page,layout,template,loading,error,default,not-found}.{ts,tsx,js,jsx}` | `inline-server-action` | Inline `"use server"` actions inside RSC components |
| Any other server file that imports an instrumented library | `instrumented-imports` | Library imports (below) |

Every server file the plugin reaches (all of the above, and any other
file that imports one of these libraries) gets its named imports of
them instrumented. `import { X } from "lib"` (aliases included) becomes
the original import plus `const X = <the agent's replacement>(original)`
on the same line:

| Module | Names |
|---|---|
| `@upstash/workflow/nextjs` | `serve`, `servePagesRouter`, `createWorkflow`, `createWorkflowPagesRouter`, `serveMany`, `serveManyPagesRouter` |
| `@upstash/workflow` | `serve`, `Client` |
| `@upstash/qstash` | `Client` |
| `bullmq` | `Queue`, `Worker` |
| `inngest` | `Inngest` |
| `@supabase/supabase-js` | `createClient` |
| `@supabase/ssr` | `createServerClient` |

Type-only imports (and names a file uses only as types), text in
comments and strings, client components (`"use client"`), the root
`middleware` / `proxy` file, `node_modules`, `import * as` and
`require()` are left alone. Each
replacement keeps the original's behavior (a class stays a class:
`new`, `instanceof`, statics and subclasses work) and falls back to the
original on anything unexpected.

Files outside these conventional locations that use `"use server"`
won't be auto-wrapped. Wrap manually with `captureServerAction(fn, "name")`
or move the file under `actions/`.

The plugin is idempotent and safe to re-run. The loader fast-paths
files that don't contain `"use server"` so unrelated route files pay
zero overhead.

## Correlation propagation

Events are linked via a `correlation_id`. The agent threads it through:

- Request headers (`X-Ezlogs-Correlation-ID`)
- `AsyncLocalStorage` (Node runtime). In a plain ESM process (`"type": "module"`,
  e.g. a BullMQ worker) this needs Node >= 20.16 or >= 22.3; on older Node
  the agent warns once at startup that concurrent work can share a
  correlation id.
- Platform fallbacks (`x-vercel-id`, `cf-ray`, `x-request-id`) for apps
  without `middleware.ts`
- Postgres `SET LOCAL` on the wrapped connection (when using
  `patchDatabaseClient`)
- Job-runner metadata for BullMQ / Inngest / Trigger.dev / QStash

**Best-effort, not guaranteed.** Cron-triggered jobs, console operations,
and cross-process job chains across cold-started serverless functions
may produce events without correlation. Those events still get captured;
they just appear as separate Actions on the dashboard.

Wire-format invariants and every intentional deviation between the
Node agent and the Ruby agent live in
[../AGENT_PARITY_NOTES.md](../AGENT_PARITY_NOTES.md).
