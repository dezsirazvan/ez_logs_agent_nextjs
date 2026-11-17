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
 * timer. Serverless mode also flushes at the end of each request
 * (flushOnServerless in http/capture.ts).
 */

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import { drainEvents } from "./buffer.js";
import { retrySender } from "./retry-sender.js";
import { maintainAuditLogAfterRequests } from "../triggers/reader.js";

const GLOBAL_KEY = Symbol.for("ezlogs-nextjs:flush-scheduler-state");

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  /** The running tick, so a caller arriving mid-send can queue after it. */
  current: Promise<void> | null;
  /** One follow-up drain queued behind `current`, shared by every caller that arrives meanwhile. */
  followUp: Promise<void> | null;
}

interface GlobalWithScheduler {
  [GLOBAL_KEY]?: SchedulerState;
}

function state(): SchedulerState {
  const g = globalThis as unknown as GlobalWithScheduler;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { timer: null, inFlight: false, current: null, followUp: null };
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

  /**
   * Drain and send now; resolves once this caller's events are sent (or
   * dropped). If a send is already running, one more drain is queued after
   * it, so events buffered since that send started are covered too: on
   * serverless, overlapping requests each hand this promise to waitUntil.
   * Concurrent callers share that single follow-up, so a slow server never
   * builds a queue.
   */
  flushNow(): Promise<void> {
    const s = state();
    if (!s.inFlight || !s.current) return tick();
    if (!s.followUp) {
      s.followUp = s.current.then(() => {
        s.followUp = null;
        return tick();
      });
    }
    return s.followUp;
  },
};

function tick(): Promise<void> {
  const s = state();
  // Skip if a previous tick is still in flight — prevents stampede when
  // sendInterval is short and the network is slow. (flushNow queues a
  // follow-up instead of skipping.)
  if (s.inFlight && s.current) return s.current;
  s.inFlight = true;
  s.current = runTick().finally(() => {
    s.inFlight = false;
    s.current = null;
  });
  return s.current;
}

async function runTick(): Promise<void> {
  try {
    const events = drainEvents();
    if (events.length > 0) await retrySender.send(events);
    // Leftover audit rows of recent requests ship on the timer too;
    // after the send, so a slow database never holds up events. Swept
    // rows are already claimed (deleted), so they ship in this tick.
    // Throttled, errors swallowed inside.
    const reader = configuration().databaseReader;
    if (!reader) return;
    await maintainAuditLogAfterRequests(reader);
    const swept = drainEvents();
    if (swept.length > 0) await retrySender.send(swept);
  } catch (error) {
    logger.error(`FlushScheduler tick failed: ${describeError(error)}`);
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
