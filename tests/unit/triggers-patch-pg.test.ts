import { afterEach, describe, expect, it } from "vitest";
import { patchPgClient } from "../../src/triggers/patch-pg.js";
import {
  runWithActorScope,
  setActor,
  _resetActorForTests,
} from "../../src/actor.js";
import {
  runWithCorrelation,
  _resetCorrelationForTests,
} from "../../src/correlation.js";

afterEach(() => {
  _resetActorForTests();
  _resetCorrelationForTests();
});

/**
 * Build a fresh `pg`-like module for each test. Each test gets its
 * own Client *class* so the patch's idempotency tracking
 * (`prototype._ezlogsPatched`) doesn't leak between tests.
 *
 * Each Client instance records every query call to `calls` and
 * resolves with a fixed result.
 */
function makeFakePg() {
  const calls: Array<{ text: string; values?: unknown[] }> = [];

  class FakeClient {
    async query(config: string | { text: string; values?: unknown[] }, values?: unknown) {
      const text = typeof config === "string" ? config : config.text;
      const params =
        typeof config === "string"
          ? (Array.isArray(values) ? (values as unknown[]) : undefined)
          : config.values;
      calls.push({ text, values: params });
      return { rows: [], rowCount: 0 };
    }
  }
  return { calls, pg: { Client: FakeClient }, FakeClient };
}

describe("patchPgClient — patch behaviour", () => {
  it("idempotent: applies once, second call is a no-op", () => {
    const { pg } = makeFakePg();
    patchPgClient(pg);
    const firstQuery = pg.Client.prototype.query;
    patchPgClient(pg);
    expect(pg.Client.prototype.query).toBe(firstQuery);
  });

  it("standalone query with no actor/correlation runs unchanged", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();
    await client.query("SELECT 1");
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toBe("SELECT 1");
  });

  it("standalone query WITH actor wraps in BEGIN/SET/<query>/COMMIT", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    await runWithCorrelation("ezl_42", async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u-7" });
        await client.query("UPDATE users SET name = 'alice' WHERE id = 1");
      });
    });

    const sqls = calls.map((c) => c.text);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => /set_config\('ezlogs\.actor_id'/.test(s))).toBe(true);
    expect(sqls.some((s) => /set_config\('ezlogs\.correlation_id'/.test(s))).toBe(true);
    expect(sqls.some((s) => s.startsWith("UPDATE users"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("ROLLBACK on user query failure", async () => {
    const calls: string[] = [];
    class FailingClient {
      async query(config: string | { text: string }) {
        const text = typeof config === "string" ? config : config.text;
        calls.push(text);
        if (text.startsWith("UPDATE")) {
          throw new Error("constraint violation");
        }
        return { rows: [] };
      }
    }
    const pg = { Client: FailingClient };
    patchPgClient(pg);
    const client = new FailingClient();

    await runWithActorScope(async () => {
      setActor({ id: "u-1" });
      await expect(
        client.query("UPDATE users SET x = 1"),
      ).rejects.toThrow("constraint violation");
    });

    expect(calls[0]).toBe("BEGIN");
    expect(calls[calls.length - 1]).toBe("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("inside an explicit BEGIN: injects SET LOCAL once, then user queries pass through", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    await runWithActorScope(async () => {
      setActor({ id: "u-1" });
      await runWithCorrelation("ezl_x", async () => {
        await client.query("BEGIN");
        await client.query("UPDATE users SET name = 'a'");
        await client.query("UPDATE users SET name = 'b'");
        await client.query("COMMIT");
      });
    });

    const sqls = calls.map((c) => c.text);
    // BEGIN, SET actor, SET correlation, UPDATE, UPDATE, COMMIT
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/set_config\('ezlogs\.actor_id'/);
    expect(sqls[2]).toMatch(/set_config\('ezlogs\.correlation_id'/);
    expect(sqls[3]).toMatch(/^UPDATE/);
    expect(sqls[4]).toMatch(/^UPDATE/);
    expect(sqls[5]).toBe("COMMIT");
    // Crucially, SET appears EXACTLY ONCE, not before each UPDATE.
    expect(
      sqls.filter((s) => /set_config\('ezlogs\.actor_id'/.test(s)).length,
    ).toBe(1);
  });

  it("inside an explicit BEGIN with no actor/correlation: passes through clean", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    // No runWithCorrelation/runWithActorScope — no GUCs to inject.
    await client.query("BEGIN");
    await client.query("UPDATE users SET name = 'a'");
    await client.query("COMMIT");

    const sqls = calls.map((c) => c.text);
    expect(sqls).toEqual(["BEGIN", "UPDATE users SET name = 'a'", "COMMIT"]);
  });

  it("two separate transactions on same client both get SETs (state resets between txs)", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    await runWithActorScope(async () => {
      setActor({ id: "u-1" });
      // Tx 1
      await client.query("BEGIN");
      await client.query("INSERT INTO foo VALUES (1)");
      await client.query("COMMIT");
      // Tx 2
      await client.query("BEGIN");
      await client.query("INSERT INTO foo VALUES (2)");
      await client.query("COMMIT");
    });

    const setCount = calls.filter((c) =>
      /set_config\('ezlogs\.actor_id'/.test(c.text),
    ).length;
    expect(setCount).toBe(2);
  });

  it("comment-prefixed BEGIN is recognized as a transaction start", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    await runWithActorScope(async () => {
      setActor({ id: "u-1" });
      await client.query("-- explicit tx for batch import\nBEGIN");
      await client.query("INSERT INTO foo VALUES (1)");
      await client.query("COMMIT");
    });

    const sqls = calls.map((c) => c.text);
    // The BEGIN-with-comment should NOT have been wrapped in a synthetic tx;
    // it should be recognized as the customer's explicit tx open.
    expect(sqls[0]).toMatch(/--.*\nBEGIN/);
    // SET LOCAL should have run before the INSERT, not before BEGIN.
    expect(sqls[1]).toMatch(/set_config\('ezlogs\.actor_id'/);
  });

  it("config-object form (not just string) is supported", async () => {
    const { calls, pg, FakeClient } = makeFakePg();
    patchPgClient(pg);
    const client = new FakeClient();

    await runWithActorScope(async () => {
      setActor({ id: "u-1" });
      await client.query({
        text: "UPDATE users SET name = $1 WHERE id = $2",
        values: ["alice", 1],
      });
    });

    const sqls = calls.map((c) => c.text);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls).toContain("UPDATE users SET name = $1 WHERE id = $2");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("non-recognized pg module shape: doesn't throw, doesn't patch", () => {
    expect(() => patchPgClient(null as unknown as never)).not.toThrow();
    expect(() => patchPgClient({} as unknown as never)).not.toThrow();
    expect(() => patchPgClient({ Client: {} } as unknown as never)).not.toThrow();
  });
});
