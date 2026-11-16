// Shared scoped-state primitive used by correlation and actor.
//
// Loads node:async_hooks via a runtime-only require so static
// analyzers (Turbopack/Webpack) don't follow the import into the
// browser bundle. Why: when ezlogs-nextjs is imported from a
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
// On Node we ask `process.getBuiltinModule` (Node >= 20.16 / 22.3)
// before `require`: the ESM build has no `require` (tsup's shim
// throws), so a plain `"type": "module"` process (a BullMQ worker, a
// script) would otherwise lose async-context tracking.
//
// Every path missing? We fall back to a module-scoped variable.
// That's correct on Edge (per-request V8 isolate). On Node it would
// mix correlation ids between concurrent requests, so we warn once.

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

  // The string is split so a future bundler doing string-match
  // analysis sees no literal "async_hooks". Cosmetic but cheap.
  const moduleName = "node:" + ["async", "hooks"].join("_");

  // 2. process.getBuiltinModule — works in ESM and CJS alike, and is
  // a plain function call, so static bundlers don't follow it.
  try {
    const getBuiltin = (
      globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
    ).process?.getBuiltinModule;
    if (typeof getBuiltin === "function") {
      const mod = getBuiltin(moduleName) as
        | { AsyncLocalStorage?: AsyncLocalStorageCtor }
        | undefined;
      if (typeof mod?.AsyncLocalStorage === "function") return mod.AsyncLocalStorage;
    }
  } catch {
    // ignore — try require next
  }

  // 3. Runtime require (CJS, or a bundler that provides one) —
  // invisible to static bundlers because the string is computed. We
  // can't use `import("node:async_hooks")` because static analyzers
  // DO follow dynamic imports.
  try {
    // Aliased, not called directly: bundlers would turn a direct
    // `require(<expression>)` into a context module.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: ((id: string) => any) | undefined =
      typeof require !== "undefined" ? require : undefined;
    if (typeof req === "function") {
      const mod = req(moduleName) as {
        AsyncLocalStorage?: AsyncLocalStorageCtor;
      };
      if (typeof mod.AsyncLocalStorage === "function") return mod.AsyncLocalStorage;
    }
  } catch {
    // ignore — fall through to the no-ALS path
  }

  warnNoAsyncLocalStorageOnNode();
  return null;
}

// Edge (per-request isolate) and the browser are fine with the shared
// variable. A Node process is not: concurrent requests and jobs would
// read each other's correlation id and actor.
function warnNoAsyncLocalStorageOnNode(): void {
  // Declared here, not at module level: this runs during module init,
  // before later top-level consts are initialized.
  const WARNED_KEY = Symbol.for("ezlogs-nextjs:no-als-warned");
  const g = globalThis as {
    EdgeRuntime?: unknown;
    process?: { versions?: { node?: string } };
    [WARNED_KEY]?: boolean;
  };
  if (g.EdgeRuntime !== undefined || !g.process?.versions?.node) return;
  if (g[WARNED_KEY]) return;
  g[WARNED_KEY] = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[ezlogs] AsyncLocalStorage is unavailable on Node ${g.process.versions.node}. ` +
      "Concurrent requests and jobs will share one correlation id and actor, " +
      "so events can be grouped into the wrong action. Upgrade to Node >= 20.16 " +
      "(or >= 22.3), or load ezlogs-nextjs through CommonJS (require).",
  );
}

export interface ScopedStorage<T> {
  read(): T | null;
  run<R>(value: T, callback: () => R): R;
  update(value: T): void;
  _resetForTests(): void;
  _isAsyncLocalStorage(): boolean;
}

/**
 * Returns a `captureAndRun` factory built on Node 18.16+'s static
 * `AsyncLocalStorage.snapshot()`. Calling the factory captures the
 * CURRENT ALS context (across every active ALS instance, including
 * the agent's correlation + actor stores) and returns a runner that
 * re-establishes it.
 *
 * Usage:
 *
 *   const captureAndRun = makeAsyncContextCapture();
 *   if (captureAndRun) {
 *     // Inside a request scope — snapshot captures it.
 *     const run = captureAndRun();
 *     // Later, possibly across an ALS-stripping async boundary:
 *     run(() => { // sees the captured context });
 *   }
 *
 * Critical: capture must happen LAZILY — inside the wrapper's
 * call site — not once at agent init. The init-time scope is empty
 * (no request is in flight), so snapshotting then yields a runner
 * that re-establishes the empty scope. The correct moment to capture
 * is the boundary between the user's request-scoped code and the
 * engine entry point we're trying to bind across.
 *
 * Runtime requirement: Node >= 18.16 (or any runtime that exposes
 * `AsyncLocalStorage.snapshot` statically — current Vercel Edge does).
 * Returns null on older runtimes; callers should fall back to calling
 * the underlying function unbound. The agent's `engines.node` floor is
 * `>=18.17` so this branch is unreachable in supported deployments.
 */
export function makeAsyncContextCapture():
  | (() => <R>(fn: () => R) => R)
  | null {
  if (!ALS_CTOR) return null;
  const ctor = ALS_CTOR as unknown as {
    snapshot?: () => <R>(fn: () => R, ...args: unknown[]) => R;
  };
  if (typeof ctor.snapshot !== "function") return null;
  const snapshot = ctor.snapshot.bind(ctor);
  return () => {
    const runSnapshot = snapshot();
    return <R>(fn: () => R): R => runSnapshot(fn);
  };
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
  key: symbol = Symbol.for("ezlogs-nextjs:default-scoped-storage"),
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
