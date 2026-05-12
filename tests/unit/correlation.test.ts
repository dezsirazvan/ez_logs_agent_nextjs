import { afterEach, describe, expect, it } from "vitest";
import {
  _isUsingAsyncLocalStorageForTests,
  _resetCorrelationForTests,
  current,
  generate,
  runWithCorrelation,
} from "../../src/correlation.js";

afterEach(() => {
  _resetCorrelationForTests();
});

describe("Correlation.generate", () => {
  it("produces ids in the format `ezl_<unix_ms>_<8-hex>` (parity with Ruby)", () => {
    const id = generate();
    expect(id).toMatch(/^ezl_\d{10,16}_[0-9a-f]{8}$/);
  });

  it("hex segment is exactly 8 lowercase chars (matches SecureRandom.hex(4))", () => {
    for (let i = 0; i < 50; i++) {
      const hex = generate().split("_")[2]!;
      expect(hex).toHaveLength(8);
      expect(hex).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("timestamp segment is a parseable Date.now() value", () => {
    const before = Date.now();
    const ts = Number(generate().split("_")[1]);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("two consecutive ids differ (high-entropy hex segment)", () => {
    expect(generate()).not.toBe(generate());
  });
});

describe("Correlation.current", () => {
  it("returns null outside any correlation scope", () => {
    expect(current()).toBeNull();
  });

  it("returns the active id inside runWithCorrelation", () => {
    runWithCorrelation("ezl_1_aaaaaaaa", () => {
      expect(current()).toBe("ezl_1_aaaaaaaa");
    });
  });

  it("scope does not leak after runWithCorrelation returns", () => {
    runWithCorrelation("ezl_1_aaaaaaaa", () => {
      expect(current()).toBe("ezl_1_aaaaaaaa");
    });
    expect(current()).toBeNull();
  });

  it("nested scopes see their innermost id and restore on unwind", () => {
    runWithCorrelation("ezl_outer_aaaaaaaa", () => {
      expect(current()).toBe("ezl_outer_aaaaaaaa");
      runWithCorrelation("ezl_inner_bbbbbbbb", () => {
        expect(current()).toBe("ezl_inner_bbbbbbbb");
      });
      expect(current()).toBe("ezl_outer_aaaaaaaa");
    });
  });
});

describe("Correlation.runWithCorrelation — async propagation", () => {
  it("threads through awaited async work (the whole point of AsyncLocalStorage)", async () => {
    const seen: Array<string | null> = [];
    await runWithCorrelation("ezl_async_cccccccc", async () => {
      seen.push(current());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      seen.push(current());
      await Promise.resolve();
      seen.push(current());
    });
    expect(seen).toEqual([
      "ezl_async_cccccccc",
      "ezl_async_cccccccc",
      "ezl_async_cccccccc",
    ]);
  });

  it("isolates concurrent scopes (no cross-contamination)", async () => {
    const results: string[] = [];

    async function recordAfter(id: string, delayMs: number): Promise<void> {
      await runWithCorrelation(id, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        results.push(current() ?? "<none>");
      });
    }

    await Promise.all([
      recordAfter("ezl_a_aaaaaaaa", 20),
      recordAfter("ezl_b_bbbbbbbb", 5),
      recordAfter("ezl_c_cccccccc", 10),
    ]);

    expect(results.sort()).toEqual([
      "ezl_a_aaaaaaaa",
      "ezl_b_bbbbbbbb",
      "ezl_c_cccccccc",
    ]);
  });
});

describe("Correlation — runtime detection", () => {
  it("uses AsyncLocalStorage in the Node test environment", () => {
    expect(_isUsingAsyncLocalStorageForTests()).toBe(true);
  });
});
