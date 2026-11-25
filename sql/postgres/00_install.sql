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

-- One-time upgrade from 0.1.x: those agents never deleted rows, so the
-- table holds history they already sent. Emptying it stops the new
-- agent's sweep from re-sending that history (and makes the index
-- builds below instant). The explicit table comment set further down
-- marks a 0.2+ table, so a re-run never truncates live rows.
DO $$
BEGIN
  IF to_regclass('public.ezlogs_audit_log') IS NOT NULL
     AND COALESCE(obj_description(to_regclass('public.ezlogs_audit_log'), 'pg_class'), '')
         NOT LIKE 'ezlogs:0.2%' THEN
    TRUNCATE public.ezlogs_audit_log;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ezlogs_audit_log (
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

COMMENT ON TABLE public.ezlogs_audit_log IS
  'ezlogs:0.2 — EZLogs audit log. Rows are deleted once sent. Do not edit this comment (upgrade marker).';

-- Hot-path index: agent reader scans WHERE correlation_id = $current.
-- Partial index keeps it small — most rows have correlation_id set.
CREATE INDEX IF NOT EXISTS ezlogs_audit_log_correlation_idx
  ON public.ezlogs_audit_log (correlation_id, captured_at)
  WHERE correlation_id IS NOT NULL;

-- Secondary index for the agent's retention sweep (rows older than
-- 5 minutes are drained, rows older than 7 days are deleted).
CREATE INDEX IF NOT EXISTS ezlogs_audit_log_captured_at_idx
  ON public.ezlogs_audit_log (captured_at);

-- Rows with no correlation (writes from outside any captured request,
-- or from a client that couldn't tag them) are drained by the agent
-- as their own actions. This keeps that scan cheap.
CREATE INDEX IF NOT EXISTS ezlogs_audit_log_uncorrelated_idx
  ON public.ezlogs_audit_log (id)
  WHERE correlation_id IS NULL;

-- ---------------------------------------------------------------------
-- 1b. Helpers used by the trigger.
-- ---------------------------------------------------------------------

-- Sensitive column names never reach ezlogs_audit_log. Mirrors the
-- agent's DB_SENSITIVE_PATTERNS (substring) + SENSITIVE_WORD_PATTERNS
-- (whole word) in src/db/shared.ts / src/http/sanitize.ts. camelCase
-- keys are split into words first (`mdmUnlockPin` -> `mdm_unlock_pin`).
-- A parity test keeps the two lists identical.
CREATE OR REPLACE FUNCTION public.ezlogs_is_sensitive_key(k text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT s ~ '(password|token|secret|api_key|credit_card|ssn|social_security|encrypted|private_key|public_key|signing_key|pem|cipher|nonce|salt|digest|signature|hmac|credential|passwd|passcode|apikey|card_number|cardnumber|cvv|cvc|verification_code|recovery_code|backup_code|one_time_code|login_code|jwt|webhook_url|connection_string|database_url|access_key|auth_key|session_key|license_key|encryption_key|ssh_key|master_key|mnemonic|seed_phrase|auth_code|reset_code|invite_code|magic_link)'
      OR lower(k) ~ '(password|token|secret|api_key|credit_card|ssn|social_security|encrypted|private_key|public_key|signing_key|pem|cipher|nonce|salt|digest|signature|hmac|credential|passwd|passcode|apikey|card_number|cardnumber|cvv|cvc|verification_code|recovery_code|backup_code|one_time_code|login_code|jwt|webhook_url|connection_string|database_url|access_key|auth_key|session_key|license_key|encryption_key|ssh_key|master_key|mnemonic|seed_phrase|auth_code|reset_code|invite_code|magic_link)'
      OR s ~ '(^|[^a-z0-9])(pin|otp|totp|iban|mfa|passphrase|jti|dsn)([^a-z0-9]|$)'
    FROM (SELECT lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g')) AS s) AS words
$$;

-- Version of the pattern lists above. BUMP IT whenever they change:
-- triggers attached under another version ignore their precomputed
-- column list (per-key check instead) and are re-attached by the next
-- `install-triggers` run.
CREATE OR REPLACE FUNCTION public.ezlogs_patterns_version() RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$ SELECT 'p3' $$;

CREATE OR REPLACE FUNCTION public.ezlogs_strip_sensitive(r jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN r IS NULL THEN NULL ELSE COALESCE(
    (SELECT jsonb_object_agg(key, value)
       FROM jsonb_each(r)
      WHERE NOT public.ezlogs_is_sensitive_key(key)),
    '{}'::jsonb) END
$$;

-- Correlation id for the current statement:
--   1. `ezlogs.correlation_id` GUC — set by the agent's patched `pg`
--      client / withDatabaseContext (direct connections).
--   2. PostgREST's `request.headers` GUC — supabase-js requests carry
--      the agent's `x-correlation-id` header (injected into every
--      outgoing fetch made inside a captured request). Only the
--      agent's own id format is accepted, so arbitrary client headers
--      can't land rows in an unrelated action.
-- Returns NULL when neither is present: the agent then reports the
-- row as its own action instead of guessing which request made it.
CREATE OR REPLACE FUNCTION public.ezlogs_request_correlation_id() RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  cid  text;
  raw  text;
  hdrs jsonb;
BEGIN
  -- NULLIF: once a session has read a custom GUC, unset reads return ''.
  cid := NULLIF(current_setting('ezlogs.correlation_id', true), '');
  IF cid IS NOT NULL THEN
    RETURN cid;
  END IF;
  raw := NULLIF(current_setting('request.headers', true), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    hdrs := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  cid := COALESCE(hdrs->>'x-ezlogs-correlation-id', hdrs->>'x-correlation-id');
  IF cid ~ '^ezl_[0-9]{1,16}_[0-9a-f]{8}$' THEN
    RETURN cid;
  END IF;
  RETURN NULL;
END;
$$;

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
  old_raw           jsonb;
  new_raw           jsonb;
  old_json          jsonb;
  new_json          jsonb;
BEGIN
  -- The PK column name is passed as a per-trigger argument by
  -- ezlogs_track(). Defaults to 'id' when missing (older installs)
  -- or empty (composite-PK tables — those legitimately have no
  -- single resource id). Per-table hooked at attach time, not
  -- looked up here, so this is a constant-time read.
  pk_column_name := COALESCE(NULLIF(TG_ARGV[0], ''), 'id');

  -- Serialize each row once; everything below reads these.
  IF TG_OP <> 'INSERT' THEN
    old_raw := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_raw := to_jsonb(NEW);
  END IF;

  -- Sensitive columns are dropped HERE, so they are never stored in
  -- ezlogs_audit_log (not only filtered later by the agent).
  -- Fast path: ezlogs_track() precomputed the table's sensitive column
  -- names (TG_ARGV[1]), its full column-name set in jsonb key order
  -- (TG_ARGV[2]) and the pattern version (TG_ARGV[3]); removing a fixed
  -- key list costs a few µs. If the column NAMES changed since then
  -- (add / drop / rename), the patterns changed, or the trigger predates
  -- 0.2.0, fall back to checking every key by name (~60µs per row image).
  IF TG_NARGS >= 4
     AND TG_ARGV[3] = public.ezlogs_patterns_version()
     AND ARRAY(SELECT jsonb_object_keys(COALESCE(new_raw, old_raw))) = TG_ARGV[2]::text[] THEN
    old_json := old_raw - TG_ARGV[1]::text[];
    new_json := new_raw - TG_ARGV[1]::text[];
  ELSE
    old_json := public.ezlogs_strip_sensitive(old_raw);
    new_json := public.ezlogs_strip_sensitive(new_raw);
  END IF;

  -- Prefer NEW's PK value when present (INSERT/UPDATE), fall back to
  -- OLD's (DELETE). Read from the STRIPPED rows, so a PK named like a
  -- secret (a `token` table keyed by the token) yields NULL, not the
  -- secret. `->>X` returns NULL when X doesn't exist or is NULL.
  resource_id_value := COALESCE(new_json->>pk_column_name, old_json->>pk_column_name);
  -- Nothing visible changed (only sensitive columns, or a no-op
  -- UPDATE): skip the row.
  IF TG_OP = 'UPDATE' AND old_json = new_json THEN
    RETURN NEW;
  END IF;

  -- Schema-qualified for double-safety. With search_path pinned above
  -- the unqualified form would also work, but explicit-public removes
  -- one whole class of "unexpected schema in path" failures.
  INSERT INTO public.ezlogs_audit_log (
    table_name, op,
    old_row, new_row,
    resource_id,
    actor_id, correlation_id
  ) VALUES (
    -- The tracked table's name (TG_ARGV[4]), so a partition's rows
    -- show under their parent; triggers attached before 0.4.5 have
    -- no 5th argument.
    COALESCE(NULLIF(TG_ARGV[4], ''), TG_TABLE_NAME), TG_OP,
    old_json,
    new_json,
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
    public.ezlogs_request_correlation_id()
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
--    Idempotent: a table whose trigger already has the current arguments
--    (PK, column names, pattern version) is left alone, so re-running
--    install-triggers takes no table lock on it (DROP TRIGGER needs
--    ACCESS EXCLUSIVE). The trigger calls the function by name, so
--    CREATE OR REPLACE above already upgrades its behavior; an outdated
--    attachment (pre-0.2.0, schema change, new patterns) is re-created,
--    restoring the fast sensitive-column path.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ezlogs_track(target_table text) RETURNS void
  LANGUAGE plpgsql
  -- Same search_path pin as the trigger function — keeps the helper
  -- working under any caller context (Supabase / PostgREST / locked
  -- down search_path).
  SET search_path = public, pg_temp
AS $$
DECLARE
  pk_column_name    text;
  sensitive_columns text[];
  all_columns       text[];
  trigger_args      text;
BEGIN
  -- A partition carries the trigger cloned from its parent (which records
  -- rows under the parent's name); that clone can't be replaced here.
  IF EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = format('public.%I', target_table)::regclass AND c.relispartition
  ) THEN
    RETURN;
  END IF;

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

  -- Precompute for the trigger's fast path (see ezlogs_audit_trigger):
  -- the sensitive column names, and every column name in jsonb key
  -- order (what `to_jsonb(row)` keys come out as).
  SELECT COALESCE(array_agg(a.attname::text)
                    FILTER (WHERE public.ezlogs_is_sensitive_key(a.attname)), '{}'),
         ARRAY(SELECT jsonb_object_keys(jsonb_object_agg(a.attname, NULL::int)))
    INTO sensitive_columns, all_columns
    FROM pg_attribute a
   WHERE a.attrelid = format('public.%I', target_table)::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped;

  -- The 5th argument is the table's own name. Postgres clones a
  -- partitioned table's trigger, arguments included, onto every
  -- partition, where TG_TABLE_NAME is the partition
  -- (`events_2026_11`); the argument keeps the parent's name.
  trigger_args := format(
    '%L, %L, %L, %L, %L',
    COALESCE(pk_column_name, ''),
    sensitive_columns::text,
    all_columns::text,
    public.ezlogs_patterns_version(),
    target_table
  );

  -- Already attached with exactly these arguments (same PK, columns and
  -- pattern version): leave it alone — no DROP TRIGGER, no table lock.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'ezlogs_audit'
       AND t.tgrelid = format('public.%I', target_table)::regclass
       AND position('ezlogs_audit_trigger(' || trigger_args || ')' IN pg_get_triggerdef(t.oid)) > 0
  ) THEN
    RETURN;
  END IF;

  EXECUTE format(
    'DROP TRIGGER IF EXISTS ezlogs_audit ON %I', target_table
  );
  -- format(%L) quotes every argument safely. An empty PK argument makes
  -- the trigger's `COALESCE(NULLIF(TG_ARGV[0], ''), 'id')` fall back to 'id'.
  EXECUTE format(
    'CREATE TRIGGER ezlogs_audit '
    'AFTER INSERT OR UPDATE OR DELETE ON %I '
    'FOR EACH ROW EXECUTE FUNCTION public.ezlogs_audit_trigger(%s)',
    target_table,
    trigger_args
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

-- ---------------------------------------------------------------------
-- 5. Lock the audit log down.
--    It holds row data from every tracked table. On Supabase the
--    `public` schema is exposed through PostgREST and `anon` /
--    `authenticated` get default grants on new tables, so without this
--    anyone with the anon key could read, forge or delete rows.
--
--    - RLS on, no policies: every non-owner role sees nothing. The
--      table owner (the role that ran this install — the agent's
--      reader normally connects as it) and the SECURITY DEFINER trigger
--      (runs as the function owner = same role) bypass RLS.
--    - Explicit revokes for PUBLIC and the Supabase API roles, on the
--      table, its sequence, ezlogs_track/untrack, and the trigger
--      function itself (EXECUTE is checked when a trigger is CREATED,
--      not when it fires: already-tracked tables keep auditing, but no
--      other role can attach it to its own table and forge rows).
--    A reader connecting as a DIFFERENT role needs:
--      GRANT SELECT, DELETE ON ezlogs_audit_log TO <role>;
--      CREATE POLICY ezlogs_reader ON ezlogs_audit_log TO <role>
--        USING (true);
-- ---------------------------------------------------------------------

-- Skip when already on: ALTER TABLE takes an ACCESS EXCLUSIVE lock.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ezlogs_audit_log'::regclass) THEN
    ALTER TABLE public.ezlogs_audit_log ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
DECLARE
  seq  text := pg_get_serial_sequence('public.ezlogs_audit_log', 'id');
  role text;
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.ezlogs_audit_log FROM PUBLIC';
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', seq);
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.ezlogs_track(text), public.ezlogs_untrack(text), public.ezlogs_audit_trigger() FROM PUBLIC';
  FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.ezlogs_audit_log FROM %I', role);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', seq, role);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.ezlogs_track(text), public.ezlogs_untrack(text), public.ezlogs_audit_trigger() FROM %I',
        role
      );
    END IF;
  END LOOP;
END $$;
