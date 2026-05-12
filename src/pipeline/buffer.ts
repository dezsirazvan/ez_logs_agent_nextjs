// Buffer — port of buffer.rb.
//
// In-memory bounded FIFO of events. Drops oldest when full. Single-
// threaded by JS semantics (no Monitor needed). Never throws — host
// app must never see an error from logging events.
//
// Pinned to globalThis to survive Next.js / Webpack / Turbopack module
// duplication. Each extracted copy of this module would otherwise have
// its own queue array, leading to events landing in one chunk's buffer
// and the flush scheduler in a different chunk seeing nothing to send.

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import type { Event } from "../event-builder.js";

const GLOBAL_QUEUE_KEY = Symbol.for("@ezlogs/nextjs:buffer-queue");

interface GlobalWithQueue {
  [GLOBAL_QUEUE_KEY]?: Event[];
}

function getQueue(): Event[] {
  const g = globalThis as unknown as GlobalWithQueue;
  if (!g[GLOBAL_QUEUE_KEY]) g[GLOBAL_QUEUE_KEY] = [];
  return g[GLOBAL_QUEUE_KEY]!;
}

export function pushEvent(event: Event): void {
  try {
    const queue = getQueue();
    const max = maxSize();
    if (queue.length >= max) {
      queue.shift();
      logger.warn(`Buffer full (${max}), dropped oldest event`);
    }
    queue.push(event);
  } catch (error) {
    logger.error(`pushEvent failed: ${describe(error)}`);
  }
}

/**
 * Drains and returns all buffered events. Atomic w.r.t. pushEvent() —
 * no event can be added between the swap and the clear. Mirrors Ruby's
 * `events = @queue.dup; @queue.clear; events`.
 */
export function drainEvents(): Event[] {
  try {
    const queue = getQueue();
    if (queue.length === 0) return [];
    // splice(0) is the standard pattern for atomic drain-and-clear:
    // returns the previous contents and empties.
    return queue.splice(0, queue.length);
  } catch (error) {
    logger.error(`drainEvents failed: ${describe(error)}`);
    return [];
  }
}

export function bufferSize(): number {
  return getQueue().length;
}

export function clearBuffer(): void {
  const queue = getQueue();
  queue.length = 0;
}

function maxSize(): number {
  try {
    return configuration().bufferSize;
  } catch {
    return 10_000;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
