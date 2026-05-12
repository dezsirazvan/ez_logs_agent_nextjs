// Inngest middleware tests against the documented hook shape.
// We don't link against the inngest package — we just call the hook
// functions our middleware returns with realistic argument shapes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ezlogsInngestMiddleware } from "../../src/jobs/inngest.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import { CORRELATION_PAYLOAD_KEY } from "../../src/jobs/shared.js";
import { runWithCorrelation } from "../../src/correlation.js";

beforeEach(() => {
  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
  clearBuffer();
});

afterEach(() => {
  clearBuffer();
});

interface MiddlewareShape {
  init: () => {
    onFunctionRun: (args: unknown) => { transformOutput: (args: unknown) => void };
    onSendEvent: () => { transformInput: (args: unknown) => void };
  };
}

function build(): MiddlewareShape {
  return ezlogsInngestMiddleware() as MiddlewareShape;
}

describe("ezlogsInngestMiddleware — onFunctionRun + transformOutput", () => {
  it("emits a success event with the documented background_job shape", () => {
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "send-welcome-email" },
      ctx: {
        runId: "01J9XYZ12345",
        attempt: 0,
        event: { name: "user.created", data: {} },
      },
    });
    hooks.transformOutput({ result: { data: { ok: true } } });

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "send-welcome-email",
      job_id: "01J9XYZ12345",
      queue: "user.created",
      retry_count: 0,
    });
    expect(event.outcome).toBe("success");
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("emits a failure event when result.error is set", () => {
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "charge-card" },
      ctx: {
        runId: "run-2",
        attempt: 2,
        event: { name: "order.placed", data: {} },
      },
    });
    hooks.transformOutput({
      result: { error: new TypeError("payment provider unreachable") },
    });

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: payment provider unreachable");
    expect(event.source_data).toMatchObject({
      retry_count: 2,
    });
  });

  it("uses correlation id propagated through event.data", () => {
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "fn1" },
      ctx: {
        runId: "r1",
        attempt: 0,
        event: {
          name: "x",
          data: { [CORRELATION_PAYLOAD_KEY]: "ezl_chain_aaaaaaaa" },
        },
      },
    });
    hooks.transformOutput({ result: { data: null } });
    const event = drainEvents()[0]!;
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
  });

  it("generates a fresh correlation id when event.data carries none", () => {
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "fn1" },
      ctx: { runId: "r1", attempt: 0, event: { name: "x", data: {} } },
    });
    hooks.transformOutput({ result: {} });
    const event = drainEvents()[0]!;
    expect(event.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("respects captureJobs=false (no event)", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "fn1" },
      ctx: { runId: "r1", attempt: 0, event: { name: "x", data: {} } },
    });
    hooks.transformOutput({ result: {} });
    expect(bufferSize()).toBe(0);
  });

  it("respects excludedJobClasses (matches against fn.id)", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedJobClasses: ["heartbeat"],
    });
    const m = build().init();
    const hooks = m.onFunctionRun({
      fn: { id: "heartbeat" },
      ctx: { runId: "r1", attempt: 0, event: { name: "x", data: {} } },
    });
    hooks.transformOutput({ result: {} });
    expect(bufferSize()).toBe(0);
  });

  it("falls back gracefully when fn.id or ctx.runId are missing", () => {
    const m = build().init();
    const hooks = m.onFunctionRun({});
    hooks.transformOutput({ result: {} });
    const event = drainEvents()[0]!;
    expect(event.source_data).toMatchObject({
      job_class: "inngest-function",
    });
  });
});

describe("ezlogsInngestMiddleware — onSendEvent.transformInput", () => {
  it("stamps the current correlation id onto outbound event payloads", () => {
    const m = build().init();
    const hooks = m.onSendEvent();
    const payloads = [
      { name: "user.created", data: { user_id: 1 } },
      { name: "user.welcomed", data: { user_id: 1, ts: 0 } },
    ];

    runWithCorrelation("ezl_send_aaaaaaaa", () => {
      hooks.transformInput({ payloads });
    });

    expect((payloads[0]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBe(
      "ezl_send_aaaaaaaa",
    );
    expect((payloads[1]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBe(
      "ezl_send_aaaaaaaa",
    );
  });

  it("never overwrites a payload's existing correlation id", () => {
    const m = build().init();
    const hooks = m.onSendEvent();
    const payloads = [
      {
        name: "x",
        data: { [CORRELATION_PAYLOAD_KEY]: "ezl_caller_bbbbbbbb" },
      },
    ];
    runWithCorrelation("ezl_auto_a", () => {
      hooks.transformInput({ payloads });
    });
    expect((payloads[0]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBe(
      "ezl_caller_bbbbbbbb",
    );
  });

  it("no-op when no correlation scope is active", () => {
    const m = build().init();
    const hooks = m.onSendEvent();
    const payloads = [{ name: "x", data: { user_id: 1 } }];
    hooks.transformInput({ payloads });
    expect((payloads[0]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBeUndefined();
  });

  it("creates a data object when a payload has no `.data`", () => {
    const m = build().init();
    const hooks = m.onSendEvent();
    const payloads: Array<{ name: string; data?: unknown }> = [{ name: "x" }];
    runWithCorrelation("ezl_1_a", () => {
      hooks.transformInput({ payloads });
    });
    expect((payloads[0]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBe(
      "ezl_1_a",
    );
  });
});
