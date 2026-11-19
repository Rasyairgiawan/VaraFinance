-- VaraFinance: Migration 0006 (Final Revision — Table & Default Privilege Hardening)
--
-- Scope:
--   1. Validates existence of all 33 expected tables in schema `public` (fails fast if missing).
--   2. Revokes all table privileges from PUBLIC, anon, and authenticated on all 33 tables,
--      removing default-granted TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, etc.
--   3. Re-grants ONLY minimal privileges to `authenticated`:
--        - SELECT, INSERT, UPDATE, DELETE on 31 CRUD tables
--        - SELECT, INSERT ONLY (append-only) on `change_logs` and `financial_mode_logs`
--   4. Revokes default table privileges for future tables created by `postgres` in `public`
--      from PUBLIC, anon, and authenticated (`REVOKE ALL ON TABLES` covers SELECT, INSERT,
--      UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN on PostgreSQL 17+).
--
-- Non-goals / Untouched:
--   - Does NOT touch `postgres`, `service_role`, `supabase_admin`, or internal Supabase roles.
--   - Does NOT touch schemas other than `public` or global default privileges.
--   - Does NOT touch sequences, functions, schemas, types, RLS, policies, FKs, triggers, or data.
--   - Safe and idempotent to re-run.

DO $$
DECLARE
  tbl TEXT;
  missing_tables TEXT[] := '{}'::TEXT[];
  crud_tables TEXT[] := ARRAY[
    'profiles',
    'accounts',
    'categories',
    'freelance_projects',
    'transactions',
    'transfers',
    'project_payments',
    'project_expenses',
    'debts',
    'debt_payments',
    'debt_write_off_entries',
    'split_bills',
    'split_bill_participants',
    'custodial_funds',
    'custodial_fund_allocations',
    'custodial_return_entries',
    'project_advances',
    'project_advance_allocations',
    'project_advance_recognitions',
    'project_advance_refunds',
    'physical_assets',
    'asset_disposals',
    'physical_item_loans',
    'asset_loss_records',
    'asset_recovery_records',
    'asset_condition_logs',
    'recurring_obligations',
    'obligation_logs',
    'savings_goals',
    'goal_contributions',
    'no_spend_confirmations'
  ];
  append_only_tables TEXT[] := ARRAY[
    'change_logs',
    'financial_mode_logs'
  ];
BEGIN
  -- 1. Validate that all 33 expected public tables exist before altering privileges.
  FOREACH tbl IN ARRAY (crud_tables || append_only_tables) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = tbl
        AND c.relkind = 'r'
    ) THEN
      missing_tables := array_append(missing_tables, tbl);
    END IF;
  END LOOP;

  IF COALESCE(array_length(missing_tables, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Migration 0006 aborted: expected table(s) missing in schema public: %',
      array_to_string(missing_tables, ', ');
  END IF;

  -- 2. Harden privileges on the 31 CRUD tables.
  FOREACH tbl IN ARRAY crud_tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;

  -- 3. Harden privileges on the 2 append-only audit log tables.
  FOREACH tbl IN ARRAY append_only_tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;

-- 4. Revoke default table privileges for future tables owned by `postgres` in `public`
--    from PUBLIC, anon, and authenticated without affecting `supabase_admin`, other schemas,
--    global defaults, or non-table object types.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
