// End-to-end test: a captured Route Handler makes an outgoing fetch
// to a downstream service, the patched fetch injects X-Correlation-ID,
// and the downstream service receives it. Proves the cross-service
// chain works without anyone manually plumbing the id.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRoute } from "../../src/http/capture.js";
import {
  isPatched,
  patchGlobalFetch,
  unpatchGlobalFetch,
} from "../../src/http/outgoing-fetch.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";

let downstream: Server;
let downstreamPort: number;
let receivedCorrelationIds: Array<string | null> = [];

beforeEach(async () => {
  receivedCorrelationIds = [];
  downstream = createServer((req: IncomingMessage, res) => {
    receivedCorrelationIds.push(
      (req.headers["x-correlation-id"] as string | undefined) ?? null,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) =>
    downstream.listen(0, "127.0.0.1", resolve),
  );
  const addr = downstream.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  downstreamPort = addr.port;

  resetConfigurationForTests();
  configuration().apply({
    serverUrl: "https://app.ezlogs.io",
    projectToken: "ezl_test",
  });
  clearBuffer();
  patchGlobalFetch();
});

afterEach(async () => {
  unpatchGlobalFetch();
  await new Promise<void>((resolve, reject) =>
    downstream.close((err) => (err ? reject(err) : resolve())),
  );
});

function fakeRequest(url: string, method = "GET"): Request {
  return new Request(url, { method });
}

describe("Outgoing fetch correlation propagation (e2e)", () => {
  it("downstream receives the same correlation_id stamped on the captured event", async () => {
    const handler = captureRoute(async () => {
      // Make a downstream call from inside the captured handler.
      await fetch(`http://127.0.0.1:${downstreamPort}/api/widgets`);
      return new Response("ok", { status: 200 });
    });

    await handler(fakeRequest("https://app.example.com/api/orders"));

    const events = drainEvents();
    expect(events).toHaveLength(1);
    const correlationId = events[0]!.correlation_id;

    expect(receivedCorrelationIds).toHaveLength(1);
    expect(receivedCorrelationIds[0]).toBe(correlationId);
  });

  it("does not inject correlation when no scope is active (background fetch)", async () => {
    // Outside any captureRoute call — like a top-level fetch in a Node
    // process that doesn't go through a captured request.
    expect(isPatched()).toBe(true);
    await fetch(`http://127.0.0.1:${downstreamPort}/health`);
    expect(receivedCorrelationIds).toEqual([null]);
  });

  it("isolates correlation across two concurrent captured requests", async () => {
    const handler = captureRoute(async () => {
      // Random jitter so the two scopes interleave their fetches.
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      await fetch(`http://127.0.0.1:${downstreamPort}/api/x`);
      return new Response("ok", { status: 200 });
    });

    await Promise.all([
      handler(fakeRequest("https://app.example.com/api/a")),
      handler(fakeRequest("https://app.example.com/api/b")),
      handler(fakeRequest("https://app.example.com/api/c")),
    ]);

    const events = drainEvents();
    expect(events).toHaveLength(3);
    const eventIds = new Set(events.map((e) => e.correlation_id!));
    const downstreamIds = new Set(receivedCorrelationIds);
    expect(downstreamIds).toEqual(eventIds);
    expect(downstreamIds.size).toBe(3);
  });
});
