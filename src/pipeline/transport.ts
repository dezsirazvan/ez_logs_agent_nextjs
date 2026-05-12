/**
 * Transport — port of transport.rb.
 *
 * Single HTTP POST. No retries (RetrySender owns that), no buffer
 * interaction, never raises to caller. Returns "success" or "failure".
 *
 * Body: { events: Event[] }. Header: Authorization: Bearer <token>.
 * Endpoint: POST <serverUrl>/api/events. Connect/read timeout enforced
 * via AbortController (10s — matches Ruby's read_timeout).
 */

import { configuration } from "../configuration.js";
import { logger } from "../logger.js";
import type { Event } from "../event-builder.js";

export type TransportResult = "success" | "failure";

const REQUEST_TIMEOUT_MS = 10_000;

export const transport = {
  async send(events: Event[]): Promise<TransportResult> {
    if (!events || events.length === 0) return "success";

    const config = configuration();
    const serverUrl = config.serverUrl;
    if (!serverUrl) {
      logger.error("Transport: serverUrl not configured");
      return "failure";
    }

    const url = `${stripTrailingSlash(serverUrl)}/api/events`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.projectToken) {
        headers["Authorization"] = `Bearer ${config.projectToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (response.status >= 200 && response.status < 300) {
        logger.debug(`Transport send succeeded (${response.status})`);
        return "success";
      }
      logger.error(`Transport send failed (${response.status})`);
      return "failure";
    } catch (error) {
      const desc = describeError(error);
      logger.error(`Transport send failed: ${desc}`);
      return "failure";
    } finally {
      clearTimeout(timer);
    }
  },
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timed out";
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
