// Integration test: serverless mode forces a synchronous flush after
// each captured route. We stand up a real http server as the EZLogs
// "ingest endpoint", point the agent at it, run a captured handler
// in serverless mode, and assert the events arrive before the handler
// returns.

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRoute } from "../../src/http/capture.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import { flushScheduler } from "../../src/pipeline/flush-scheduler.js";
import {
  _resetServerlessCacheForTests,
  _setServerlessOverrideForTests,
} from "../../src/pipeline/serverless.js";

let ingest: Server;
let ingestPort: number;
let received: Array<{ events: unknown[] }> = [];

beforeEach(async () => {
  received = [];
  ingest = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
  const addr = ingest.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  ingestPort = addr.port;

  resetConfigurationForTests();
  configuration().apply({
    serverUrl: `http://127.0.0.1:${ingestPort}`,
    projectToken: "ezl_test",
    sendInterval: 60_000, // long enough that no periodic flush could fire
  });
  clearBuffer();
  _resetServerlessCacheForTests();
});

afterEach(async () => {
  _setServerlessOverrideForTests(null);
  _resetServerlessCacheForTests();
  await flushScheduler.stop();
  await new Promise<void>((resolve, reject) =>
    ingest.close((err) => (err ? reject(err) : resolve())),
  );
});

function fakeRequest(url: string): Request {
  return new Request(url);
}

describe("Serverless flush mode", () => {
  it("non-serverless mode: events stay buffered after a captured request", async () => {
    _setServerlessOverrideForTests(false);

    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/api/users" },
    );

    await handler(fakeRequest("https://app.example.com/api/users"));

    // Event is in the buffer; nothing has been shipped because
    // sendInterval is 60s and we never called flushNow.
    expect(bufferSize()).toBe(1);
    expect(received).toHaveLength(0);
  });

  it("serverless mode: events ship synchronously before captureRoute resolves", async () => {
    _setServerlessOverrideForTests(true);

    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/api/users" },
    );

    await handler(fakeRequest("https://app.example.com/api/users"));

    expect(bufferSize()).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.events).toHaveLength(1);
  });

  it("serverless mode + thrown handler still ships the failure event", async () => {
    _setServerlessOverrideForTests(true);

    const handler = captureRoute(async () => {
      throw new TypeError("downstream timeout");
    });

    await expect(
      handler(fakeRequest("https://app.example.com/api/orders")),
    ).rejects.toThrow("downstream timeout");

    expect(bufferSize()).toBe(0);
    expect(received).toHaveLength(1);
  });
});
