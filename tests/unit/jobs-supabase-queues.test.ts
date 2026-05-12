// Supabase Queues (pgmq) tests against a fake supabase client.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureQueueMessage,
  stampPgmqPayload,
  wrapSupabaseQueueClient,
} from "../../src/jobs/supabase-queues.js";
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

interface RpcCall {
  fn: string;
  args: unknown;
}

function makeFakeSupabase() {
  const calls: RpcCall[] = [];
  function buildSchema(_name: string) {
    return {
      rpc(fn: string, args?: unknown) {
        calls.push({ fn, args });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }
  return {
    client: {
      schema: buildSchema,
    },
    calls,
  };
}

describe("wrapSupabaseQueueClient — enqueue stamping", () => {
  it("stamps the correlation id onto pgmq.send message bodies", async () => {
    const fake = makeFakeSupabase();
    const sb = wrapSupabaseQueueClient(fake.client);

    await runWithCorrelation("ezl_send_aaaaaaaa", async () => {
      await sb.schema("pgmq_public").rpc("send", {
        queue_name: "emails",
        message: { to: "alice@example.com" },
      });
    });

    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0]!.args as { queue_name: string; message: Record<string, unknown> };
    expect(args.queue_name).toBe("emails");
    expect(args.message).toEqual({
      to: "alice@example.com",
      [CORRELATION_PAYLOAD_KEY]: "ezl_send_aaaaaaaa",
    });
  });

  it("stamps each message of pgmq.send_batch", async () => {
    const fake = makeFakeSupabase();
    const sb = wrapSupabaseQueueClient(fake.client);

    await runWithCorrelation("ezl_batch_aaaaaaaa", async () => {
      await sb.schema("pgmq_public").rpc("send_batch", {
        queue_name: "emails",
        messages: [{ to: "a@b" }, { to: "c@d" }],
      });
    });

    const args = fake.calls[0]!.args as { messages: Array<Record<string, unknown>> };
    expect(args.messages[0]![CORRELATION_PAYLOAD_KEY]).toBe("ezl_batch_aaaaaaaa");
    expect(args.messages[1]![CORRELATION_PAYLOAD_KEY]).toBe("ezl_batch_aaaaaaaa");
  });

  it("never overwrites a caller-supplied correlation id", async () => {
    const fake = makeFakeSupabase();
    const sb = wrapSupabaseQueueClient(fake.client);

    await runWithCorrelation("ezl_auto_a", async () => {
      await sb.schema("pgmq_public").rpc("send", {
        queue_name: "emails",
        message: {
          to: "x",
          [CORRELATION_PAYLOAD_KEY]: "ezl_caller_b",
        },
      });
    });

    const args = fake.calls[0]!.args as { message: Record<string, unknown> };
    expect(args.message[CORRELATION_PAYLOAD_KEY]).toBe("ezl_caller_b");
  });

  it("doesn't stamp when no correlation scope is active", async () => {
    const fake = makeFakeSupabase();
    const sb = wrapSupabaseQueueClient(fake.client);
    await sb.schema("pgmq_public").rpc("send", {
      queue_name: "emails",
      message: { to: "x" },
    });
    const args = fake.calls[0]!.args as { message: Record<string, unknown> };
    expect(args.message[CORRELATION_PAYLOAD_KEY]).toBeUndefined();
  });

  it("doesn't stamp non-pgmq RPC calls (the wrap is scoped to pgmq_public)", async () => {
    const fake = makeFakeSupabase();
    const sb = wrapSupabaseQueueClient(fake.client);

    await runWithCorrelation("ezl_x_a", async () => {
      await sb.schema("public").rpc("send", {
        queue_name: "emails",
        message: { to: "x" },
      });
    });

    const args = fake.calls[0]!.args as { message: Record<string, unknown> };
    expect(args.message[CORRELATION_PAYLOAD_KEY]).toBeUndefined();
  });

  it("is idempotent — wrapping twice does not double-stamp", async () => {
    const fake = makeFakeSupabase();
    wrapSupabaseQueueClient(fake.client);
    wrapSupabaseQueueClient(fake.client);

    await runWithCorrelation("ezl_1_a", async () => {
      await fake.client.schema("pgmq_public").rpc("send", {
        queue_name: "emails",
        message: { to: "x" },
      });
    });

    const args = fake.calls[0]!.args as { message: Record<string, unknown> };
    expect(Object.keys(args.message).sort()).toEqual([CORRELATION_PAYLOAD_KEY, "to"]);
  });
});

describe("captureQueueMessage — worker-side capture", () => {
  it("emits a success event with the canonical background_job shape", async () => {
    await captureQueueMessage(
      {
        queueName: "emails",
        messageId: "msg-42",
        readCount: 1,
        message: {
          to: "alice@example.com",
          [CORRELATION_PAYLOAD_KEY]: "ezl_chain_aaaaaaaa",
        },
      },
      async () => "delivered",
    );

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "emails",
      job_id: "msg-42",
      queue: "emails",
      retry_count: 1,
    });
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
  });

  it("emits failure on rejection and re-throws", async () => {
    await expect(
      captureQueueMessage(
        {
          queueName: "emails",
          messageId: "msg-1",
          message: { to: "x" },
        },
        async () => {
          throw new TypeError("smtp down");
        },
      ),
    ).rejects.toThrow("smtp down");

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: smtp down");
  });

  it("generates a fresh correlation id when message carries none", async () => {
    await captureQueueMessage(
      {
        queueName: "emails",
        messageId: "msg-1",
        message: { to: "x" },
      },
      async () => undefined,
    );
    const event = drainEvents()[0]!;
    expect(event.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("respects captureJobs=false (no event)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    await captureQueueMessage(
      {
        queueName: "emails",
        messageId: "msg-1",
        message: { to: "x" },
      },
      async () => undefined,
    );
    expect(bufferSize()).toBe(0);
  });
});

describe("stampPgmqPayload — explicit helper", () => {
  it("stamps the current correlation id on a plain message body", () => {
    const message: Record<string, unknown> = { to: "x" };
    runWithCorrelation("ezl_x_aaaaaaaa", () => {
      stampPgmqPayload(message);
    });
    expect(message[CORRELATION_PAYLOAD_KEY]).toBe("ezl_x_aaaaaaaa");
  });

  it("never overwrites a caller-supplied id", () => {
    const message: Record<string, unknown> = {
      [CORRELATION_PAYLOAD_KEY]: "ezl_caller_b",
    };
    runWithCorrelation("ezl_auto_a", () => {
      stampPgmqPayload(message);
    });
    expect(message[CORRELATION_PAYLOAD_KEY]).toBe("ezl_caller_b");
  });

  it("passes through non-object messages unchanged", () => {
    runWithCorrelation("ezl_a", () => {
      expect(stampPgmqPayload("string-payload")).toBe("string-payload");
      expect(stampPgmqPayload(null)).toBeNull();
    });
  });
});
