import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transport } from "../../src/pipeline/transport.js";
import { configuration, resetConfigurationForTests } from "../../src/configuration.js";
import type { Event } from "../../src/event-builder.js";

const realFetch = globalThis.fetch;

function event(label: string): Event {
  return {
    timestamp: "2026-01-15T12:00:00.000Z",
    source_type: "http_request",
    source_data: { label },
    outcome: "success",
    correlation_id: null,
    resource_ids: [],
    context: null,
    duration_ms: null,
    error_message: null,
  };
}

beforeEach(() => {
  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Transport.send", () => {
  it("returns success immediately for empty arrays without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await transport.send([]);
    expect(result).toBe("success");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to <serverUrl>/api/events with the documented body shape", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = [event("a"), event("b")];
    const result = await transport.send(events);

    expect(result).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.ezlogs.io/api/events");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer ezl_test");
    expect(JSON.parse(init?.body as string)).toEqual({ events });
  });

  it("strips trailing slash from serverUrl", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io/",
      projectToken: "ezl_test",
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await transport.send([event("a")]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.ezlogs.io/api/events");
  });

  it("omits Authorization header when projectToken is null (parity with Ruby)", async () => {
    resetConfigurationForTests();
    configuration().apply({ serverUrl: "https://app.ezlogs.io", projectToken: "" });
    configuration().projectToken = null; // simulate unset
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await transport.send([event("a")]);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("classifies 2xx as success", async () => {
    // 204 No Content responses cannot have a body per the Fetch spec.
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    expect(await transport.send([event("a")])).toBe("success");
  });

  it("classifies 4xx as failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    expect(await transport.send([event("a")])).toBe("failure");
  });

  it("classifies 5xx as failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    expect(await transport.send([event("a")])).toBe("failure");
  });

  it("returns failure on network error without throwing to caller", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await transport.send([event("a")])).toBe("failure");
  });

  it("returns failure when serverUrl is not configured", async () => {
    resetConfigurationForTests();
    expect(await transport.send([event("a")])).toBe("failure");
  });
});
