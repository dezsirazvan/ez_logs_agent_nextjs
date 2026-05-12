import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORRELATION_PAYLOAD_KEY,
  emitJobEvent,
  extractCorrelationFromPayload,
  runJobWithCapture,
  stampCorrelationOnPayload,
} from "../../src/jobs/shared.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
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

describe("emitJobEvent — wire shape", () => {
  it("emits with the documented background_job source_data shape", () => {
    emitJobEvent({
      jobClass: "ChargeCardJob",
      jobId: "01J9XYZ12345",
      queue: "default",
      retryCount: 0,
      correlationId: "ezl_1_aaaaaaaa",
      outcome: "success",
      durationMs: 412,
      startedAt: new Date("2026-01-15T12:00:00.000Z"),
    });

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "ChargeCardJob",
      job_id: "01J9XYZ12345",
      queue: "default",
      retry_count: 0,
    });
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_1_aaaaaaaa");
    expect(event.duration_ms).toBe(412);
    expect(event.error_message).toBeNull();
  });

  it("compacts null/undefined keys from source_data (parity with Ruby .compact)", () => {
    emitJobEvent({
      jobClass: "InngestFn",
      // queue intentionally omitted — Inngest has no queue concept
      correlationId: "ezl_1_aaaaaaaa",
      outcome: "success",
      startedAt: new Date(),
    });
    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({ job_class: "InngestFn" });
  });

  it("emits failure events with error_message", () => {
    emitJobEvent({
      jobClass: "SendEmailJob",
      jobId: "abc",
      queue: "mailers",
      correlationId: null,
      outcome: "failure",
      errorMessage: "TypeError: connection refused",
      startedAt: new Date(),
    });
    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: connection refused");
  });

  it("respects captureJobs=false", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    emitJobEvent({
      jobClass: "X",
      correlationId: null,
      outcome: "success",
      startedAt: new Date(),
    });
    expect(bufferSize()).toBe(0);
  });

  it("respects excludedJobClasses", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedJobClasses: ["HeartbeatJob"],
    });
    emitJobEvent({
      jobClass: "HeartbeatJob",
      correlationId: null,
      outcome: "success",
      startedAt: new Date(),
    });
    expect(bufferSize()).toBe(0);
  });

  it("uses the active correlation scope when correlationId is unset", () => {
    runWithCorrelation("ezl_scope_aaaaaaaa", () => {
      emitJobEvent({
        jobClass: "X",
        outcome: "success",
        startedAt: new Date(),
      });
    });
    const event = drainEvents()[0]!;
    expect(event.correlation_id).toBe("ezl_scope_aaaaaaaa");
  });
});

describe("extractCorrelationFromPayload", () => {
  it("reads under the default key", () => {
    expect(
      extractCorrelationFromPayload({ [CORRELATION_PAYLOAD_KEY]: "ezl_1_a" }),
    ).toBe("ezl_1_a");
  });

  it("returns null when the key is absent or not a non-empty string", () => {
    expect(extractCorrelationFromPayload({})).toBeNull();
    expect(extractCorrelationFromPayload({ [CORRELATION_PAYLOAD_KEY]: "" })).toBeNull();
    expect(extractCorrelationFromPayload({ [CORRELATION_PAYLOAD_KEY]: 42 })).toBeNull();
    expect(extractCorrelationFromPayload(null)).toBeNull();
    expect(extractCorrelationFromPayload("not an object")).toBeNull();
  });

  it("supports an alternate key", () => {
    expect(
      extractCorrelationFromPayload({ correlationId: "ezl_x_a" }, "correlationId"),
    ).toBe("ezl_x_a");
  });
});

describe("stampCorrelationOnPayload", () => {
  it("mutates the payload to add the current correlation id", () => {
    const payload: Record<string, unknown> = { foo: "bar" };
    runWithCorrelation("ezl_1_aaaaaaaa", () => {
      stampCorrelationOnPayload(payload);
    });
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBe("ezl_1_aaaaaaaa");
    expect(payload.foo).toBe("bar"); // existing fields preserved
  });

  it("never overwrites a caller-supplied id", () => {
    const payload: Record<string, unknown> = {
      [CORRELATION_PAYLOAD_KEY]: "ezl_caller_b",
    };
    runWithCorrelation("ezl_auto_a", () => {
      stampCorrelationOnPayload(payload);
    });
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBe("ezl_caller_b");
  });

  it("no-op when no correlation scope is active", () => {
    const payload: Record<string, unknown> = {};
    stampCorrelationOnPayload(payload);
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBeUndefined();
  });

  it("no-op when payload is not an object", () => {
    runWithCorrelation("ezl_a", () => {
      // None of these should throw.
      stampCorrelationOnPayload(null);
      stampCorrelationOnPayload(undefined);
    });
  });
});

describe("runJobWithCapture", () => {
  it("emits success on resolved work and propagates the result", async () => {
    const result = await runJobWithCapture(
      {
        jobClass: "ChargeCardJob",
        jobId: "j1",
        queue: "default",
        retryCount: 0,
        correlationId: "ezl_propagated_a",
      },
      async () => 42,
    );
    expect(result).toBe(42);
    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_propagated_a");
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("emits failure and re-throws when work rejects", async () => {
    await expect(
      runJobWithCapture(
        {
          jobClass: "BoomJob",
          jobId: "j2",
          queue: "default",
          retryCount: 1,
          correlationId: null,
        },
        async () => {
          throw new TypeError("downstream API down");
        },
      ),
    ).rejects.toThrow("downstream API down");
    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: downstream API down");
  });

  it("generates a fresh correlation id when none was propagated", async () => {
    await runJobWithCapture(
      {
        jobClass: "X",
        jobId: null,
        correlationId: null,
      },
      async () => undefined,
    );
    const event = drainEvents()[0]!;
    expect(event.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("isolates concurrent jobs (no correlation cross-contamination)", async () => {
    const results: string[] = [];

    async function recordJob(id: string, delayMs: number): Promise<void> {
      await runJobWithCapture(
        { jobClass: "X", correlationId: id },
        async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          results.push(id);
        },
      );
    }

    await Promise.all([
      recordJob("ezl_a_aaaaaaaa", 20),
      recordJob("ezl_b_bbbbbbbb", 5),
      recordJob("ezl_c_cccccccc", 10),
    ]);

    const events = drainEvents();
    expect(events).toHaveLength(3);
    const ids = new Set(events.map((e) => e.correlation_id));
    expect(ids).toEqual(new Set(["ezl_a_aaaaaaaa", "ezl_b_bbbbbbbb", "ezl_c_cccccccc"]));
  });
});
