import { describe, expect, it } from "vitest";
import {
  extractGraphqlErrorsFromBody,
  extractOperationNameFromQuery,
  inferOperationTypeFromName,
  inferOperationTypeFromQuery,
  isGraphqlPath,
  parseGraphqlBody,
} from "../../src/http/graphql.js";

describe("isGraphqlPath", () => {
  it.each([
    ["/graphql", true],
    ["/graphql/", true],
    ["/graphql/v1", true],
    ["/api/graphql", false],
    ["/graph", false],
  ])("%s -> %s", (path, expected) => {
    expect(isGraphqlPath(path)).toBe(expected);
  });
});

describe("operation-type inference", () => {
  it("from query string", () => {
    expect(inferOperationTypeFromQuery("query GetUsers { users { id } }")).toBe(
      "query",
    );
    expect(inferOperationTypeFromQuery("mutation CreateUser { ... }")).toBe(
      "mutation",
    );
    expect(inferOperationTypeFromQuery("subscription Heartbeat { ... }")).toBe(
      "subscription",
    );
    expect(inferOperationTypeFromQuery("{ users { id } }")).toBe("query"); // shorthand
    expect(inferOperationTypeFromQuery(null)).toBeNull();
  });

  it("from operation name (prefix conventions)", () => {
    expect(inferOperationTypeFromName("GetUsers")).toBe("query");
    expect(inferOperationTypeFromName("FetchOrder")).toBe("query");
    expect(inferOperationTypeFromName("CreateUser")).toBe("mutation");
    expect(inferOperationTypeFromName("Foo")).toBeNull();
    expect(inferOperationTypeFromName(null)).toBeNull();
  });
});

describe("extractOperationNameFromQuery", () => {
  it("named operations", () => {
    expect(
      extractOperationNameFromQuery("query GetUsers($id: ID!) { ... }"),
    ).toBe("GetUsers");
    expect(extractOperationNameFromQuery("mutation _create { ... }")).toBe(
      "_create",
    );
  });

  it("anonymous + shorthand → null", () => {
    expect(extractOperationNameFromQuery("query { users { id } }")).toBeNull();
    expect(extractOperationNameFromQuery("{ users { id } }")).toBeNull();
  });
});

describe("parseGraphqlBody", () => {
  it("returns metadata for a normal mutation", () => {
    const result = parseGraphqlBody(
      {
        query: "mutation CreateUser($input: CreateUserInput!) { ... }",
        operationName: "CreateUser",
        variables: { input: { email: "alice@example.com", password: "x" } },
      },
      [],
      [],
    );
    expect(result.metadata).not.toBe("skip");
    if (result.metadata === null || result.metadata === "skip") throw new Error("expected metadata");
    expect(result.metadata.graphql_operation).toBe("CreateUser");
    expect(result.metadata.graphql_type).toBe("mutation");
    const vars = result.metadata.graphql_variables as Record<string, unknown>;
    expect(vars).not.toBeNull();
    const input = vars.input as Record<string, unknown>;
    expect(input.password).toBe("[FILTERED]");
  });

  it("returns 'skip' for IntrospectionQuery (default-excluded operation)", () => {
    expect(
      parseGraphqlBody(
        { query: "query IntrospectionQuery { __schema { types { name } } }", operationName: "IntrospectionQuery" },
        ["IntrospectionQuery", "__*"],
        [],
      ).metadata,
    ).toBe("skip");
  });

  it("returns 'skip' for prefix-pattern matches (__schema)", () => {
    expect(
      parseGraphqlBody(
        { query: "query __schema { types { name } }", operationName: "__schema" },
        ["__*"],
        [],
      ).metadata,
    ).toBe("skip");
  });

  it("returns null for non-object body", () => {
    expect(parseGraphqlBody("not an object", [], []).metadata).toBeNull();
    expect(parseGraphqlBody(null, [], []).metadata).toBeNull();
  });

  it("falls back to anonymous when no operation name", () => {
    const result = parseGraphqlBody(
      { query: "{ users { id } }" },
      [],
      [],
    );
    if (result.metadata === null || result.metadata === "skip") throw new Error("expected metadata");
    expect(result.metadata.graphql_operation).toBe("anonymous");
    expect(result.metadata.graphql_type).toBe("query");
  });
});

describe("extractGraphqlErrorsFromBody", () => {
  it("returns null when no errors", () => {
    expect(extractGraphqlErrorsFromBody({ data: { users: [] } })).toBeNull();
    expect(extractGraphqlErrorsFromBody({})).toBeNull();
    expect(extractGraphqlErrorsFromBody(null)).toBeNull();
  });

  it("returns single message verbatim", () => {
    expect(
      extractGraphqlErrorsFromBody({
        errors: [{ message: "Forbidden" }],
        data: null,
      }),
    ).toBe("Forbidden");
  });

  it("joins multiple messages with '; '", () => {
    expect(
      extractGraphqlErrorsFromBody({
        errors: [{ message: "first" }, { message: "second" }],
      }),
    ).toBe("first; second");
  });

  it("ignores non-string error messages", () => {
    expect(
      extractGraphqlErrorsFromBody({
        errors: [{ message: 42 }, { message: "real" }, {}],
      }),
    ).toBe("real");
  });
});
