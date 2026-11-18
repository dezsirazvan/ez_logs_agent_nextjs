// Loads a Node built-in at runtime only, so static bundlers
// (Turbopack/Webpack) don't follow it into Edge or browser builds.
// `process.getBuiltinModule` (Node >= 20.16 / 22.3) works in ESM and
// CJS; `require` covers older Node in CJS. Returns null when neither
// is available (Edge, browser).
export function loadNodeBuiltin<T>(name: string): T | null {
  const moduleName = "node:" + name;
  try {
    const getBuiltin = (
      globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
    ).process?.getBuiltinModule;
    if (typeof getBuiltin === "function") {
      const mod = getBuiltin(moduleName);
      if (mod) return mod as T;
    }
  } catch {
    // try require next
  }
  try {
    // Aliased, not called directly: bundlers would turn a direct
    // `require(<expression>)` into a context module.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: ((id: string) => any) | undefined =
      typeof require !== "undefined" ? require : undefined;
    if (typeof req === "function") return req(moduleName) as T;
  } catch {
    // not available
  }
  return null;
}
