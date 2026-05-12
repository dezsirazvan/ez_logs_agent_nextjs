// Upstash Workflow / QStash adapter tests against a fake QStash
// client + synthetic Request objects.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkflowRequest,
  emitUpstashWorkflowEvent,
  wrapQStashClient,
} from "../../src/jobs/upstash-workflow.js";
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

interface PublishCall {
  fn: "publishJSON" | "publish";
  request: { headers?: Record<string, string>; body?: unknown; url?: string };
}

function makeFakeQStash() {
  const calls: PublishCall[] = [];
  return {
    client: {
      async publishJSON(request: PublishCall["request"]) {
        calls.push({ fn: "publishJSON", request });
        return { messageId: "msg-1" };
      },
      async publish(request: PublishCall["request"]) {
        calls.push({ fn: "publish", request });
        return { messageId: "msg-1" };
      },
    },
    calls,
  };
}

describe("wrapQStashClient — outbound stamping", () => {
  it("stamps Upstash-Forward-X-Correlation-ID on publishJSON when in scope", async () => {
    const fake = makeFakeQStash();
    const qstash = wrapQStashClient(fake.client);

    await runWithCorrelation("ezl_publish_aaaaaaaa", async () => {
      await qstash.publishJSON({
        url: "https://app.example.com/api/workflow",
        body: { user_id: 1 },
      });
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.request.headers).toEqual({
      "upstash-forward-x-correlation-id": "ezl_publish_aaaaaaaa",
    });
  });

  it("preserves user-supplied headers (merge, not replace)", async () => {
    const fake = makeFakeQStash();
    const qstash = wrapQStashClient(fake.client);

    await runWithCorrelation("ezl_x_aaaaaaaa", async () => {
      await qstash.publishJSON({
        url: "https://app.example.com/api/workflow",
        body: {},
        headers: { "x-trace-id": "abc" },
      });
    });

    expect(fake.calls[0]!.request.headers).toEqual({
      "x-trace-id": "abc",
      "upstash-forward-x-correlation-id": "ezl_x_aaaaaaaa",
    });
  });

  it("never overwrites a caller-supplied forward header (regardless of casing)", async () => {
    const fake = makeFakeQStash();
    const qstash = wrapQStashClient(fake.client);

    await runWithCorrelation("ezl_auto_a", async () => {
      await qstash.publishJSON({
        url: "https://app.example.com/api/workflow",
        body: {},
        headers: { "Upstash-Forward-X-Correlation-ID": "ezl_caller_b" },
      });
    });

    // The caller's casing wins; we don't add a duplicate lowercased key.
    expect(fake.calls[0]!.request.headers).toEqual({
      "Upstash-Forward-X-Correlation-ID": "ezl_caller_b",
    });
  });

  it("does not stamp when no correlation scope is active", async () => {
    const fake = makeFakeQStash();
    const qstash = wrapQStashClient(fake.client);
    await qstash.publishJSON({
      url: "https://app.example.com/api/workflow",
      body: {},
    });
    expect(fake.calls[0]!.request.headers).toBeUndefined();
  });

  it("wraps publish() the same way as publishJSON", async () => {
    const fake = makeFakeQStash();
    const qstash = wrapQStashClient(fake.client);
    await runWithCorrelation("ezl_pub_a", async () => {
      await qstash.publish({ url: "x", body: "raw" });
    });
    expect(fake.calls[0]!.request.headers).toEqual({
      "upstash-forward-x-correlation-id": "ezl_pub_a",
    });
  });

  it("is idempotent — wrapping twice does not double-wrap", async () => {
    const fake = makeFakeQStash();
    wrapQStashClient(fake.client);
    wrapQStashClient(fake.client);
    await runWithCorrelation("ezl_1_a", async () => {
      await fake.client.publishJSON({ url: "x", body: {} });
    });
    expect(Object.keys(fake.calls[0]!.request.headers ?? {})).toEqual([
      "upstash-forward-x-correlation-id",
    ]);
  });
});

describe("captureWorkflowRequest — worker-side capture", () => {
  function fakeRequest(headers: Record<string, string>): Request {
    return new Request("https://app.example.com/api/workflow", {
      method: "POST",
      headers,
    });
  }

  it("emits a background_job event with the documented shape", async () => {
    const request = fakeRequest({
      "upstash-workflow-runid": "wfr_01J9XYZ12345",
      "upstash-retried": "0",
      "x-correlation-id": "ezl_chain_aaaaaaaa",
    });

    await captureWorkflowRequest(
      { request, workflowName: "send-welcome" },
      async () => "ok",
    );

    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("background_job");
    expect(event.source_data).toEqual({
      job_class: "send-welcome",
      job_id: "wfr_01J9XYZ12345",
      queue: "send-welcome",
      retry_count: 0,
    });
    expect(event.outcome).toBe("success");
    expect(event.correlation_id).toBe("ezl_chain_aaaaaaaa");
  });

  it("uses stepName as `queue` when provided", async () => {
    const request = fakeRequest({
      "upstash-workflow-runid": "wfr_1",
      "upstash-retried": "0",
    });
    await captureWorkflowRequest(
      { request, workflowName: "send-welcome", stepName: "send-email" },
      async () => null,
    );
    const event = drainEvents()[0]!;
    expect(event.source_data).toMatchObject({
      job_class: "send-welcome",
      queue: "send-email",
    });
  });

  it("derives retry_count from Upstash-Retried", async () => {
    const request = fakeRequest({
      "upstash-workflow-runid": "wfr_1",
      "upstash-retried": "3",
    });
    await captureWorkflowRequest(
      { request, workflowName: "send-welcome" },
      async () => null,
    );
    expect(drainEvents()[0]!.source_data).toMatchObject({ retry_count: 3 });
  });

  it("emits failure on rejection and re-throws", async () => {
    const request = fakeRequest({});
    await expect(
      captureWorkflowRequest({ request, workflowName: "boom" }, async () => {
        throw new TypeError("downstream timeout");
      }),
    ).rejects.toThrow("downstream timeout");

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: downstream timeout");
  });

  it("falls back to the prefixed header when x-correlation-id isn't set directly", async () => {
    const request = fakeRequest({
      "upstash-forward-x-correlation-id": "ezl_fwd_aaaaaaaa",
    });
    await captureWorkflowRequest(
      { request, workflowName: "x" },
      async () => null,
    );
    expect(drainEvents()[0]!.correlation_id).toBe("ezl_fwd_aaaaaaaa");
  });

  it("generates a fresh correlation id when no header is present", async () => {
    const request = fakeRequest({});
    await captureWorkflowRequest(
      { request, workflowName: "x" },
      async () => null,
    );
    expect(drainEvents()[0]!.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
  });

  it("respects captureJobs=false (no event)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureJobs: false,
    });
    const request = fakeRequest({});
    await captureWorkflowRequest(
      { request, workflowName: "x" },
      async () => null,
    );
    expect(bufferSize()).toBe(0);
  });
});

describe("emitUpstashWorkflowEvent — standalone helper", () => {
  it("emits with the same shape as captureWorkflowRequest", () => {
    const request = new Request("https://app.example.com/api/workflow", {
      headers: {
        "upstash-workflow-runid": "wfr_1",
        "upstash-retried": "1",
        "x-correlation-id": "ezl_chain_a",
      },
    });

    emitUpstashWorkflowEvent({
      workflowName: "send-welcome",
      request,
      outcome: "success",
      durationMs: 250,
    });

    const event = drainEvents()[0]!;
    expect(event.source_data).toEqual({
      job_class: "send-welcome",
      job_id: "wfr_1",
      queue: "send-welcome",
      retry_count: 1,
    });
    expect(event.duration_ms).toBe(250);
  });
});
