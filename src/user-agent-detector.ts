/**
 * Detect whether an HTTP request originated from an AI agent client
 * (Claude Desktop, ChatGPT, Cursor, Windsurf, …) by inspecting the
 * User-Agent header.
 *
 * Behavior is intentionally narrow: only the documented vendor
 * prefixes match. Anything else (browsers, curl, mobile apps) returns
 * null — we never *infer* agency from weak signals.
 *
 * Port of `lib/ez_logs_agent/user_agent_detector.rb`. Both agents must
 * stay in lockstep — new vendors get added in BOTH files in the same PR.
 */
import type { ActorKind } from "./configuration.js";

export interface AgentDetection {
  kind: ActorKind & "agent";
  vendor: string;
  label: string;
  suggestedId: string;
}

interface VendorPattern {
  readonly prefix: string;
  readonly vendor: string;
  readonly label: string;
}

const PATTERNS: readonly VendorPattern[] = [
  { prefix: "claude-", vendor: "claude", label: "Claude" },
  { prefix: "anthropic-", vendor: "claude", label: "Claude" },
  { prefix: "gpt-", vendor: "openai", label: "ChatGPT" },
  { prefix: "chatgpt-", vendor: "openai", label: "ChatGPT" },
  { prefix: "openai-", vendor: "openai", label: "ChatGPT" },
  { prefix: "cursor-", vendor: "cursor", label: "Cursor" },
  { prefix: "windsurf-", vendor: "windsurf", label: "Windsurf" },
];

/**
 * Classify a User-Agent string. Returns null when the UA does not
 * match any known LLM-client prefix.
 */
export function classifyUserAgent(userAgent: string | null | undefined): AgentDetection | null {
  if (typeof userAgent !== "string" || userAgent.length === 0) return null;

  const ua = userAgent.toLowerCase();
  const match = PATTERNS.find((p) => ua.startsWith(p.prefix));
  if (!match) return null;

  return {
    kind: "agent",
    vendor: match.vendor,
    label: match.label,
    suggestedId: `agent:${match.vendor}`,
  };
}
