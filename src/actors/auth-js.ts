// Auth.js v5 actor extractor.
//
// Usage in a customer's instrumentation.ts:
//
//   import { ezlogs } from "ezlogs-nextjs";
//   import { authJsActor } from "ezlogs-nextjs/actors";
//   import { auth } from "@/auth";  // user's Auth.js v5 helper
//
//   ezlogs.init({
//     // ...
//     actorFromRequest: authJsActor({ auth }),
//   });
//
// Auth.js v5 colocates the auth helper in the user's own `auth.ts`,
// so the customer passes their own `auth` import in. No dynamic
// import — there's no shared module path to resolve from.

import type { ActorContext, ActorFromRequest } from "../configuration.js";
import { logger } from "../logger.js";

interface AuthJsSessionUser {
  id?: string | null;
  email?: string | null;
  name?: string | null;
}

interface AuthJsSession {
  user?: AuthJsSessionUser | null;
}

export interface AuthJsActorOptions {
  /**
   * The user's `auth()` helper from their `auth.ts` config (Auth.js v5+).
   * Called with no arguments; returns the current session or null.
   */
  auth: () => Promise<AuthJsSession | null> | AuthJsSession | null;
}

/**
 * Returns an `ActorFromRequest` that resolves the current user via
 * the user-supplied Auth.js v5 `auth()` helper. Returns null on no
 * session or on any thrown error.
 */
export function authJsActor(options: AuthJsActorOptions): ActorFromRequest {
  return async (): Promise<ActorContext | null> => {
    try {
      const session = await Promise.resolve(options.auth());
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
        `authJsActor: extraction failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  };
}
