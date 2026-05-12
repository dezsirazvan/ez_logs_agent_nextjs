// ezlogs-nextjs/actors — built-in actor extractors for the most
// common Next.js auth providers. Each adapter is a one-line opt-in:
//
//   import { clerkActor }    from "ezlogs-nextjs/actors";
//   import { nextAuthActor } from "ezlogs-nextjs/actors";
//   import { authJsActor }   from "ezlogs-nextjs/actors";
//
//   ezlogs.init({ actorFromRequest: clerkActor() });
//
// Compose them when an app uses multiple providers:
//
//   actorFromRequest: async (req) =>
//     (await clerkActor()(req)) ?? (await nextAuthActor({ authOptions })(req)),
//
// Lazy-imports the auth SDK at runtime so it stays an optional peer
// dep — apps that don't use a given provider pay nothing. A failed
// extraction returns null and never crashes the host.

export { clerkActor } from "./clerk.js";
export { nextAuthActor } from "./next-auth.js";
export type { NextAuthActorOptions } from "./next-auth.js";
export { authJsActor } from "./auth-js.js";
export type { AuthJsActorOptions } from "./auth-js.js";
