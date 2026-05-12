// NextAuth.js (v4) actor extractor.
//
// Usage in a customer's instrumentation.ts:
//
//   import { ezlogs } from "@ezlogs/nextjs";
//   import { nextAuthActor } from "@ezlogs/nextjs/actors";
//   import { authOptions } from "@/lib/auth";  // user's NextAuth config
//
//   ezlogs.init({
//     // ...
//     actorFromRequest: nextAuthActor({ authOptions }),
//   });
//
// Lazy-imports `next-auth/next` so apps that don't use NextAuth pay
// nothing. For Auth.js v5+ apps that colocate `auth.ts` with the app,
// use `authJsActor` instead.

import type { ActorContext, ActorFromRequest } from "../configuration.js";
import { logger } from "../logger.js";

interface NextAuthSessionUser {
  id?: string | null;
  email?: string | null;
  name?: string | null;
}

interface NextAuthSession {
  user?: NextAuthSessionUser | null;
}

export interface NextAuthActorOptions {
  /**
   * The same NextAuth config the customer passes to the auth handler
   * (`/api/auth/[...nextauth]/route.ts`). We pass it straight through
   * to `getServerSession`.
   */
  authOptions: unknown;
}

/**
 * Returns an `ActorFromRequest` that resolves the current user via
 * `getServerSession(authOptions)`. Returns null on no session, on any
 * thrown error, or when `next-auth` isn't installed.
 */
export function nextAuthActor(
  options: NextAuthActorOptions,
): ActorFromRequest {
  return async (): Promise<ActorContext | null> => {
    try {
      // `next-auth/next` is the v4 server-side entry point. Dynamic
      // import dodges bundler resolution since `next-auth` is an
      // optional peer dep.
      const specifier = "next-auth" + "/next";
      const mod = (await (Function(
        "s",
        "return import(s)",
      ) as (s: string) => Promise<unknown>)(specifier)) as {
        getServerSession: (opts?: unknown) => Promise<NextAuthSession | null>;
      };
      if (typeof mod?.getServerSession !== "function") return null;

      const session = await mod.getServerSession(options.authOptions);
      const user = session?.user;
      if (!user) return null;

      const id = (user.id ?? user.email) || null;
      if (typeof id !== "string" || id.length === 0) return null;

      const label =
        (typeof user.name === "string" && user.name) ||
        (typeof user.email === "string" && user.email) ||
        undefined;

      return label ? { id, label } : { id };
    } catch (error) {
      logger.debug(
        `nextAuthActor: extraction failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  };
}
