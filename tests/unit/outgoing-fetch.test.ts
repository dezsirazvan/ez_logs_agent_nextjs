import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPatched,
  patchGlobalFetch,
  unpatchGlobalFetch,
} from "../../src/http/outgoing-fetch.js";
import {
  _resetCorrelationForTests,
  runWithCorrelation,
} from "../../src/correlation.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  unpatchGlobalFetch();
  _resetCorrelationForTests();
});

afterEach(() => {
  unpatchGlobalFetch();
  globalThis.fetch = realFetch;
  _resetCorrelationForTests();
  vi.restoreAllMocks();
});

describe("patchGlobalFetch", () => {
  it("isPatched flips to true after patch and back after unpatch", () => {
    expect(isPatched()).toBe(false);
    patchGlobalFetch();
    expect(isPatched()).toBe(true);
    unpatchGlobalFetch();
    expect(isPatched()).toBe(false);
  });

  it("is idempotent — calling patch twice does not double-wrap", () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = inner as unknown as typeof fetch;

    patchGlobalFetch();
    patchGlobalFetch(); // second call should no-op

    unpatchGlobalFetch();
    expect(globalThis.fetch).toBe(inner);
  });

  it("does not modify the request when no correlation scope is active", async () => {
    const inner = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      return new Response(headers.get("x-correlation-id") ?? "absent", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    const result = await fetch("https://example.com/api");
    expect(await result.text()).toBe("absent");
  });

  it("injects X-Correlation-ID for plain url+init calls inside a scope", async () => {
    let observedHeader: string | null = null;
    const inner = vi.fn(async (_input: unknown, init?: RequestInit) => {
      observedHeader = new Headers(init?.headers).get("x-correlation-id");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    await runWithCorrelation("ezl_1_aaaaaaaa", async () => {
      await fetch("https://example.com/api");
    });

    expect(observedHeader).toBe("ezl_1_aaaaaaaa");
  });

  it("merges with existing headers in init.headers (does not clobber)", async () => {
    let observed: Headers | null = null;
    const inner = vi.fn(async (_input: unknown, init?: RequestInit) => {
      observed = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    await runWithCorrelation("ezl_1_aaaaaaaa", async () => {
      await fetch("https://example.com/api", {
        headers: { authorization: "Bearer xyz", accept: "application/json" },
      });
    });

    expect(observed!.get("authorization")).toBe("Bearer xyz");
    expect(observed!.get("accept")).toBe("application/json");
    expect(observed!.get("x-correlation-id")).toBe("ezl_1_aaaaaaaa");
  });

  it("does not overwrite a caller-supplied X-Correlation-ID", async () => {
    let observed: string | null = null;
    const inner = vi.fn(async (_input: unknown, init?: RequestInit) => {
      observed = new Headers(init?.headers).get("x-correlation-id");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    await runWithCorrelation("ezl_auto_aaaaaaaa", async () => {
      await fetch("https://example.com/api", {
        headers: { "x-correlation-id": "ezl_caller_bbbbbbbb" },
      });
    });

    expect(observed).toBe("ezl_caller_bbbbbbbb");
  });

  it("injects when fetch is called with a Request object as input", async () => {
    let observed: string | null = null;
    const inner = vi.fn(async (input: Request) => {
      observed = input.headers.get("x-correlation-id");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    await runWithCorrelation("ezl_req_aaaaaaaa", async () => {
      await fetch(new Request("https://example.com/api"));
    });

    expect(observed).toBe("ezl_req_aaaaaaaa");
  });

  it("preserves caller's X-Correlation-ID on a Request-as-input call", async () => {
    let observed: string | null = null;
    const inner = vi.fn(async (input: Request) => {
      observed = input.headers.get("x-correlation-id");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    await runWithCorrelation("ezl_auto_aaaaaaaa", async () => {
      await fetch(
        new Request("https://example.com/api", {
          headers: { "x-correlation-id": "ezl_caller_bbbbbbbb" },
        }),
      );
    });

    expect(observed).toBe("ezl_caller_bbbbbbbb");
  });

  it("falls through to original fetch when injection throws (defensive)", async () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = inner as unknown as typeof fetch;
    patchGlobalFetch();

    // Pass an input shape that will throw inside Headers — `null` for
    // headers, plus a non-Request, non-string input.
    await runWithCorrelation("ezl_x_aaaaaaaa", async () => {
      // @ts-expect-error — deliberate odd input
      await fetch({ weird: true }, { headers: 12345 as unknown as Headers });
    });

    // The host fetch was still called — never break the user's call.
    expect(inner).toHaveBeenCalled();
  });

  it("unpatch restores the previous fetch implementation", async () => {
    const before = vi.fn(async () => new Response("before", { status: 200 }));
    globalThis.fetch = before as unknown as typeof fetch;
    patchGlobalFetch();
    expect(globalThis.fetch).not.toBe(before); // wrapped
    unpatchGlobalFetch();
    expect(globalThis.fetch).toBe(before);
  });
});
