import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushScheduler } from "../../src/pipeline/flush-scheduler.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
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
    sendInterval: 50,
  });
  clearBuffer();
});

afterEach(async () => {
  await flushScheduler.stop();
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FlushScheduler", () => {
  it("start/stop are idempotent", async () => {
    flushScheduler.start();
    expect(flushScheduler.isRunning()).toBe(true);
    flushScheduler.start(); // idempotent
    expect(flushScheduler.isRunning()).toBe(true);
    await flushScheduler.stop();
    expect(flushScheduler.isRunning()).toBe(false);
    await flushScheduler.stop(); // idempotent
  });

  it("flushNow drains the buffer and ships via Transport", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    pushEvent(event("a"));
    pushEvent(event("b"));
    await flushScheduler.flushNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as { events: Event[] };
    expect(body.events.length).toBe(2);
    expect(bufferSize()).toBe(0);
  });

  it("flushNow with empty buffer does not call fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await flushScheduler.flushNow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stop() flushes remaining events before resolving (clean shutdown)", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    flushScheduler.start();
    pushEvent(event("a"));
    await flushScheduler.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
