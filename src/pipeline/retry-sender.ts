/**
 * RetrySender — port of retry_sender.rb with one documented deviation.
 *
 * Wraps Transport.send() with exponential backoff:
 *   delay_seconds = 0.5 * 2^(attempt - 1), capped at 5
 *   attempts: configuration.retryAttempts + 1 (initial + retries)
 *
 * DEVIATION FROM RUBY: Node adds ±20% jitter to each delay. Reason —
 * serverless deployments share a moment-of-impact across many lambda
 * instances; without jitter every replica retries at the same exact ms,
 * thundering-herd into the recovering server. The base schedule is
 * unchanged. See AGENT_PARITY_NOTES.md.
 *
 * Tests can disable jitter via `setJitterForTests(false)` so the
 * scheduling parity test compares clean numbers.
 */

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import { transport, type TransportResult } from "./transport.js";
import type { Event } from "../event-builder.js";

const MAX_SLEEP_MS = 5_000;
const BASE_DELAY_MS = 500;
const JITTER_FRACTION = 0.2;

let jitterEnabled = true;
let randomFn: () => number = Math.random;

export const retrySender = {
  async send(events: Event[]): Promise<TransportResult> {
    if (!events || events.length === 0) return "success";

    const maxAttempts = retryAttempts() + 1; // initial + retries
    let attempt = 1;

    while (attempt <= maxAttempts) {
      const result = await attemptSend(events, attempt, maxAttempts);
      if (result === "success") return "success";

      if (attempt >= maxAttempts) break;

      await sleepBeforeRetry(attempt);
      attempt += 1;
    }

    logger.error(
      `RetrySender: failed after ${maxAttempts} attempts, dropping ${events.length} events`,
    );
    return "failure";
  },
};

async function attemptSend(
  events: Event[],
  attempt: number,
  maxAttempts: number,
): Promise<TransportResult> {
  try {
    return await transport.send(events);
  } catch (error) {
    logger.error(
      `RetrySender: transport raised (attempt ${attempt}/${maxAttempts}): ${describeError(error)}`,
    );
    return "failure";
  }
}

function sleepBeforeRetry(attempt: number): Promise<void> {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_SLEEP_MS);
  const delay = jitterEnabled ? applyJitter(base) : base;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function applyJitter(base: number): number {
  // ±20% — uniform random in [base*(1-JF), base*(1+JF)]
  const span = base * JITTER_FRACTION;
  return base - span + randomFn() * 2 * span;
}

function retryAttempts(): number {
  try {
    const value = configuration().retryAttempts;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return 3;
    }
    return value;
  } catch {
    return 3;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Test-only. Not exported from the package entry. */
export function setJitterForTests(enabled: boolean): void {
  jitterEnabled = enabled;
}

/** Test-only. Not exported from the package entry. */
export function setRandomForTests(fn: () => number): void {
  randomFn = fn;
}

/** Test-only. Reset to defaults. */
export function resetRetrySenderForTests(): void {
  jitterEnabled = true;
  randomFn = Math.random;
}

/** Exposed for tests that want to assert the unjittered schedule. */
export function backoffScheduleMsForTests(retries: number): number[] {
  const out: number[] = [];
  for (let attempt = 1; attempt <= retries; attempt++) {
    out.push(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_SLEEP_MS));
  }
  return out;
}

/**
 * Test-only. Mirrors the exact branch sleepBeforeRetry takes — jitter
 * pass-through when disabled, randomized when enabled.
 */
export function applyJitterForTests(base: number): number {
  return jitterEnabled ? applyJitter(base) : base;
}
