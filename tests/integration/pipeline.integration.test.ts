/**
 * Integration test — full pipeline against a real local HTTP server.
 *
 * Stands up an http.createServer() on a random port, points the agent
 * at it, pushes events, calls flush(), and asserts the server received
 * the documented body shape with the expected Authorization header.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import { flushScheduler } from "../../src/pipeline/flush-scheduler.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import type { Event } from "../../src/event-builder.js";

interface ReceivedRequest {
  authorization: string | undefined;
  contentType: string | undefined;
  body: { events: Event[] };
}

let server: Server;
let port: number;
let received: ReceivedRequest[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

beforeEach(async () => {
  received = [];
  server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/events") {
      const raw = await readBody(req);
      received.push({
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: JSON.parse(raw),
      });
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  port = addr.port;

  resetConfigurationForTests();
  configuration().apply({
    serverUrl: `http://127.0.0.1:${port}`,
    projectToken: "ezl_integration",
    sendInterval: 50,
  });
  clearBuffer();
});

afterEach(async () => {
  await flushScheduler.stop();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function event(label: string): Event {
  return {
    timestamp: "2026-01-15T12:00:00.000Z",
    source_type: "http_request",
    source_data: { label },
    outcome: "success",
    correlation_id: "ezl_1737000000000_deadbeef",
    resource_ids: [],
    context: null,
    duration_ms: null,
    error_message: null,
  };
}

describe("Pipeline integration", () => {
  it("flush() ships buffered events with the documented body and headers", async () => {
    pushEvent(event("a"));
    pushEvent(event("b"));
    await flushScheduler.flushNow();

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.contentType).toBe("application/json");
    expect(r.authorization).toBe("Bearer ezl_integration");
    expect(r.body.events).toHaveLength(2);
    expect(r.body.events[0]?.source_data).toEqual({ label: "a" });
  });

  it("the periodic scheduler flushes within sendInterval", async () => {
    flushScheduler.start();
    pushEvent(event("scheduled"));

    // Wait a bit longer than sendInterval (50ms) for the timer to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.body.events[0]?.source_data).toEqual({
      label: "scheduled",
    });
  });
});
