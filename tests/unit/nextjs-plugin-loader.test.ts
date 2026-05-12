// Loader unit tests.
//
// We invoke the loader's main function directly with a synthetic
// context and source code. Asserts the transformed output renames the
// user's exports in-place and appends wrapper exports.

import { describe, expect, it } from "vitest";
import loader, { pitch } from "../../src/nextjs-plugin/loader.js";

interface TestContext {
  resourcePath: string;
  resource: string;
  request: string;
  remainingRequest: string;
  query: string | Record<string, unknown>;
  getOptions: () => Record<string, unknown>;
}

function makeContext(overrides: Partial<TestContext> & { kind: string }): TestContext {
  return {
    resourcePath: overrides.resourcePath ?? "/project/app/api/users/route.ts",
    resource: overrides.resource ?? "/project/app/api/users/route.ts",
    request: overrides.request ?? "/project/app/api/users/route.ts",
    remainingRequest: overrides.remainingRequest ?? "",
    query: overrides.query ?? "",
    getOptions: () => ({ kind: overrides.kind }),
  };
}

describe("pitch() — no-op", () => {
  it("returns undefined (we no longer use the bypass-query trick)", () => {
    const ctx = makeContext({ kind: "app-route-handler" });
    expect(pitch.call(ctx as never, "")).toBeUndefined();
  });
});

describe("loader — App Router rewrite", () => {
  it("renames `export async function GET` and appends a wrapped export", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/users/route.ts",
    });
    const source = `import { db } from "../db";\n\nexport async function GET(req: Request) {\n  return Response.json(await db.users.findMany());\n}\n`;
    const out = loader.call(ctx as never, source);

    // Original export keyword stripped + identifier renamed
    expect(out).toContain("async function __ezlogs_orig_GET(");
    expect(out).not.toMatch(/^export\s+async\s+function\s+GET\b/m);
    // Wrapped re-export appended
    expect(out).toContain('import { captureRoute as __ezlogs_capture } from "ezlogs-nextjs"');
    expect(out).toContain("export const GET = __ezlogs_capture(__ezlogs_orig_GET, __ezlogs_meta)");
    expect(out).toContain('"routeModulePath":"app/api/users"');
    // Rest of the user's code is preserved verbatim
    expect(out).toContain('import { db } from "../db"');
    expect(out).toContain("Response.json(await db.users.findMany())");
  });

  it("handles `export function NAME` (non-async)", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/x/route.ts",
    });
    const source = `export function POST(req) { return new Response("ok"); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("function __ezlogs_orig_POST(");
    expect(out).toContain("export const POST = __ezlogs_capture(__ezlogs_orig_POST");
  });

  it("handles `export const NAME = ...` arrow form", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/x/route.ts",
    });
    const source = `export const POST = async (req: Request) => Response.json({ ok: true });\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("const __ezlogs_orig_POST = async (req: Request)");
    expect(out).toContain("export const POST = __ezlogs_capture(__ezlogs_orig_POST");
  });

  it("handles typed `export const POST: RouteHandler = ...`", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/x/route.ts",
    });
    const source = `export const POST: RouteHandler = async (req) => Response.json({});\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("const __ezlogs_orig_POST: RouteHandler = async (req)");
    expect(out).toContain("export const POST = __ezlogs_capture(__ezlogs_orig_POST");
  });

  it("wraps multiple exported methods (GET + POST + DELETE)", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/items/route.ts",
    });
    const source = [
      "export async function GET() { return Response.json([]); }",
      "export async function POST(req) { return Response.json({}, { status: 201 }); }",
      "export const DELETE = async () => new Response(null, { status: 204 });",
      "",
    ].join("\n");
    const out = loader.call(ctx as never, source);

    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect(out).toContain(`__ezlogs_orig_${method}`);
      expect(out).toContain(`export const ${method} = __ezlogs_capture(__ezlogs_orig_${method}`);
    }
  });

  it("passes through routes with no recognized HTTP-method exports", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/x/route.ts",
    });
    const source = `export { GET } from "./shared";\n`; // re-export pattern we don't handle
    expect(loader.call(ctx as never, source)).toBe(source);
  });

  it("is idempotent — already-wrapped source is returned unchanged", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/x/route.ts",
    });
    const wrapped = `async function __ezlogs_orig_GET() {}\nexport const GET = __ezlogs_capture(__ezlogs_orig_GET, ${"{}"});\n`;
    expect(loader.call(ctx as never, wrapped)).toBe(wrapped);
  });

  it("computes routeModulePath correctly for src/app paths", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/src/app/api/widgets/[id]/route.ts",
    });
    const source = `export async function GET() { return new Response(); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain('"routeModulePath":"app/api/widgets/[id]"');
  });

  it("preserves dynamic-route segments ([...slug])", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/project/app/api/posts/[...slug]/route.tsx",
    });
    const source = `export async function GET() { return new Response(); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain('"routeModulePath":"app/api/posts/[...slug]"');
  });
});

// Local-aliased re-export shape used by NextAuth catch-all routes and
// similar auth libraries:
//   const handler = NextAuth(authOptions)
//   export { handler as GET, handler as POST }
// The wrapper replaces the export statement with one captureRoute
// call per method, preserving the local declaration.
describe("loader — App Router local-aliased re-export rewrite", () => {
  const nextAuthCtx = (resourcePath = "/project/app/api/auth/[...nextauth]/route.ts"): TestContext =>
    makeContext({ kind: "app-route-handler", resourcePath });

  it("wraps the NextAuth catch-all shape (`export { handler as GET, handler as POST }`)", () => {
    const source = `import NextAuth from "next-auth";
import { authOptions } from "@/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
`;
    const out = loader.call(nextAuthCtx() as never, source);

    // Local declaration preserved verbatim.
    expect(out).toContain("const handler = NextAuth(authOptions);");
    // Original export statement removed.
    expect(out).not.toMatch(/export\s*\{\s*handler\s+as\s+GET/);
    // Wrapped exports added.
    expect(out).toContain('import { captureRoute as __ezlogs_capture } from "ezlogs-nextjs"');
    expect(out).toContain("export const GET = __ezlogs_capture(handler, __ezlogs_meta)");
    expect(out).toContain("export const POST = __ezlogs_capture(handler, __ezlogs_meta)");
    // Route module path computed from the resource path.
    expect(out).toContain('"routeModulePath":"app/api/auth/[...nextauth]"');
  });

  it("handles partial method coverage (`export { handler as GET }` alone)", () => {
    const source = `const handler = NextAuth();
export { handler as GET };
`;
    const out = loader.call(nextAuthCtx() as never, source);
    expect(out).toContain("export const GET = __ezlogs_capture(handler, __ezlogs_meta)");
    expect(out).not.toContain("export const POST");
  });

  it("does NOT rewrite cross-file re-exports (`export { GET } from \"./shared\"`)", () => {
    const source = `export { GET } from "./shared";\n`;
    expect(loader.call(nextAuthCtx() as never, source)).toBe(source);
  });

  it("does NOT rewrite cross-file aliased re-exports (`export { foo as GET } from \"./x\"`)", () => {
    const source = `export { foo as GET, bar as POST } from "./external";\n`;
    expect(loader.call(nextAuthCtx() as never, source)).toBe(source);
  });

  it("does NOT rewrite mixed blocks containing non-method names", () => {
    // The block has `helperFn` with no `as METHOD` — too risky to
    // partial-rewrite, so we bail out entirely.
    const source = `const handler = makeHandler();
const helperFn = () => {};
export { handler as GET, helperFn };
`;
    expect(loader.call(nextAuthCtx() as never, source)).toBe(source);
  });

  it("does NOT match lowercase method names (only uppercase HTTP verbs)", () => {
    const source = `const handler = NextAuth();
export { handler as get, handler as post };
`;
    expect(loader.call(nextAuthCtx() as never, source)).toBe(source);
  });

  it("is idempotent — already-wrapped source passes through unchanged", () => {
    const source = `const handler = NextAuth();
export { handler as GET, handler as POST };
`;
    const once = loader.call(nextAuthCtx() as never, source);
    const twice = loader.call(nextAuthCtx() as never, once);
    expect(twice).toBe(once);
  });
});

describe("loader — Pages Router rewrite", () => {
  it("rewrites `export default async function NAME` to const + wrapped default", () => {
    const ctx = makeContext({
      kind: "pages-api",
      resourcePath: "/project/pages/api/users.ts",
    });
    const source = `export default async function handler(req, res) {\n  res.status(200).json({ ok: true });\n}\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("const __ezlogs_orig_default = async function");
    expect(out).toContain('import { capturePagesApi as __ezlogs_capture_pages } from "ezlogs-nextjs"');
    expect(out).toContain("__ezlogs_capture_pages(__ezlogs_orig_default, __ezlogs_meta)");
    expect(out).toContain('"routeModulePath":"pages/api/users"');
  });

  it("rewrites anonymous `export default function`", () => {
    const ctx = makeContext({
      kind: "pages-api",
      resourcePath: "/project/pages/api/x.ts",
    });
    const source = `export default function (req, res) { res.end("ok"); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("const __ezlogs_orig_default = function");
  });

  it("rewrites `export default <identifier>`", () => {
    const ctx = makeContext({
      kind: "pages-api",
      resourcePath: "/project/pages/api/x.ts",
    });
    const source = `function handler(req, res) {}\nexport default handler;\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain("const __ezlogs_orig_default = handler");
    expect(out).toContain("__ezlogs_capture_pages(__ezlogs_orig_default");
  });

  it("strips src/ prefix on Pages Router routes", () => {
    const ctx = makeContext({
      kind: "pages-api",
      resourcePath: "/project/src/pages/api/widgets.ts",
    });
    const source = `export default function (req, res) { res.end(); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain('"routeModulePath":"pages/api/widgets"');
  });

  it("passes through Pages Router files without an export default", () => {
    const ctx = makeContext({
      kind: "pages-api",
      resourcePath: "/project/pages/api/x.ts",
    });
    const source = `export const config = { runtime: "edge" };\n`;
    expect(loader.call(ctx as never, source)).toBe(source);
  });
});

describe("loader — defensive fallbacks", () => {
  it("falls back to a sensible routeModulePath when the path has no /app/ segment", () => {
    const ctx = makeContext({
      kind: "app-route-handler",
      resourcePath: "/somewhere/route.ts",
    });
    const source = `export async function GET() { return new Response(); }\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toContain('"routeModulePath":"app/route"');
  });

  it("reads options from query string when getOptions is unavailable", () => {
    const ctx: TestContext = {
      resourcePath: "/project/app/api/x/route.ts",
      resource: "/project/app/api/x/route.ts",
      request: "",
      remainingRequest: "",
      query: "?kind=app-route-handler",
      getOptions: () => ({}),
    };
    // override getOptions to simulate Webpack v4-style ctx
    const ctxWithoutGetOptions = { ...ctx, getOptions: undefined };
    const source = `export async function GET() { return new Response(); }\n`;
    const out = loader.call(
      ctxWithoutGetOptions as unknown as TestContext,
      source,
    );
    expect(out).toContain('"routeModulePath":"app/api/x"');
  });
});

describe("loader — Middleware rewrite", () => {
  it("wraps `export function middleware(...)`", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    const source = `import type { NextRequest } from "next/server";\nexport function middleware(req: NextRequest) {\n  return Response.next();\n}\nexport const config = { matcher: ["/:path*"] };\n`;
    const out = loader.call(ctx as never, source);

    expect(out).toContain("function __ezlogs_orig_middleware(");
    expect(out).toContain('import { withMiddlewareCapture as __ezlogs_with_mw } from "ezlogs-nextjs"');
    expect(out).toContain("export const middleware = __ezlogs_with_mw(__ezlogs_orig_middleware)");
    // config export must pass through untouched
    expect(out).toContain('export const config = { matcher: ["/:path*"] }');
  });

  it("wraps `export async function middleware(...)`", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/src/middleware.ts",
    });
    const source = `export async function middleware(req) { return req; }\n`;
    const out = loader.call(ctx as never, source);

    expect(out).toContain("async function __ezlogs_orig_middleware(");
    expect(out).toContain("export const middleware = __ezlogs_with_mw(__ezlogs_orig_middleware)");
  });

  it("wraps `export const middleware = ...`", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    const source = `export const middleware = (req) => req;\n`;
    const out = loader.call(ctx as never, source);

    expect(out).toContain("const __ezlogs_orig_middleware =");
    expect(out).toContain("export const middleware = __ezlogs_with_mw(__ezlogs_orig_middleware)");
  });

  it("wraps `export default function ...`", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    const source = `export default async function (req) { return req; }\n`;
    const out = loader.call(ctx as never, source);

    expect(out).toContain("const __ezlogs_orig_default = async function");
    expect(out).toContain("export default __ezlogs_with_mw(__ezlogs_orig_default)");
  });

  it("wraps `export default <expression>`", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    const source = `const handler = (req) => req;\nexport default handler;\n`;
    const out = loader.call(ctx as never, source);

    expect(out).toContain("const __ezlogs_orig_default = handler;");
    expect(out).toContain("export default __ezlogs_with_mw(__ezlogs_orig_default)");
  });

  it("is idempotent — already-wrapped sources pass through", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    const source = `function __ezlogs_orig_middleware(req) { return req; }\nexport const middleware = __ezlogs_with_mw(__ezlogs_orig_middleware);\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toBe(source);
  });

  it("passes through unrecognized export shapes", () => {
    const ctx = makeContext({
      kind: "middleware",
      resourcePath: "/project/middleware.ts",
    });
    // Re-export pattern — we don't rewrite these.
    const source = `export { middleware } from "./impl";\n`;
    const out = loader.call(ctx as never, source);
    expect(out).toBe(source);
  });
});

describe("loader — Server Action rewrite", () => {
  function saCtx(resourcePath = "/project/src/app/actions/hardware.ts"): TestContext {
    return makeContext({ kind: "server-action", resourcePath });
  }

  it("passes through files without a top-level \"use server\" directive", () => {
    const source = `export const x = 1;\nexport function helper() { return 1; }\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toBe(source);
  });

  it("wraps `export async function` exports in a \"use server\" file", () => {
    const source =
      `'use server';\n\nimport { db } from "../db";\n\nexport async function createUser(input) { return db.users.insert(input); }\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain("'use server'"); // directive preserved verbatim
    expect(out).toContain("async function __ezlogs_orig_createUser(");
    expect(out).toContain('import { captureServerActionExport as __ezlogs_capture_sa } from "ezlogs-nextjs"');
    expect(out).toContain('export const createUser = __ezlogs_capture_sa(__ezlogs_orig_createUser, "createUser")');
  });

  it("wraps `export const NAME = factory(...)` shape", () => {
    const source =
      `'use server';\nimport { make } from "./make";\nexport const updateUser = make({ permission: "users:update" }, async (ctx, input) => input);\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain("const __ezlogs_orig_updateUser =");
    expect(out).toContain('export const updateUser = __ezlogs_capture_sa(__ezlogs_orig_updateUser, "updateUser")');
  });

  it("wraps multiple exports in a single file", () => {
    const source =
      `"use server";\nexport async function a() {}\nexport async function b() {}\nexport const c = () => 1;\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain('export const a = __ezlogs_capture_sa(__ezlogs_orig_a, "a")');
    expect(out).toContain('export const b = __ezlogs_capture_sa(__ezlogs_orig_b, "b")');
    expect(out).toContain('export const c = __ezlogs_capture_sa(__ezlogs_orig_c, "c")');
  });

  it("skips never-wrap exports (config, metadata, generateMetadata)", () => {
    const source =
      `"use server";\nexport const config = { matcher: ["/x"] };\nexport const metadata = { title: "X" };\nexport async function generateMetadata() { return {}; }\nexport async function realAction() { return 1; }\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain('export const realAction = __ezlogs_capture_sa(__ezlogs_orig_realAction, "realAction")');
    // config / metadata / generateMetadata pass through unchanged
    expect(out).not.toContain("__ezlogs_orig_config");
    expect(out).not.toContain("__ezlogs_orig_metadata");
    expect(out).not.toContain("__ezlogs_orig_generateMetadata");
  });

  it("accepts double-quoted directives", () => {
    const source = `"use server";\nexport async function x() {}\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain('export const x = __ezlogs_capture_sa(__ezlogs_orig_x, "x")');
  });

  it("tolerates leading comments + whitespace before the directive", () => {
    const source =
      `// header comment\n/* block */\n\n  'use server';\nexport async function x() {}\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toContain('export const x = __ezlogs_capture_sa(__ezlogs_orig_x, "x")');
  });

  it("does NOT wrap when 'use server' is inside a function body (function-level directive)", () => {
    // v0.1 only handles file-level directives; function-level needs a real parser.
    const source =
      `import { db } from "./db";\nexport async function notAnAction() {\n  "use server";\n  return db.x;\n}\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toBe(source);
  });

  it("is idempotent — already-wrapped sources pass through unchanged", () => {
    const source =
      `'use server';\nasync function __ezlogs_orig_x() {}\nexport const x = __ezlogs_capture_sa(__ezlogs_orig_x, "x");\n`;
    const out = loader.call(saCtx() as never, source);
    expect(out).toBe(source);
  });

  it("ignores re-export patterns (export { foo } from \"./...\")", () => {
    const source = `'use server';\nexport { foo } from "./impl";\n`;
    const out = loader.call(saCtx() as never, source);
    // No matching shape, no rewrite, but the directive triggered a scan.
    expect(out).toBe(source);
  });
});

describe("loader — Supabase factory import rewrite", () => {
  function sbCtx(resourcePath = "/project/src/lib/supabase/server.ts"): TestContext {
    return makeContext({ kind: "supabase-factory", resourcePath });
  }

  it("rewrites `createServerClient` from @supabase/ssr", () => {
    const source =
      `import { createServerClient } from "@supabase/ssr";\nexport function makeClient() { return createServerClient(url, key, opts); }\n`;
    const out = loader.call(sbCtx() as never, source);

    expect(out).toContain('import { wrapSupabase as __ezlogs_orig_wrap }');
    expect(out).toContain('createServerClient as __ezlogs_orig_createServerClient');
    expect(out).toContain('const createServerClient =');
    expect(out).toContain('__ezlogs_orig_wrap(__ezlogs_orig_createServerClient(...');
    // The original call site is preserved verbatim — it now resolves
    // to the wrapper const instead of the imported binding.
    expect(out).toContain('return createServerClient(url, key, opts);');
  });

  it("rewrites `createClient` from @supabase/supabase-js", () => {
    const source =
      `import { createClient } from "@supabase/supabase-js";\nexport const c = createClient(url, key);\n`;
    const out = loader.call(sbCtx() as never, source);

    expect(out).toContain('createClient as __ezlogs_orig_createClient');
    expect(out).toContain('const createClient =');
    expect(out).toContain('__ezlogs_orig_wrap(__ezlogs_orig_createClient(...');
  });

  it("rewrites multiple factories in the same file", () => {
    const source =
      `import { createClient } from "@supabase/supabase-js";\nimport { createServerClient } from "@supabase/ssr";\nconst a = createClient(u, k);\nconst b = createServerClient(u, k);\n`;
    const out = loader.call(sbCtx() as never, source);

    expect(out).toContain('createClient as __ezlogs_orig_createClient');
    expect(out).toContain('createServerClient as __ezlogs_orig_createServerClient');
  });

  it("preserves other named imports alongside the factory", () => {
    const source =
      `import { createServerClient, type CookieOptions } from "@supabase/ssr";\nconst c = createServerClient(u, k);\n`;
    const out = loader.call(sbCtx() as never, source);
    expect(out).toContain('type CookieOptions');
    expect(out).toContain('createServerClient as __ezlogs_orig_createServerClient');
  });

  it("does NOT rewrite aliased imports (`createServerClient as foo`)", () => {
    const source =
      `import { createServerClient as ssrClient } from "@supabase/ssr";\nconst c = ssrClient(u, k);\n`;
    const out = loader.call(sbCtx() as never, source);
    expect(out).toBe(source);
  });

  it("passes through files that don't import any supabase factory", () => {
    const source = `import { something } from "./helper";\nexport const x = 1;\n`;
    const out = loader.call(sbCtx() as never, source);
    expect(out).toBe(source);
  });

  it("is idempotent — already-rewritten sources pass through", () => {
    const source =
      `import { wrapSupabase as __ezlogs_orig_wrap } from "ezlogs-nextjs/supabase";\nimport { createServerClient as __ezlogs_orig_createServerClient } from "@supabase/ssr";\nconst createServerClient = (...args) => __ezlogs_orig_wrap(__ezlogs_orig_createServerClient(...args));\nexport const c = createServerClient(u, k);\n`;
    const out = loader.call(sbCtx() as never, source);
    expect(out).toBe(source);
  });
});

// Inline `"use server"` actions inside RSC route files (page.tsx,
// layout.tsx, etc.). The transform keeps the function declaration
// AND the directive intact (both required for SWC's Server Reference
// registration) and only wraps the body AFTER the directive.
describe("loader — inline-server-action rewrite", () => {
  const inlineCtx = (resourcePath = "/project/app/posts/[id]/page.tsx"): TestContext =>
    makeContext({ kind: "inline-server-action", resourcePath });

  it("wraps an inline async function and keeps declaration + directive intact", () => {
    const source = `import { redirect } from "next/navigation";
async function deletePost(formData: FormData) {
  "use server";
  await db.posts.delete({ where: { id: formData.get("id") } });
  redirect("/posts");
}
export default function Page() { return null; }
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain('import { __ezlogs_run_inline_server_action } from "ezlogs-nextjs"');
    // Declaration intact (SWC needs it to register the action).
    expect(out).toMatch(/async\s+function\s+deletePost\s*\(formData:\s*FormData\)/);
    // Directive still the first inner statement.
    expect(out).toMatch(/\{\s*\n\s*"use server"/);
    // Body wrapped through the runtime helper.
    expect(out).toContain('return await __ezlogs_run_inline_server_action("deletePost", async () =>');
    expect(out).toContain('redirect("/posts")');
  });

  it("wraps multiple inline actions in one file", () => {
    const source = `async function a() { "use server"; await x(); }
async function b() { "use server"; await y(); }
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain('__ezlogs_run_inline_server_action("a", async () =>');
    expect(out).toContain('__ezlogs_run_inline_server_action("b", async () =>');
  });

  it("preserves a TS return-type annotation on the function", () => {
    const source = `async function getUser(id: string): Promise<User> {
  "use server";
  return await db.findUnique({ where: { id } });
}
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain("Promise<User>");
    expect(out).toContain('__ezlogs_run_inline_server_action("getUser", async () =>');
  });

  it("wraps an arrow-form inline action", () => {
    const source = `const createUser = async (formData: FormData): Promise<void> => {
  "use server";
  await db.users.create({ data: parse(formData) });
};
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain('__ezlogs_run_inline_server_action("createUser", async () =>');
  });

  it("wraps an async function-expression assigned to a const", () => {
    const source = `const updatePost = async function updatePost(formData: FormData) {
  "use server";
  return await db.posts.update({ data: parse(formData) });
};
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain('__ezlogs_run_inline_server_action("updatePost", async () =>');
  });

  it("does NOT wrap a file-level `\"use server\"` directive", () => {
    // The directive isn't inside a function body — it's the first
    // statement at file scope. The file-level loader handles those.
    const source = `"use server";
export async function action() { return 1; }
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toBe(source);
  });

  it("fast-paths files with no `\"use server\"` substring (unchanged)", () => {
    const source = `export default function Page() { return <div>hello</div>; }\n`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toBe(source);
  });

  it("does NOT wrap a string literal containing `\"use server\"` outside the prologue", () => {
    // The directive substring lives inside a function body but as a
    // value, not as the first statement. Must be left alone.
    const source = `function describe() {
  const note = "use server";
  return note;
}
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toBe(source);
  });

  it("does NOT wrap a comment containing `\"use server\"`", () => {
    const source = `// "use server"\nasync function regular() { return 1; }\n`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toBe(source);
  });

  it("is idempotent — already-rewritten sources pass through", () => {
    const source = `import { __ezlogs_run_inline_server_action } from "ezlogs-nextjs";
async function deletePost() { "use server";
return await __ezlogs_run_inline_server_action(\"deletePost\", async () => { await x(); });
}
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toBe(source);
  });

  it("fails open on a sucrase parse error (returns source unchanged + warns)", () => {
    // Deliberately broken syntax. The loader catches the parse error,
    // logs a warning, and returns the source untouched.
    const source = `async function broken() { "use server"; const x = }\n`;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const out = loader.call(inlineCtx() as never, source);
      expect(out).toBe(source);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("transformed TSX with JSX after the inline action stays valid", () => {
    // The output should still be valid TSX — not just textually
    // similar. We verify by re-parsing through sucrase.
    const source = `import { redirect } from "next/navigation";
async function deletePost(formData: FormData): Promise<void> {
  "use server";
  await db.posts.delete({ where: { id: formData.get("id") } });
  redirect("/posts");
}
export default function Page({ params }: { params: { id: string } }) {
  return (
    <form action={deletePost}>
      <input type="hidden" name="id" value={params.id} />
      <button>Delete</button>
    </form>
  );
}
`;
    const out = loader.call(inlineCtx() as never, source);
    expect(out).toContain('__ezlogs_run_inline_server_action("deletePost", async () =>');
    // Round-trip through sucrase to confirm the output is well-formed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require("sucrase/dist/parser/index.js");
    expect(() => parse(out, true, true, false)).not.toThrow();
  });
});
