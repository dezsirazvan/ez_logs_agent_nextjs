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
