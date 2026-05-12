import { defineConfig } from "tsup";

/**
 * Each subpath entry is added in the commit that ships the corresponding
 * adapter — see ez_logs_agent_nextjs/AGENT_PARITY_NOTES.md and the
 * package.json `exports` map. The build deliberately does not declare
 * adapter entries that don't exist on disk yet; tsup would error.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "db/prisma": "src/db/prisma.ts",
    "db/drizzle": "src/db/drizzle.ts",
    "db/supabase": "src/db/supabase.ts",
    "jobs/bullmq": "src/jobs/bullmq.ts",
    "jobs/inngest": "src/jobs/inngest.ts",
    "jobs/trigger": "src/jobs/trigger.ts",
    "jobs/supabase-queues": "src/jobs/supabase-queues.ts",
    "jobs/upstash-workflow": "src/jobs/upstash-workflow.ts",
    "nextjs-plugin/index": "src/nextjs-plugin/index.ts",
    "nextjs-plugin/loader": "src/nextjs-plugin/loader.ts",
    "actors/index": "src/actors/index.ts",
    "triggers/index": "src/triggers/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  // Sourcemaps are skipped in the published tarball — they'd bloat
  // the package by ~70% and consumers don't need them. Dev/test
  // runs work directly off the TS source via vitest.
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node18",
});
