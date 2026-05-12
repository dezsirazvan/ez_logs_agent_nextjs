import { describe, expect, it } from "vitest";
import { authJsActor } from "../../src/actors/index.js";

// Auth.js v5 doesn't use a dynamic import — the customer passes their
// own `auth` helper into the factory, so we mock via a plain function.

describe("authJsActor", () => {
  it("returns the user from the provided `auth()` helper", async () => {
    const auth = () =>
      Promise.resolve({ user: { id: "u-1", email: "a@b.com", name: "Alice" } });
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "u-1", label: "Alice" });
  });

  it("supports a synchronous `auth()` helper too", async () => {
    const auth = () => ({ user: { id: "u-1", email: "a@b.com" } });
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "u-1", label: "a@b.com" });
  });

  it("uses email as id when user.id is missing", async () => {
    const auth = () => ({ user: { email: "a@b.com", name: "Alice" } });
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toEqual({ id: "a@b.com", label: "Alice" });
  });

  it("returns null when session is null", async () => {
    const auth = () => null;
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("returns null when session has no user", async () => {
    const auth = () => ({ user: null });
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("returns null when auth() throws", async () => {
    const auth = (() => {
      throw new Error("session decoding failed");
    }) as () => never;
    const actor = await authJsActor({ auth })(new Request("http://localhost/x"));
    expect(actor).toBeNull();
  });

  it("does not propagate errors to the caller", async () => {
    const auth = (() => {
      throw new Error("boom");
    }) as () => never;
    await expect(
      authJsActor({ auth })(new Request("http://localhost/x")),
    ).resolves.toBeNull();
  });
});
