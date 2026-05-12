import { describe, expect, it } from "vitest";
import { sanitizeRequestParams } from "../../src/http/sanitize.js";

describe("sanitizeRequestParams", () => {
  it("returns null for null/undefined input", () => {
    expect(sanitizeRequestParams(null)).toBeNull();
    expect(sanitizeRequestParams(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(sanitizeRequestParams("alice")).toBeNull();
    expect(sanitizeRequestParams(42)).toBeNull();
    expect(sanitizeRequestParams([{ id: "1" }])).toBeNull();
  });

  it("returns null after stripping all framework-internal keys", () => {
    expect(
      sanitizeRequestParams({ controller: "users", action: "index" }),
    ).toBeNull();
  });

  it("filters sensitive substring matches (case-insensitive)", () => {
    expect(
      sanitizeRequestParams({
        email: "alice@example.com",
        password: "hunter2",
        Api_Token: "abc",
        ssn: "111-22-3333",
        credit_card: "4242",
      }),
    ).toEqual({
      email: "alice@example.com",
      password: "[FILTERED]",
      Api_Token: "[FILTERED]",
      ssn: "[FILTERED]",
      credit_card: "[FILTERED]",
    });
  });

  it("recurses into nested objects", () => {
    expect(
      sanitizeRequestParams({
        user: { email: "a@b", password: "x" },
      }),
    ).toEqual({
      user: { email: "a@b", password: "[FILTERED]" },
    });
  });

  it("collapses deeply nested objects to '[Object]' beyond MAX_NESTING_DEPTH (parity with Ruby's MAX_NESTING_DEPTH = 3)", () => {
    expect(
      sanitizeRequestParams({
        a: { b: { c: { d: { e: "too deep" } } } },
      }),
    ).toEqual({
      a: { b: { c: { d: "[Object]" } } },
    });
  });

  it("preserves small primitive arrays in full", () => {
    expect(
      sanitizeRequestParams({ tags: ["a", "b", "c"] }),
    ).toEqual({ tags: ["a", "b", "c"] });
  });

  it("summarizes large primitive arrays", () => {
    const arr = Array.from({ length: 12 }, (_, i) => i);
    const out = sanitizeRequestParams({ ids: arr }) as { ids: string };
    expect(out.ids).toMatch(/\.\.\. \(12 total\)/);
  });

  it("filters whole array when array key matches sensitive substring", () => {
    // `tokens` contains the substring `token` → entire value replaced.
    expect(
      sanitizeRequestParams({
        tokens: [
          { name: "ci", value: "wow" },
          { name: "prod", value: "such" },
        ],
      }),
    ).toEqual({ tokens: "[FILTERED]" });
  });

  it("respects user-supplied additional patterns", () => {
    expect(
      sanitizeRequestParams(
        { internal_id: "x", email: "a@b" },
        ["internal_id"],
      ),
    ).toEqual({ internal_id: "[FILTERED]", email: "a@b" });
  });

  it("user patterns are case-insensitive substrings", () => {
    expect(
      sanitizeRequestParams(
        { Internal_ID: "x" },
        ["INTERNAL"],
      ),
    ).toEqual({ Internal_ID: "[FILTERED]" });
  });
});
