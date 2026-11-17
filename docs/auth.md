# Actor extraction

EZLogs tracks **who** triggered each action. The agent ships built-in
extractors for the four most common Next.js auth providers, lazy-imported
so apps that don't use a given provider pay nothing at runtime.

Wire the extractor in `ezlogs.init()` via `actorFromRequest`.

## Clerk

```ts
import { clerkActor } from "ezlogs-nextjs/actors";

ezlogs.init({
  // ...
  actorFromRequest: clerkActor(),
});
```

## NextAuth.js (v4)

```ts
import { nextAuthActor } from "ezlogs-nextjs/actors";
import { authOptions } from "@/lib/auth";

ezlogs.init({
  // ...
  actorFromRequest: nextAuthActor({ authOptions }),
});
```

## Auth.js (v5)

```ts
import { authJsActor } from "ezlogs-nextjs/actors";
import { auth } from "@/auth";

ezlogs.init({
  // ...
  actorFromRequest: authJsActor({ auth }),
});
```

## Supabase Auth

No opt-in needed. The agent resolves the current user via `auth.getUser()`
automatically once any Supabase client is wrapped. Disable via
`actorFromSupabase: false` if you'd rather supply your own resolution.

## Custom JWT / bearer token

For your own session cookie or `Authorization: Bearer …` header,
verify the token in the hook and return the user. The hook receives a
`Request` (route handlers) or an object with Web `Headers` as
`headers` (Server Actions, Pages Router API routes), so read headers
only:

```ts
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

ezlogs.init({
  // ...
  actorFromRequest: async (request) => {
    const cookie = request.headers.get("cookie") ?? "";
    const token =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, secret);
      return { id: String(payload.sub), label: payload.email as string | undefined };
    } catch {
      return null; // expired / invalid: no actor rather than a wrong one
    }
  },
});
```

- **`id`** (required) is the stable key the dashboard groups an
  actor's activity by: your user id, never something that changes.
- **`label`** (optional) is what people read: "Ivy Tran" or an email.
  Leave it out and the dashboard shows the id. The label is masked on
  default (redacted) share links and embeds.
- Return `null` when there is no valid session. Never decode a token
  without verifying it.
- The hook runs before your route or Server Action. A sign-in sets
  the session cookie in its response, so the sign-in itself has no
  actor; the requests after it do.

## Custom / composing

```ts
actorFromRequest: async (request) => {
  return (
    (await clerkActor()(request)) ??
    (await nextAuthActor({ authOptions })(request))
  );
}
```

The hook returns `{ id: string, label?: string }` or `null`.
**Missing data is acceptable; wrong data is not** — the agent never
guesses an identity it can't prove.
