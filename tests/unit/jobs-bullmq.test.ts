// BullMQ adapter tests against fake Queue + Worker stand-ins.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  wrapBullQueue,
  wrapBullWorker,
} from "../../src/jobs/bullmq.js";
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

// --- Fakes -----------------------------------------------------------

class FakeQueue {
  added: Array<{ name: string; data: unknown; opts?: unknown }> = [];
  bulk: Array<Array<{ name: string; data: unknown; opts?: unknown }>> = [];
  name = "test-queue";

  async add(name: string, data: unknown, opts?: unknown): Promise<{ id: string }> {
    this.added.push({ name, data, opts });
    return { id: `${this.added.length}` };
  }

  async addBulk(
    jobs: Array<{ name: string; data: unknown; opts?: unknown }>,
  ): Promise<unknown> {
    this.bulk.push(jobs);
    return [];
  }
}

class FakeWorker extends EventEmitter {
  name = "test-queue";
}

// --- Queue tests -----------------------------------------------------

describe("wrapBullQueue", () => {
  it("stamps the current correlation id onto job.data", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);

    await runWithCorrelation("ezl_1_aaaaaaaa", async () => {
      await q.add("send-email", { to: "alice@example.com" });
    });

    expect(q.added).toHaveLength(1);
    expect(q.added[0]!.data).toEqual({
      to: "alice@example.com",
      [CORRELATION_PAYLOAD_KEY]: "ezl_1_aaaaaaaa",
    });
  });

  it("never overwrites a caller-supplied correlation id on data", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);

    await runWithCorrelation("ezl_auto_a", async () => {
      await q.add("send-email", {
        to: "alice@example.com",
        [CORRELATION_PAYLOAD_KEY]: "ezl_caller_bbbbbbbb",
      });
    });

    expect((q.added[0]!.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]).toBe(
      "ezl_caller_bbbbbbbb",
    );
  });

  it("does not stamp when no correlation scope is active", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);
    await q.add("send-email", { to: "x" });
    expect(q.added[0]!.data).toEqual({ to: "x" });
  });

  it("passes through non-object data unchanged (e.g. string payload)", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);
    await runWithCorrelation("ezl_1_a", async () => {
      await q.add("legacy", "string-payload");
    });
    expect(q.added[0]!.data).toBe("string-payload");
  });

  it("stamps each job in addBulk", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);
    await runWithCorrelation("ezl_1_a", async () => {
      await q.addBulk([
        { name: "send-email", data: { to: "a@b" } },
        { name: "send-email", data: { to: "c@d" } },
      ]);
    });
    const stamped = q.bulk[0]!.map((j) => (j.data as Record<string, unknown>)[CORRELATION_PAYLOAD_KEY]);
    expect(stamped).toEqual(["ezl_1_a", "ezl_1_a"]);
  });

  it("is idempotent — wrapping twice does not double-stamp", async () => {
    const q = new FakeQueue();
    wrapBullQueue(q);
    wrapBullQueue(q);
    await runWithCorrelation("ezl_1_a", async () => {
      await q.add("x", { foo: "bar" });
    });
    // The data still has exactly the original key + our key.
    expect(Object.keys(q.added[0]!.data as Record<string, unknown>).sort()).toEqual([
      CORRELATION_PAYLOAD_KEY,
      "foo",
    ]);
  });
});

// --- Worker tests ----------------------------------------------------

describe("wrapBullWorker", () => {
  it("emits a success event on `completed` with retry_count derived from attemptsMade", () => {
    const w = new FakeWorker();
    wrapBullWorker(w);

    w.emit("completed", {
      id: "01J9XYZ12345",
      name: "send-email",
      data: { [CORRELATION_PAYLOAD_KEY]: "ezl_chain_aaaaaaaa" },
      attemptsMade: 1, // first attempt = retry_count 0
      queueName: "mailers",
      timestamp: Date.now() - 50,
    });

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "send-email",
      job_id: "01J9XYZ12345",
      queue: "mailers",
      retry_count: 0,
    });
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("emits a failure event on `failed` with the error name + message", () => {
    const w = new FakeWorker();
    wrapBullWorker(w);

    w.emit("failed", {
      id: "abc",
      name: "send-email",
      data: {},
      attemptsMade: 3,
      queueName: "mailers",
      timestamp: Date.now() - 100,
    }, new TypeError("connection refused"));

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: connection refused");
    expect(event.source_data).toMatchObject({
      retry_count: 2, // attemptsMade=3 means 2 retries already burned
    });
  });

  it("falls back to the worker name when job.name is missing", () => {
    const w = new FakeWorker();
    w.name = "scheduled-tasks";
    wrapBullWorker(w);
    w.emit("completed", { id: 1, data: {}, attemptsMade: 1, timestamp: Date.now() });
    const event = drainEvents()[0]!;
    expect(event.source_data).toMatchObject({ job_class: "scheduled-tasks" });
  });

  it("respects captureJobs=false (no event from listeners)", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    const w = new FakeWorker();
    wrapBullWorker(w);
    w.emit("completed", { id: 1, name: "x", data: {}, attemptsMade: 1, timestamp: Date.now() });
    expect(bufferSize()).toBe(0);
  });

  it("respects excludedJobClasses (uses job.name as the class identifier)", () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      excludedJobClasses: ["heartbeat"],
    });
    const w = new FakeWorker();
    wrapBullWorker(w);
    w.emit("completed", {
      id: 1,
      name: "heartbeat",
      data: {},
      attemptsMade: 1,
      timestamp: Date.now(),
    });
    expect(bufferSize()).toBe(0);
  });

  it("is idempotent — wrapping twice does not register listeners twice", () => {
    const w = new FakeWorker();
    const onSpy = vi.spyOn(w, "on");
    wrapBullWorker(w);
    wrapBullWorker(w);
    // The second wrap should not register additional listeners.
    expect(onSpy).toHaveBeenCalledTimes(2); // completed + failed only
  });

  it("worker capture survives missing job fields without crashing", () => {
    const w = new FakeWorker();
    wrapBullWorker(w);
    expect(() => w.emit("completed")).not.toThrow();
    expect(bufferSize()).toBe(0);
  });
});

// --- e2e correlation chain ------------------------------------------

describe("BullMQ end-to-end correlation chain", () => {
  it("an enqueue + execute round-trip stamps the same correlation id on both events", async () => {
    const q = new FakeQueue();
    const w = new FakeWorker();
    wrapBullQueue(q);
    wrapBullWorker(w);

    await runWithCorrelation("ezl_chain_aaaaaaaa", async () => {
      await q.add("send-email", { to: "alice@example.com" });
    });

    // Simulate the worker picking up the same job that q stamped.
    const queued = q.added[0]!;
    w.emit("completed", {
      id: "j1",
      name: queued.name,
      data: queued.data,
      attemptsMade: 1,
      queueName: q.name,
      timestamp: Date.now(),
    });

    const event = drainEvents()[0]!;
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
  });
});
