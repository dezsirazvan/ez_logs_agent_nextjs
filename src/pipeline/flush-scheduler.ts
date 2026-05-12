/**
 * FlushScheduler — port of flush_scheduler.rb.
 *
 * Periodic flush via setInterval. On each tick: drain Buffer → ship via
 * RetrySender. Idempotent start/stop. Never throws.
 *
 * Pinned to globalThis to survive Next.js / Webpack / Turbopack module
 * duplication — same reason as configuration.ts and buffer.ts.
 *
 * Note on serverless: this scheduler is the long-lived-process model.
 * Vercel functions and Lambda freeze between requests, killing the
 * timer. Serverless mode disables the scheduler and uses sync flush.
 */

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import { drainEvents } from "./buffer.js";
import { retrySender } from "./retry-sender.js";

const GLOBAL_KEY = Symbol.for("@ezlogs/nextjs:flush-scheduler-state");

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

interface GlobalWithScheduler {
  [GLOBAL_KEY]?: SchedulerState;
}

function state(): SchedulerState {
  const g = globalThis as unknown as GlobalWithScheduler;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { timer: null, inFlight: false };
  }
  return g[GLOBAL_KEY]!;
}

export const flushScheduler = {
  start(): void {
    const s = state();
    if (s.timer !== null) return; // idempotent

    const interval = sendInterval();
    s.timer = setInterval(() => {
      void tick();
    }, interval);

    // Don't keep the Node process alive just for the flush timer.
    if (typeof s.timer === "object" && s.timer !== null && "unref" in s.timer) {
      (s.timer as { unref: () => void }).unref();
    }

    logger.debug(`FlushScheduler started (interval ${interval}ms)`);
  },

  async stop(): Promise<void> {
    const s = state();
    if (s.timer === null) return; // idempotent
    clearInterval(s.timer);
    s.timer = null;
    // Flush whatever's left so a clean shutdown ships pending events.
    await tick();
    logger.debug("FlushScheduler stopped");
  },

  isRunning(): boolean {
    return state().timer !== null;
  },

  /** Force a single drain-and-send cycle. Used by serverless flush + tests. */
  async flushNow(): Promise<void> {
    await tick();
  },
};

async function tick(): Promise<void> {
  const s = state();
  // Skip if a previous tick is still in flight — prevents stampede when
  // sendInterval is short and the network is slow.
  if (s.inFlight) return;
  s.inFlight = true;
  try {
    const events = drainEvents();
    if (events.length === 0) return;
    await retrySender.send(events);
  } catch (error) {
    logger.error(`FlushScheduler tick failed: ${describeError(error)}`);
  } finally {
    s.inFlight = false;
  }
}

function sendInterval(): number {
  try {
    const value = configuration().sendInterval;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return 5_000;
    }
    return value;
  } catch {
    return 5_000;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
