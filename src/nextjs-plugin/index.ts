// withEzlogsConfig — Next.js build-time plugin for zero-touch HTTP capture.
//
// Usage (in next.config.js):
//
//   const { withEzlogsConfig } = require("ezlogs-nextjs/plugin")
//   module.exports = withEzlogsConfig({
//     // your existing Next.js config
//   })
//
// Wraps every App Router route handler (app/**/route.{ts,js,tsx,jsx})
// and every Pages Router API route (pages/api/**/*.{ts,js,tsx,jsx})
// at build time. No per-route opt-in.
//
// Database adapters (Supabase / Prisma / Drizzle) are NOT auto-wrapped.
// Wrap your client factory once per file:
//
//   import { wrapSupabase } from "ezlogs-nextjs/supabase"
//   const client = wrapSupabase(createServerClient(...))
//
// Why no auto-alias for Supabase: build-time aliasing of @supabase/ssr
// fights Turbopack's resolve graph (recursion / browser-bundling /
// CJS-interop in different Next.js versions). The two-line manual
// wrap is the same pattern Sentry, Datadog, Highlight all use, and
// it works without bundler magic.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

interface NextConfig {
  webpack?: (
    config: WebpackConfig,
    options: WebpackContext,
  ) => WebpackConfig;
  pageExtensions?: string[];
  turbopack?: TurbopackConfig;
  [key: string]: unknown;
}

interface TurbopackConfig {
  root?: string;
  rules?: Record<string, TurbopackRule | TurbopackRule[]>;
  resolveAlias?: Record<string, string | string[] | Record<string, string>>;
  resolveExtensions?: string[];
  debugIds?: boolean;
  [key: string]: unknown;
}

interface TurbopackRule {
  loaders?: Array<string | { loader: string; options?: Record<string, unknown> }>;
  as?: string;
  type?: string;
  condition?: TurbopackCondition;
}

type TurbopackCondition =
  | string
  | { not: TurbopackCondition }
  | { all: TurbopackCondition[] }
  | { any: TurbopackCondition[] }
  | { path: string | RegExp }
  | { content: RegExp }
  | { query: string | RegExp }
  | { contentType: string | RegExp };

interface WebpackConfig {
  module?: { rules?: WebpackRule[] };
  resolve?: { alias?: Record<string, string | string[]> };
  [key: string]: unknown;
}

interface WebpackRule {
  test?: RegExp | ((path: string) => boolean);
  include?: string | RegExp | Array<string | RegExp> | ((path: string) => boolean);
  exclude?: string | RegExp | Array<string | RegExp> | ((path: string) => boolean);
  use?: WebpackUseEntry | WebpackUseEntry[];
  [key: string]: unknown;
}

type WebpackUseEntry =
  | string
  | { loader: string; options?: Record<string, unknown> };

interface WebpackContext {
  dir: string;
  isServer: boolean;
  dev: boolean;
  buildId: string;
  config: NextConfig;
}

// Next.js's closed set of route-filename conventions. Every file
// matching one of these names under `app/` (or `src/app/`) is
// dispatched by Next's runtime — never imported by sibling code —
// so it's safe to apply the inline-action loader without triggering
// Turbopack's path-doubling bug.
const INLINE_ROUTE_FILENAMES = [
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "default",
  "not-found",
] as const;

export function withEzlogsConfig(nextConfig: NextConfig = {}): NextConfig {
  const userWebpack = nextConfig.webpack;
  const loaderPath = resolveLoaderPath();

  return {
    ...nextConfig,
    webpack(config, options): WebpackConfig {
      const merged = userWebpack ? userWebpack(config, options) : config;
      // Server-side only — capturing client bundles would emit events
      // from the browser, which is out of scope.
      if (!options.isServer) return merged;
      return installLoaders(merged, options);
    },
    turbopack: mergeTurbopackConfig(nextConfig.turbopack, loaderPath),
  };
}

function mergeTurbopackConfig(
  userTurbopack: TurbopackConfig | undefined,
  loaderPath: string,
): TurbopackConfig {
  // Per-extension rules. Turbopack's `as` field is the loader-output's
  // file-type assertion — when set to "*.js" it skips TS parsing on
  // the output, which fails on TypeScript route handlers. The fix:
  // emit one rule per source extension and set `as` to the matching
  // extension so the output re-enters the appropriate compilation
  // pipeline (TS/TSX/JS/JSX).
  const ezlogsRules: Record<string, TurbopackRule | TurbopackRule[]> = {};

  for (const ext of ["ts", "tsx", "js", "jsx"] as const) {
    ezlogsRules[`**/{app,src/app}/**/route.${ext}`] = {
      condition: { not: "browser" },
      loaders: [
        {
          loader: loaderPath,
          options: { kind: "app-route-handler" },
        },
      ],
      as: `*.${ext}`,
    };
    ezlogsRules[`**/{pages,src/pages}/api/**/*.${ext}`] = {
      condition: { not: "browser" },
      loaders: [
        {
          loader: loaderPath,
          options: { kind: "pages-api" },
        },
      ],
      as: `*.${ext}`,
    };
    // Root middleware.ts (or src/middleware.ts). Next supports exactly
    // one middleware file per project, located at the project root or
    // under src/. We auto-wrap so a fresh install seeds correlation_id
    // on every request without the user touching their middleware code.
    ezlogsRules[`**/middleware.${ext}`] = {
      condition: { not: "browser" },
      loaders: [
        {
          loader: loaderPath,
          options: { kind: "middleware" },
        },
      ],
      as: `*.${ext}`,
    };
    ezlogsRules[`**/src/middleware.${ext}`] = {
      condition: { not: "browser" },
      loaders: [
        {
          loader: loaderPath,
          options: { kind: "middleware" },
        },
      ],
      as: `*.${ext}`,
    };

    // Server Actions live in user-conventional directories: `actions/`,
    // `app/actions/`, `src/actions/`, `src/app/actions/`. We scope the
    // loader to those paths instead of running on every TS file —
    // running on every file caused Turbopack to double-append `.tsx`
    // to imports of unrelated component files (it normalizes paths
    // through the loader's `as` hint, even when the loader returns
    // source unchanged).
    //
    // Files outside these conventional locations that still use
    // `"use server"` will not be auto-wrapped — users with non-standard
    // layouts can fall back to manual `captureServerAction()` or open
    // an issue.
    const actionGlobs = [
      `**/{actions,src/actions}/**/*.${ext}`,
      `**/{app,src/app}/**/actions.${ext}`,
      `**/{app,src/app}/**/actions/**/*.${ext}`,
    ];
    for (const glob of actionGlobs) {
      ezlogsRules[glob] = {
        condition: { not: "browser" },
        loaders: [
          {
            loader: loaderPath,
            options: { kind: "server-action" },
          },
        ],
        as: `*.${ext}`,
      };
    }

    // Supabase factory files — `lib/supabase/*`, `utils/supabase/*`,
    // and the same under `src/`. These are the conventional locations
    // for `createClient` / `createServerClient` factory definitions in
    // Next + Supabase apps (matches the Supabase docs template + Vercel
    // starter templates). The loader rewrites factory imports so every
    // returned client is wrapped with `wrapSupabase()`.
    const supabaseGlobs = [
      `**/{lib,src/lib,utils,src/utils}/supabase/**/*.${ext}`,
    ];
    for (const glob of supabaseGlobs) {
      ezlogsRules[glob] = {
        condition: { not: "browser" },
        loaders: [
          {
            loader: loaderPath,
            options: { kind: "supabase-factory" },
          },
        ],
        as: `*.${ext}`,
      };
    }

    // Inline `"use server"` actions inside RSC route files. Scoping
    // to Next's closed set of route filenames (page/layout/template/
    // loading/error/default/not-found) keeps the glob narrow, AND a
    // content condition restricts the rule to files that actually
    // contain `"use server"`. Without the content gate, Turbopack
    // wires this loader chain onto every `page.tsx` in the project —
    // and the mere presence of a loader chain on `page.tsx` triggers
    // the path-doubling bug (`./page.tsx.tsx`), even when the loader
    // returns its input unchanged. Verified live against
    // nextjs-auth-starter on 2026-05-10: narrow glob alone, and
    // narrow glob + dropping `as`, both still hit the bug. The
    // content condition ducks the bug entirely by skipping rule
    // registration on the affected files.
    //
    // We also OMIT `as: "*.${ext}"` here: the inline-action transform
    // only adds existing syntax (function calls, async/await, an
    // import), so the output doesn't need to re-enter TS compilation.
    for (const inlineFilename of INLINE_ROUTE_FILENAMES) {
      ezlogsRules[`**/{app,src/app}/**/${inlineFilename}.${ext}`] = {
        condition: {
          all: [{ not: "browser" }, { content: /"use server"|'use server'/ }],
        },
        loaders: [
          {
            loader: loaderPath,
            options: { kind: "inline-server-action" },
          },
        ],
      };
    }
  }

  return {
    ...userTurbopack,
    rules: {
      ...(userTurbopack?.rules ?? {}),
      ...ezlogsRules,
    },
  };
}

function installLoaders(
  config: WebpackConfig,
  context: WebpackContext,
): WebpackConfig {
  const loaderPath = resolveLoaderPath();
  const projectDir = context.dir;
  const pageExtensions = context.config.pageExtensions ?? ["tsx", "ts", "jsx", "js"];
  const extPattern = pageExtensions.join("|");

  const appDir = resolve(projectDir, "app");
  const srcAppDir = resolve(projectDir, "src/app");
  const pagesDir = resolve(projectDir, "pages");
  const srcPagesDir = resolve(projectDir, "src/pages");

  const newRules: WebpackRule[] = [];

  newRules.push({
    test: new RegExp(`[/\\\\]route\\.(${extPattern})$`),
    include: [appDir, srcAppDir],
    use: [
      {
        loader: loaderPath,
        options: { kind: "app-route-handler", projectDir },
      },
    ],
  });

  newRules.push({
    test: new RegExp(`[/\\\\]pages[/\\\\]api[/\\\\].*\\.(${extPattern})$`),
    include: [pagesDir, srcPagesDir],
    use: [
      {
        loader: loaderPath,
        options: { kind: "pages-api", projectDir },
      },
    ],
  });

  // Root middleware.ts — Next allows exactly one of:
  //   <projectDir>/middleware.{ts,tsx,js,jsx}
  //   <projectDir>/src/middleware.{ts,tsx,js,jsx}
  // Anchor on the project root so we never auto-wrap a file named
  // middleware.ts buried inside node_modules or a subdirectory the
  // user didn't intend.
  newRules.push({
    test: new RegExp(`^${escapeRegex(projectDir)}[/\\\\](src[/\\\\])?middleware\\.(${extPattern})$`),
    use: [
      {
        loader: loaderPath,
        options: { kind: "middleware", projectDir },
      },
    ],
  });

  // Server Actions — scoped to the conventional `actions/` directories.
  // Running on every file broke Turbopack import resolution (the `as`
  // hint doubled extensions on component imports). The loader fast-path
  // still skips any file without a top-level "use server" directive.
  const actionsActionsDir = resolve(projectDir, "actions");
  const srcActionsDir = resolve(projectDir, "src/actions");
  const appActionsDir = resolve(projectDir, "app/actions");
  const srcAppActionsDir = resolve(projectDir, "src/app/actions");
  newRules.push({
    test: new RegExp(`\\.(${extPattern})$`),
    include: [actionsActionsDir, srcActionsDir, appActionsDir, srcAppActionsDir],
    use: [
      {
        loader: loaderPath,
        options: { kind: "server-action", projectDir },
      },
    ],
  });
  // Sibling-style actions: app/<route>/actions.ts, src/app/<route>/actions.ts.
  // Webpack rules can't combine include with a path-anchored regex easily,
  // so we use a regex that matches files literally named "actions.<ext>"
  // anywhere under app/ or src/app/.
  const appDirForActions = resolve(projectDir, "app");
  const srcAppDirForActions = resolve(projectDir, "src/app");
  newRules.push({
    test: new RegExp(`[/\\\\]actions\\.(${extPattern})$`),
    include: [appDirForActions, srcAppDirForActions],
    use: [
      {
        loader: loaderPath,
        options: { kind: "server-action", projectDir },
      },
    ],
  });

  // Supabase factory files — `lib/supabase/`, `utils/supabase/`, and
  // their `src/` variants. The loader rewrites any imported factory
  // from `@supabase/supabase-js` or `@supabase/ssr` so every
  // constructed client is wrapped with `wrapSupabase()`.
  const libSupabase = resolve(projectDir, "lib/supabase");
  const srcLibSupabase = resolve(projectDir, "src/lib/supabase");
  const utilsSupabase = resolve(projectDir, "utils/supabase");
  const srcUtilsSupabase = resolve(projectDir, "src/utils/supabase");
  newRules.push({
    test: new RegExp(`\\.(${extPattern})$`),
    include: [libSupabase, srcLibSupabase, utilsSupabase, srcUtilsSupabase],
    use: [
      {
        loader: loaderPath,
        options: { kind: "supabase-factory", projectDir },
      },
    ],
  });

  // Inline `"use server"` actions inside RSC route files. Anchored on
  // Next's closed set of conventional filenames (page/layout/template/
  // loading/error/default/not-found) so the rule never fires on a
  // file that could be imported by a sibling component.
  newRules.push({
    test: new RegExp(
      `[/\\\\](${INLINE_ROUTE_FILENAMES.join("|")})\\.(${extPattern})$`,
    ),
    include: [appDir, srcAppDir],
    use: [
      {
        loader: loaderPath,
        options: { kind: "inline-server-action", projectDir },
      },
    ],
  });

  const updated: WebpackConfig = { ...config };
  if (!updated.module) updated.module = {};
  if (!updated.module.rules) updated.module.rules = [];
  updated.module.rules = [...updated.module.rules, ...newRules];

  return updated;
}

function resolveLoaderPath(): string {
  const here =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return resolve(here, "loader.cjs");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
