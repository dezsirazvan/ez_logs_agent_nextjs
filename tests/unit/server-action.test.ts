import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureServerAction } from "../../src/http/capture.js";
import {
  bufferSize,
  clearBuffer,
  drainEvents,
} from "../../src/pipeline/buffer.js";
import {
  configuration,
  resetConfigurationForTests,
} from "../../src/configuration.js";

// `loadNextHeaders` calls `await import("next/headers")`. The real
// module is only present inside a Next.js host app — here we mock it
// so tests for the Server Action actor hook can drive whatever
// header value they need. The state lives in `vi.hoisted(...)` so
// vitest's hoisting of `vi.mock` doesn't put the mock above the
// variable declaration.
const nextHeadersState = vi.hoisted(() => ({
  current: new Headers(),
}));
vi.mock("next/headers", () => ({
  headers: () => nextHeadersState.current,
}));

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

describe("captureServerAction", () => {
  it("emits a success event with serverAction shape", async () => {
    const action = captureServerAction(
      async (formData: FormData) => ({ ok: true, fields: formData.get("name") }),
      "updateProfile",
    );

    const fd = new FormData();
    fd.set("name", "Alice");
    const result = await action(fd);

    expect(result).toEqual({ ok: true, fields: "Alice" });
    const event = drainEvents()[0]!;
    expect(event.source_type).toBe("http_request");
    expect(event.outcome).toBe("success");
    expect(event.source_data).toMatchObject({
      controller: "server-action",
      action: "updateProfile",
      method: "POST",
      status_code: 200,
    });
  });

  it("emits a failure event with the error name+message and re-throws", async () => {
    const action = captureServerAction(async () => {
      throw new TypeError("validation failed");
    }, "createOrder");

    await expect(action()).rejects.toThrow("validation failed");

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("TypeError: validation failed");
    expect(event.source_data).toMatchObject({
      controller: "server-action",
      action: "createOrder",
      status_code: 500,
    });
  });

  it("preserves the action's signature shape", async () => {
    const original = async (a: number, b: number): Promise<number> => a + b;
    const wrapped = captureServerAction(original, "add");

    const result = await wrapped(2, 3);
    expect(result).toBe(5);
  });

  it("respects captureHttp=false (passes through, no event)", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      captureHttp: false,
    });
    const action = captureServerAction(async () => "ok", "x");
    await action();
    expect(bufferSize()).toBe(0);
  });

  it("classifies { success: false, error } return values as failure (default heuristic)", async () => {
    // Most Next.js apps catch errors inside the action body and
    // return `{ success: false, error: "..." }` instead of throwing — the
    // HTTP response stays 200 but the action did fail. The default
    // heuristic must surface that as a failure event.
    const action = captureServerAction(async () => {
      return { success: false, error: "Validation failed: name required" };
    }, "createOrder");

    const result = await action();
    expect(result).toEqual({
      success: false,
      error: "Validation failed: name required",
    });

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("Error: Validation failed: name required");
    expect(event.source_data).toMatchObject({ status_code: 500 });
  });

  it("does NOT classify { success: true } as failure", async () => {
    const action = captureServerAction(
      async () => ({ success: true, data: { id: 1 } }),
      "x",
    );
    await action();
    expect(drainEvents()[0]!.outcome).toBe("success");
  });

  it("does NOT classify { success: false } without an error string", async () => {
    // A bare `{ success: false }` may mean "no-op" rather than failure.
    // The heuristic stays conservative.
    const action = captureServerAction(
      async () => ({ success: false }),
      "x",
    );
    await action();
    expect(drainEvents()[0]!.outcome).toBe("success");
  });

  it("respects a user-supplied isServerActionError classifier", async () => {
    // tRPC-style: error info under `error.message`, not at top level.
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      isServerActionError: (result) => {
        const r = result as { error?: { message?: string } } | null;
        if (r?.error?.message) {
          return { errorMessage: r.error.message };
        }
        return false;
      },
    });

    const action = captureServerAction(
      async () => ({ error: { message: "tRPC unauthorized" } }),
      "x",
    );
    await action();

    const event = drainEvents()[0]!;
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("Error: tRPC unauthorized");
  });

  it("falls through to the default heuristic when classifier returns undefined", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      isServerActionError: () => undefined,
    });

    const action = captureServerAction(
      async () => ({ success: false, error: "boom" }),
      "x",
    );
    await action();
    expect(drainEvents()[0]!.outcome).toBe("failure");
  });

  it("does not crash when a user classifier throws", async () => {
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      isServerActionError: () => {
        throw new Error("classifier bug");
      },
    });

    // A buggy user classifier must NOT propagate to the host. The
    // default heuristic still applies, so this success result is recorded
    // as success (no `{ success: false, error }` shape).
    const action = captureServerAction(async () => ({ ok: 1 }), "x");
    await action();
    expect(drainEvents()[0]!.outcome).toBe("success");
  });

  // Phase 4: built-in shape detection for the most common Server Action
  // wrapper libraries. The user classifier still wins; these run only
  // when the user didn't supply one (or returned undefined).

  describe("Phase 4 built-in shape detection", () => {
    // next-safe-action — `{ data, serverError, validationErrors }`.
    it("classifies next-safe-action `serverError` as failure", async () => {
      const action = captureServerAction(
        async () => ({ data: null, serverError: "Not authorized" }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toBe("Error: Not authorized");
    });

    it("classifies next-safe-action `validationErrors` (with content) as failure", async () => {
      const action = captureServerAction(
        async () => ({
          data: null,
          validationErrors: { email: ["Required"], name: ["Too short"] },
        }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toContain("email: Required");
    });

    it("does NOT classify next-safe-action with empty validationErrors as failure", async () => {
      // Some apps emit `validationErrors: {}` on success-with-warnings.
      const action = captureServerAction(
        async () => ({ data: { id: 1 }, validationErrors: {} }),
        "x",
      );
      await action();
      expect(drainEvents()[0]!.outcome).toBe("success");
    });

    // zsa tuple — `[null, { code, message }]`.
    it("classifies zsa tuple as failure", async () => {
      const action = captureServerAction(
        async () => [null, { code: "NOT_FOUND", message: "User not found" }],
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toBe("Error: User not found");
    });

    // zsa object — `{ data: null, error: { code, message } }`.
    it("classifies zsa object as failure", async () => {
      const action = captureServerAction(
        async () => ({
          data: null,
          error: { code: "FORBIDDEN", message: "No access" },
        }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toBe("Error: No access");
    });

    // Conform — `{ status: 'error', intent, error: { field: [...] } }`.
    it("classifies Conform `{status: 'error'}` as failure", async () => {
      const action = captureServerAction(
        async () => ({
          status: "error" as const,
          intent: "submit",
          error: { email: ["Invalid email"] },
        }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toContain("email: Invalid email");
    });

    it("does NOT misclassify a Conform-like shape that lacks `intent`", async () => {
      // Other libs return `{ status: 'error' }` for non-failure states.
      // Our classifier requires `intent` as a soft co-signal so we
      // don't false-positive.
      const action = captureServerAction(
        async () => ({ status: "error", reason: "rate limited but ok" }),
        "x",
      );
      await action();
      expect(drainEvents()[0]!.outcome).toBe("success");
    });

    // Zod safeParse — `{ success: false, error: ZodError }` where
    // `ZodError.issues` is the actionable info.
    it("classifies Zod safeParse failure as failure", async () => {
      const action = captureServerAction(
        async () => ({
          success: false,
          error: {
            issues: [
              { path: ["email"], message: "Required" },
              { path: ["name"], message: "Too short" },
            ],
          },
        }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toContain("Required");
      expect(event.error_message).toContain("Too short");
    });

    // Regression: existing { success: false, error: <string> } shape
    // (hand-rolled createServerAction wrappers — the Phase 3 default heuristic).
    it("preserves the original `{success:false, error:<string>}` heuristic", async () => {
      const action = captureServerAction(
        async () => ({ success: false, error: "Validation failed" }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toBe("Error: Validation failed");
    });

    it("user classifier wins over all built-in shapes", async () => {
      // User classifier returns false → skip user classifier and fall
      // through to built-in shapes, which would catch zsa. But here
      // we want to confirm the user classifier's truthy decision wins:
      configuration().apply({
        serverUrl: "https://app.ezlogs.io",
        projectToken: "ezl_test",
        isServerActionError: () => ({ errorMessage: "custom override" }),
      });

      const action = captureServerAction(
        async () => ({ data: null, serverError: "ignored by user classifier" }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.outcome).toBe("failure");
      expect(event.error_message).toBe("Error: custom override");
    });

    it("truncates long error messages to ~200 chars", async () => {
      const longMessage = "x".repeat(500);
      const action = captureServerAction(
        async () => ({ data: null, serverError: longMessage }),
        "x",
      );
      await action();
      const event = drainEvents()[0]!;
      expect(event.error_message).toMatch(/…$/);
      // "Error: " prefix + 200 chars
      expect(event.error_message!.length).toBeLessThanOrEqual(7 + 201);
    });
  });

  // Phase 4 Step 6 finding: Server Action capture only ever called
  // `maybeExtractSupabaseActor` — the user's `actorFromRequest` hook
  // was silently ignored. That meant non-Supabase auth schemes (custom
  // JWT cookies, NextAuth without Supabase, Clerk, etc.) shipped every
  // Server Action event with no actor. This guard catches that
  // regression.
  describe("actorFromRequest hook in Server Actions", () => {
    // The agent's `loadNextHeaders` does `await import("next/headers")`
    // so Next's bundler can resolve the module statically in the
    // app-rsc layer. The module-level `vi.mock("next/headers", ...)`
    // intercepts that import; `setNextHeaders` below mutates the
    // returned Headers instance per-test.
    function setNextHeaders(headers: Record<string, string>): void {
      nextHeadersState.current = new Headers(headers);
    }

    it("invokes the user-supplied actorFromRequest with a Headers facade", async () => {
      setNextHeaders({ cookie: "session=abc" });

      let receivedCookie: string | null = null;
      configuration().apply({
        serverUrl: "https://app.ezlogs.io",
        projectToken: "ezl_test",
        actorFromRequest: (request: unknown) => {
          // The facade exposes the same `headers.get(...)` shape as a
          // real Request, so user code that reads cookies works
          // unchanged.
          const headers = (request as { headers: Headers }).headers;
          receivedCookie = headers.get("cookie");
          return { id: "u-42", label: "alice@example.com" };
        },
      });

      const action = captureServerAction(async () => ({ ok: true }), "x");
      await action();

      expect(receivedCookie).toBe("session=abc");
      const event = drainEvents()[0]!;
      const ctxActor = (event.context as { actor?: unknown } | null)?.actor as
        | { id: string; label?: string }
        | undefined;
      expect(ctxActor).toEqual({ id: "u-42", label: "alice@example.com" });
    });

    it("returning null from the hook is fine (event ships without an actor)", async () => {
      setNextHeaders({ cookie: "" });
      configuration().apply({
        serverUrl: "https://app.ezlogs.io",
        projectToken: "ezl_test",
        actorFromRequest: () => null,
      });

      const action = captureServerAction(async () => ({ ok: true }), "x");
      await action();

      const event = drainEvents()[0]!;
      // No actor populated; event is still emitted normally.
      expect(event.context).toBeNull();
    });

    it("resolves the actor BEFORE the action body runs (DB events inherit it)", async () => {
      // Phase 4 Step 6 finding: the actor hook used to run AFTER the
      // action body completed, so DB events emitted from inside the
      // body shipped with `actor: null`. The hook must run first so
      // `getCurrentActor()` returns the user from inside the body.
      setNextHeaders({ cookie: "session=abc" });

      let observedActorIdInsideAction: string | null = "<not captured>";
      configuration().apply({
        serverUrl: "https://app.ezlogs.io",
        projectToken: "ezl_test",
        actorFromRequest: () => ({ id: "u-99", label: "carol@example.com" }),
      });

      // Late-import inside the test so the mock is in place.
      const { getCurrentActor } = await import("../../src/actor.js");

      const action = captureServerAction(async () => {
        // This simulates what a Drizzle/Prisma query callback would
        // see when it reads `getCurrentActor()` to attach the actor
        // to its DB event.
        observedActorIdInsideAction = getCurrentActor()?.id ?? null;
        return { ok: true };
      }, "x");
      await action();

      expect(observedActorIdInsideAction).toBe("u-99");
    });

    it("forwards FormData arguments as request_params (top-level fields)", async () => {
      // Phase 4 Step 6 finding: the dashboard only showed `from_page`
      // because we discarded the action's args. Now we lift FormData
      // fields to the top of request_params.
      setNextHeaders({ cookie: "session=abc" });

      const action = captureServerAction(
        async (_formData: FormData) => ({ ok: true }),
        "inviteTeamMember",
      );

      const fd = new FormData();
      fd.set("email", "alice@example.com");
      fd.set("role", "member");
      fd.set("$ACTION_REF_1", "ignore me");

      await action(fd);

      const event = drainEvents()[0]!;
      const params = (event.source_data as { request_params?: Record<string, unknown> })
        .request_params!;
      expect(params.email).toBe("alice@example.com");
      expect(params.role).toBe("member");
      expect(params.$ACTION_REF_1).toBeUndefined();
    });

    it("drops prevState noise when FormData is present (return-value reuse)", async () => {
      // After the user submits once and the action returns
      // `{name, success: "..."}`, useActionState passes that return
      // value back as prevState on the next submission. We must NOT
      // surface it as `arg0.name`, `arg0.success` — that's noisy
      // RSC plumbing, not "the user's input".
      setNextHeaders({ cookie: "session=abc" });

      const action = captureServerAction(
        async (_prev: unknown, _fd: FormData) => ({ ok: true }),
        "updateAccount",
      );

      const fd = new FormData();
      fd.set("name", "razvan-new");
      fd.set("email", "test@test.com");

      // Simulate the previous return value coming back as prevState.
      const prevReturn = {
        name: "razvan-old",
        success: "Account updated successfully.",
      };
      await action(prevReturn, fd);

      const event = drainEvents()[0]!;
      const params = (event.source_data as { request_params?: Record<string, unknown> })
        .request_params!;
      // Top-level fields from FormData (the actual user input)
      expect(params.name).toBe("razvan-new");
      expect(params.email).toBe("test@test.com");
      // No leaked prevState noise
      expect(params["arg0.name"]).toBeUndefined();
      expect(params["arg0.success"]).toBeUndefined();
      expect(params.arg0).toBeUndefined();
      expect(params.success).toBeUndefined();
    });

    it("prefers FormData over a leading prevState object (useActionState pattern)", async () => {
      // useActionState calls the action with `(prevState, formData)`.
      // We must lift FormData fields to the top level — NOT the empty
      // prevState — so the dashboard shows `email: ...` instead of
      // `arg1.email: ...`.
      setNextHeaders({ cookie: "session=abc" });

      const action = captureServerAction(
        async (_prevState: unknown, _formData: FormData) => ({ ok: true }),
        "updateAccount",
      );

      const fd = new FormData();
      fd.set("name", "Razvan");
      fd.set("email", "razvan@example.com");

      // First arg = previous state (empty object — useActionState's initial)
      // Second arg = the FormData payload
      await action({}, fd);

      const event = drainEvents()[0]!;
      const params = (event.source_data as { request_params?: Record<string, unknown> })
        .request_params!;
      // Top-level fields from FormData
      expect(params.name).toBe("Razvan");
      expect(params.email).toBe("razvan@example.com");
      // No nested `arg1.*` keys
      expect(params["arg1.name"]).toBeUndefined();
      // Empty prev-state arg dropped, NOT `arg0: {}`
      expect(params.arg0).toBeUndefined();
    });

    it("forwards plain-object arguments as request_params", async () => {
      // next-safe-action style — first arg is a typed input.
      setNextHeaders({ cookie: "session=abc" });

      const action = captureServerAction(
        async (_input: { ids: string[]; entityType: string }) => ({ ok: true }),
        "startBulkDelete",
      );
      await action({ ids: ["a", "b", "c"], entityType: "hardware" });

      const event = drainEvents()[0]!;
      const params = (event.source_data as { request_params?: Record<string, unknown> })
        .request_params!;
      expect(params.ids).toEqual(["a", "b", "c"]);
      expect(params.entityType).toBe("hardware");
    });

    it("does not propagate hook errors to the caller", async () => {
      setNextHeaders({ cookie: "session=abc" });
      configuration().apply({
        serverUrl: "https://app.ezlogs.io",
        projectToken: "ezl_test",
        actorFromRequest: () => {
          throw new Error("hook bug");
        },
      });

      const action = captureServerAction(async () => ({ ok: true }), "x");
      // The hook throwing must NOT propagate — the host action stays
      // green.
      await expect(action()).resolves.toEqual({ ok: true });
    });
  });

  it("captures multiple concurrent invocations with isolated correlation ids", async () => {
    const action = captureServerAction(async (label: string) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return label;
    }, "labeledAction");

    await Promise.all([action("a"), action("b"), action("c")]);

    const events = drainEvents();
    expect(events).toHaveLength(3);
    const ids = new Set(events.map((e) => e.correlation_id));
    expect(ids.size).toBe(3);
    events.forEach((e) =>
      expect(e.correlation_id).toMatch(/^ezl_\d+_[0-9a-f]{8}$/),
    );
  });

  it("auto-flushes audit-log rows for the current correlation when databaseReader is set", async () => {
    // Stand-in for the customer's pg/drizzle/prisma exec. Returns one
    // audit row scoped to the request's correlation_id.
    const reader = vi.fn(async (sql: string, params: ReadonlyArray<unknown>) => {
      expect(sql).toMatch(/SELECT table_name, op, old_row, new_row, resource_id/);
      const correlation = params[0] as string;
      return {
        rows: [
          {
            table_name: "users",
            op: "INSERT",
            old_row: null,
            new_row: { id: 7, name: "alice", email: "alice@example.com" },
            resource_id: "7",
          },
        ],
        // The fake echoes the correlation back so the assertion below
        // confirms the request's id was forwarded.
        _correlation: correlation,
      };
    });
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      databaseReader: reader,
    });

    const action = captureServerAction(async () => ({ ok: true }), "createUser");
    await action();

    const events = drainEvents();
    // Expect 2: the database_callback row drained from the audit log,
    // followed by the http_request event for the Server Action itself.
    expect(events.length).toBe(2);
    const dbEvent = events[0]!;
    const httpEvent = events[1]!;
    expect(dbEvent.source_type).toBe("database_callback");
    expect(dbEvent.source_data).toMatchObject({
      model_class: "users",
      operation: "create",
    });
    expect(httpEvent.source_type).toBe("http_request");
    // Both share the same correlation — that's the whole point of
    // grouping DB events under the action.
    expect(dbEvent.correlation_id).toBe(httpEvent.correlation_id);
    expect(reader.mock.calls[0]![1]).toEqual([httpEvent.correlation_id]);
  });

  it("does not call databaseReader when no rows are tagged with this correlation", async () => {
    const reader = vi.fn(async () => ({ rows: [] }));
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      databaseReader: reader,
    });

    const action = captureServerAction(async () => ({ ok: true }), "noop");
    await action();

    // The reader IS called (we don't know ahead of time whether rows
    // exist), but no DB events are emitted — only the http_request.
    expect(reader).toHaveBeenCalledTimes(1);
    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.source_type).toBe("http_request");
  });

  it("databaseReader errors do not break the request — http event still ships", async () => {
    const reader = vi.fn().mockRejectedValue(new Error("connection refused"));
    configuration().apply({
      serverUrl: "https://app.ezlogs.io",
      projectToken: "ezl_test",
      databaseReader: reader,
    });

    const action = captureServerAction(async () => ({ ok: true }), "stillWorks");
    await action();

    const events = drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.source_type).toBe("http_request");
  });
});
