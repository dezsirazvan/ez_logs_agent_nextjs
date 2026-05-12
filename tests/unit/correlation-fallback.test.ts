// Phase 4 — correlation fallback for apps without `middleware.ts`.
//
// When the customer hasn't installed our `withMiddlewareCapture`
// wrapper (or has no `middleware.ts` at all), each HTTP entry point
// generates its own correlation id by default. This test covers the
// platform-id fallback: derive the same correlation id from
// `x-vercel-id`, `cf-ray`, or `x-request-id` so multiple cold-started
// invocations of the same logical request still group.

import { describe, expect, it } from "vitest";
import { resolveCorrelation } from "../../src/correlation.js";

function makeHeaders(entries: Record<string, string | undefined>): {
  get: (name: string) => string | null;
} {
  return {
    get(name: string): string | null {
      const v = entries[name];
      return typeof v === "string" ? v : null;
    },
  };
}

describe("resolveCorrelation", () => {
  it("uses an upstream `x-ezlogs-correlation-id` verbatim", () => {
    const out = resolveCorrelation(
      makeHeaders({ "x-ezlogs-correlation-id": "ezl_123_deadbeef" }),
    );
    expect(out).toBe("ezl_123_deadbeef");
  });

  it("derives a stable id from `x-vercel-id`", () => {
    const out = resolveCorrelation(makeHeaders({ "x-vercel-id": "iad1::xyz" }));
    expect(out).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("returns the SAME id for two requests with the same `x-vercel-id`", () => {
    // The point of the fallback: two cold-started entry points in one
    // logical request share a platform id, so they must share an
    // ezlogs correlation id even though the timestamp portion drifts.
    const a = resolveCorrelation(makeHeaders({ "x-vercel-id": "iad1::xyz" }));
    const b = resolveCorrelation(makeHeaders({ "x-vercel-id": "iad1::xyz" }));
    // Hash portion (last 8 hex chars) is what proves they group.
    expect(a.slice(-8)).toBe(b.slice(-8));
  });

  it("`x-ezlogs-correlation-id` overrides `x-vercel-id`", () => {
    const out = resolveCorrelation(
      makeHeaders({
        "x-ezlogs-correlation-id": "ezl_999_caffe000",
        "x-vercel-id": "iad1::xyz",
      }),
    );
    expect(out).toBe("ezl_999_caffe000");
  });

  it("falls through `x-vercel-id` -> `cf-ray` -> `x-request-id`", () => {
    const cfOnly = resolveCorrelation(makeHeaders({ "cf-ray": "abc123-DFW" }));
    const reqIdOnly = resolveCorrelation(
      makeHeaders({ "x-request-id": "req-7" }),
    );
    expect(cfOnly).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
    expect(reqIdOnly).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
    // Different inputs -> different hash portions.
    expect(cfOnly.slice(-8)).not.toBe(reqIdOnly.slice(-8));
  });

  it("prefers `x-vercel-id` over `cf-ray` over `x-request-id`", () => {
    const allThree = resolveCorrelation(
      makeHeaders({
        "x-vercel-id": "iad1::v",
        "cf-ray": "abc-DFW",
        "x-request-id": "req-7",
      }),
    );
    const onlyVercel = resolveCorrelation(
      makeHeaders({ "x-vercel-id": "iad1::v" }),
    );
    // The hash portion comes from the highest-priority source —
    // `x-vercel-id` here.
    expect(allThree.slice(-8)).toBe(onlyVercel.slice(-8));
  });

  it("generates a fresh id when no platform header is present", () => {
    const out = resolveCorrelation(makeHeaders({}));
    expect(out).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("generates a fresh id when headers is null/undefined", () => {
    expect(resolveCorrelation(null)).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
    expect(resolveCorrelation(undefined)).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("ignores empty-string platform headers and falls through", () => {
    // A reverse proxy that strips a header to empty string shouldn't
    // produce a deterministic-but-meaningless correlation id.
    const out = resolveCorrelation(makeHeaders({ "x-vercel-id": "" }));
    expect(out).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
    // ...and two empty-vercel-id requests should NOT share an id, since
    // the input carried no real grouping signal — they fall through to
    // `generate()`.
    const a = resolveCorrelation(makeHeaders({ "x-vercel-id": "" }));
    const b = resolveCorrelation(makeHeaders({ "x-vercel-id": "" }));
    expect(a).not.toBe(b);
  });

  it("survives a header accessor that throws", () => {
    const throwingHeaders = {
      get(_name: string): string | null {
        throw new Error("headers locked");
      },
    };
    // Must not propagate to the host application.
    expect(() => resolveCorrelation(throwingHeaders)).not.toThrow();
    expect(resolveCorrelation(throwingHeaders)).toMatch(
      /^ezl_\d+_[0-9a-f]{8}$/,
    );
  });
});
