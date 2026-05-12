// ezlogs-nextjs/triggers — public API for the trigger-based capture path.
//
// Phase 5 introduces row-trigger-based change-data-capture as the
// primary DB capture path. The per-ORM adapters (`./drizzle`,
// `./prisma`, `./supabase`) remain shipped as fallbacks for
// environments where customers can't run the migration (PlanetScale,
// some managed pools, custom auth schemes).
//
// Three pieces ship from this subpath:
//
//   `runInstall` / `parseArgs`      — programmatic entry to the install
//                                     command. The bin shim
//                                     `./bin/install.cjs` wraps it
//                                     with a `pg`-backed exec.
//   `withDatabaseContext`           — helper that sets
//                                     ezlogs.actor_id /
//                                     ezlogs.correlation_id GUCs on
//                                     a transaction so the trigger
//                                     captures the request scope.
//   `wrapDatabaseReader`            — agent reader that scans
//                                     ezlogs_audit_log per request
//                                     and emits database_callback
//                                     events through the existing
//                                     pipeline.
//
// All four pieces ship now. The HTTP capturers call `flushAuditLog`
// at the end of each request when `databaseReader` is configured.

export { runInstall, parseArgs, detectEngine, buildTrackingSql } from "./install.js";
export type { Detected } from "./install.js";

export {
  applyDatabaseContext,
  withDatabaseContext,
  getDatabaseContext,
} from "./context.js";
export type {
  SqlExecutor,
  PgLikeClient,
  DatabaseContextSnapshot,
} from "./context.js";

export {
  readAuditRows,
  emitAuditRows,
  flushAuditLog,
  takeAuditSnapshot,
  detectTriggerTrackedTables,
} from "./reader.js";
export type { AuditRow } from "./reader.js";

export {
  runWithAuditSnapshotScope,
  currentAuditSnapshot,
} from "./audit-snapshot.js";

export { patchPgClient } from "./patch-pg.js";
