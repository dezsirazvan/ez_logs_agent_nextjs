// Webpack/Turbopack loader for auto-wrapping Next.js route handlers.
//
// Earlier versions of this loader used a "?ezlogs-original" query-string
// bypass + re-import trick. That works on Webpack but breaks on
// Turbopack: Turbopack treats the query as part of the resolved path,
// so the re-import points at a non-existent file and the build fails.
//
// New strategy: rename the user's exported handlers in-place by string
// rewriting, then append wrapper exports that re-export wrapped
// versions. The original source still runs through the rest of the
// loader chain (TypeScript, JSX, etc.) — we only mutate the export
// declarations.
//
// Supported shapes (the only shapes Next.js actually accepts for
// route handlers):
//   export async function GET(req: Request) { ... }
//   export function GET(req: Request) { ... }
//   export const GET = async (req: Request) => { ... }
//   export const GET: SomeType = async (req: Request) => { ... }
//
// Re-exports like `export { GET } from "./shared"` are NOT rewritten —
// they pass through unchanged. Routes that use that pattern won't be
// auto-instrumented; users wrap manually with captureRoute() if they
// need it.

import { sep } from "node:path";

// Sucrase's deep parser entry point has no published types and lives
// at an internal path that could move in a future sucrase release.
// To keep a sucrase upgrade from breaking customer builds at module-
// load time, we lazy-resolve the parser the first time we need it
// and memoize the result. On resolution failure we cache the failure
// (warn-once) and return null; callers fall open by returning the
// source unchanged. The customer's build still succeeds; that one
// inline server action just isn't auto-captured (they can still wrap
// manually with `captureServerAction`).
type SucraseParseFn = (
  source: string,
  isJSX: boolean,
  isTS: boolean,
  isFlow: boolean,
) => SucraseParseResult;

let cachedSucraseParse: SucraseParseFn | null | undefined;

function getSucraseParse(): SucraseParseFn | null {
  if (cachedSucraseParse !== undefined) return cachedSucraseParse;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("sucrase/dist/parser/index.js") as {
      parse?: SucraseParseFn;
    };
    if (typeof mod.parse !== "function") {
      throw new Error("sucrase parser module has no `parse` export");
    }
    cachedSucraseParse = mod.parse;
    return cachedSucraseParse;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[ezlogs] sucrase parser unavailable; inline Server Actions won't be auto-captured. Wrap them manually with captureServerAction(). Reason: ${message}`,
    );
    cachedSucraseParse = null;
    return null;
  }
}

interface PitchContext {
  query: string | { [key: string]: unknown };
  resourcePath: string;
  resource: string;
  request: string;
  remainingRequest: string;
  callback?: (
    error: Error | null,
    content?: string,
    sourceMap?: unknown,
  ) => void;
  async?: () => (
    error: Error | null,
    content?: string,
    sourceMap?: unknown,
  ) => void;
  data?: Record<string, unknown>;
  emitWarning?: (warning: Error | string) => void;
  getOptions?: () => Record<string, unknown>;
}

const HTTP_METHOD_NAMES = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

type HttpMethodName = (typeof HTTP_METHOD_NAMES)[number];

const ALREADY_WRAPPED_MARKER = "__ezlogs_orig_";
// The npm package name. Single source of truth for every `import …
// from "<package>"` that the loader injects into customer code, AND
// for the in-file sentinel strings the loader's re-export transform
// uses to detect already-wrapped files. The runtime package is
// unscoped (`ezlogs-nextjs` on npm); the loader used to emit a
// scoped `@ezlogs/nextjs` import which broke every customer's
// `next build`.
const PACKAGE_NAME = "ezlogs-nextjs";

// Idempotency marker emitted by transforms that don't rename a local
// declaration (so `__ezlogs_orig_` never appears). The re-export
// route handler uses this — its output contains `export const GET =
// __ezlogs_capture(handler, ...)` with no rename, so we need a
// separate sentinel to detect already-wrapped files on second pass.
const REEXPORT_WRAP_MARKER = `${PACKAGE_NAME} auto-wrap re-export`;

/**
 * Loader entry point. Receives the user's source file as a string,
 * returns transformed source. Both Webpack and Turbopack call this
 * the same way (Turbopack uses loader-runner under the hood).
 *
 * Outer fail-open guard: this loader runs at the customer's `next
 * build` time on every file Next.js routes through it. A throw in
 * ANY of the rewrite helpers (regex catastrophe, malformed source,
 * future sucrase incompatibility) would break the customer's build.
 * EZLogs must never break the host. On any exception we log a warn
 * with the file path + error, and return the source unchanged so
 * the build continues — that one file just isn't auto-instrumented.
 * The customer can still wrap manually via `captureRoute()` /
 * `captureServerAction()`.
 */
export default function loader(this: PitchContext, source: string): string {
  try {
    return loaderImpl.call(this, source);
  } catch (loaderError) {
    const path = this.resourcePath ?? "<unknown>";
    const message =
      loaderError instanceof Error
        ? `${loaderError.name}: ${loaderError.message}`
        : String(loaderError);
    // eslint-disable-next-line no-console
    console.warn(
      `[ezlogs] loader failed for ${path}; leaving source unchanged so the build succeeds. ${message}`,
    );
    return source;
  }
}

function loaderImpl(this: PitchContext, source: string): string {
  // Idempotent: if the file already contains our marker, it's been
  // wrapped (e.g. by a re-evaluation during dev hot reload). Don't
  // wrap again.
  if (
    source.includes(ALREADY_WRAPPED_MARKER) ||
    source.includes(REEXPORT_WRAP_MARKER)
  ) {
    return source;
  }

  const options = readOptions(this);
  const kind = (options.kind as string | undefined) ?? "app-route-handler";
  const routeModulePath = computeRouteModulePath(this.resourcePath, kind);

  if (kind === "pages-api") {
    return rewritePagesApi(source, routeModulePath);
  }
  if (kind === "middleware") {
    return rewriteMiddleware(source);
  }
  if (kind === "server-action") {
    // The server-action loader also handles supabase factory wrapping
    // because both transformations run on user source files. Order
    // matters: we rewrite supabase imports FIRST so that any wrapped
    // factory calls inside an action file produce instrumented
    // clients, then run the SA wrap pass.
    const withSupabase = rewriteSupabaseFactoryImports(source);
    return rewriteServerActionFile(withSupabase);
  }
  if (kind === "supabase-factory") {
    return rewriteSupabaseFactoryImports(source);
  }
  if (kind === "inline-server-action") {
    return rewriteInlineServerActions(source, this.resourcePath);
  }
  return rewriteAppRoute(source, routeModulePath);
}

/**
 * Pitch is intentionally a no-op. We don't use the pitch bypass
 * pattern any more — both Webpack and Turbopack send the source
 * through the main loader function, which we transform inline.
 */
export function pitch(this: PitchContext, _remainingRequest: string): undefined {
  return undefined;
}

/**
 * App Router route handler rewrite. Looks for any of the known
 * HTTP-method exports (GET, POST, ...) in any of the supported
 * declaration shapes, renames the local declarations, and appends
 * wrapped re-exports.
 */
function rewriteAppRoute(source: string, routeModulePath: string): string {
  const detected = new Set<HttpMethodName>();
  let rewritten = source;

  for (const method of HTTP_METHOD_NAMES) {
    const renamed = renameExport(rewritten, method);
    if (renamed.changed) {
      detected.add(method);
      rewritten = renamed.source;
    }
  }

  if (detected.size === 0) {
    // No top-level `export async function NAME` / `export const NAME =`
    // shapes found. Try the local-aliased re-export pattern next, used
    // notably by NextAuth catch-all routes:
    //
    //   const handler = NextAuth(authOptions)
    //   export { handler as GET, handler as POST }
    //
    // The transform replaces just the export statement with wrapped
    // exports. The local declaration (and anything else in the file)
    // is preserved verbatim.
    return rewriteLocalAliasedRouteExports(source, routeModulePath);
  }

  const meta = JSON.stringify({ routeModulePath });
  const wrapperBlock = [
    "",
    "// --- ezlogs-nextjs auto-wrap (build-time) ---",
    `import { captureRoute as __ezlogs_capture } from "${PACKAGE_NAME}";`,
    `const __ezlogs_meta = ${meta};`,
    ...Array.from(detected).map(
      (method) =>
        `export const ${method} = __ezlogs_capture(${ALREADY_WRAPPED_MARKER}${method}, __ezlogs_meta);`,
    ),
    "// --- end ezlogs-nextjs auto-wrap ---",
    "",
  ].join("\n");

  return rewritten + wrapperBlock;
}

/**
 * Handle the local-aliased re-export shape NextAuth (and similar auth
 * libraries) use:
 *
 *   const handler = NextAuth(authOptions)
 *   export { handler as GET, handler as POST }
 *
 * The pattern is narrow:
 *   - Single `export { ... }` statement
 *   - Every entry is `<localName> as <HTTP_METHOD>` (no bare names,
 *     no aliased-to-non-method names)
 *   - NO `from "..."` clause (cross-file re-exports can't be safely
 *     wrapped — the target file may export non-functions or values
 *     that change shape across versions)
 *
 * Transform: leave the local declaration in place, REPLACE the
 * export statement with one `export const METHOD = capture(local, meta)`
 * per matched method.
 *
 * Returns `source` unchanged when the pattern doesn't match.
 */
function rewriteLocalAliasedRouteExports(
  source: string,
  routeModulePath: string,
): string {
  // Match `export { ... }` with NO `from` clause. Anchored on `export`
  // at line start (or after whitespace) and a `}` followed by an
  // optional semicolon — but NOT followed by `from`.
  const exportBlockRegex =
    /(^|\n)(\s*)export\s*\{\s*([^}]+)\s*\}\s*;?(?!\s*from)/g;

  const methodSet = new Set<string>(HTTP_METHOD_NAMES);
  let match: RegExpExecArray | null;
  let matchedBlock: { full: string; entries: string; start: number; end: number } | null = null;

  while ((match = exportBlockRegex.exec(source)) !== null) {
    const entriesStr = match[3]!;
    // Each entry must be `<ident> as <HTTP_METHOD>`. We require ALL
    // entries to fit this shape — a mix (e.g. `{ handler as GET, foo }`)
    // bails out, since handling partial rewrites would change semantics
    // in surprising ways.
    const parts = entriesStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) continue;

    const parsed = parts.map((part) => {
      const m = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (!m) return null;
      return { local: m[1]!, exported: m[2]! };
    });

    if (parsed.some((p) => p === null)) continue;
    if (!parsed.every((p) => methodSet.has(p!.exported))) continue;

    matchedBlock = {
      full: match[0]!,
      entries: entriesStr,
      start: match.index + match[1]!.length, // exclude the leading newline
      end: match.index + match[0]!.length,
    };
    break; // only handle the first such block per file
  }

  if (!matchedBlock) return source;

  // Re-parse entries from the matched block (already validated above).
  const entries = matchedBlock.entries
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((part) => {
      const m = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/)!;
      return { local: m[1]!, exported: m[2]! as HttpMethodName };
    });

  const meta = JSON.stringify({ routeModulePath });
  const wrapperLines = [
    "// --- ezlogs-nextjs auto-wrap re-export (build-time) ---",
    `import { captureRoute as __ezlogs_capture } from "${PACKAGE_NAME}";`,
    `const __ezlogs_meta = ${meta};`,
    ...entries.map(
      (e) => `export const ${e.exported} = __ezlogs_capture(${e.local}, __ezlogs_meta);`,
    ),
    "// --- end ezlogs-nextjs auto-wrap re-export ---",
  ];

  const before = source.slice(0, matchedBlock.start);
  const after = source.slice(matchedBlock.end);
  return `${before}${wrapperLines.join("\n")}${after}`;
}

/**
 * Pages Router rewrite. Pages Router routes export a single default
 * function (sometimes with a `config` named export). Wrap the default.
 */
// Identifiers that look like exports but should NEVER be wrapped:
//   - `config` is the well-known Next.js metadata export.
//   - `metadata` / `generateMetadata` are Next App Router metadata APIs.
// Everything else is treated as a candidate Server Action target. The
// captureServerActionExport helper guards at runtime so non-function
// values (constants, schemas, etc.) pass through untouched.
const NEVER_WRAP_EXPORTS = new Set(["config", "metadata", "generateMetadata"]);

// Modules whose factory exports we wrap to auto-instrument every
// constructed Supabase client. Map: module specifier -> exported name.
// Both factories return a SupabaseClient instance; wrapping the call
// site instruments the resulting object's `from()` directly.
const SUPABASE_FACTORY_IMPORTS: ReadonlyArray<{
  module: string;
  exportName: string;
}> = [
  { module: "@supabase/supabase-js", exportName: "createClient" },
  { module: "@supabase/ssr", exportName: "createServerClient" },
  { module: "@supabase/ssr", exportName: "createBrowserClient" },
];

/**
 * Build-time import rewrite for the Supabase factory functions.
 *
 * Why a build-time rewrite instead of runtime prototype-patching:
 * Turbopack duplicates the SupabaseClient class across server/RSC/edge
 * layers, so patching the prototype reachable from one layer misses
 * clients constructed in another. Wrapping the factory CALL SITE in
 * the user's own source file produces a wrapped instance regardless
 * of which class instance the layer's bundle contains.
 *
 * Transformation:
 *
 *   import { createServerClient } from "@supabase/ssr";
 *   const c = createServerClient(url, key, opts);
 *
 * becomes:
 *
 *   import { createServerClient as __ezlogs_orig_createServerClient } from "@supabase/ssr";
 *   import { wrapSupabase as __ezlogs_wrap } from "ezlogs-nextjs/supabase";
 *   const createServerClient = (...args) => __ezlogs_wrap(__ezlogs_orig_createServerClient(...args));
 *   const c = createServerClient(url, key, opts);
 *
 * Idempotent (the `__ezlogs_orig_` marker check at the loader entry
 * skips already-rewritten files). Aliased imports
 * (`{ createClient as foo }`) are NOT rewritten in v0.1 — users with
 * aliases can fall back to manual `wrapSupabase()`.
 */
function rewriteSupabaseFactoryImports(source: string): string {
  let rewritten = source;
  let changed = false;
  let needsWrapImport = false;

  for (const { module, exportName } of SUPABASE_FACTORY_IMPORTS) {
    // Match: import { ..., createServerClient, ... } from "@supabase/ssr"
    // The named-imports list can contain other names + commas + whitespace.
    // We match the named-imports block and check whether `exportName` is
    // present as a non-aliased name.
    const importPattern = new RegExp(
      `(import\\s*\\{[^}]*?)\\b(${exportName})\\b(\\s*(?:,[^}]*)?\\}\\s*from\\s*['"]${escapeRegexLiteral(module)}['"])`,
      "m",
    );
    const match = rewritten.match(importPattern);
    if (!match) continue;
    // Skip when the user aliased the import: `createServerClient as foo`.
    // Detect by looking at the character immediately after the name.
    const insertPoint = match.index! + match[1]!.length + match[2]!.length;
    const after = rewritten.slice(insertPoint, insertPoint + 6);
    if (/^\s+as\b/.test(after)) continue;

    // Rewrite the named import: `createServerClient` -> `createServerClient as __ezlogs_orig_<name>`.
    rewritten = rewritten.replace(importPattern, (_full, lead, name, tail) => {
      return `${lead}${name} as ${ALREADY_WRAPPED_MARKER}${name}${tail}`;
    });

    // Append a wrapper const so all references to `name` in the rest
    // of the file resolve to the instrumented version.
    const wrapper = `const ${exportName} = (...__ezlogs_args) => ${ALREADY_WRAPPED_MARKER}wrap(${ALREADY_WRAPPED_MARKER}${exportName}(...__ezlogs_args));`;
    rewritten = `${rewritten}\n${wrapper}\n`;

    changed = true;
    needsWrapImport = true;
  }

  if (!changed) return source;

  if (needsWrapImport) {
    rewritten = `import { wrapSupabase as ${ALREADY_WRAPPED_MARKER}wrap } from "${PACKAGE_NAME}/supabase";\n${rewritten}`;
  }

  return rewritten;
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * "use server" file rewrite. Auto-wraps every exported function-valued
 * symbol from a file-level `"use server"` directive through
 * `captureServerActionExport`, which is a runtime-conditional wrap:
 * functions get instrumented, non-functions pass through.
 *
 * Recognized export shapes (matching the rest of the loader):
 *   export async function NAME(...) { ... }
 *   export function NAME(...) { ... }
 *   export const NAME = <expr>
 *   export let NAME = <expr>
 *   export var NAME = <expr>
 *
 * Re-exports (`export { foo } from "./bar"`) are NOT rewritten — they
 * pass through unchanged. Function-level "use server" directives
 * (where individual functions inside a non-directive file are marked)
 * are also out of scope for v0.1; the file-level directive is the
 * dominant pattern.
 */
function rewriteServerActionFile(source: string): string {
  // Only act on files whose FIRST real statement is a "use server"
  // directive. We do a light prefix scan so files where "use server"
  // appears later (e.g. inside a function body) don't get wrapped.
  if (!hasFileLevelUseServer(source)) return source;

  const detected: string[] = [];
  let rewritten = source;

  // Find all top-level export names. This regex is anchored on the
  // export keyword and only matches the three shapes we know how to
  // rename. Type-only exports (`export type X = ...`, `export interface`)
  // are skipped because the regex requires `function` / `const|let|var`
  // keywords.
  const pattern =
    /(^|\n)\s*export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[2]!;
    if (NEVER_WRAP_EXPORTS.has(name)) continue;
    names.add(name);
  }

  if (names.size === 0) return source;

  for (const name of names) {
    const renamed = renameExport(rewritten, name);
    if (renamed.changed) {
      detected.push(name);
      rewritten = renamed.source;
    }
  }

  if (detected.length === 0) return source;

  const wrapperBlock = [
    "",
    "// --- ezlogs-nextjs auto-wrap server action (build-time) ---",
    `import { captureServerActionExport as __ezlogs_capture_sa } from "${PACKAGE_NAME}";`,
    ...detected.map(
      (name) =>
        `export const ${name} = __ezlogs_capture_sa(${ALREADY_WRAPPED_MARKER}${name}, ${JSON.stringify(name)});`,
    ),
    "// --- end ezlogs-nextjs auto-wrap server action ---",
    "",
  ].join("\n");

  return rewritten + wrapperBlock;
}

// Sucrase token type constants we rely on. Sourced directly from
// sucrase/dist/parser/tokenizer/types.js — kept here as named
// constants so the transform reads cleanly. If sucrase renumbers
// these in a future release the build catches it (the parser tests
// would fail).
const TT_NAME = 5632;
const TT_STRING = 4608;
const TT_FUNCTION = 73232;
const TT_BRACE_L = 9728;
const TT_BRACE_R = 11264;
const TT_PAREN_L = 13824;
const TT_PAREN_R = 14336;
const TT_SEMI = 16384;
const TT_EQ = 29728;
const TT_ARROW = 22528;
const TT_CONST = 80912;
const TT_LET = 79888;
const TT_VAR = 78864;

const INLINE_HELPER_NAME = "__ezlogs_run_inline_server_action";

interface SucraseToken {
  type: number;
  start: number;
  end: number;
  scopeDepth: number;
}

interface SucraseScope {
  startTokenIndex: number;
  endTokenIndex: number;
  isFunctionScope: boolean;
}

interface SucraseParseResult {
  tokens: SucraseToken[];
  scopes: SucraseScope[];
}

/**
 * Rewrite inline `"use server"` actions inside RSC components
 * (page/layout/etc.) so each one runs through
 * `__ezlogs_run_inline_server_action`. We KEEP the original function
 * declaration AND the literal `"use server"` directive as the first
 * inner statement — both are required for SWC's Server Reference
 * registration to pick up the symbol. Only the statements AFTER the
 * directive are wrapped:
 *
 *   async function deletePost(formData) {
 *     "use server"
 *     ...body...
 *   }
 *     ↓
 *   async function deletePost(formData) {
 *     "use server"
 *     return await __ezlogs_run_inline_server_action(deletePost, async () => {
 *       ...body...
 *     })
 *   }
 *
 * Three function shapes are recognized — the only shapes inline
 * actions actually take in the wild:
 *
 *   async function NAME(args)            { "use server"; ... }
 *   const NAME = async (args)            => { "use server"; ... }
 *   const NAME = async function NAME?(args) { "use server"; ... }
 *
 * Files with no `"use server"` substring fast-path out unchanged.
 * Any sucrase parse error returns the source unchanged with a
 * `console.warn` — never break the user's build.
 */
export function rewriteInlineServerActions(
  source: string,
  filename: string,
): string {
  // Fast path 1: no directive substring anywhere → nothing to do.
  if (!source.includes("use server")) return source;

  // Fast path 2: already transformed (e.g. a re-evaluation in dev).
  if (source.includes(INLINE_HELPER_NAME)) return source;

  // Fast path 3: sucrase parser unavailable (deep-import path moved,
  // package not installed). `getSucraseParse` warns once on first
  // failed resolution; we just return source unchanged here.
  const sucraseParse = getSucraseParse();
  if (sucraseParse === null) return source;

  let parsed: SucraseParseResult;
  try {
    const isJSX = /\.(jsx|tsx)$/i.test(filename);
    const isTS = /\.(ts|tsx)$/i.test(filename);
    parsed = sucraseParse(source, isJSX, isTS, false) as SucraseParseResult;
  } catch (e) {
    // Fail-open: parse error means we leave the source untouched.
    // The user's build still works; that one inline action just
    // isn't captured. Same fallback as today.
    const message = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[ezlogs] sucrase parse failed for ${filename}; leaving source unchanged. ${message}`,
    );
    return source;
  }

  const { tokens, scopes } = parsed;
  const patches: Array<{
    bodyContentStart: number;
    bodyContentEnd: number;
    name: string;
    bodyText: string;
  }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type !== TT_STRING) continue;

    const slice = source.slice(tok.start, tok.end);
    if (slice !== '"use server"' && slice !== "'use server'") continue;

    // The directive must be the first statement in a function body —
    // i.e. the previous token is `{` and that brace opens a scope.
    const prev = tokens[i - 1];
    if (!prev || prev.type !== TT_BRACE_L) continue;
    const braceLIdx = i - 1;

    // Find the scope whose startTokenIndex == braceLIdx. That scope's
    // endTokenIndex - 1 is the matching `}` (sucrase's endTokenIndex
    // is exclusive).
    const scope = scopes.find((s) => s.startTokenIndex === braceLIdx);
    if (!scope) continue;
    const braceRIdx = scope.endTokenIndex - 1;
    const braceR = tokens[braceRIdx];
    if (!braceR || braceR.type !== TT_BRACE_R) continue;

    // Walk back from `{` to identify the function shape and capture
    // the action's name (used as the runtime identifier).
    const shape = identifyFunctionShape(tokens, braceLIdx, source);
    if (!shape) continue;

    // The directive's tail end: prefer the trailing semi if present,
    // otherwise the directive token's `end`.
    const next = tokens[i + 1];
    const directiveEnd =
      next && next.type === TT_SEMI ? next.end : tok.end;

    // Capture the body text AFTER the directive and BEFORE the
    // closing brace. We preserve it verbatim — it goes inside the
    // wrap's arrow callback unchanged.
    const bodyContentStart = directiveEnd;
    const bodyContentEnd = braceR.start;
    const bodyText = source.slice(bodyContentStart, bodyContentEnd);

    // Skip empty bodies — nothing to wrap.
    if (bodyText.trim().length === 0) continue;

    patches.push({
      bodyContentStart,
      bodyContentEnd,
      name: shape.name,
      bodyText,
    });
  }

  if (patches.length === 0) return source;

  // Apply patches RIGHT-TO-LEFT so earlier offsets stay valid.
  patches.sort((a, b) => b.bodyContentStart - a.bodyContentStart);

  let out = source;
  for (const patch of patches) {
    // Embed the action name as a string literal at build time. We
    // can't rely on `patch.name`'s `.name` property at runtime —
    // SWC's Server Reference registration replaces the function
    // value with a wrapped reference whose `.name` is `""` or an
    // internal `$$ACTION_*` identifier. The literal string captured
    // from the AST is the only stable source of the original name.
    const nameLiteral = JSON.stringify(patch.name);
    const replacement = `\nreturn await ${INLINE_HELPER_NAME}(${nameLiteral}, async () => {${patch.bodyText}});\n`;
    out =
      out.slice(0, patch.bodyContentStart) +
      replacement +
      out.slice(patch.bodyContentEnd);
  }

  // Prepend the import. Idempotency check at the top of the function
  // already guarded against double-prepending.
  return `import { ${INLINE_HELPER_NAME} } from "${PACKAGE_NAME}";\n${out}`;
}

/**
 * Walk backward from the function body's `{` token to identify the
 * function shape and extract the action name. Recognized shapes:
 *
 *   async function NAME(...) { ... }            -> name: NAME
 *   const NAME = async (...) => { ... }         -> name: NAME
 *   const NAME = async function NAME?(...) { ... } -> name: NAME (LHS)
 *
 * Returns null when none of the three shapes match. Defensive — any
 * unexpected token sequence falls through to "skip this candidate".
 */
function identifyFunctionShape(
  tokens: SucraseToken[],
  braceLIdx: number,
  source: string,
): { name: string } | null {
  // The token immediately before `{` is either `=>` (arrow) or `)`
  // (named function or function expression).
  const beforeBrace = tokens[braceLIdx - 1];
  if (!beforeBrace) return null;

  if (beforeBrace.type === TT_ARROW) {
    // Arrow form: walk back past TS return type annotation (if any),
    // past the matching `(...args)`, past optional `async`, then past
    // `=` to the `const NAME` LHS.
    let cursor = braceLIdx - 2; // skip the `=>`
    cursor = skipReturnTypeAnnotation(tokens, cursor);
    cursor = skipMatchingParens(tokens, cursor);
    if (cursor < 0) return null;
    // Optional `async` keyword.
    const maybeAsync = tokens[cursor];
    if (maybeAsync && maybeAsync.type === TT_NAME) {
      const asyncSlice = source.slice(maybeAsync.start, maybeAsync.end);
      if (asyncSlice === "async") cursor -= 1;
    }
    // Expect `=`.
    if (!tokens[cursor] || tokens[cursor]!.type !== TT_EQ) return null;
    cursor -= 1;
    // Expect identifier (the const name).
    const nameTok = tokens[cursor];
    if (!nameTok || nameTok.type !== TT_NAME) return null;
    cursor -= 1;
    // Expect `const` / `let` / `var`.
    const declTok = tokens[cursor];
    if (
      !declTok ||
      (declTok.type !== TT_CONST &&
        declTok.type !== TT_LET &&
        declTok.type !== TT_VAR)
    ) {
      return null;
    }
    return { name: source.slice(nameTok.start, nameTok.end) };
  }

  // Otherwise the token before `{` is either `)` (no return type) or
  // the last token of a TS return-type annotation (`...> {`,
  // `string {`, etc.). Walk back to the matching `)`.
  let parenRIdx = braceLIdx - 1;
  while (parenRIdx >= 0 && tokens[parenRIdx]!.type !== TT_PAREN_R) {
    // Conservative bound: if we cross another brace we're not in a
    // function-shaped sequence, bail.
    if (
      tokens[parenRIdx]!.type === TT_BRACE_L ||
      tokens[parenRIdx]!.type === TT_BRACE_R ||
      tokens[parenRIdx]!.type === TT_ARROW
    ) {
      return null;
    }
    parenRIdx -= 1;
  }
  if (parenRIdx < 0) return null;

  if (tokens[parenRIdx]!.type === TT_PAREN_R) {
    // Named function or function expression. Walk back through
    // (params), optional name, `function`, then check what's before.
    let cursor = skipMatchingParens(tokens, parenRIdx);
    if (cursor < 0) return null;
    // Optional function name (identifier).
    let nameTok: SucraseToken | undefined;
    const maybeName = tokens[cursor];
    if (maybeName && maybeName.type === TT_NAME) {
      // Could be the function name or the `async` keyword followed
      // by `function`. Distinguish by what's before.
      const slice = source.slice(maybeName.start, maybeName.end);
      if (slice !== "async") {
        nameTok = maybeName;
        cursor -= 1;
      }
    }
    // Expect `function`.
    if (!tokens[cursor] || tokens[cursor]!.type !== TT_FUNCTION) return null;
    cursor -= 1;
    // Optional `async` (which tokenizes as a name).
    const beforeFn = tokens[cursor];
    if (beforeFn && beforeFn.type === TT_NAME) {
      const slice = source.slice(beforeFn.start, beforeFn.end);
      if (slice === "async") cursor -= 1;
    }
    // Two cases:
    //   1. Named function declaration: prior token is `export` or
    //      whatever — the function has its own name, use it.
    //   2. Function expression assigned to a const: prior chain is
    //      `... = async function ...`. Walk back further to find
    //      `const NAME =`.
    if (nameTok && tokens[cursor] && tokens[cursor]!.type !== TT_EQ) {
      return { name: source.slice(nameTok.start, nameTok.end) };
    }
    // Function expression: expect `=`.
    if (!tokens[cursor] || tokens[cursor]!.type !== TT_EQ) {
      // Anonymous function declaration with no LHS is unusable.
      return nameTok
        ? { name: source.slice(nameTok.start, nameTok.end) }
        : null;
    }
    cursor -= 1;
    const constNameTok = tokens[cursor];
    if (!constNameTok || constNameTok.type !== TT_NAME) return null;
    return { name: source.slice(constNameTok.start, constNameTok.end) };
  }

  return null;
}

/**
 * If the token at `idx` ends a TypeScript return-type annotation
 * (`: SomeType`), walk back over it and return the index of the token
 * right before the `:`. Otherwise returns `idx` unchanged.
 *
 * The annotation starts with `:` and runs until we hit the function
 * params' closing `)` (ascending paren-depth back to zero from where
 * we are). Conservative — we don't try to parse the type, just skip
 * tokens until we balance back to where a return type couldn't be.
 */
function skipReturnTypeAnnotation(
  tokens: SucraseToken[],
  idx: number,
): number {
  // We're looking for `): RetType {` shape — when called from arrow
  // form, idx points at the token before `=>`. The token at idx is
  // either `)` (no return type) or the last token of the return type.
  // If the next-following sequence is `<TYPE>: ... )` we need to skip.
  // Simplest robust heuristic: scan back collecting tokens until we
  // hit a `)` that closes the params. If we encounter a `:` along the
  // way at the right depth, treat everything from `:` up to (but not
  // including) the original idx as the return type.
  if (idx < 0) return idx;
  // Quick path: if tokens[idx] is `)`, there's no annotation.
  if (tokens[idx] && tokens[idx]!.type === TT_PAREN_R) return idx;

  let depth = 0;
  for (let j = idx; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.type === TT_PAREN_R) depth += 1;
    else if (t.type === TT_PAREN_L) {
      depth -= 1;
      if (depth < 0) return idx; // unbalanced — bail
    } else if (
      t.type === 17408 /* colon */ &&
      depth === 0
    ) {
      // Found the return-type colon. Step before it.
      return j - 1;
    }
  }
  return idx;
}

/**
 * Walk back from `idx` (which must point at a `)`) to the matching
 * `(`, returning the index of the token BEFORE the `(`. Returns -1
 * when unbalanced.
 */
function skipMatchingParens(tokens: SucraseToken[], idx: number): number {
  if (idx < 0 || !tokens[idx] || tokens[idx]!.type !== TT_PAREN_R) return -1;
  let depth = 0;
  for (let j = idx; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.type === TT_PAREN_R) depth += 1;
    else if (t.type === TT_PAREN_L) {
      depth -= 1;
      if (depth === 0) return j - 1;
    }
  }
  return -1;
}

/**
 * Detect a file-level "use server" directive: the first non-comment,
 * non-whitespace statement of the file must be the literal string
 * "use server" (single or double quotes), terminated by a semicolon
 * or newline. Cheap to compute — we don't need a full parser, just to
 * peek at the file head.
 */
function hasFileLevelUseServer(source: string): boolean {
  // Strip leading whitespace + line/block comments greedily.
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source.charCodeAt(i);
    // whitespace
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      i += 1;
      continue;
    }
    // // line comment
    if (ch === 0x2f && source.charCodeAt(i + 1) === 0x2f) {
      const eol = source.indexOf("\n", i);
      if (eol === -1) return false;
      i = eol + 1;
      continue;
    }
    // /* block comment */
    if (ch === 0x2f && source.charCodeAt(i + 1) === 0x2a) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    break;
  }
  // We're at the first real character. Must be a quote starting a
  // directive prologue.
  const head = source.slice(i, i + 14);
  return /^["']use server["']/.test(head);
}

/**
 * Root middleware rewrite. Handles every shape Next.js accepts for the
 * top-level `middleware.ts` export:
 *
 *   export default function middleware(req) { ... }
 *   export default async function middleware(req) { ... }
 *   export default (req) => { ... }
 *   export function middleware(req) { ... }
 *   export async function middleware(req) { ... }
 *   export const middleware = (req) => { ... }
 *
 * The `export const config = { matcher: ... }` named export is left
 * untouched so Next still picks up the matcher metadata.
 */
function rewriteMiddleware(source: string): string {
  const namedRenamed = renameExport(source, "middleware");
  if (namedRenamed.changed) {
    const wrapperBlock = [
      "",
      "// --- ezlogs-nextjs auto-wrap middleware (build-time) ---",
      `import { withMiddlewareCapture as __ezlogs_with_mw } from "${PACKAGE_NAME}";`,
      `export const middleware = __ezlogs_with_mw(${ALREADY_WRAPPED_MARKER}middleware);`,
      "// --- end ezlogs-nextjs auto-wrap middleware ---",
      "",
    ].join("\n");
    return namedRenamed.source + wrapperBlock;
  }

  const defaultRenamed = renameDefaultExport(source);
  if (defaultRenamed.changed) {
    const wrapperBlock = [
      "",
      "// --- ezlogs-nextjs auto-wrap middleware (build-time) ---",
      `import { withMiddlewareCapture as __ezlogs_with_mw } from "${PACKAGE_NAME}";`,
      `export default __ezlogs_with_mw(${ALREADY_WRAPPED_MARKER}default);`,
      "// --- end ezlogs-nextjs auto-wrap middleware ---",
      "",
    ].join("\n");
    return defaultRenamed.source + wrapperBlock;
  }

  return source;
}

function rewritePagesApi(source: string, routeModulePath: string): string {
  // We rewrite `export default <expr>` so the original default is
  // accessible as a renamed local variable. Then append the wrapped
  // default export.
  const renamed = renameDefaultExport(source);
  if (!renamed.changed) {
    // Pages Router file without a recognized default export shape —
    // pass through.
    return source;
  }

  const meta = JSON.stringify({ routeModulePath });
  const wrapperBlock = [
    "",
    "// --- ezlogs-nextjs auto-wrap (build-time) ---",
    `import { capturePagesApi as __ezlogs_capture_pages } from "${PACKAGE_NAME}";`,
    `const __ezlogs_meta = ${meta};`,
    `export default typeof ${ALREADY_WRAPPED_MARKER}default === "function"`,
    `  ? __ezlogs_capture_pages(${ALREADY_WRAPPED_MARKER}default, __ezlogs_meta)`,
    `  : ${ALREADY_WRAPPED_MARKER}default;`,
    "// --- end ezlogs-nextjs auto-wrap ---",
    "",
  ].join("\n");

  return renamed.source + wrapperBlock;
}

interface RenameResult {
  source: string;
  changed: boolean;
}

/**
 * Rename a top-level named export so the original declaration is
 * accessible as `__ezlogs_orig_<NAME>`. Handles three shapes:
 *
 *   export async function NAME(...)  -> async function __ezlogs_orig_NAME(...)
 *   export function NAME(...)        -> function __ezlogs_orig_NAME(...)
 *   export const NAME = ...           -> const __ezlogs_orig_NAME = ...
 *
 * Multi-shape support means TypeScript files with type annotations
 * (`export const POST: RouteHandler = ...`) work too, since the regex
 * only touches the keyword + name and leaves the rest alone.
 */
function renameExport(source: string, name: string): RenameResult {
  // Word-boundary anchored — we don't want `GET` matching inside
  // `GETTER` or some other identifier.
  const patterns: Array<RegExp> = [
    // `export async function NAME(`
    new RegExp(`(^|\\s)export\\s+async\\s+function\\s+${name}\\b`, "m"),
    // `export function NAME(`
    new RegExp(`(^|\\s)export\\s+function\\s+${name}\\b`, "m"),
    // `export const NAME =` / `export let NAME =` / `export var NAME =`
    new RegExp(`(^|\\s)export\\s+(const|let|var)\\s+${name}\\b`, "m"),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const replaced = source.replace(pattern, (full, lead) => {
        // Strip the leading `export` keyword and rename the identifier.
        // Preserves leading whitespace so source positions are stable.
        const rest = full
          .replace(/^\s*export\s+/, "")
          .replace(new RegExp(`\\b${name}\\b`), `${ALREADY_WRAPPED_MARKER}${name}`);
        return `${lead}${rest}`;
      });
      return { source: replaced, changed: true };
    }
  }

  return { source, changed: false };
}

/**
 * Rename `export default <expr>` so the original is accessible as
 * `__ezlogs_orig_default`. Handles three shapes:
 *
 *   export default async function NAME(...) ...
 *   export default function NAME(...) ...
 *   export default <expression>
 */
function renameDefaultExport(source: string): RenameResult {
  // Shape 1+2: `export default [async] function [NAME](`
  // Convert to a const so the wrapped reference at the bottom of the
  // file resolves cleanly regardless of whether NAME exists.
  const fnDefault = source.match(
    /(^|\n)\s*export\s+default\s+(async\s+)?function\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/,
  );
  if (fnDefault) {
    const replaced = source.replace(
      /(^|\n)(\s*)export\s+default\s+(async\s+)?function\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*/,
      (_full, lead, ws, asyncKw = "", _name) => {
        return `${lead}${ws}const ${ALREADY_WRAPPED_MARKER}default = ${asyncKw}function `;
      },
    );
    return { source: replaced, changed: true };
  }

  // Shape 3: `export default <expression>`. The expression can be a
  // call, identifier, arrow function, etc. We rewrite to a const.
  const exprDefault = source.match(/(^|\n)\s*export\s+default\s+/);
  if (exprDefault) {
    const replaced = source.replace(
      /(^|\n)(\s*)export\s+default\s+/,
      (_full, lead, ws) => `${lead}${ws}const ${ALREADY_WRAPPED_MARKER}default = `,
    );
    return { source: replaced, changed: true };
  }

  return { source, changed: false };
}

function readOptions(ctx: PitchContext): Record<string, unknown> {
  if (typeof ctx.getOptions === "function") return ctx.getOptions();
  if (typeof ctx.query === "string") {
    if (!ctx.query.startsWith("?")) return {};
    try {
      const parsed = new URLSearchParams(ctx.query.slice(1));
      const out: Record<string, unknown> = {};
      parsed.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    } catch {
      return {};
    }
  }
  if (typeof ctx.query === "object" && ctx.query !== null)
    return ctx.query as Record<string, unknown>;
  return {};
}

function computeRouteModulePath(resourcePath: string, kind: string): string {
  const normalized = resourcePath.split(sep).join("/");

  if (kind === "pages-api") {
    const match = normalized.match(/\/pages\/api\/(.+)$/);
    if (match) return stripExt(`pages/api/${match[1]!}`);
    return `pages/api/${stripExt(basename(resourcePath))}`;
  }

  const match = normalized.match(/\/app\/(.+)$/);
  if (match) {
    const trailing = match[1]!.replace(/\/route\.[^/]+$/, "");
    return `app/${trailing}`;
  }
  return "app/route";
}

function stripExt(p: string): string {
  return p.replace(/\.[^/.]+$/, "");
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
