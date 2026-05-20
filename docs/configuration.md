# Configuration reference

All options have sensible defaults. **Only `serverUrl` and `projectToken`
are required.**

## Minimal

```ts
ezlogs.init({
  serverUrl: "https://your-ezlogs-server.com",
  projectToken: "ezl_your_api_key_here",
});
```

## Full surface

```ts
ezlogs.init({
  // ==========================================
  // Required
  // ==========================================
  serverUrl: "https://your-ezlogs-server.com",
  projectToken: "ezl_your_api_key_here",

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
    // and `{success: false}` shapes. Override here only when needed.
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
| `app/**/route.{ts,tsx,js,jsx}` | `app-route-handler` | App Router route handlers (GET / POST / …) |
| `pages/api/**/*.{ts,tsx,js,jsx}` | `pages-api` | Pages Router API routes |
| `middleware.{ts,tsx,js,jsx}` (root + `src/`) | `middleware` | Your `middleware.ts` (correlation seeding) |
| `actions/**/*`, `app/**/actions.{ts,tsx}`, `app/**/actions/**/*` | `server-action` | File-level `"use server"` modules |
| `app/**/{page,layout,template,loading,error,default,not-found}.{ts,tsx,js,jsx}` | `inline-server-action` | Inline `"use server"` actions inside RSC components |
| `lib/supabase/**`, `utils/supabase/**` (+ `src/` variants) | `supabase-factory` | Rewrites Supabase factory imports to auto-instrument every client |

Files outside these conventional locations that use `"use server"`
won't be auto-wrapped. Wrap manually with `captureServerAction(fn, "name")`
or move the file under `actions/`.

The plugin is idempotent and safe to re-run. The loader fast-paths
files that don't contain `"use server"` so unrelated route files pay
zero overhead.

## Correlation propagation

Events are linked via a `correlation_id`. The agent threads it through:

- Request headers (`X-Ezlogs-Correlation-ID`)
- `AsyncLocalStorage` (Node runtime)
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
