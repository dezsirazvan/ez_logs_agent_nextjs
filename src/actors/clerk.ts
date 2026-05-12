// Clerk actor extractor.
//
// Usage in a customer's instrumentation.ts:
//
//   import { ezlogs } from "@ezlogs/nextjs";
//   import { clerkActor } from "@ezlogs/nextjs/actors";
//
//   ezlogs.init({
//     // ...
//     actorFromRequest: clerkActor(),
//   });
//
// Lazy-imports `@clerk/nextjs/server` so the package isn't a hard
// peer dep — apps that don't use Clerk pay nothing. Errors swallowed
// (returns null) so a misconfigured Clerk install never crashes the
// host.

import type { ActorContext, ActorFromRequest } from "../configuration.js";
import { logger } from "../logger.js";

interface ClerkSessionClaims {
  email?: string;
  name?: string;
  username?: string;
  // Anything else we might find under publicMetadata or sessionClaims
  [key: string]: unknown;
}

interface ClerkAuthReturn {
  userId?: string | null;
  sessionClaims?: ClerkSessionClaims | null;
}

/**
 * Returns an `ActorFromRequest` that pulls the current user from
 * Clerk's `auth()` helper. Returns null when no user is signed in,
 * when `@clerk/nextjs` isn't installed, or on any internal error.
 *
 * Compose with other extractors when an app uses multiple providers:
 *
 *   actorFromRequest: async (req) =>
 *     (await clerkActor()(req)) ?? (await nextAuthActor(opts)(req)),
 */
export function clerkActor(): ActorFromRequest {
  return async (): Promise<ActorContext | null> => {
    try {
      // Dynamic import dodges static bundler resolution — `@clerk/nextjs`
      // is an optional peer dep. The dynamic-import shape is typed as
      // unknown so TypeScript doesn't try to type-check the module.
      const specifier = "@clerk/nextjs" + "/server";
      const mod = (await (Function(
        "s",
        "return import(s)",
      ) as (s: string) => Promise<unknown>)(specifier)) as {
        auth: () => Promise<ClerkAuthReturn> | ClerkAuthReturn;
      };
      if (typeof mod?.auth !== "function") return null;

      const result = await Promise.resolve(mod.auth());
      const userId = result?.userId;
      if (typeof userId !== "string" || userId.length === 0) return null;

      const claims = result?.sessionClaims ?? {};
      const label =
        (typeof claims.email === "string" && claims.email) ||
        (typeof claims.name === "string" && claims.name) ||
        (typeof claims.username === "string" && claims.username) ||
        undefined;

      return label ? { id: userId, label } : { id: userId };
    } catch (error) {
      // `@clerk/nextjs` not installed, or `auth()` threw. Either way
      // we degrade silently — the host app must never crash because of
      // an actor extractor.
      logger.debug(
        `clerkActor: extraction failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  };
}
