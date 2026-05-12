import { describe, expect, it } from "vitest";
import { ArgError, build, type BuildInput } from "../../src/event-builder.js";

const FIXED_TIMESTAMP = "2026-01-15T12:00:00.000Z";

function baseHttpInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    source_type: "http_request",
    source_data: { method: "GET", path: "/x" },
    outcome: "success",
    timestamp: FIXED_TIMESTAMP,
    ...overrides,
  };
}

describe("EventBuilder.build — required fields", () => {
  it("rejects missing source_type", () => {
    expect(() =>
      build({ ...baseHttpInput(), source_type: undefined as unknown as string }),
    ).toThrow(ArgError);
  });

  it("rejects unknown source_type", () => {
    expect(() => build({ ...baseHttpInput(), source_type: "telemetry" })).toThrow(
      /source_type must be one of/,
    );
  });

  it("rejects missing source_data", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        source_data: undefined as unknown as Record<string, unknown>,
      }),
    ).toThrow(/source_data is required/);
  });

  it("rejects non-object source_data", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        source_data: "x" as unknown as Record<string, unknown>,
      }),
    ).toThrow(/source_data must be an object/);
  });

  it("rejects unknown outcome", () => {
    expect(() => build({ ...baseHttpInput(), outcome: "maybe" })).toThrow(
      /outcome must be one of/,
    );
  });
});

describe("EventBuilder.build — outcome/error_message consistency", () => {
  it("rejects success with error_message", () => {
    expect(() =>
      build({ ...baseHttpInput(), outcome: "success", error_message: "boom" }),
    ).toThrow(/error_message must be null when outcome is 'success'/);
  });

  it("rejects failure without error_message", () => {
    expect(() => build({ ...baseHttpInput(), outcome: "failure" })).toThrow(
      /error_message is required when outcome is 'failure'/,
    );
  });

  it("rejects failure with empty error_message", () => {
    expect(() =>
      build({ ...baseHttpInput(), outcome: "failure", error_message: "" }),
    ).toThrow(/error_message is required when outcome is 'failure'/);
  });

  it("accepts failure with non-empty error_message", () => {
    const event = build({
      ...baseHttpInput(),
      outcome: "failure",
      error_message: "HTTP 500",
    });
    expect(event.outcome).toBe("failure");
    expect(event.error_message).toBe("HTTP 500");
  });
});

describe("EventBuilder.build — timestamp", () => {
  it("defaults to now() when null", () => {
    const before = Date.now();
    const event = build({ ...baseHttpInput(), timestamp: null });
    const after = Date.now();
    const ts = new Date(event.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    // Format: ISO with millisecond precision and Z suffix
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("preserves a string timestamp verbatim (parity with Ruby)", () => {
    const event = build({ ...baseHttpInput(), timestamp: FIXED_TIMESTAMP });
    expect(event.timestamp).toBe(FIXED_TIMESTAMP);
  });

  it("normalizes a Date timestamp via toISOString()", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    const event = build({ ...baseHttpInput(), timestamp: date });
    expect(event.timestamp).toBe("2026-01-15T12:00:00.000Z");
  });

  it("rejects an invalid timestamp string", () => {
    expect(() =>
      build({ ...baseHttpInput(), timestamp: "not-a-date" }),
    ).toThrow(/timestamp must be valid ISO 8601/);
  });
});

describe("EventBuilder.build — resource_ids", () => {
  it("accepts an empty array", () => {
    const event = build({ ...baseHttpInput(), resource_ids: [] });
    expect(event.resource_ids).toEqual([]);
  });

  it("rejects non-array resource_ids", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        resource_ids: "x" as unknown as never,
      }),
    ).toThrow(/resource_ids must be an array/);
  });

  it("rejects entries missing required keys", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        resource_ids: [{ resource_type: "User" } as never],
      }),
    ).toThrow(/must have resource_type and resource_id/);
  });

  it("rejects non-string resource_type", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        resource_ids: [
          { resource_type: 1 as unknown as string, resource_id: "1" },
        ],
      }),
    ).toThrow(/resource_type must be a string/);
  });

  it("rejects non-string resource_id", () => {
    expect(() =>
      build({
        ...baseHttpInput(),
        resource_ids: [
          { resource_type: "User", resource_id: 1 as unknown as string },
        ],
      }),
    ).toThrow(/resource_id must be a string/);
  });
});

describe("EventBuilder.build — duration_ms", () => {
  it("accepts null", () => {
    expect(build({ ...baseHttpInput(), duration_ms: null }).duration_ms).toBeNull();
  });

  it("rejects negatives", () => {
    expect(() => build({ ...baseHttpInput(), duration_ms: -1 })).toThrow(
      /duration_ms must be >= 0/,
    );
  });

  it("rejects floats", () => {
    expect(() => build({ ...baseHttpInput(), duration_ms: 1.5 })).toThrow(
      /must be an integer/,
    );
  });
});

describe("EventBuilder.build — sensitive-key sanitization", () => {
  it("filters top-level sensitive keys in source_data", () => {
    const event = build({
      ...baseHttpInput(),
      source_data: {
        method: "POST",
        path: "/auth",
        password: "hunter2",
        api_key: "sk_live_xxx",
      },
    });
    expect(event.source_data.password).toBe("[FILTERED]");
    expect(event.source_data.api_key).toBe("[FILTERED]");
    expect(event.source_data.method).toBe("POST");
  });

  it("filters nested sensitive keys recursively", () => {
    const event = build({
      ...baseHttpInput(),
      source_data: {
        request_params: {
          user: { password: "hunter2", email: "x@y" },
        },
      },
    });
    const params = event.source_data.request_params as Record<string, unknown>;
    const user = params.user as Record<string, unknown>;
    expect(user.password).toBe("[FILTERED]");
    expect(user.email).toBe("x@y");
  });

  it("filters sensitive keys inside arrays of plain objects (when the array key itself isn't sensitive)", () => {
    // `auth_codes` doesn't contain any SENSITIVE_KEYS pattern, so we
    // recurse into each element. Inside each element, `secret` matches
    // the substring `secret`.
    const event = build({
      ...baseHttpInput(),
      source_data: {
        auth_codes: [
          { name: "ci", secret: "x" },
          { name: "prod", secret: "y" },
        ],
      },
    });
    const arr = event.source_data.auth_codes as Array<Record<string, unknown>>;
    expect(arr[0]?.secret).toBe("[FILTERED]");
    expect(arr[1]?.secret).toBe("[FILTERED]");
    expect(arr[0]?.name).toBe("ci");
  });

  it("filters the whole array when its key matches a sensitive substring (parity with Ruby)", () => {
    // `tokens` contains the substring `token` → entire value (the array)
    // is replaced with "[FILTERED]". This matches Ruby's behavior: the
    // sensitive-key check fires before recursion.
    const event = build({
      ...baseHttpInput(),
      source_data: {
        tokens: [
          { name: "ci", secret: "x" },
          { name: "prod", secret: "y" },
        ],
      },
    });
    expect(event.source_data.tokens).toBe("[FILTERED]");
  });

  it("matches snake_case sensitive keys case-insensitively (substring)", () => {
    const event = build({
      ...baseHttpInput(),
      source_data: { user_token: "abc", USER_TOKEN: "def" },
    });
    expect(event.source_data.user_token).toBe("[FILTERED]");
    expect(event.source_data.USER_TOKEN).toBe("[FILTERED]");
  });

  it("does NOT match camelCase keys when the SENSITIVE_KEYS entry is snake_case (parity gap, see AGENT_PARITY_NOTES.md)", () => {
    // SENSITIVE_KEYS includes `credit_card` and `api_key`. After
    // lowercasing, `creditcard` and `apikey` do NOT contain those
    // underscored substrings, so they pass through. The Ruby agent
    // behaves identically — verified via the parity fixture. Fixing
    // this would diverge from Ruby and break wire compatibility.
    const event = build({
      ...baseHttpInput(),
      source_data: { CreditCard: "4242", apiKey: "sk_live_x" },
    });
    expect(event.source_data.CreditCard).toBe("4242");
    expect(event.source_data.apiKey).toBe("sk_live_x");
  });

  it("sanitizes context the same way as source_data", () => {
    const event = build({
      ...baseHttpInput(),
      context: { actor: { id: "1", api_key: "secret" } },
    });
    const actor = (event.context as Record<string, unknown>).actor as Record<
      string,
      unknown
    >;
    expect(actor.api_key).toBe("[FILTERED]");
    expect(actor.id).toBe("1");
  });
});

describe("EventBuilder.build — wire-format key ordering", () => {
  it("emits all 9 top-level keys in the documented order", () => {
    const event = build({
      ...baseHttpInput(),
      correlation_id: "ezl_1737000000000_deadbeef",
      duration_ms: 100,
    });
    expect(Object.keys(event)).toEqual([
      "timestamp",
      "source_type",
      "source_data",
      "outcome",
      "correlation_id",
      "resource_ids",
      "context",
      "duration_ms",
      "error_message",
    ]);
  });

  it("retains explicit nulls for unset optional fields (not undefined)", () => {
    const event = build(baseHttpInput());
    expect(event.correlation_id).toBeNull();
    expect(event.context).toBeNull();
    expect(event.duration_ms).toBeNull();
    expect(event.error_message).toBeNull();
  });
});
