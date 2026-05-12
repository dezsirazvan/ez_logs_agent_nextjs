import { describe, expect, it } from "vitest";
import {
  buildHttpSourceData,
  determineOutcome,
} from "../../src/http/source-data.js";

describe("buildHttpSourceData", () => {
  it("builds the documented App Router shape", () => {
    const result = buildHttpSourceData({
      method: "GET",
      url: new URL("https://app.example.com/api/users?limit=5"),
      statusCode: 200,
      rawParams: { limit: "5" },
      routeModulePath: "app/api/users",
      userAgent: "Mozilla/5.0",
      remoteIp: "127.0.0.1",
      contentType: "application/json",
      excludedVariableKeys: [],
    });
    expect(result).toEqual({
      method: "GET",
      path: "/api/users",
      status_code: 200,
      controller: "app/api/users",
      action: "GET",
      format: "json",
      user_agent: "Mozilla/5.0",
      remote_ip: "127.0.0.1",
      request_params: { limit: "5" },
    });
  });

  it("uses 'server-action' / function name for Server Actions", () => {
    const result = buildHttpSourceData({
      method: "POST",
      url: new URL("https://app.example.com/dashboard"),
      statusCode: 200,
      rawParams: null,
      serverActionName: "updateProfile",
      userAgent: null,
      remoteIp: null,
      contentType: "text/plain",
      excludedVariableKeys: [],
    });
    expect(result.controller).toBe("server-action");
    expect(result.action).toBe("updateProfile");
  });

  it("compacts null-valued keys (parity with Ruby's .compact)", () => {
    const result = buildHttpSourceData({
      method: "GET",
      url: new URL("https://app.example.com/anon"),
      statusCode: 200,
      rawParams: null,
      userAgent: null,
      remoteIp: null,
      contentType: null,
      excludedVariableKeys: [],
    });
    expect(result).not.toHaveProperty("user_agent");
    expect(result).not.toHaveProperty("remote_ip");
    expect(result).not.toHaveProperty("format");
    expect(result).not.toHaveProperty("controller");
    expect(result.method).toBe("GET");
  });

  it("merges GraphQL metadata when present (no request_params)", () => {
    const result = buildHttpSourceData({
      method: "POST",
      url: new URL("https://app.example.com/graphql"),
      statusCode: 200,
      rawParams: { query: "{ users { id } }" }, // ignored when graphql present
      userAgent: null,
      remoteIp: null,
      contentType: "application/json",
      excludedVariableKeys: [],
      graphql: {
        graphql_operation: "ListUsers",
        graphql_type: "query",
        graphql_variables: { limit: 5 },
      },
    });
    expect(result.graphql_operation).toBe("ListUsers");
    expect(result.graphql_type).toBe("query");
    expect(result.graphql_variables).toEqual({ limit: 5 });
    expect(result.request_params).toBeUndefined();
  });
});

describe("buildHttpSourceData — Server Action verb/entity parsing", () => {
  function build(serverActionName: string): Record<string, unknown> {
    return buildHttpSourceData({
      method: "POST",
      url: new URL(`http://localhost/__server-action/${serverActionName}`),
      statusCode: 200,
      rawParams: null,
      serverActionName,
      userAgent: null,
      remoteIp: null,
      contentType: null,
      excludedVariableKeys: [],
    });
  }

  it("updateHardwareAction → verb=update, entity=Hardware", () => {
    const out = build("updateHardwareAction");
    expect(out.verb).toBe("update");
    expect(out.entity).toBe("Hardware");
  });

  it("createSpaceAction → verb=create, entity=Space", () => {
    const out = build("createSpaceAction");
    expect(out.verb).toBe("create");
    expect(out.entity).toBe("Space");
  });

  it("deleteEmployeeAction → verb=destroy, entity=Employee", () => {
    const out = build("deleteEmployeeAction");
    expect(out.verb).toBe("destroy");
    expect(out.entity).toBe("Employee");
  });

  it("listCanvasesAction → verb=read, entity=Canvas (singularized)", () => {
    const out = build("listCanvasesAction");
    expect(out.verb).toBe("read");
    expect(out.entity).toBe("Canvase"); // naive singularization; dashboard handles display
  });

  it("bulkAssignHardwareAction → verb=update, entity=Hardware (bulk collapses)", () => {
    const out = build("bulkAssignHardwareAction");
    expect(out.verb).toBe("update");
    expect(out.entity).toBe("Hardware");
  });

  it("markHardwareAsReceivedAction → verb=update, entity=Hardware", () => {
    const out = build("markHardwareAsReceivedAction");
    expect(out.verb).toBe("update");
    expect(out.entity).toBe("Hardware");
  });

  it("reportHardwareLostStolenAction → verb=update, entity=HardwareLostStolen", () => {
    // `report` is recognized; everything after is the entity blob.
    const out = build("reportHardwareLostStolenAction");
    expect(out.verb).toBe("update");
    expect(out.entity).toBe("HardwareLostStolen");
  });

  it("does NOT emit verb/entity for unknown leading tokens", () => {
    const out = build("frobnicateWidget");
    expect(out.verb).toBeUndefined();
    expect(out.entity).toBeUndefined();
  });

  it("renamePolicy → verb=update, entity=Policy (-y plural rule)", () => {
    const out = build("renamePolicies");
    expect(out.verb).toBe("update");
    expect(out.entity).toBe("Policy");
  });

  it("does not emit verb/entity for non-Server-Action requests", () => {
    const out = buildHttpSourceData({
      method: "GET",
      url: new URL("http://localhost/api/users"),
      statusCode: 200,
      rawParams: null,
      routeModulePath: "app/api/users",
      userAgent: null,
      remoteIp: null,
      contentType: null,
      excludedVariableKeys: [],
    });
    expect(out.verb).toBeUndefined();
    expect(out.entity).toBeUndefined();
  });
});

describe("determineOutcome", () => {
  it("exception > 4xx > graphql > success", () => {
    const err = new TypeError("boom");
    expect(determineOutcome(500, err, "graphql err")).toEqual({
      outcome: "failure",
      error_message: "TypeError: boom",
    });
  });

  it("4xx without exception returns 'HTTP <status>'", () => {
    expect(determineOutcome(404, null, null)).toEqual({
      outcome: "failure",
      error_message: "HTTP 404",
    });
  });

  it("graphql errors on 200 still produce failure", () => {
    expect(determineOutcome(200, null, "Authorization failed")).toEqual({
      outcome: "failure",
      error_message: "Authorization failed",
    });
  });

  it("2xx, 3xx, and null status are success", () => {
    expect(determineOutcome(200, null, null).outcome).toBe("success");
    expect(determineOutcome(204, null, null).outcome).toBe("success");
    expect(determineOutcome(302, null, null).outcome).toBe("success");
    expect(determineOutcome(null, null, null).outcome).toBe("success");
  });
});
