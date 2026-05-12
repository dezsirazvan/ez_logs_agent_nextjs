// Trigger.dev adapter tests against a fake `tasks` object that
// implements the documented `middleware` registration surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTriggerHooks,
  stampPayloadForTrigger,
} from "../../src/jobs/trigger.js";
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

interface FakeTasks {
  middleware: (
    name: string,
    handler: (params: {
      payload: unknown;
      ctx?: unknown;
      next: () => Promise<unknown>;
    }) => Promise<unknown>,
  ) => void;
  // Storage for inspecting registered handlers
  __handlers?: Map<string, (params: unknown) => Promise<unknown>>;
}

function makeFakeTasks(): FakeTasks {
  const tasks: FakeTasks = {
    middleware(name, handler) {
      if (!tasks.__handlers) tasks.__handlers = new Map();
      tasks.__handlers.set(name, handler as unknown as (p: unknown) => Promise<unknown>);
    },
  };
  return tasks;
}

async function runRegistered(
  tasks: FakeTasks,
  params: {
    payload: unknown;
    ctx?: unknown;
    next: () => Promise<unknown>;
  },
): Promise<unknown> {
  const handler = tasks.__handlers?.get("ezlogs");
  if (!handler) throw new Error("ezlogs handler not registered");
  return handler(params);
}

describe("registerTriggerHooks", () => {
  it("registers an `ezlogs` middleware on tasks", () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);
    expect(tasks.__handlers?.has("ezlogs")).toBe(true);
  });

  it("is idempotent — calling twice does not register two handlers", () => {
    const tasks = makeFakeTasks();
    const spy = vi.spyOn(tasks, "middleware");
    registerTriggerHooks(tasks);
    registerTriggerHooks(tasks);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("no-ops when tasks.middleware is unavailable (graceful degrade)", () => {
    const tasks = {} as FakeTasks;
    expect(() => registerTriggerHooks(tasks)).not.toThrow();
  });
});

describe("registerTriggerHooks — capture lifecycle", () => {
  it("emits a success event with the documented background_job shape", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: {},
      ctx: {
        task: { id: "send-welcome" },
        run: { id: "run_01J9XYZ", queue: { name: "default" } },
        attempt: { number: 1 },
      },
      next: async () => "ok",
    });

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "send-welcome",
      job_id: "run_01J9XYZ",
      queue: "default",
      retry_count: 0,
    });
    expect(event.outcome).toBe("success");
  });

  it("derives retry_count from attempt.number - 1 (Trigger.dev is 1-indexed)", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: {},
      ctx: {
        task: { id: "x" },
        run: { id: "r1" },
        attempt: { number: 4 },
      },
      next: async () => null,
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toMatchObject({ retry_count: 3 });
  });

  it("emits a failure event and re-throws when next() throws", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await expect(
      runRegistered(tasks, {
        payload: {},
        ctx: { task: { id: "charge" }, run: { id: "r1" }, attempt: { number: 1 } },
        next: async () => {
          throw new TypeError("upstream timeout");
        },
      }),
    ).rejects.toThrow("upstream timeout");

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: upstream timeout");
  });

  it("uses correlation id propagated through payload.ezlogs_correlation_id", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: { [CORRELATION_PAYLOAD_KEY]: "ezl_chain_aaaaaaaa", user_id: 1 },
      ctx: { task: { id: "x" }, run: { id: "r1" }, attempt: { number: 1 } },
      next: async () => null,
    });

    const event = drainEvents()[0]!;
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
  });

  it("generates a fresh correlation id when payload carries none", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: { user_id: 1 },
      ctx: { task: { id: "x" }, run: { id: "r1" }, attempt: { number: 1 } },
      next: async () => null,
    });

    const event = drainEvents()[0]!;
    expect(event.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("respects captureJobs=false (no event)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: {},
      ctx: { task: { id: "x" }, run: { id: "r1" }, attempt: { number: 1 } },
      next: async () => null,
    });

    expect(bufferSize()).toBe(0);
  });

  it("respects excludedJobClasses (matches against ctx.task.id)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedJobClasses: ["heartbeat"],
    });
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: {},
      ctx: { task: { id: "heartbeat" }, run: { id: "r1" }, attempt: { number: 1 } },
      next: async () => null,
    });

    expect(bufferSize()).toBe(0);
  });

  it("falls back to defaults when ctx fields are missing", async () => {
    const tasks = makeFakeTasks();
    registerTriggerHooks(tasks);

    await runRegistered(tasks, {
      payload: {},
      next: async () => null,
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toMatchObject({
      job_class: "trigger-task",
      retry_count: 0,
    });
  });
});

describe("stampPayloadForTrigger", () => {
  it("stamps the current correlation id when payload is a plain object", () => {
    const payload: Record<string, unknown> = { user_id: 1 };
    runWithCorrelation("ezl_send_aaaaaaaa", () => {
      stampPayloadForTrigger(payload);
    });
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBe("ezl_send_aaaaaaaa");
  });

  it("never overwrites a caller-supplied correlation id", () => {
    const payload: Record<string, unknown> = {
      [CORRELATION_PAYLOAD_KEY]: "ezl_caller_b",
    };
    runWithCorrelation("ezl_auto_a", () => {
      stampPayloadForTrigger(payload);
    });
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBe("ezl_caller_b");
  });

  it("returns the payload unchanged when no correlation scope is active", () => {
    const payload: Record<string, unknown> = { user_id: 1 };
    expect(stampPayloadForTrigger(payload)).toBe(payload);
    expect(payload[CORRELATION_PAYLOAD_KEY]).toBeUndefined();
  });

  it("passes through non-object payloads unchanged", () => {
    runWithCorrelation("ezl_a_aaaaaaaa", () => {
      expect(stampPayloadForTrigger("string-payload")).toBe("string-payload");
      expect(stampPayloadForTrigger(42)).toBe(42);
      expect(stampPayloadForTrigger(null)).toBeNull();
    });
  });
});
