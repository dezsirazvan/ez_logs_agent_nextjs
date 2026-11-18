// Shared by the loader (which rewrites the imports) and the plugin
// (whose Turbopack rule only runs the loader on files that name one of
// these modules).

/**
 * Library exports the agent instruments wherever the app's server code
 * imports them (see instrument.ts for the runtime side). `via` is the
 * agent subpath whose `__ezlogsInstrument` replaces them. A new
 * integration is one row here plus its replacement in that module.
 */
export const INSTRUMENTED_IMPORTS: ReadonlyArray<{ module: string; names: readonly string[]; via: string }> = [
  {
    module: "@upstash/workflow/nextjs",
    names: ["serve", "servePagesRouter", "createWorkflow", "createWorkflowPagesRouter", "serveMany", "serveManyPagesRouter"],
    via: "upstash-workflow",
  },
  { module: "@upstash/workflow", names: ["serve", "Client"], via: "upstash-workflow" },
  { module: "@upstash/qstash", names: ["Client"], via: "upstash-workflow" },
  { module: "bullmq", names: ["Queue", "Worker"], via: "bullmq" },
  { module: "inngest", names: ["Inngest"], via: "inngest" },
  { module: "@supabase/supabase-js", names: ["createClient"], via: "supabase" },
  { module: "@supabase/ssr", names: ["createServerClient"], via: "supabase" },
];

/** Matches source that imports one of the instrumented modules (Turbopack content condition). */
export const INSTRUMENTED_IMPORT_CONTENT = new RegExp(
  `from\\s*["'](?:${[...new Set(INSTRUMENTED_IMPORTS.map((e) => e.module))]
    .map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("|")})["']`,
);
