import { afterEach, describe, expect, it, vi } from "vitest";
import { nextAuthActor } from "../../src/actors/index.js";

const realFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = realFunction;
  vi.restoreAllMocks();
});

function stubDynamicImport(matcher: (specifier: string) => unknown): void {
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

const dummyAuthOptions = { providers: [], session: { strategy: "jwt" as const } };

describe("nextAuthActor", () => {
  it("returns the user from `getServerSession`", async () => {
    stubDynamicImport(() => ({
      getServerSession: () =>
        Promise.resolve({
          user: { id: "u-1", email: "a@b.com", name: "Alice" },
        }),
    }));

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toEqual({ id: "u-1", label: "Alice" });
  });

  it("falls back to email when name is missing", async () => {
    stubDynamicImport(() => ({
      getServerSession: () =>
        Promise.resolve({ user: { id: "u-2", email: "a@b.com" } }),
    }));

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toEqual({ id: "u-2", label: "a@b.com" });
  });

  it("uses email as id when user.id is missing (legacy NextAuth shape)", async () => {
    stubDynamicImport(() => ({
      getServerSession: () =>
        Promise.resolve({ user: { email: "a@b.com", name: "Alice" } }),
    }));

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toEqual({ id: "a@b.com", label: "Alice" });
  });

  it("returns null when no session", async () => {
    stubDynamicImport(() => ({
      getServerSession: () => Promise.resolve(null),
    }));

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toBeNull();
  });

  it("returns null when next-auth is not installed", async () => {
    stubDynamicImport(() => {
      throw new Error("Cannot find package 'next-auth/next'");
    });

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toBeNull();
  });

  it("returns null when getServerSession throws", async () => {
    stubDynamicImport(() => ({
      getServerSession: () => {
        throw new Error("session decoding failed");
      },
    }));

    const actor = await nextAuthActor({ authOptions: dummyAuthOptions })(
      new Request("http://localhost/x"),
    );
    expect(actor).toBeNull();
  });

  it("does not propagate errors to the caller", async () => {
    stubDynamicImport(() => {
      throw new Error("boom");
    });

    await expect(
      nextAuthActor({ authOptions: dummyAuthOptions })(new Request("http://localhost/x")),
    ).resolves.toBeNull();
  });
});
