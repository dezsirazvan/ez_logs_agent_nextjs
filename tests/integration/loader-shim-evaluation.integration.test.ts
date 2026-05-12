// Integration test: dynamic-evaluate a synthetic loader output against
// a fake route module to confirm the wrapped exports actually call
// captureRoute and that captureRoute records an event.
//
// We can't run a real Webpack build inside vitest (the next/webpack
// resolution chain is heavy). What we CAN do: hand-build the shim
// the same way the loader would, replacing the `?ezlogs-original`
// import with a synthesized in-process module, and confirm the
// resulting wrapped GET/POST emit events when invoked.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRoute } from "../../src/http/capture.js";
import {
  clearBuffer,
  drainEvents,
} from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";

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

describe("loader shim — evaluated end-to-end", () => {
  it("wraps GET/POST exports and emits one event per call", async () => {
    // Stand-in for the user's `app/api/users/route.ts` module — what
    // the bypass-import would resolve to.
    const orig = {
      GET: async (_req: Request) => Response.json({ list: [] }),
      POST: async (_req: Request) =>
        Response.json({ ok: true }, { status: 201 }),
      dynamic: "force-dynamic" as const,
    };

    // Inline equivalent of what the loader emits: wrap each known
    // method, pass-through config exports.
    const meta = { routeModulePath: "app/api/users" };
    const wrapped = {
      GET: typeof orig.GET === "function" ? captureRoute(orig.GET, meta) : orig.GET,
      POST: typeof orig.POST === "function" ? captureRoute(orig.POST, meta) : orig.POST,
      dynamic: orig.dynamic,
    };

    expect(wrapped.dynamic).toBe("force-dynamic");

    await wrapped.GET(new Request("https://app.example.com/api/users"));
    await wrapped.POST(
      new Request("https://app.example.com/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      }),
    );

    const events = drainEvents();
    expect(events).toHaveLength(2);

    const [getEvent, postEvent] = events;
    expect(getEvent!.source_data).toMatchObject({
      method: "GET",
      controller: "app/api/users",
      action: "GET",
      status_code: 200,
    });
    expect(postEvent!.source_data).toMatchObject({
      method: "POST",
      controller: "app/api/users",
      action: "POST",
      status_code: 201,
    });
  });

  it("undefined exports stay undefined (typeof guard works)", async () => {
    const orig: { GET?: never; POST: (req: Request) => Promise<Response> } = {
      POST: async () => new Response("ok"),
    };
    const wrapped = {
      GET:
        typeof (orig as { GET?: unknown }).GET === "function"
          ? captureRoute(
              (orig as { GET: (req: Request) => Promise<Response> }).GET,
              { routeModulePath: "app/api/x" },
            )
          : (orig as { GET?: unknown }).GET,
      POST: captureRoute(orig.POST, { routeModulePath: "app/api/x" }),
    };

    expect(wrapped.GET).toBeUndefined();
    expect(typeof wrapped.POST).toBe("function");
  });
});
