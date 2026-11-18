// Runtime side of the plugin's instrumented imports.
//
// The build plugin rewrites `import { X } from "<library>"` in the app's
// server files to `const X = __ezlogsInstrument("<library>#X", original)`
// (see INSTRUMENTED_IMPORTS in nextjs-plugin/loader.ts). Each adapter
// module exports one `__ezlogsInstrument`, built here from a table of
// replacements, so the library-specific behavior lives in plain,
// tested runtime code and the loader stays a generic rewrite.
//
// Every replacement fails open: anything unexpected returns the
// original export (or instance) unchanged. The app must never break
// because of the agent.

import { logger } from "./logger.js";

type Replace = (original: unknown) => unknown;

/** `(key, original) => replacement`, with the original kept on any surprise. */
export function instrumentFrom(replacements: Record<string, Replace>): (key: string, original: unknown) => unknown {
  return (key, original) => {
    const replace = Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : undefined;
    if (!replace) return original;
    try {
      return replace(original) ?? original;
    } catch (error) {
      logger.debug(`instrument ${key} failed (${error instanceof Error ? error.message : String(error)}); using the original`);
      return original;
    }
  };
}

/**
 * The class, with every instance passed through `wrapInstance` (which
 * patches it in place and returns it). `new`, subclasses, statics and
 * `instanceof` behave as with the original class.
 */
export function instrumentClass(
  original: unknown,
  wrapInstance: (instance: object) => unknown,
  mapArgs?: (args: unknown[]) => unknown[],
): unknown {
  if (typeof original !== "function") return original;
  return new Proxy(original, {
    construct(target, args, newTarget) {
      let callArgs = args;
      if (mapArgs) {
        try {
          callArgs = mapArgs(args);
        } catch {
          callArgs = args;
        }
      }
      const instance = Reflect.construct(target, callArgs, newTarget) as object;
      try {
        return (wrapInstance(instance) as object | null) ?? instance;
      } catch {
        return instance;
      }
    },
  });
}

/** The factory, with every returned value passed through `wrapResult`. */
export function instrumentFactory(original: unknown, wrapResult: (value: unknown) => unknown): unknown {
  if (typeof original !== "function") return original;
  const factory = original as (...args: unknown[]) => unknown;
  return new Proxy(factory, {
    apply(target, thisArg, args) {
      const value = Reflect.apply(target, thisArg, args);
      try {
        return wrapResult(value) ?? value;
      } catch {
        return value;
      }
    },
  });
}
