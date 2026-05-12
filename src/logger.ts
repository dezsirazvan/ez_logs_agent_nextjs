/**
 * Internal logger for the agent.
 *
 * Mirrors EzLogsAgent::Logger: prefixed messages, `:warn` default level,
 * never throws. The host app must never see an exception from logging.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

// The agent gets duplicated across Next's app-ssr / app-rsc / edge
// layers — each layer evaluates index.js separately, so a
// module-local `let currentLevel` ends up with one copy per layer.
// `setLogLevel("debug")` from `instrumentation.ts` runs in the node
// layer; the per-Server-Action `logger.debug(...)` runs in app-rsc.
// Without globalThis-pinning, the latter sees the default "warn" and
// silently swallows everything. Same fix we use for correlation
// storage and the global config singleton.
const LEVEL_KEY = Symbol.for("ezlogs-nextjs:log-level");

interface GlobalWithLogLevel {
  [LEVEL_KEY]?: LogLevel;
}

function readLevel(): LogLevel {
  const g = globalThis as unknown as GlobalWithLogLevel;
  return g[LEVEL_KEY] ?? "warn";
}

export function setLogLevel(level: LogLevel): void {
  (globalThis as unknown as GlobalWithLogLevel)[LEVEL_KEY] = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[readLevel()];
}

function safeWrite(level: LogLevel, message: string): void {
  try {
    if (!shouldLog(level)) return;
    const line = `[ezlogs] ${message}`;
    if (level === "error" || level === "warn") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  } catch {
    // logging must never crash
  }
}

export const logger = {
  debug: (message: string) => safeWrite("debug", message),
  info: (message: string) => safeWrite("info", message),
  warn: (message: string) => safeWrite("warn", message),
  error: (message: string) => safeWrite("error", message),
};
