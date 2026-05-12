import { beforeEach, describe, expect, it } from "vitest";
import {
  Configuration,
  DEFAULT_EXCLUDED_PATHS,
  DEFAULT_EXCLUDED_TABLES,
  DEFAULT_EXCLUDED_JOB_CLASSES,
  DEFAULT_EXCLUDED_GRAPHQL_OPERATIONS,
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";

beforeEach(() => {
  resetConfigurationForTests();
});

describe("Configuration — defaults", () => {
  it("captures everything by default", () => {
    const c = new Configuration();
    expect(c.captureHttp).toBe(true);
    expect(c.captureDb).toBe(true);
    expect(c.captureJobs).toBe(true);
  });

  it("uses 10_000 buffer / 3_000ms send / 3 retries (matches Ruby agent)", () => {
    const c = new Configuration();
    expect(c.bufferSize).toBe(10_000);
    expect(c.sendInterval).toBe(3_000);
    expect(c.retryAttempts).toBe(3);
  });

  it("patches global fetch by default", () => {
    expect(new Configuration().patchGlobalFetch).toBe(true);
  });

  it("logs at warn level by default (parity with Ruby)", () => {
    expect(new Configuration().logLevel).toBe("warn");
  });
});

describe("Configuration — apply()", () => {
  it("applies user options", () => {
    const c = new Configuration();
    c.apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      bufferSize: 500,
      sendInterval: 1_000,
    });
    expect(c.serverUrl).toBe("https://app.ezlogs.io");
    expect(c.projectToken).toBe("ezl_test");
    expect(c.bufferSize).toBe(500);
    expect(c.sendInterval).toBe(1_000);
  });

  it("preserves defaults for omitted options", () => {
    const c = new Configuration();
    c.apply({ serverUrl: "x", projectToken: "y" });
    expect(c.bufferSize).toBe(10_000);
    expect(c.captureHttp).toBe(true);
  });
});

describe("Configuration — merged exclusion lists (parity with Ruby)", () => {
  it("merges defaults + user paths", () => {
    const c = new Configuration();
    c.apply({
      serverUrl: "x",
      projectToken: "y",
      excludedPaths: ["/admin*"],
    });
    expect(c.allExcludedPaths()).toContain("/admin*");
    DEFAULT_EXCLUDED_PATHS.forEach((p) => {
      expect(c.allExcludedPaths()).toContain(p);
    });
  });

  it("merges defaults + user tables", () => {
    const c = new Configuration();
    c.apply({ serverUrl: "x", projectToken: "y", excludedTables: ["audit_log"] });
    expect(c.allExcludedTables()).toContain("audit_log");
    DEFAULT_EXCLUDED_TABLES.forEach((t) => {
      expect(c.allExcludedTables()).toContain(t);
    });
  });

  it("merges defaults + user job classes", () => {
    const c = new Configuration();
    c.apply({
      serverUrl: "x",
      projectToken: "y",
      excludedJobClasses: ["app/internal/heartbeat"],
    });
    expect(c.allExcludedJobClasses()).toContain("app/internal/heartbeat");
    DEFAULT_EXCLUDED_JOB_CLASSES.forEach((j) => {
      expect(c.allExcludedJobClasses()).toContain(j);
    });
  });

  it("merges defaults + user graphql operations", () => {
    const c = new Configuration();
    c.apply({
      serverUrl: "x",
      projectToken: "y",
      excludedGraphqlOperations: ["HealthCheck"],
    });
    expect(c.allExcludedGraphqlOperations()).toContain("HealthCheck");
    DEFAULT_EXCLUDED_GRAPHQL_OPERATIONS.forEach((g) => {
      expect(c.allExcludedGraphqlOperations()).toContain(g);
    });
  });
});

describe("Configuration — Next.js-specific defaults", () => {
  it("excludes _next, _vercel, NextAuth", () => {
    expect(DEFAULT_EXCLUDED_PATHS).toContain("/_next/*");
    expect(DEFAULT_EXCLUDED_PATHS).toContain("/_vercel/*");
    // NextAuth: only GET/HEAD on /api/auth/* is excluded (skips
    // session-refresh polls). POSTs go through to capture sign-in /
    // sign-out / register callback events.
    const authPattern = DEFAULT_EXCLUDED_PATHS.find(
      (p) => typeof p === "object" && p.path === "/api/auth/*",
    );
    expect(authPattern).toBeDefined();
    expect((authPattern as { methods: readonly string[] }).methods).toEqual(["GET", "HEAD"]);
  });

  it("excludes auth.js / NextAuth Prisma-adapter session/verification tables", () => {
    expect(DEFAULT_EXCLUDED_TABLES).toContain("Session");
    expect(DEFAULT_EXCLUDED_TABLES).toContain("VerificationToken");
    expect(DEFAULT_EXCLUDED_TABLES).toContain("_prisma_migrations");
  });

  it("ships an empty default job-class exclusion list", () => {
    // No reliable cross-runner infrastructure jobs to filter by default.
    expect(DEFAULT_EXCLUDED_JOB_CLASSES).toEqual([]);
  });

  it("excludes login/logout patterns across common conventions", () => {
    expect(DEFAULT_EXCLUDED_PATHS).toContain("*/login*");
    expect(DEFAULT_EXCLUDED_PATHS).toContain("*/logout*");
    expect(DEFAULT_EXCLUDED_PATHS).toContain("*/sign-in*");
    expect(DEFAULT_EXCLUDED_PATHS).toContain("*/sign-out*");
  });
});

describe("Configuration — singleton", () => {
  it("configuration() returns the same instance across calls", () => {
    expect(configuration()).toBe(configuration());
  });

  it("resetConfigurationForTests() yields a fresh instance", () => {
    const a = configuration();
    a.apply({ serverUrl: "x", projectToken: "y", bufferSize: 1 });
    resetConfigurationForTests();
    const b = configuration();
    expect(b).not.toBe(a);
    expect(b.bufferSize).toBe(10_000);
  });
});
