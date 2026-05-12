import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests against the live Postgres on :5436 share a
    // single database. Vitest's default is to run files in parallel
    // forks; two files concurrently dropping/recreating the audit
    // function trip a "cache lookup failed for function" race in
    // pg's prepared-statement cache. `fileParallelism: false` keeps
    // unit tests fast (still runs in one process) while serializing
    // file-level execution so DDL doesn't collide. Within a file,
    // tests still run in declaration order.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
