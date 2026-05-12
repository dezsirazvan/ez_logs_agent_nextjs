import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyJitterForTests,
  backoffScheduleMsForTests,
  resetRetrySenderForTests,
  retrySender,
  setJitterForTests,
  setRandomForTests,
} from "../../src/pipeline/retry-sender.js";
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
  setJitterForTests(false);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetRetrySenderForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RetrySender — schedule (parity with Ruby)", () => {
  it("backoff schedule is 0.5s, 1s, 2s, 4s, capped at 5s", () => {
    expect(backoffScheduleMsForTests(5)).toEqual([500, 1000, 2000, 4000, 5000]);
  });

  it("never exceeds the 5s cap", () => {
    expect(backoffScheduleMsForTests(10).every((d) => d <= 5000)).toBe(true);
  });
});

describe("RetrySender — happy path", () => {
  it("returns success immediately on first-attempt success without sleeping", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;

    const start = Date.now();
    const result = await retrySender.send([event("a")]);
    const elapsed = Date.now() - start;

    expect(result).toBe("success");
    expect(elapsed).toBeLessThan(100);
  });

  it("returns success early for empty event arrays", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await retrySender.send([])).toBe("success");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RetrySender — retry behavior", () => {
  it("retries failures up to retryAttempts + 1 total tries", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      retryAttempts: 2, // = 3 total tries
    });

    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    // Use fake timers so we don't actually wait 0.5s + 1s.
    vi.useFakeTimers();
    const promise = retrySender.send([event("a")]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("failure");
    expect(calls).toBe(3);
  });

  it("returns success as soon as a retry succeeds", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      retryAttempts: 3,
    });

    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("nope", { status: 500 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const promise = retrySender.send([event("a")]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(calls).toBe(3);
  });
});

describe("RetrySender — jitter (Node-only deviation)", () => {
  it("applyJitter stays within ±20% of base for the full random range", () => {
    setJitterForTests(true);
    const base = 1000;
    const min = base * 0.8;
    const max = base * 1.2;

    setRandomForTests(() => 0); // smallest possible jitter
    expect(applyJitterForTests(base)).toBeCloseTo(min);

    setRandomForTests(() => 1); // largest possible jitter
    expect(applyJitterForTests(base)).toBeCloseTo(max);

    setRandomForTests(() => 0.5); // midpoint = exactly base
    expect(applyJitterForTests(base)).toBeCloseTo(base);
  });

  it("with jitter disabled the schedule is exactly the unjittered base (parity gate)", () => {
    setJitterForTests(false);
    expect(applyJitterForTests(500)).toBe(500);
    expect(applyJitterForTests(1000)).toBe(1000);
    expect(applyJitterForTests(5000)).toBe(5000);
  });
});
