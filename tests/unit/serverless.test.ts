import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetServerlessCacheForTests,
  _setServerlessOverrideForTests,
  isServerless,
} from "../../src/pipeline/serverless.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetServerlessCacheForTests();
  delete process.env.VERCEL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.NETLIFY;
  delete process.env.CF_PAGES;
});

afterEach(() => {
  _resetServerlessCacheForTests();
  process.env = { ...originalEnv };
});

describe("isServerless", () => {
  it("returns false when no signal env is set", () => {
    expect(isServerless()).toBe(false);
  });

  it("returns true when VERCEL=1", () => {
    process.env.VERCEL = "1";
    expect(isServerless()).toBe(true);
  });

  it("returns true when AWS_LAMBDA_FUNCTION_NAME is non-empty", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-handler";
    expect(isServerless()).toBe(true);
  });

  it("ignores AWS_LAMBDA_FUNCTION_NAME when empty", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "";
    expect(isServerless()).toBe(false);
  });

  it("returns true when NETLIFY=true", () => {
    process.env.NETLIFY = "true";
    expect(isServerless()).toBe(true);
  });

  it("returns true when CF_PAGES=1", () => {
    process.env.CF_PAGES = "1";
    expect(isServerless()).toBe(true);
  });

  it("caches the result after first call", () => {
    expect(isServerless()).toBe(false);
    process.env.VERCEL = "1";
    expect(isServerless()).toBe(false); // cached
    _resetServerlessCacheForTests();
    expect(isServerless()).toBe(true);
  });

  it("test-only override beats env detection", () => {
    process.env.VERCEL = "1";
    _setServerlessOverrideForTests(false);
    expect(isServerless()).toBe(false);
    _setServerlessOverrideForTests(true);
    expect(isServerless()).toBe(true);
    _setServerlessOverrideForTests(null);
    expect(isServerless()).toBe(true);
  });
});
