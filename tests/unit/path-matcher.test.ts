import { describe, expect, it } from "vitest";
import { hasExcludedExtension, pathMatches } from "../../src/http/path-matcher.js";

describe("pathMatches", () => {
  it("exact match", () => {
    expect(pathMatches("/favicon.ico", "/favicon.ico")).toBe(true);
    expect(pathMatches("/favicon.ico/extra", "/favicon.ico")).toBe(false);
  });

  it("prefix match (X*)", () => {
    expect(pathMatches("/_next/static/main.js", "/_next/*")).toBe(true);
    expect(pathMatches("/_nextfoo", "/_next/*")).toBe(false);
  });

  it("suffix match (*X)", () => {
    expect(pathMatches("/admin/logout", "*/logout")).toBe(true);
    expect(pathMatches("/logout", "*/logout")).toBe(true);
    expect(pathMatches("/logout/cb", "*/logout")).toBe(false);
  });

  it("contains match (*X*)", () => {
    expect(pathMatches("/admin/login/cb", "*/login*")).toBe(true);
    expect(pathMatches("/login", "*/login*")).toBe(true);
    expect(pathMatches("/sign-up", "*/login*")).toBe(false);
  });
});

describe("hasExcludedExtension", () => {
  it("matches against the path suffix", () => {
    expect(hasExcludedExtension("/static/main.js", [".js", ".css"])).toBe(true);
    expect(hasExcludedExtension("/static/main.css", [".js", ".css"])).toBe(true);
    expect(hasExcludedExtension("/static/main.html", [".js", ".css"])).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(hasExcludedExtension("", [".js"])).toBe(false);
  });
});
