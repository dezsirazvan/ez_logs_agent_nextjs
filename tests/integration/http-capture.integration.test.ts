/**
 * Integration test for HTTP capture.
 *
 * Wraps a synthetic Route Handler in `captureRoute()`, invokes it
 * with a fake `Request`, then asserts the buffered event has the
 * expected wire shape — including correlation propagation, actor
 * extraction via the configured hook, sanitization, and outcome
 * classification.
 *
 * No real Next.js server needed — `Request` is a WHATWG global.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRoute } from "../../src/http/capture.js";
import { bufferSize, clearBuffer, drainEvents, pushEvent } from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";
import { current as currentCorrelation } from "../../src/correlation.js";
import type { Event } from "../../src/event-builder.js";

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

function fakeRequest(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, init);
}

function lastEvent(): Event {
  const events = drainEvents();
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe("captureRoute — HTTP capture", () => {
  it("emits a success event for a 200 GET", async () => {
    const handler = captureRoute(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      { routeModulePath: "app/api/users" },
    );

    const response = await handler(fakeRequest("https://app.example.com/api/users"));
    expect(response.status).toBe(200);

    const event = lastEvent();
    expect(event.source_type).toBe("http_request");
    expect(event.outcome).toBe("success");
    expect(event.error_message).toBeNull();
    expect(event.source_data).toMatchObject({
      method: "GET",
      path: "/api/users",
      status_code: 200,
      controller: "app/api/users",
      action: "GET",
    });
    expect(event.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/);
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("classifies 4xx as failure with HTTP <status> message", async () => {
    const handler = captureRoute(
      async () => new Response("missing", { status: 404 }),
      { routeModulePath: "app/api/widgets/[id]" },
    );

    await handler(fakeRequest("https://app.example.com/api/widgets/123"));

    const event = lastEvent();
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("HTTP 404");
  });

  it("classifies a thrown handler as failure and re-throws", async () => {
    const handler = captureRoute(async () => {
      throw new TypeError("payment provider unreachable");
    });

    await expect(
      handler(fakeRequest("https://app.example.com/api/orders", { method: "POST" })),
    ).rejects.toThrow("payment provider unreachable");

    const event = lastEvent();
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: payment provider unreachable");
  });

  it("sanitizes JSON request_params (filters password / api_key)", async () => {
    const handler = captureRoute(
      async () => new Response("ok", { status: 201 }),
      { routeModulePath: "app/api/users" },
    );

    await handler(
      fakeRequest("https://app.example.com/api/users", {
        method: "POST",
        body: JSON.stringify({
          email: "alice@example.com",
          password: "hunter2",
          api_key: "sk_live_xxx",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    const event = lastEvent();
    const params = (event.source_data as { request_params: Record<string, unknown> })
      .request_params;
    expect(params.password).toBe("[FILTERED]");
    expect(params.api_key).toBe("[FILTERED]");
    expect(params.email).toBe("alice@example.com");
  });

  it("populates context.actor when actorFromRequest hook returns one", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      actorFromRequest: () => ({ id: "42", label: "alice@example.com" }),
    });

    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/api/profile" },
    );

    await handler(fakeRequest("https://app.example.com/api/profile"));

    const event = lastEvent();
    expect(event.context).toEqual({
      actor: { id: "42", label: "alice@example.com" },
    });
  });

  it("leaves context null when actorFromRequest returns null/undefined", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      actorFromRequest: () => null,
    });

    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/api/anon" },
    );

    await handler(fakeRequest("https://app.example.com/api/anon"));

    const event = lastEvent();
    expect(event.context).toBeNull();
  });

  it("threads correlation_id through awaited downstream work in the handler", async () => {
    const seen: Array<string | null> = [];

    const handler = captureRoute(async () => {
      seen.push(currentCorrelation());
      await new Promise((r) => setTimeout(r, 0));
      seen.push(currentCorrelation());
      return new Response("ok", { status: 200 });
    });

    await handler(fakeRequest("https://app.example.com/api/x"));

    const event = lastEvent();
    expect(seen[0]).toBe(event.correlation_id);
    expect(seen[1]).toBe(event.correlation_id);
  });

  it("excludes paths matched by DEFAULT_EXCLUDED_PATHS (no event emitted)", async () => {
    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/_next/static" },
    );

    await handler(fakeRequest("https://app.example.com/_next/static/main.js"));

    expect(bufferSize()).toBe(0);
  });

  it("excludes GET /api/auth/* (NextAuth session-refresh polling)", async () => {
    const handler = captureRoute(
      async () => new Response("{}", { status: 200 }),
      { routeModulePath: "app/api/auth/[...nextauth]" },
    );

    await handler(
      fakeRequest("https://app.example.com/api/auth/session", { method: "GET" }),
    );

    expect(bufferSize()).toBe(0);
  });

  it("CAPTURES POST /api/auth/* (sign-in, sign-out, register callbacks)", async () => {
    const handler = captureRoute(
      async () => new Response("{}", { status: 200 }),
      { routeModulePath: "app/api/auth/[...nextauth]" },
    );

    await handler(
      fakeRequest("https://app.example.com/api/auth/callback/credentials", {
        method: "POST",
        body: "email=x@y.com",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );

    const event = lastEvent();
    expect(event.source_data.path).toBe("/api/auth/callback/credentials");
    expect(event.source_data.method).toBe("POST");
  });

  it("treats a handler that throws synchronously as a failure event", async () => {
    const handler = captureRoute(() => {
      throw new Error("sync boom");
    });

    await expect(
      handler(fakeRequest("https://app.example.com/api/sync")),
    ).rejects.toThrow("sync boom");

    const event = lastEvent();
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("Error: sync boom");
  });

  it("captures Server Action shape when serverActionName is provided", async () => {
    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { serverActionName: "updateProfile" },
    );

    await handler(fakeRequest("https://app.example.com/dashboard", { method: "POST" }));

    const event = lastEvent();
    expect(event.source_data).toMatchObject({
      controller: "server-action",
      action: "updateProfile",
    });
  });

  it("isolates correlation across two concurrent requests", async () => {
    const ids: string[] = [];
    const handler = captureRoute(async () => {
      ids.push(currentCorrelation()!);
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      ids.push(currentCorrelation()!);
      return new Response("ok", { status: 200 });
    });

    await Promise.all([
      handler(fakeRequest("https://app.example.com/a")),
      handler(fakeRequest("https://app.example.com/b")),
      handler(fakeRequest("https://app.example.com/c")),
    ]);

    // Each request should see the same id at start and end of its handler.
    // We can only verify the buffer has 3 distinct correlation_ids, none null.
    const events = drainEvents();
    expect(events).toHaveLength(3);
    const correlationIds = events.map((e) => e.correlation_id);
    const uniqueIds = new Set(correlationIds);
    expect(uniqueIds.size).toBe(3);
    correlationIds.forEach((id) => expect(id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/));
  });

  it("respects captureHttp = false (passes through, no event)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureHttp: false,
    });

    const handler = captureRoute(
      async () => new Response("ok", { status: 200 }),
      { routeModulePath: "app/api/x" },
    );

    await handler(fakeRequest("https://app.example.com/api/x"));
    expect(bufferSize()).toBe(0);
  });

  it("captures GraphQL POST with operation metadata + filters sensitive variables", async () => {
    const handler = captureRoute(
      async () =>
        new Response(JSON.stringify({ data: { user: { id: "42" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await handler(
      fakeRequest("https://app.example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
          operationName: "CreateUser",
          variables: { input: { email: "alice@example.com", password: "x" } },
        }),
      }),
    );

    const event = lastEvent();
    const sd = event.source_data as Record<string, unknown>;
    expect(sd.graphql_operation).toBe("CreateUser");
    expect(sd.graphql_type).toBe("mutation");
    const vars = sd.graphql_variables as Record<string, unknown>;
    const input = vars.input as Record<string, unknown>;
    expect(input.password).toBe("[FILTERED]");
    expect(sd.request_params).toBeUndefined();
  });

  it("skips IntrospectionQuery (no event emitted)", async () => {
    const handler = captureRoute(
      async () =>
        new Response(JSON.stringify({ data: { __schema: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await handler(
      fakeRequest("https://app.example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "query IntrospectionQuery { __schema { types { name } } }",
          operationName: "IntrospectionQuery",
        }),
      }),
    );

    expect(bufferSize()).toBe(0);
  });

  it("captures GraphQL response errors on a 200 OK", async () => {
    const handler = captureRoute(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "Forbidden" }, { message: "Validation failed" }],
            data: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await handler(
      fakeRequest("https://app.example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "query GetWidget { widget { id } }",
          operationName: "GetWidget",
        }),
      }),
    );

    const event = lastEvent();
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("Forbidden; Validation failed");
  });
});
