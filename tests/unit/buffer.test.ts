import { beforeEach, describe, expect, it } from "vitest";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import { configuration, resetConfigurationForTests } from "../../src/configuration.js";
import type { Event } from "../../src/event-builder.js";

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
  clearBuffer();
});

describe("Buffer", () => {
  it("starts empty", () => {
    expect(bufferSize()).toBe(0);
    expect(drainEvents()).toEqual([]);
  });

  it("push accumulates events", () => {
    pushEvent(event("a"));
    pushEvent(event("b"));
    expect(bufferSize()).toBe(2);
  });

  it("flush atomically drains and clears (parity with Ruby)", () => {
    pushEvent(event("a"));
    pushEvent(event("b"));
    const drained = drainEvents();
    expect(drained.map((e) => (e.source_data as { label: string }).label)).toEqual([
      "a",
      "b",
    ]);
    expect(bufferSize()).toBe(0);
  });

  it("drops oldest when full (FIFO)", () => {
    configuration().apply({ serverUrl: "x", projectToken: "y", bufferSize: 3 });
    pushEvent(event("1"));
    pushEvent(event("2"));
    pushEvent(event("3"));
    pushEvent(event("4")); // pushes out "1"
    const drained = drainEvents();
    expect(drained.map((e) => (e.source_data as { label: string }).label)).toEqual([
      "2",
      "3",
      "4",
    ]);
  });

  it("clear empties the buffer", () => {
    pushEvent(event("a"));
    clearBuffer();
    expect(bufferSize()).toBe(0);
  });
});
