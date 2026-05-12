// Serverless flush mode.
//
// Vercel functions and AWS Lambda freeze the JS process between
// requests. The setInterval flush scheduler can't run during freeze,
// so any events it hasn't shipped get dropped on cold starts. Same
// problem with `process.on("beforeExit")` — Lambda doesn't fire it.
//
// Solution: detect serverless at init, and have the HTTP capture
// flush synchronously after each handler resolves. The periodic
// scheduler still runs (in case multiple requests share a warm
// process), but it's no longer the only safety net.
//
// Detection is conservative — we only treat known runtimes as
// serverless. Everything else uses the long-lived-process model.

let cachedFlag: boolean | null = null;
let override: boolean | null = null;

/**
 * Returns true when the agent is running in a serverless runtime.
 * Cached after first call so subsequent reads are free.
 *
 * Detection signals (any one is sufficient):
 *   - process.env.VERCEL === "1"        — Vercel functions
 *   - process.env.AWS_LAMBDA_FUNCTION_NAME — AWS Lambda
 *   - process.env.NETLIFY === "true"    — Netlify Functions
 *   - process.env.CF_PAGES === "1"      — Cloudflare Pages
 */
export function isServerless(): boolean {
  if (override !== null) return override;
  if (cachedFlag !== null) return cachedFlag;
  cachedFlag = detect();
  return cachedFlag;
}

function detect(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  const env = process.env;
  if (env.VERCEL === "1") return true;
  if (typeof env.AWS_LAMBDA_FUNCTION_NAME === "string" && env.AWS_LAMBDA_FUNCTION_NAME) {
    return true;
  }
  if (env.NETLIFY === "true") return true;
  if (env.CF_PAGES === "1") return true;
  return false;
}

/** Test-only. Force the serverless detection result. */
export function _setServerlessOverrideForTests(value: boolean | null): void {
  override = value;
  cachedFlag = null;
}

/** Test-only. Clear the cached detection so the next read re-evaluates. */
export function _resetServerlessCacheForTests(): void {
  cachedFlag = null;
  override = null;
}
