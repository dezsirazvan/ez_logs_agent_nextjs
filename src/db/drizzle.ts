// Drizzle DB capture.
//
// Drizzle's only public hook is its Logger interface — every executed
// query goes through `logger.logQuery(sql, params)`. We get the
// parameterized SQL string but NOT the row state. So this adapter:
//
//   - Sniffs the SQL to extract operation (INSERT/UPDATE/DELETE) and
//     table name. Reads (SELECT, WITH ... SELECT) are skipped.
//   - Emits a database_callback event with source_data
//     { model_class: <table>, operation: <create|update|destroy> }.
//   - Does NOT populate context.changes or context.initial_attributes
//     in v0.1 — Drizzle gives us no row identity or column values
//     without parsing the whole SQL. Documented as a known gap in
//     AGENT_PARITY_NOTES.md; users who want full DB context use
//     Prisma or supabase-js.
//
// Usage:
//
//   import { drizzle } from "drizzle-orm/postgres-js"
//   import { ezlogsDrizzleLogger } from "ezlogs-nextjs/drizzle"
//
//   const db = drizzle(client, { logger: ezlogsDrizzleLogger() })
//
// Or compose with the user's existing logger:
//
//   const db = drizzle(client, {
//     logger: ezlogsDrizzleLogger({ next: myLogger }),
//   })

import { logger } from "../logger.js";
import { emitDbEvent, type DbOperation } from "./shared.js";

interface DrizzleLogger {
  logQuery(query: string, params: unknown[]): void;
}

interface Options {
  /** Chain to a user's existing logger after capture. */
  next?: DrizzleLogger;
}

export function ezlogsDrizzleLogger(options: Options = {}): DrizzleLogger {
  return {
    logQuery(query: string, params: unknown[]): void {
      try {
        const parsed = parseMutation(query);
        if (parsed) {
          // Phase 4: try to extract resource_id from a simple
          // `WHERE id = $N` shape. Only fires when the WHERE clause
          // contains exactly that single equality and nothing else;
          // bails to null on any uncertainty.
          const resourceId =
            parsed.operation === "create"
              ? null
              : extractResourceIdFromSimpleWhere(query, params);

          // For UPDATEs, parse the SET clause so the dashboard shows
          // what the user wrote. Drizzle's logger gives no before-state
          // so we ship `to` only — no `from`. Better than rendering
          // "No tracked changes" on every Drizzle UPDATE.
          const changes =
            parsed.operation === "update"
              ? extractSetChangesFromUpdate(query, params)
              : null;

          emitDbEvent({
            modelClass: parsed.table,
            operation: parsed.operation,
            resourceId,
            changes,
          });
        }
      } catch (error) {
        logger.debug(`drizzle capture failed: ${describeError(error)}`);
      } finally {
        if (options.next) {
          try {
            options.next.logQuery(query, params);
          } catch {
            // never break the chain
          }
        }
      }
    },
  };
}

/**
 * Extract a resource id from a simple `WHERE id = $N` (Postgres) or
 * `WHERE id = ?` (MySQL / SQLite) clause. Returns null on any
 * uncertainty — the parser is intentionally narrow.
 *
 * Accepted shapes (case-insensitive, optional double-quotes around `id`):
 *
 *   UPDATE "t" SET ... WHERE id = $1
 *   DELETE FROM "t" WHERE "id" = $2
 *   UPDATE t SET ... WHERE id = ?
 *
 * Rejected (return null) — Phase 4 leaves these for later:
 *
 *   WHERE id = $1 AND user_id = $2     (paranoid filter; ambiguous which placeholder to use)
 *   WHERE asset_id = $1                (non-`id` column; unique-per-row signal we don't have)
 *   WHERE id IN ($1, $2)               (multi-row)
 *   WHERE upper(id) = $1               (function call; can't index back to params)
 *   anything with `OR`, parens, sub-queries
 */
export function extractResourceIdFromSimpleWhere(
  query: string,
  params: unknown[],
): string | number | null {
  // Find the first `WHERE` keyword (whole-word, case-insensitive).
  const whereMatch = query.match(/\bWHERE\b/i);
  if (!whereMatch || whereMatch.index === undefined) return null;

  // Look only at what follows WHERE, up to the next clause keyword
  // (RETURNING / ORDER BY / LIMIT / OFFSET) or end-of-string. Drizzle
  // doesn't generate trailing semicolons, but tolerate them anyway.
  const afterWhere = query
    .slice(whereMatch.index + 5)
    .replace(/;\s*$/, "");
  const clause = afterWhere
    .split(/\b(?:RETURNING|ORDER\s+BY|LIMIT|OFFSET|GROUP\s+BY|HAVING)\b/i)[0]
    ?.trim();
  if (!clause) return null;

  // Reject anything with a connective or grouping construct. We could
  // try to handle `AND user_id = $2` later, but for Phase 4 it's
  // explicitly out of scope.
  if (/\b(?:AND|OR|NOT|IN|BETWEEN|LIKE|IS)\b/i.test(clause)) return null;
  if (/[()]/.test(clause)) return null;

  // Match the exact `<id-column> = <placeholder>` shape. Accepted column forms:
  //   id                        — bare identifier
  //   "id" / `id` / [id]        — quoted (Postgres / MySQL / SQL Server)
  //   "users"."id"              — table-qualified (Drizzle's default —
  //                               eq(table.col, x) renders this shape)
  //   schema.users.id           — fully qualified (rare, but cheap to allow)
  //
  // The qualifier itself may be quoted with double quotes / backticks /
  // square brackets, with optional whitespace around the dots. We don't
  // verify the qualifier matches the mutated table — Drizzle won't
  // construct a WHERE referencing a different table without a JOIN
  // (which `(` would already have rejected above).
  //
  // Placeholder is Postgres `$N` or generic `?`.
  const idColumn =
    `(?:` +
    // Optionally a 1-2-segment qualifier: `<table>.` or `<schema>.<table>.`
    `(?:(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*){0,2}` +
    // Then the literal `id` column (quoted or bare).
    `(?:"id"|\`id\`|\\[id\\]|id)` +
    `)`;
  const eq = clause.match(
    new RegExp(`^\\s*${idColumn}\\s*=\\s*(\\$(\\d+)|\\?)\\s*$`, "i"),
  );
  if (!eq) return null;

  // Postgres `$N` indexes 1-based into params.
  if (eq[2] !== undefined) {
    const idx = Number(eq[2]) - 1;
    if (idx < 0 || idx >= params.length) return null;
    return coerceResourceId(params[idx]);
  }

  // MySQL / SQLite `?` — count `?` placeholders BEFORE the WHERE clause
  // to find which positional param the WHERE binds to. This matches
  // Drizzle's mysql / sqlite dialects.
  const before = query.slice(0, whereMatch.index);
  const positionInQuery = countQuestionMarks(before);
  if (positionInQuery >= params.length) return null;
  return coerceResourceId(params[positionInQuery]);
}

function coerceResourceId(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

/**
 * Extract `{column: newValue, ...}` from an UPDATE's `SET` clause.
 *
 * Drizzle's logger gives us `(query, params)` only — there's no
 * before-state. But the SET clause itself encodes what's being
 * written, with parameter placeholders pointing into `params`. So
 * we can at least surface the new values; without this, every
 * Drizzle UPDATE renders "No tracked changes" in the dashboard.
 *
 * Accepted shapes (case-insensitive):
 *
 *   UPDATE "t" SET "name" = $1
 *   UPDATE t SET name = $1, email = $2 WHERE id = $3
 *   update "users" set "name" = $1, "email" = $2 where ...
 *
 * Rejected — return null:
 *
 *   SET expressions involving function calls (`now()`, `upper(...)`)
 *   SET expressions referencing other columns (`count = count + 1`)
 *   SET CASE WHEN ... THEN ...
 *   Any sub-query in the SET
 *
 * Drizzle's typed builders only generate the simple `col = $N` shape
 * for `.set({col: val})`. The rejected shapes appear when users drop
 * to raw SQL via `sql\`\`` template tags, which we (correctly) leave
 * as "no changes captured" rather than guess.
 */
export function extractSetChangesFromUpdate(
  query: string,
  params: unknown[],
): { attribute: string; to: unknown }[] | null {
  const setMatch = query.match(/\bSET\b/i);
  if (!setMatch || setMatch.index === undefined) return null;

  // Stop at WHERE / RETURNING / FROM / clause boundaries.
  const afterSet = query.slice(setMatch.index + 3);
  const stopMatch = afterSet.match(
    /\b(WHERE|RETURNING|FROM|ORDER\s+BY|LIMIT|OFFSET|GROUP\s+BY|HAVING|;)\b/i,
  );
  const setClause = stopMatch
    ? afterSet.slice(0, stopMatch.index).trim()
    : afterSet.trim();
  if (!setClause) return null;

  // Reject anything that looks like a function call, sub-query, or
  // self-referential column expression. Drizzle's typed builder does
  // not produce these; they'd come from `sql\`...\``.
  if (/[()]/.test(setClause)) return null;
  // Reject CASE WHEN / etc. Same reasoning.
  if (/\bCASE\b|\bWHEN\b|\bSELECT\b/i.test(setClause)) return null;

  const out: { attribute: string; to: unknown }[] = [];

  // Walk the comma-separated assignments. We split on `,` outside
  // quoted identifiers / string literals — Drizzle generates clean
  // input but a customer using sql`` could insert weird payloads.
  const assignments = splitTopLevelCommas(setClause);
  for (const piece of assignments) {
    const eq = piece.match(
      // Same column form as the WHERE-clause matcher: bare, quoted,
      // or table-qualified. Placeholder is $N or ?.
      /^\s*(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)*("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(\$(\d+)|\?)\s*$/i,
    );
    if (!eq) return null;
    const column = eq[2] ?? eq[3] ?? eq[4] ?? eq[5];
    if (!column) return null;

    const placeholderIsDollar = eq[7] !== undefined;
    let value: unknown;
    if (placeholderIsDollar) {
      const idx = Number(eq[7]) - 1;
      if (idx < 0 || idx >= params.length) return null;
      value = params[idx];
    } else {
      // For `?` we need to count question marks BEFORE this slot.
      // Drizzle MySQL/SQLite assigns positional params left-to-right
      // through the whole query, including the SET clause.
      // The slot for THIS `?` is: count of `?` chars in `query` before
      // the matched piece's offset within the query.
      const pieceOffsetInQuery = setMatch.index + 3 + setClause.indexOf(piece);
      const before = query.slice(0, pieceOffsetInQuery + piece.indexOf("?"));
      const slot = countQuestionMarks(before);
      if (slot >= params.length) return null;
      value = params[slot];
    }

    out.push({ attribute: column, to: value });
  }

  return out.length === 0 ? null : out;
}

// Split a string on top-level commas — i.e. commas that aren't inside
// quoted identifiers (`"foo, bar"`) or string literals ('foo, bar').
// Used by extractSetChangesFromUpdate to walk assignments.
function splitTopLevelCommas(input: string): string[] {
  const result: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBracket = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (!inDouble && !inBacktick && !inBracket && c === "'") {
      if (inSingle && input[i + 1] === "'") {
        buf += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
    } else if (!inSingle && !inBacktick && !inBracket && c === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && !inBracket && c === "`") {
      inBacktick = !inBacktick;
    } else if (!inSingle && !inDouble && !inBacktick && c === "[") {
      inBracket = true;
    } else if (inBracket && c === "]") {
      inBracket = false;
    } else if (
      !inSingle &&
      !inDouble &&
      !inBacktick &&
      !inBracket &&
      c === ","
    ) {
      result.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) result.push(buf);
  return result;
}

// Count question marks that are real parameter placeholders — i.e.
// not inside a string literal or comment. Drizzle generates clean
// SQL so the simple case dominates; we still protect against `'?'`
// inside a string.
function countQuestionMarks(input: string): number {
  let count = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < input.length) {
    const c = input[i];
    if (!inDouble && c === "'") {
      // Handle SQL escape: `''` inside a string is a literal `'`
      if (inSingle && input[i + 1] === "'") {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
    } else if (!inSingle && c === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && c === "?") {
      count += 1;
    }
    i += 1;
  }
  return count;
}

interface ParsedMutation {
  operation: DbOperation;
  table: string;
}

// Sniff the first SQL keyword + table name. Tolerant to leading
// whitespace, comments, schema-qualified names, quoted identifiers.
// Doesn't try to be a SQL parser — just picks up the obvious shapes
// Drizzle generates.
export function parseMutation(query: string): ParsedMutation | null {
  if (!query) return null;
  const stripped = stripLeading(query);
  const upper = stripped.slice(0, 64).toUpperCase();

  if (upper.startsWith("INSERT INTO")) {
    return makeParsed(stripped, "insert into".length, "create");
  }
  if (upper.startsWith("UPDATE")) {
    return makeParsed(stripped, "update".length, "update");
  }
  if (upper.startsWith("DELETE FROM")) {
    return makeParsed(stripped, "delete from".length, "destroy");
  }
  return null;
}

function makeParsed(
  stripped: string,
  consumeLen: number,
  operation: DbOperation,
): ParsedMutation | null {
  const remainder = stripped.slice(consumeLen).trimStart();
  const table = parseIdentifier(remainder);
  if (!table) return null;
  return { operation, table };
}

// Strip leading whitespace, single-line comments (-- foo) and
// block comments (/* ... */) before sniffing the operation.
function stripLeading(query: string): string {
  let i = 0;
  while (i < query.length) {
    const c = query.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i++;
      continue;
    }
    if (query.startsWith("--", i)) {
      const eol = query.indexOf("\n", i);
      i = eol === -1 ? query.length : eol + 1;
      continue;
    }
    if (query.startsWith("/*", i)) {
      const end = query.indexOf("*/", i + 2);
      i = end === -1 ? query.length : end + 2;
      continue;
    }
    break;
  }
  return query.slice(i);
}

// Read the first identifier (optionally schema-qualified, quoted with
// double quotes / backticks / square brackets). Returns the
// last component (table name) without the quoting characters.
function parseIdentifier(input: string): string | null {
  if (!input) return null;
  const m = input.match(
    /^("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))?/,
  );
  if (!m) return null;
  const last = m[2] ?? m[1] ?? "";
  return unquote(last);
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if (first === '"' && last === '"') return token.slice(1, -1);
    if (first === "`" && last === "`") return token.slice(1, -1);
    if (first === "[" && last === "]") return token.slice(1, -1);
  }
  return token;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
