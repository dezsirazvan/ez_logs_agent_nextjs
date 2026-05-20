-- @ezlogs/nextjs — Postgres trigger-based change-data-capture install.
--
-- Run once per database. Idempotent: safe to re-run after upgrades.
-- After this, attach the trigger to specific tables with:
--
--   SELECT ezlogs_track('users');
--   SELECT ezlogs_track('orders');
--
-- The agent then reads ezlogs_audit_log per request and ships full
-- OLD/NEW diffs to the EZLogs server, so every UPDATE/DELETE event
-- in the dashboard carries real before/after values regardless of
-- which client wrote the row (Drizzle, Supabase, Prisma, raw SQL).
--
-- Customers using PgBouncer in transaction-mode pooling (Supabase,
-- Neon, Vercel Postgres): set ezlogs.actor_id / ezlogs.correlation_id
-- with `SET LOCAL` inside an explicit transaction. The agent's
-- `withDatabaseContext` helper does this automatically.

-- ---------------------------------------------------------------------
-- 1. Audit log table — single JSONB-keyed table for all audited tables.
--    Avoids per-table schema sprawl (Supabase audit-log pattern).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ezlogs_audit_log (
  id              bigserial   PRIMARY KEY,
  table_name      text        NOT NULL,
  op              text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  -- old_row is NULL on INSERT; new_row is NULL on DELETE.
  old_row         jsonb,
  new_row         jsonb,
  -- Stringified resource id for fast lookup. Falls back to NULL when
  -- the row has no `id` column (composite PKs, junction tables).
  resource_id     text,
  -- App-supplied context. NULL when the customer's request handler
  -- didn't set them via SET LOCAL — the trigger still fires.
  actor_id        text,
  correlation_id  text,
  -- Postgres transaction id — groups multiple statements from one
  -- application-level operation.
  txid            bigint      NOT NULL DEFAULT txid_current(),
  -- clock_timestamp() (real wall time), not transaction_timestamp(),
  -- so rows in the same transaction sort in execution order.
  captured_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Hot-path index: agent reader scans WHERE correlation_id = $current.
-- Partial index keeps it small — most rows have correlation_id set.
CREATE INDEX IF NOT EXISTS ezlogs_audit_log_correlation_idx
  ON ezlogs_audit_log (correlation_id, captured_at)
  WHERE correlation_id IS NOT NULL;

-- Secondary index for cleanup / retention queries
-- (DELETE FROM ezlogs_audit_log WHERE captured_at < now() - interval '7 days').
CREATE INDEX IF NOT EXISTS ezlogs_audit_log_captured_at_idx
  ON ezlogs_audit_log (captured_at);

-- ---------------------------------------------------------------------
-- 2. Generic trigger function — one function audits every table.
--    No per-table code generation; we introspect via TG_TABLE_NAME and
--    to_jsonb(NEW)/to_jsonb(OLD) at trigger-fire time.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ezlogs_audit_trigger() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER  -- run as the function owner so triggers fire even
                    -- when the caller has narrow privileges
  -- Pin search_path so the function works under any caller context.
  -- Supabase's PostgREST runs requests with `search_path = ''` for
  -- security; without this clause, the unqualified `ezlogs_audit_log`
  -- below would fail with "relation does not exist" and BLOCK the
  -- customer's mutation. The agent must never break the host app.
  -- pg_temp is appended last to keep the recommended Supabase
  -- security-definer pattern.
  SET search_path = public, pg_temp
AS $$
DECLARE
  resource_id_value text;
  pk_column_name    text;
BEGIN
  -- The PK column name is passed as a per-trigger argument by
  -- ezlogs_track(). Defaults to 'id' when missing (older installs)
  -- or empty (composite-PK tables — those legitimately have no
  -- single resource id). Per-table hooked at attach time, not
  -- looked up here, so this is a constant-time read.
  pk_column_name := COALESCE(NULLIF(TG_ARGV[0], ''), 'id');

  -- Prefer NEW's PK value when present (INSERT/UPDATE), fall back to
  -- OLD's (DELETE). `to_jsonb(NEW)->>X` returns NULL when X doesn't
  -- exist or is itself NULL — both are fine for our use.
  resource_id_value := COALESCE(
    (to_jsonb(NEW)->>pk_column_name),
    (to_jsonb(OLD)->>pk_column_name)
  );

  -- Schema-qualified for double-safety. With search_path pinned above
  -- the unqualified form would also work, but explicit-public removes
  -- one whole class of "unexpected schema in path" failures.
  INSERT INTO public.ezlogs_audit_log (
    table_name, op,
    old_row, new_row,
    resource_id,
    actor_id, correlation_id
  ) VALUES (
    TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    resource_id_value,
    -- `current_setting(_, true)` returns NULL when the GUC is unset
    -- (the second arg = missing_ok). Without `true`, an unsignaled
    -- request would raise and roll back the user's mutation — we
    -- never want that.
    --
    -- NULLIF(_, '') normalizes empty strings to NULL. Postgres caches
    -- references to a custom GUC in a session — once any function in
    -- the session has read it, subsequent reads return '' (not NULL)
    -- when the GUC is unset on the next request. The agent reader
    -- treats both as "no actor" — coercing here means downstream
    -- (TS code, dashboard) only has to check one shape.
    NULLIF(current_setting('ezlogs.actor_id',     true), ''),
    NULLIF(current_setting('ezlogs.correlation_id', true), '')
  );

  -- AFTER triggers ignore the return value, but plpgsql requires one.
  -- COALESCE handles INSERT (NEW), UPDATE (NEW), DELETE (OLD).
  RETURN COALESCE(NEW, OLD);
EXCEPTION
  -- HARD CONTRACT: the agent's audit logic must NEVER break the
  -- customer's mutation. If anything in this trigger raises (audit
  -- log dropped, permissions revoked, disk full, schema drift, etc.)
  -- we swallow it, raise a WARNING for the DBA, and let the user's
  -- INSERT/UPDATE/DELETE proceed. Losing audit data is recoverable;
  -- breaking the customer's app is not.
  WHEN others THEN
    RAISE WARNING '[ezlogs] audit trigger on % failed (continuing): %',
      TG_TABLE_NAME, SQLERRM;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------
-- 3. ezlogs_track() — attach the trigger to a named table.
--    Idempotent: drops + recreates so re-running is safe.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ezlogs_track(target_table text) RETURNS void
  LANGUAGE plpgsql
  -- Same search_path pin as the trigger function — keeps the helper
  -- working under any caller context (Supabase / PostgREST / locked
  -- down search_path).
  SET search_path = public, pg_temp
AS $$
DECLARE
  pk_column_name text;
BEGIN
  -- Detect the table's single-column primary key so the trigger can
  -- populate `resource_id` correctly regardless of how the customer
  -- named their PK column. Tables whose PK isn't `id` are a normal
  -- pattern: foreign-keyed children, single-table-inheritance, slug
  -- and uuid columns named to match their domain meaning.
  --
  -- We look up the column in the PK constraint via pg_index +
  -- pg_attribute. For composite PKs we leave `pk_column_name` NULL —
  -- there's no single resource id, and `resource_id` stays empty
  -- (which is the correct outcome — those rows aren't a "resource"
  -- in the activity sense; they're a join).
  SELECT a.attname INTO pk_column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid
                       AND a.attnum   = ANY(i.indkey)
   WHERE i.indrelid = format('public.%I', target_table)::regclass
     AND i.indisprimary
     AND array_length(i.indkey, 1) = 1
   LIMIT 1;

  EXECUTE format(
    'DROP TRIGGER IF EXISTS ezlogs_audit ON %I', target_table
  );
  -- Pass the resolved PK column name as a literal trigger argument.
  -- format(%L) quotes safely; NULL → 'null'-like which the trigger's
  -- `COALESCE(NULLIF(TG_ARGV[0], ''), 'id')` falls back from to 'id'.
  EXECUTE format(
    'CREATE TRIGGER ezlogs_audit '
    'AFTER INSERT OR UPDATE OR DELETE ON %I '
    'FOR EACH ROW EXECUTE FUNCTION public.ezlogs_audit_trigger(%L)',
    target_table,
    COALESCE(pk_column_name, '')
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 4. ezlogs_untrack() — detach the trigger from a named table.
--    Useful for retiring audited tables without touching the data.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ezlogs_untrack(target_table text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS ezlogs_audit ON %I', target_table
  );
END;
$$;
