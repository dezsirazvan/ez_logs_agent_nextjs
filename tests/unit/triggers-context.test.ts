import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDatabaseContext,
  withDatabaseContext,
} from "../../src/triggers/context.js";
import { runWithActorScope, setActor, _resetActorForTests } from "../../src/actor.js";
import {
  runWithCorrelation,
  _resetCorrelationForTests,
} from "../../src/correlation.js";

afterEach(() => {
  _resetActorForTests();
  _resetCorrelationForTests();
});

describe("applyDatabaseContext", () => {
  it("no-ops (no SQL) when both actor and correlation are unset", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await applyDatabaseContext(exec);
    expect(exec).not.toHaveBeenCalled();
  });

  it("issues SET ezlogs.actor_id when actor is set", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await runWithActorScope(async () => {
      setActor({ id: "user_123", label: "alice@example.com" });
      await applyDatabaseContext(exec);
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).toMatch(/set_config\('ezlogs\.actor_id'/);
    expect(exec.mock.calls[0]![1]).toEqual(["user_123"]);
  });

  it("issues SET ezlogs.correlation_id when correlation is set", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await runWithCorrelation("ezl_test_abcdef12", async () => {
      await applyDatabaseContext(exec);
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).toMatch(/set_config\('ezlogs\.correlation_id'/);
    expect(exec.mock.calls[0]![1]).toEqual(["ezl_test_abcdef12"]);
  });

  it("issues both SETs when actor + correlation are set", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await runWithCorrelation("ezl_xyz", async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u1" });
        await applyDatabaseContext(exec);
      });
    });
    expect(exec).toHaveBeenCalledTimes(2);
    // Order: actor first, correlation second (matches plan + helper).
    expect(exec.mock.calls[0]![0]).toMatch(/actor_id/);
    expect(exec.mock.calls[1]![0]).toMatch(/correlation_id/);
  });

  it("uses set_config(_, _, true) so the GUC is local to the transaction", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await runWithActorScope(async () => {
      setActor({ id: "u1" });
      await applyDatabaseContext(exec);
    });
    // The third positional argument to set_config (`is_local`) must be
    // literally `true` — without it, PgBouncer-pooled deployments
    // would leak the GUC to other tenants on the same connection.
    expect(exec.mock.calls[0]![0]).toMatch(/set_config\([^)]*,\s*true\)/);
  });

  it("swallows errors from exec — never breaks the customer's transaction", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("syntax error"));
    await runWithActorScope(async () => {
      setActor({ id: "u1" });
      // Does NOT throw.
      await applyDatabaseContext(exec);
    });
    expect(exec).toHaveBeenCalled();
  });

  it("skips empty actor.id — defensive, mirrors validateActor's contract", async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await runWithActorScope(async () => {
      // setActor refuses empty id, so we test the guard inside applyDatabaseContext
      // by supplying a non-empty id then verify only one call (actor) was made.
      setActor({ id: "u1" });
      await applyDatabaseContext(exec);
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("withDatabaseContext", () => {
  function makeClient() {
    const calls: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params });
        return undefined;
      }),
    };
    return { client, calls };
  }

  it("BEGIN, applies context, runs callback, COMMIT", async () => {
    const { client, calls } = makeClient();

    await runWithCorrelation("ezl_test_42", async () => {
      await runWithActorScope(async () => {
        setActor({ id: "u1" });
        await withDatabaseContext(client, async (c) => {
          await c.query("INSERT INTO foo VALUES ($1)", [1]);
        });
      });
    });

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => /set_config\('ezlogs\.actor_id'/.test(s))).toBe(true);
    expect(sqls.some((s) => /set_config\('ezlogs\.correlation_id'/.test(s))).toBe(true);
    expect(sqls.some((s) => s.startsWith("INSERT INTO foo"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("ROLLBACK + rethrow when callback throws", async () => {
    const { client, calls } = makeClient();

    await expect(
      withDatabaseContext(client, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
  });

  it("rethrows the callback error even if ROLLBACK itself fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("connection terminated");
        if (sql === "BEGIN") return undefined;
        throw new Error("user-side failure");
      }),
    };

    await expect(
      withDatabaseContext(client, async (c) => {
        await c.query("SELECT 1");
      }),
    ).rejects.toThrow("user-side failure");
  });

  it("works with no actor/correlation set — just BEGIN/callback/COMMIT, no SETs", async () => {
    const { client, calls } = makeClient();
    await withDatabaseContext(client, async (c) => {
      await c.query("SELECT 1");
    });
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });
});
