// `.env` loading for the install-triggers CLI, the way `next dev` /
// `next build` load it, so `DATABASE_URL` in `.env` / `.env.local`
// is found without exporting it first.
//
// Uses the app's own `@next/env` when it resolves (exact Next.js
// behavior); otherwise dotenv's line grammar + dotenv-expand style
// `${VAR}` expansion over the same files in the same precedence.
// Never overrides a variable that is already set.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Load env files from `dir` into `env`. Returns the file names loaded. */
export function loadEnvFiles(dir: string, env: Env = process.env): string[] {
  const dev = env.NODE_ENV !== "production";
  try {
    const nextEnv = createRequire(join(dir, "package.json"))("@next/env") as {
      loadEnvConfig: (
        dir: string,
        dev?: boolean,
        log?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
      ) => { loadedEnvFiles?: Array<{ path: string }> };
    };
    // @next/env writes to process.env; only use it when that is the target.
    if (env === process.env) {
      const { loadedEnvFiles = [] } = nextEnv.loadEnvConfig(dir, dev, {
        info: () => {},
        error: () => {},
      });
      return loadedEnvFiles.map((f) => f.path);
    }
  } catch {
    // no @next/env in this project: fall through to the parser
  }

  const mode = env.NODE_ENV === "test" ? "test" : dev ? "development" : "production";
  // Highest precedence first; Next skips `.env.local` in test mode.
  const files = [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"];
  const loaded: string[] = [];
  const parsed: Record<string, ParsedValue> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const [key, value] of Object.entries(parseEnvEntries(text))) {
      if (!(key in parsed)) parsed[key] = value;
    }
  }
  // Expand like dotenv-expand (what @next/env runs): `$VAR` / `${VAR}` /
  // `${VAR:-default}`, set variables first, then other loaded ones.
  const resolving = new Set<string>();
  const resolve = (key: string): string | undefined => {
    if (env[key] !== undefined) return env[key];
    const entry = parsed[key];
    if (!entry || resolving.has(key)) return undefined;
    resolving.add(key);
    const value = entry.expand ? expand(entry.value, resolve) : entry.value;
    resolving.delete(key);
    return value;
  };
  for (const key of Object.keys(parsed)) {
    if (env[key] === undefined) env[key] = resolve(key);
  }
  return loaded;
}

interface ParsedValue {
  value: string;
  /** False for single-quoted values (dotenv-expand leaves them literal). */
  expand: boolean;
}

function expand(value: string, lookup: (key: string) => string | undefined): string {
  return value.replace(
    /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, fallback?: string, bare?: string) => {
      if (match === "\\$") return "$";
      const found = lookup((braced ?? bare)!);
      return found !== undefined && found !== "" ? found : (fallback ?? "");
    },
  );
}

// dotenv's own line grammar: `KEY=value`, optional `export `, quoted
// values may span lines, a trailing `# comment` is dropped outside quotes.
const LINE =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

function parseEnvEntries(text: string): Record<string, ParsedValue> {
  const out: Record<string, ParsedValue> = {};
  const src = text.replace(/\r\n?/g, "\n");
  for (const match of src.matchAll(LINE)) {
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    const quoted = (quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote) && value.length > 1;
    if (quoted) value = value.slice(1, -1);
    if (quote === '"' && quoted) value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    out[match[1]!] = { value, expand: !(quoted && quote === "'") };
  }
  return out;
}

/** `KEY=value` pairs as written (no expansion); see `parseEnvEntries`. */
export function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnvEntries(text)).map(([k, v]) => [k, v.value]));
}
