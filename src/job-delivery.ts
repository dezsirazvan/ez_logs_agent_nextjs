// A request that only delivers a background job.
//
// Job runners that call the app over HTTP (Upstash Workflow / QStash,
// Inngest) deliver each step or function run as a POST to a route.
// The job capture records that delivery as a background_job event; an
// HTTP event for the same POST would be a second, actor-less card for
// one piece of work. Route capture opens a delivery slot per request,
// the job capture marks it, and route capture then sends no HTTP event
// (the request's DB rows are still flushed).

import { createScopedStorage } from "./edge-fallback.js";

export interface DeliverySlot {
  jobDelivery: boolean;
}

const storage = createScopedStorage<DeliverySlot>(Symbol.for("ezlogs-nextjs:job-delivery"));

/** Runs a captured request with its own delivery slot. */
export function runWithDeliverySlot<R>(slot: DeliverySlot, callback: () => R): R {
  return storage.run(slot, callback);
}

/** Marks the current captured request as a job delivery. No-op outside one. */
export function markJobDelivery(): void {
  const slot = storage.read();
  if (slot) slot.jobDelivery = true;
}
