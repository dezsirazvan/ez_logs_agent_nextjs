import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _detectDatabaseUrlFromEnvForTests as detect } from "../../src/index.js";

// All the env var names the detector probes. We snapshot + restore so
// the customer's actual env (set in CI, local dev) never bleeds into
// or out of these tests.
const KNOWN_VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "DIRECT_URL",
  "SUPABASE_DB_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const name of KNOWN_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of KNOWN_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("detectDatabaseUrlFromEnv", () => {
  it("returns null when no candidate is set", () => {
    expect(detect()).toBeNull();
  });

  it("picks DATABASE_URL first", () => {
    process.env.DATABASE_URL = "postgres://u:p@a/db1";
    process.env.POSTGRES_URL = "postgres://u:p@b/db2";
    expect(detect()).toBe("postgres://u:p@a/db1");
  });

  it("falls through to POSTGRES_URL when DATABASE_URL is absent", () => {
    process.env.POSTGRES_URL = "postgresql://u:p@h/db";
    expect(detect()).toBe("postgresql://u:p@h/db");
  });

  it("recognizes both postgres:// and postgresql:// schemes", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h/db";
    expect(detect()).toBe("postgresql://u:p@h/db");
  });

  it("ignores values that aren't a Postgres URL (defends against e.g. mongodb in DATABASE_URL)", () => {
    process.env.DATABASE_URL = "mongodb://localhost/db";
    process.env.POSTGRES_URL = "postgres://u:p@h/db";
    expect(detect()).toBe("postgres://u:p@h/db");
  });

  it("ignores empty strings", () => {
    process.env.DATABASE_URL = "";
    process.env.POSTGRES_URL = "postgres://u:p@h/db";
    expect(detect()).toBe("postgres://u:p@h/db");
  });

  it("walks the full priority chain in order", () => {
    process.env.SUPABASE_DB_URL = "postgres://u:p@supa/db";
    expect(detect()).toBe("postgres://u:p@supa/db");
  });

  it("Vercel + Prisma combination: prefers POSTGRES_PRISMA_URL over POSTGRES_URL_NON_POOLING when DATABASE_URL absent", () => {
    process.env.POSTGRES_URL_NON_POOLING = "postgres://direct/db";
    process.env.POSTGRES_PRISMA_URL = "postgres://pooled/db";
    expect(detect()).toBe("postgres://pooled/db");
  });
});
