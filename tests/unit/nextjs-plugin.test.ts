// withEzlogsConfig() integration tests against synthetic Next.js
// webpack contexts. Asserts that the plugin merges with the user's
// existing webpack hook, installs loader rules for App + Pages
// routers, and only applies on the server build.

import { describe, expect, it, vi } from "vitest";
import { withEzlogsConfig } from "../../src/nextjs-plugin/index.js";

interface WebpackContext {
  dir: string;
  isServer: boolean;
  dev: boolean;
  buildId: string;
  config: { pageExtensions?: string[] };
}

interface WebpackConfig {
  module?: { rules?: Array<Record<string, unknown>> };
  resolve?: { alias?: Record<string, string> };
  [key: string]: unknown;
}

function ctx(over: Partial<WebpackContext> = {}): WebpackContext {
  return {
    dir: "/project",
    isServer: true,
    dev: false,
    buildId: "test",
    config: {},
    ...over,
  };
}

describe("withEzlogsConfig", () => {
  it("returns the input config when webpack is not invoked", () => {
    const out = withEzlogsConfig({ reactStrictMode: true } as never);
    expect((out as { reactStrictMode: boolean }).reactStrictMode).toBe(true);
    expect(typeof (out as { webpack: unknown }).webpack).toBe("function");
  });

  it("preserves the user's existing webpack hook", () => {
    const userHook = vi.fn(
      (config: WebpackConfig) => ({ ...config, userHooked: true }) as WebpackConfig,
    );

    const out = withEzlogsConfig({ webpack: userHook } as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };

    const result = out.webpack({ module: { rules: [] } }, ctx());
    expect(userHook).toHaveBeenCalled();
    expect((result as WebpackConfig & { userHooked?: boolean }).userHooked).toBe(true);
  });

  it("installs two loader rules on the server build", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };

    const result = out.webpack({ module: { rules: [] } }, ctx());
    const rules = result.module?.rules ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(2);

    const tests = rules.map((r) => String(r.test));
    // App Router: matches files ending with /route.ts|.js|.tsx|.jsx
    expect(tests.some((t) => t.includes("route"))).toBe(true);
    // Pages Router: matches pages/api/*
    expect(tests.some((t) => t.includes("pages") && t.includes("api"))).toBe(true);
  });

  it("does NOT install loader rules on the client build", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };

    const result = out.webpack(
      { module: { rules: [] } },
      ctx({ isServer: false }),
    );
    expect(result.module?.rules ?? []).toHaveLength(0);
  });

  it("respects user-configured pageExtensions", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };

    const result = out.webpack(
      { module: { rules: [] } },
      ctx({ config: { pageExtensions: ["mts", "ts"] } }),
    );
    const rules = result.module?.rules ?? [];
    const tests = rules.map((r) => String(r.test));
    expect(tests.some((t) => t.includes("mts"))).toBe(true);
  });

  it("appends to the user's existing module.rules array (does not replace)", () => {
    const userRule = {
      test: /\.svg$/,
      use: "raw-loader",
    };
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };

    const result = out.webpack(
      { module: { rules: [userRule] } },
      ctx(),
    );

    const rules = result.module?.rules ?? [];
    expect(rules).toContainEqual(userRule);
    expect(rules.length).toBeGreaterThan(1);
  });
});

describe("withEzlogsConfig — Turbopack rules", () => {
  it("emits one rule per source extension for App + Pages routers", () => {
    const out = withEzlogsConfig({} as never) as {
      turbopack?: { rules?: Record<string, unknown> };
    };
    expect(out.turbopack).toBeDefined();
    const rules = out.turbopack?.rules ?? {};
    const keys = Object.keys(rules);

    // Per-extension App Router rules — `as` must match input extension
    // so TS/TSX files re-enter Turbopack's TypeScript pipeline instead
    // of being parsed as plain JS.
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      expect(keys).toContain(`**/{app,src/app}/**/route.${ext}`);
      expect(keys).toContain(`**/{pages,src/pages}/api/**/*.${ext}`);
    }
  });

  it("each rule preserves the source extension via `as`", () => {
    const out = withEzlogsConfig({} as never) as {
      turbopack?: { rules?: Record<string, { as?: string }> };
    };
    const rules = out.turbopack?.rules ?? {};
    expect(rules["**/{app,src/app}/**/route.ts"]?.as).toBe("*.ts");
    expect(rules["**/{app,src/app}/**/route.tsx"]?.as).toBe("*.tsx");
    expect(rules["**/{pages,src/pages}/api/**/*.tsx"]?.as).toBe("*.tsx");
  });

  it("merges with the user's existing turbopack.rules (does not replace)", () => {
    const userRules = {
      "*.svg": { loaders: ["@svgr/webpack"], as: "*.js" },
    };
    const out = withEzlogsConfig({
      turbopack: { rules: userRules },
    } as never) as {
      turbopack?: { rules?: Record<string, unknown> };
    };
    const rules = out.turbopack?.rules ?? {};
    expect(rules["*.svg"]).toEqual(userRules["*.svg"]);
    expect(Object.keys(rules).length).toBeGreaterThan(1);
  });

  it("preserves user-configured turbopack.root and resolveAlias", () => {
    const out = withEzlogsConfig({
      turbopack: {
        root: "/some/root",
        resolveAlias: { foo: "bar" },
      },
    } as never) as {
      turbopack?: { root?: string; resolveAlias?: Record<string, string> };
    };
    expect(out.turbopack?.root).toBe("/some/root");
    expect(out.turbopack?.resolveAlias?.foo).toBe("bar");
  });

  it("Turbopack rules are gated server-only (not:browser)", () => {
    const out = withEzlogsConfig({} as never) as {
      turbopack?: { rules?: Record<string, { condition?: unknown }> };
    };
    const rules = out.turbopack?.rules ?? {};
    // Each rule must include the not:browser gate either as the entire
    // condition or as one branch of an `all` compound. The Server Action
    // glob also excludes node_modules/.next, so its condition is compound.
    for (const rule of Object.values(rules)) {
      const cond = rule.condition as
        | { not: unknown }
        | { all: Array<{ not: unknown }> };
      const isSimpleNotBrowser =
        "not" in cond && (cond as { not: unknown }).not === "browser";
      const isCompoundWithNotBrowser =
        "all" in cond &&
        Array.isArray((cond as { all: unknown[] }).all) &&
        (cond as { all: Array<{ not: unknown }> }).all.some(
          (b) => b && typeof b === "object" && "not" in b && b.not === "browser",
        );
      expect(isSimpleNotBrowser || isCompoundWithNotBrowser).toBe(true);
    }
  });

  it("emits Turbopack rules for root middleware (both layouts)", () => {
    const out = withEzlogsConfig({} as never) as {
      turbopack?: {
        rules?: Record<
          string,
          { loaders?: Array<{ options?: { kind?: string } }>; as?: string }
        >;
      };
    };
    const rules = out.turbopack?.rules ?? {};
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      const rootKey = `**/middleware.${ext}`;
      const srcKey = `**/src/middleware.${ext}`;
      expect(rules[rootKey]).toBeDefined();
      expect(rules[srcKey]).toBeDefined();
      expect(rules[rootKey]?.loaders?.[0]?.options?.kind).toBe("middleware");
      expect(rules[srcKey]?.loaders?.[0]?.options?.kind).toBe("middleware");
      expect(rules[rootKey]?.as).toBe(`*.${ext}`);
    }
  });
});

describe("withEzlogsConfig — middleware Webpack rule", () => {
  it("matches the project root middleware.ts", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };
    const result = out.webpack({ module: { rules: [] } }, ctx({ dir: "/project" }));
    const rules = result.module?.rules ?? [];
    const middlewareRule = rules.find((r) => {
      const useArr = (r as { use?: Array<{ options?: { kind?: string } }> }).use;
      return useArr?.[0]?.options?.kind === "middleware";
    });
    expect(middlewareRule).toBeDefined();

    const test = (middlewareRule as { test: RegExp }).test;
    expect(test.test("/project/middleware.ts")).toBe(true);
    expect(test.test("/project/src/middleware.ts")).toBe(true);
    expect(test.test("/project/middleware.tsx")).toBe(true);
  });

  it("does NOT match middleware files outside the project root", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };
    const result = out.webpack({ module: { rules: [] } }, ctx({ dir: "/project" }));
    const rules = result.module?.rules ?? [];
    const middlewareRule = rules.find((r) => {
      const useArr = (r as { use?: Array<{ options?: { kind?: string } }> }).use;
      return useArr?.[0]?.options?.kind === "middleware";
    }) as { test: RegExp };

    expect(middlewareRule.test.test("/project/lib/middleware.ts")).toBe(false);
    expect(middlewareRule.test.test("/project/node_modules/foo/middleware.ts")).toBe(false);
    expect(middlewareRule.test.test("/other-project/middleware.ts")).toBe(false);
  });

  it("does NOT install middleware loader on client build", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };
    const result = out.webpack(
      { module: { rules: [] } },
      ctx({ isServer: false }),
    );
    expect(result.module?.rules ?? []).toHaveLength(0);
  });
});

describe("withEzlogsConfig — inline-server-action rules", () => {
  const INLINE_FILENAMES = [
    "page",
    "layout",
    "template",
    "loading",
    "error",
    "default",
    "not-found",
  ];

  it("installs a Webpack rule whose test matches every inline route filename", () => {
    const out = withEzlogsConfig({} as never) as {
      webpack: (c: WebpackConfig, ctx: WebpackContext) => WebpackConfig;
    };
    const result = out.webpack({ module: { rules: [] } }, ctx({ dir: "/project" }));
    const rules = result.module?.rules ?? [];
    const inlineRule = rules.find((r) => {
      const useArr = (r as { use?: Array<{ options?: { kind?: string } }> }).use;
      return useArr?.[0]?.options?.kind === "inline-server-action";
    });
    expect(inlineRule).toBeDefined();

    const test = (inlineRule as { test: RegExp }).test;
    for (const filename of INLINE_FILENAMES) {
      for (const ext of ["ts", "tsx", "js", "jsx"]) {
        expect(test.test(`/project/app/posts/${filename}.${ext}`)).toBe(true);
        expect(test.test(`/project/src/app/posts/${filename}.${ext}`)).toBe(true);
      }
    }
    // Must NOT match unrelated filenames under app/.
    expect(test.test("/project/app/posts/route.ts")).toBe(false);
    expect(test.test("/project/app/posts/some-component.tsx")).toBe(false);
  });

  it("installs Turbopack rules for all 28 filename × extension combinations gated on `\"use server\"` content", () => {
    // `as` is deliberately NOT set, and the rule fires only on files
    // whose content matches /"use server"|'use server'/. Without this
    // content gate, Turbopack registers the loader chain on every
    // page.tsx and triggers a path-doubling bug. See
    // nextjs-plugin/index.ts comment + 2026-05-10 decisions log.
    const out = withEzlogsConfig({} as never) as {
      turbopack?: {
        rules?: Record<
          string,
          {
            loaders?: Array<{ options?: { kind?: string } }>;
            as?: string;
            condition?: { all?: Array<{ not?: string; content?: RegExp }> };
          }
        >;
      };
    };
    const rules = out.turbopack?.rules ?? {};
    let count = 0;
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      for (const filename of INLINE_FILENAMES) {
        const key = `**/{app,src/app}/**/${filename}.${ext}`;
        const rule = rules[key];
        expect(rule, `expected rule for ${key}`).toBeDefined();
        expect(rule?.loaders?.[0]?.options?.kind).toBe("inline-server-action");
        expect(rule?.as).toBeUndefined();
        const conds = rule?.condition?.all ?? [];
        expect(conds.length).toBe(2);
        expect(conds[0]?.not).toBe("browser");
        expect(conds[1]?.content).toBeInstanceOf(RegExp);
        // Sanity: directive matches, plain page contents do not.
        expect(conds[1]?.content?.test('async function foo() { "use server"; }')).toBe(true);
        expect(conds[1]?.content?.test('"use client"\nexport default function Page() {}')).toBe(false);
        count += 1;
      }
    }
    expect(count).toBe(28);
  });
});
