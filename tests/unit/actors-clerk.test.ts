import { afterEach, describe, expect, it, vi } from "vitest";
import { clerkActor } from "../../src/actors/index.js";

// Each test stubs `Function` so we can intercept the dynamic import
// shape `(Function("s","return import(s)") as any)(specifier)` used
// inside the extractor. We can't use `vi.mock("@clerk/nextjs/server")`
// because the agent constructs the specifier at runtime to dodge
// bundler resolution.

const realFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = realFunction;
  vi.restoreAllMocks();
});

function stubDynamicImport(
  matcher: (specifier: string) => unknown,
): void {
  // Replace `Function` with a stub that returns an importer for our
  // test fixture. The extractor calls `Function("s","return import(s)")`
  // — we need that constructor invocation to return a function which,
  // when called with a specifier, produces the mocked module.
  // We forward all OTHER `Function(...)` calls to the real constructor
  // so we don't break anything else in the test runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.Function = function (...args: string[]): any {
    if (args.length === 2 && args[0] === "s" && args[1] === "return import(s)") {
      return (specifier: string) => Promise.resolve(matcher(specifier));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realFunction as any)(...args);
  } as typeof realFunction;
  globalThis.Function.prototype = realFunction.prototype;
}

describe("clerkActor", () => {
  it("returns the user from `auth()` with email as label", async () => {
    stubDynamicImport(() => ({
      auth: () =>
        Promise.resolve({
          userId: "user_abc123",
          sessionClaims: { email: "alice@example.com", name: "Alice" },
        }),
    }));

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "user_abc123", label: "alice@example.com" });
  });

  it("falls back to name when email is missing", async () => {
    stubDynamicImport(() => ({
      auth: () =>
        Promise.resolve({
          userId: "user_1",
          sessionClaims: { name: "Bob" },
        }),
    }));

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "user_1", label: "Bob" });
  });

  it("returns id without label when no claims are present", async () => {
    stubDynamicImport(() => ({
      auth: () => Promise.resolve({ userId: "user_2", sessionClaims: null }),
    }));

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "user_2" });
  });

  it("returns null when no user is signed in", async () => {
    stubDynamicImport(() => ({
      auth: () => Promise.resolve({ userId: null, sessionClaims: null }),
    }));

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("returns null when @clerk/nextjs is not installed", async () => {
    // Simulate a missing peer dep — the dynamic import rejects.
    stubDynamicImport(() => {
      throw new Error("Cannot find package '@clerk/nextjs/server'");
    });

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("returns null when auth() throws", async () => {
    stubDynamicImport(() => ({
      auth: () => {
        throw new Error("clerk session invalid");
      },
    }));

    const actor = await clerkActor()(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("does not propagate errors to the caller", async () => {
    stubDynamicImport(() => {
      throw new Error("boom");
    });

    // The agent's `maybeRunActorHook` callsite has its own try/catch,
    // but the extractor itself must also not throw — we don't want to
    // depend on the caller's safety net.
    await expect(
      clerkActor()(new Request("http://localhost/x")),
    ).resolves.toBeNull();
  });
});
