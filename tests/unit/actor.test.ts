import { afterEach, describe, expect, it } from "vitest";
import {
  _resetActorForTests,
  getCurrentActor,
  runWithActorScope,
  setActor,
  validateActor,
} from "../../src/actor.js";

afterEach(() => {
  _resetActorForTests();
});

describe("validateActor (port of ActorValidator.sanitize)", () => {
  it("treats null as valid (means 'unknown provenance')", () => {
    expect(validateActor(null)).toBeNull();
    expect(validateActor(undefined)).toBeNull();
  });

  it("requires the input to be a plain object", () => {
    expect(validateActor("alice")).toBeNull();
    expect(validateActor(42)).toBeNull();
    expect(validateActor(true)).toBeNull();
    expect(validateActor([{ id: "1" }])).toBeNull();
  });

  it("requires a non-empty id", () => {
    expect(validateActor({})).toBeNull();
    expect(validateActor({ id: "" })).toBeNull();
    expect(validateActor({ id: null })).toBeNull();
    expect(validateActor({ id: undefined })).toBeNull();
  });

  it("coerces non-string id to string (parity with Ruby's id.to_s)", () => {
    expect(validateActor({ id: 42 })).toEqual({ id: "42" });
    expect(validateActor({ id: 0 })).toEqual({ id: "0" });
  });

  it("treats id=0 as a valid id (not falsy in this context)", () => {
    expect(validateActor({ id: 0 })).toEqual({ id: "0" });
  });

  it("includes label when present, omits when absent", () => {
    expect(validateActor({ id: "42" })).toEqual({ id: "42" });
    expect(validateActor({ id: "42", label: "alice@example.com" })).toEqual({
      id: "42",
      label: "alice@example.com",
    });
  });

  it("coerces label to string", () => {
    expect(validateActor({ id: "42", label: 99 })).toEqual({
      id: "42",
      label: "99",
    });
  });

  it("drops null/undefined label", () => {
    expect(validateActor({ id: "42", label: null })).toEqual({ id: "42" });
    expect(validateActor({ id: "42", label: undefined })).toEqual({ id: "42" });
  });

  it("ignores extra fields (parity with Ruby — id + label only)", () => {
    expect(validateActor({ id: "42", label: "alice", role: "admin", api_key: "x" })).toEqual({
      id: "42",
      label: "alice",
    });
  });
});

describe("getCurrentActor / setActor inside an active scope", () => {
  it("starts at null inside a fresh scope", () => {
    runWithActorScope(() => {
      expect(getCurrentActor()).toBeNull();
    });
  });

  it("setActor + getCurrentActor round-trip", () => {
    runWithActorScope(() => {
      setActor({ id: "42", label: "alice@example.com" });
      expect(getCurrentActor()).toEqual({ id: "42", label: "alice@example.com" });
    });
  });

  it("invalid actors are silently ignored, getCurrentActor stays null", () => {
    runWithActorScope(() => {
      setActor({ no_id: "wrong" });
      expect(getCurrentActor()).toBeNull();
    });
  });

  it("scope is isolated: actor does not leak across runWithActorScope calls", () => {
    runWithActorScope(() => {
      setActor({ id: "42" });
    });
    runWithActorScope(() => {
      expect(getCurrentActor()).toBeNull();
    });
  });

  it("threads through awaited async work", async () => {
    const seen: Array<unknown> = [];
    await runWithActorScope(async () => {
      setActor({ id: "42", label: "alice" });
      seen.push(getCurrentActor());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      seen.push(getCurrentActor());
    });
    expect(seen).toEqual([
      { id: "42", label: "alice" },
      { id: "42", label: "alice" },
    ]);
  });

  it("isolates concurrent scopes (no cross-contamination under Promise.all)", async () => {
    const results: Array<string | null> = [];

    async function recordAfter(id: string, delayMs: number): Promise<void> {
      await runWithActorScope(async () => {
        setActor({ id });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        results.push(getCurrentActor()?.id ?? null);
      });
    }

    await Promise.all([
      recordAfter("a", 20),
      recordAfter("b", 5),
      recordAfter("c", 10),
    ]);

    expect(results.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("getCurrentActor outside any scope", () => {
  it("returns null when called without runWithActorScope", () => {
    expect(getCurrentActor()).toBeNull();
  });
});
