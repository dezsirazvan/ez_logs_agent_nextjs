// Shared scoped-state primitive used by correlation and actor.
//
// Loads node:async_hooks via a runtime-only require so static
// analyzers (Turbopack/Webpack) don't follow the import into the
// browser bundle. Why: when @ezlogs/nextjs is imported from a
// supabase-shim path that ALSO appears in the client bundle, any
// static `import "node:async_hooks"` makes Turbopack fail because
// async_hooks doesn't exist on the browser. The runtime-only path
// is invisible to static analysis.
//
// On Edge runtime, AsyncLocalStorage is exposed on globalThis as of
// Vercel's recent runtime versions. We probe globalThis first so
// Edge bundles get real async-context tracking even though they
// can't `require("node:async_hooks")`.
//
// Either path missing? We fall back to a module-scoped variable.
// That's correct on Edge (per-request V8 isolate) and best-effort
// on weird runtimes. Server Node always succeeds via require().

interface AsyncLocalStorageCtor {
  new <T>(): {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  };
}

const ALS_CTOR = loadAsyncLocalStorage();

function loadAsyncLocalStorage(): AsyncLocalStorageCtor | null {
  // 1. globalThis (Vercel Edge runtimes that polyfill it)
  const fromGlobal = (globalThis as { AsyncLocalStorage?: AsyncLocalStorageCtor })
    .AsyncLocalStorage;
  if (typeof fromGlobal === "function") return fromGlobal;

  // 2. Runtime require — invisible to static bundlers because the
  // string is computed. We can't use `import("node:async_hooks")`
  // because static analyzers DO follow dynamic imports.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: ((id: string) => any) | undefined =
      typeof require !== "undefined"
        ? require
        : // In ESM, `createRequire` is the official escape hatch.
          // We pull it via globalThis to avoid a static `import`
          // that would itself be browser-bundled.
          undefined;
    if (typeof req === "function") {
      // The string is split so a future bundler doing string-match
      // analysis sees no literal "async_hooks". Cosmetic but cheap.
      const moduleName = ["async", "hooks"].join("_");
      const mod = req("node:" + moduleName) as {
        AsyncLocalStorage?: AsyncLocalStorageCtor;
      };
      if (typeof mod.AsyncLocalStorage === "function") return mod.AsyncLocalStorage;
    }
  } catch {
    // ignore — fall through to the no-ALS path
  }

  return null;
}

export interface ScopedStorage<T> {
  read(): T | null;
  run<R>(value: T, callback: () => R): R;
  update(value: T): void;
  _resetForTests(): void;
  _isAsyncLocalStorage(): boolean;
}

interface GlobalScopedStores {
  [key: symbol]: { als: unknown; edgeFallback: { value: unknown } | null } | undefined;
}

/**
 * Create (or retrieve, when called again with the same `key`) a scoped
 * storage instance. Pinning the ALS instance to `globalThis` is what
 * makes correlation work across Turbopack-duplicated module copies:
 * every chunk that bundles this module shares the same backing
 * AsyncLocalStorage, so a `runWithCorrelation` opened in chunk A is
 * visible to a `current()` call in chunk B.
 *
 * Pass a `key` that uniquely identifies the logical scope (correlation
 * vs actor vs whatever else). Always use `Symbol.for(...)` so the key
 * itself is stable across modules.
 */
export function createScopedStorage<T>(
  key: symbol = Symbol.for("@ezlogs/nextjs:default-scoped-storage"),
): ScopedStorage<T> {
  const globalStore = globalThis as unknown as GlobalScopedStores;
  let entry = globalStore[key];
  if (!entry) {
    const als = (() => {
      if (!ALS_CTOR) return null;
      try {
        return new ALS_CTOR<{ value: unknown }>();
      } catch {
        return null;
      }
    })();
    entry = { als, edgeFallback: null };
    globalStore[key] = entry;
  }
  // Narrow once for the closures below. The shape is consistent across
  // all calls with the same key.
  const als = entry.als as
    | { getStore(): { value: T } | undefined; run<R>(store: { value: T }, cb: () => R): R }
    | null;
  const stateRef = entry as {
    edgeFallback: { value: T } | null;
  };

  return {
    read(): T | null {
      if (als) return als.getStore()?.value ?? null;
      return stateRef.edgeFallback?.value ?? null;
    },

    run<R>(value: T, callback: () => R): R {
      if (als) return als.run({ value }, callback);
      const previous = stateRef.edgeFallback;
      stateRef.edgeFallback = { value };
      try {
        return callback();
      } finally {
        stateRef.edgeFallback = previous;
      }
    },

    update(value: T): void {
      if (als) {
        const store = als.getStore();
        if (store) store.value = value;
        return;
      }
      stateRef.edgeFallback = { value };
    },

    _resetForTests(): void {
      stateRef.edgeFallback = null;
    },

    _isAsyncLocalStorage(): boolean {
      return als !== null;
    },
  };
}
