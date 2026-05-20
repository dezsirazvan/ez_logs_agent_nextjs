# Troubleshooting

## No events showing up

1. **Confirm the agent initialized.** Look for this in your dev-server
   logs:

   ```
   [ezlogs] FlushScheduler started (interval 3000ms)
   ```

   If absent, `ezlogs.init` didn't run — check `instrumentation.ts`
   is at the project root (or `src/`) and that `process.env.NEXT_RUNTIME
   === "nodejs"` is true.

2. **Enable debug logging:**

   ```ts
   ezlogs.init({
     // ...
     logLevel: "debug",
   });
   ```

   Restart and watch for `[ezlogs] Transport send succeeded (202)`
   after each request.

3. **Verify network connectivity:**

   ```bash
   curl -I $EZLOGS_SERVER_URL
   ```

## `Module not found: Can't resolve './page.tsx.tsx'`

A Turbopack path-doubling bug. The agent guards against this on its
own rules; if you've customized `next.config.js` with your own
`turbopack.rules`, narrow your rule's content condition or scope.

## Auth events not captured

`/api/auth/*` is excluded by default for **GET / HEAD only** — NextAuth's
session-refresh polls would otherwise flood the dashboard. POST callbacks
(sign-in, sign-out, register) ARE captured. If you've added your own
exclusion that covers `POST`, remove it.

## Inline `"use server"` action not captured

The auto-wrap only fires on Next's conventional route filenames:
`page`, `layout`, `template`, `loading`, `error`, `default`,
`not-found`. If your inline action lives elsewhere, either move it
or wrap it manually with `captureServerAction`.

## HTTP 401 from the EZLogs server

1. Verify your API key in the EZLogs dashboard under
   **Settings → API Keys**.
2. Check for whitespace in `projectToken`: `"ezl_abc123"` not
   `" ezl_abc123 "`.
3. Confirm the key hasn't been revoked.

## Events appearing late

Normal. Events flush every 3 seconds by default. To reduce latency at
the cost of more network calls, set `sendInterval: 1000`.

## Buffer warnings

```
[ezlogs] Buffer full, dropping oldest event
```

Your app generates events faster than they can be sent. Increase
`bufferSize` or `sendInterval`, or disable a noisy capture type
(`captureDb: false` in a write-heavy app).

## "serverUrl is not HTTPS" warning

The agent warns at init time when `serverUrl` is `http://` against a
non-local host — a typo like `http://app.ezlogs.io` would silently
ship events in cleartext. If you're intentionally pointing at a
non-HTTPS internal endpoint, set `allowInsecureTransport: true` to
suppress.
