-- VaraFinance: Migration 0005 (Phase 2.3B Step 1)
-- Complete Phase 2.1 - 2.6 PostgreSQL Schema, Accounting Integrity Constraints,
-- Cross-Tenant Composite Foreign Keys, and Granular Row Level Security (RLS).
--
-- IMPORTANT:
-- 1. Jalankan setelah 0001_initial_schema.sql .. 0004_user_profiles_auth_pin.sql.
-- 2. Script ini idempotent untuk schema preparation dan TIDAK mengubah data lokal / localStorage.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;

-- Forward-compatible security hardening for 0004 auth helpers:
-- Ensures legacy resolve_login_email is removed even if 0004 ran earlier.
DROP FUNCTION IF EXISTS public.resolve_login_email(TEXT);

CREATE OR REPLACE FUNCTION public.is_username_available(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_username IS NULL OR pg_catalog.btrim(p_username) !~ '^[A-Za-z0-9._]{3,24}$' THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE pg_catalog.lower(username) = pg_catalog.lower(pg_catalog.btrim(p_username))
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.is_username_available(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_username_available(TEXT) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private_auth;
REVOKE ALL ON SCHEMA private_auth FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private_auth TO service_role;

CREATE OR REPLACE FUNCTION private_auth.get_user_id_by_username(p_username TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id
  FROM public.profiles AS p
  WHERE p_username IS NOT NULL
    AND pg_catalog.btrim(p_username) ~ '^[A-Za-z0-9._]{3,24}$'
    AND pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(p_username))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private_auth.get_user_id_by_username(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private_auth.get_user_id_by_username(TEXT) TO service_role;

-- ============================================================================
-- 1. UPDATE EXISTING TABLES (0001 - 0004) TO COVER PHASE 2.1 - 2.6 & SYNC META
-- ============================================================================

-- 1.1 Profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 3 CHECK (schema_version >= 1),
  ADD COLUMN IF NOT EXISTS username_normalized TEXT GENERATED ALWAYS AS (
    CASE WHEN username IS NULL THEN NULL ELSE pg_catalog.lower(pg_catalog.btrim(username)) END
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_normalized
  ON public.profiles (username_normalized)
  WHERE username_normalized IS NOT NULL;

ALTER TABLE public.profiles
  ALTER COLUMN reminder_settings SET DEFAULT '{"enabled":true,"obligationDaysBefore":3,"debtDueDaysBefore":3,"dailyNoSpendReminder":true,"cigaretteLimitAlert":true,"browserNotificationsEnabled":false,"customReminders":[],"reminderStates":{}}'::jsonb;

-- 1.2 Accounts
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounts'::regclass AND conname = 'accounts_id_user_id_key'
  ) THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_system_key
  ON public.accounts (user_id, system_key)
  WHERE system_key IS NOT NULL AND deleted_at IS NULL;

-- 1.3 Categories
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.categories'::regclass AND conname = 'categories_id_user_id_key'
  ) THEN
    ALTER TABLE public.categories ADD CONSTRAINT categories_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS categories_updated_at ON public.categories;
CREATE TRIGGER categories_updated_at
  BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_system_key
  ON public.categories (user_id, system_key)
  WHERE system_key IS NOT NULL AND deleted_at IS NULL;

-- 1.4 Freelance Projects
ALTER TABLE public.freelance_projects
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.freelance_projects'::regclass AND conname = 'freelance_projects_share_sum_check'
  ) THEN
    ALTER TABLE public.freelance_projects
      ADD CONSTRAINT freelance_projects_share_sum_check CHECK (business_share_pct + personal_share_pct = 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.freelance_projects'::regclass AND conname = 'freelance_projects_id_user_id_key'
  ) THEN
    ALTER TABLE public.freelance_projects ADD CONSTRAINT freelance_projects_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

-- 1.5 Debts & Receivables (expand status & Phase 2.1-2.6 metadata before transactions link)
ALTER TABLE public.debts
  DROP CONSTRAINT IF EXISTS debts_status_check;

ALTER TABLE public.debts
  ADD CONSTRAINT debts_status_check CHECK (status IN ('active', 'paid', 'written_off'));

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS receivable_type TEXT,
  ADD COLUMN IF NOT EXISTS debt_receipt_type TEXT,
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS expense_category_id UUID,
  ADD COLUMN IF NOT EXISTS transaction_id UUID,
  ADD COLUMN IF NOT EXISTS project_id UUID,
  ADD COLUMN IF NOT EXISTS project_payment_id UUID,
  ADD COLUMN IF NOT EXISTS project_expense_id UUID,
  ADD COLUMN IF NOT EXISTS split_bill_id UUID,
  ADD COLUMN IF NOT EXISTS linked_debt_id UUID,
  ADD COLUMN IF NOT EXISTS asset_id UUID,
  ADD COLUMN IF NOT EXISTS physical_loan_id UUID,
  ADD COLUMN IF NOT EXISTS reimbursement_kind TEXT,
  ADD COLUMN IF NOT EXISTS revenue_already_recorded BOOLEAN,
  ADD COLUMN IF NOT EXISTS date DATE,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS written_off_amount BIGINT NOT NULL DEFAULT 0 CHECK (written_off_amount >= 0),
  ADD COLUMN IF NOT EXISTS written_off_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS write_off_reason TEXT,
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.debts'::regclass AND conname = 'debts_receivable_type_check'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_receivable_type_check
      CHECK (
        receivable_type IS NULL OR receivable_type IN (
          'personal_loan', 'project_sales', 'split_bill', 'friend_advance',
          'project_reimbursement', 'asset_sale', 'asset_loss_compensation'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.debts'::regclass AND conname = 'debts_receipt_type_check'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_receipt_type_check
      CHECK (debt_receipt_type IS NULL OR debt_receipt_type IN ('cash_received', 'direct_expense'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.debts'::regclass AND conname = 'debts_reimbursement_kind_check'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_reimbursement_kind_check
      CHECK (reimbursement_kind IS NULL OR reimbursement_kind IN ('pure_advance', 'pass_through'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.debts'::regclass AND conname = 'debts_remaining_lte_initial_check'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_remaining_lte_initial_check
      CHECK (remaining_amount <= initial_amount AND written_off_amount <= initial_amount);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.debts'::regclass AND conname = 'debts_id_user_id_key'
  ) THEN
    ALTER TABLE public.debts ADD CONSTRAINT debts_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_user_system_key
  ON public.debts (user_id, system_key)
  WHERE system_key IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_user_idempotency
  ON public.debts (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 1.6 Transactions (fix income_source enum + add Phase 2.1-2.6 flags & links)
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_income_source_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_income_source_check
  CHECK (
    income_source IS NULL OR income_source IN (
      'daily_allowance', 'freelance', 'salary', 'business', 'passive', 'other'
    )
  );

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS debt_id UUID,
  ADD COLUMN IF NOT EXISTS split_bill_id UUID,
  ADD COLUMN IF NOT EXISTS custodial_fund_id UUID,
  ADD COLUMN IF NOT EXISTS project_advance_id UUID,
  ADD COLUMN IF NOT EXISTS asset_id UUID,
  ADD COLUMN IF NOT EXISTS physical_loan_id UUID,
  ADD COLUMN IF NOT EXISTS ledger_group_id UUID,
  ADD COLUMN IF NOT EXISTS parent_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS transaction_nature TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS affects_account_balance BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS exclude_from_expense_stats BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS exclude_from_income_stats BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND conname = 'transactions_nature_check'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_nature_check
      CHECK (
        transaction_nature IN (
          'standard',
          'loan_disbursement',
          'debt_receipt',
          'debt_direct_expense',
          'debt_repayment',
          'receivable_collection',
          'receivable_write_off',
          'custodial_receipt',
          'custodial_return',
          'project_advance_receipt',
          'project_advance_recognition',
          'project_advance_refund',
          'split_bill_payment',
          'split_bill_personal_share',
          'friend_advance',
          'project_reimbursement_advance',
          'reimbursement_collection',
          'linked_borrow_lend',
          'asset_purchase_cash',
          'asset_purchase_credit',
          'asset_purchase_down_payment',
          'asset_sale_proceeds',
          'reconciliation'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND conname = 'transactions_id_user_id_key'
  ) THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_user_ledger_group
  ON public.transactions (user_id, ledger_group_id)
  WHERE ledger_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_user_parent
  ON public.transactions (user_id, parent_transaction_id)
  WHERE parent_transaction_id IS NOT NULL;

-- 1.7 Transfers
ALTER TABLE public.transfers
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS restricted_movements JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transfers'::regclass AND conname = 'transfers_id_user_id_key'
  ) THEN
    ALTER TABLE public.transfers ADD CONSTRAINT transfers_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS transfers_updated_at ON public.transfers;
CREATE TRIGGER transfers_updated_at
  BEFORE UPDATE ON public.transfers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_user_idempotency
  ON public.transfers (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 1.8 Project Payments
ALTER TABLE public.project_payments
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_payments'::regclass AND conname = 'project_payments_id_user_id_key'
  ) THEN
    ALTER TABLE public.project_payments ADD CONSTRAINT project_payments_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS project_payments_updated_at ON public.project_payments;
CREATE TRIGGER project_payments_updated_at
  BEFORE UPDATE ON public.project_payments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 1.9 Project Expenses
ALTER TABLE public.project_expenses
  ADD COLUMN IF NOT EXISTS expense_kind TEXT NOT NULL DEFAULT 'project_cost',
  ADD COLUMN IF NOT EXISTS linked_receivable_id UUID,
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'project_expenses_kind_check'
  ) THEN
    ALTER TABLE public.project_expenses
      ADD CONSTRAINT project_expenses_kind_check
      CHECK (expense_kind IN ('project_cost', 'pure_advance', 'pass_through'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'project_expenses_id_user_id_key'
  ) THEN
    ALTER TABLE public.project_expenses ADD CONSTRAINT project_expenses_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS project_expenses_updated_at ON public.project_expenses;
CREATE TRIGGER project_expenses_updated_at
  BEFORE UPDATE ON public.project_expenses
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 1.10 Debt Payments
ALTER TABLE public.debt_payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DROP TRIGGER IF EXISTS debt_payments_updated_at ON public.debt_payments;
CREATE TRIGGER debt_payments_updated_at
  BEFORE UPDATE ON public.debt_payments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_payments_user_idempotency
  ON public.debt_payments (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 1.11 Recurring Obligations
ALTER TABLE public.recurring_obligations
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS linked_debt_id UUID,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.recurring_obligations'::regclass AND conname = 'recurring_obligations_id_user_id_key'
  ) THEN
    ALTER TABLE public.recurring_obligations ADD CONSTRAINT recurring_obligations_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_obligations_user_system_key
  ON public.recurring_obligations (user_id, system_key)
  WHERE system_key IS NOT NULL AND deleted_at IS NULL;

-- 1.12 Obligation Logs (fix action enum & amount check)
ALTER TABLE public.obligation_logs
  DROP CONSTRAINT IF EXISTS obligation_logs_action_check,
  DROP CONSTRAINT IF EXISTS obligation_logs_amount_check;

ALTER TABLE public.obligation_logs
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.obligation_logs'::regclass AND conname = 'obligation_logs_action_check'
  ) THEN
    ALTER TABLE public.obligation_logs
      ADD CONSTRAINT obligation_logs_action_check
      CHECK (action IN ('reserve', 'pay', 'reallocate', 'status_change'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.obligation_logs'::regclass AND conname = 'obligation_logs_amount_nonneg_check'
  ) THEN
    ALTER TABLE public.obligation_logs
      ADD CONSTRAINT obligation_logs_amount_nonneg_check
      CHECK (amount >= 0 AND (action NOT IN ('reserve', 'pay') OR amount > 0));
  END IF;
END $$;

DROP TRIGGER IF EXISTS obligation_logs_updated_at ON public.obligation_logs;
CREATE TRIGGER obligation_logs_updated_at
  BEFORE UPDATE ON public.obligation_logs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 1.13 Savings Goals & Goal Contributions
ALTER TABLE public.savings_goals
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.savings_goals'::regclass AND conname = 'savings_goals_id_user_id_key'
  ) THEN
    ALTER TABLE public.savings_goals ADD CONSTRAINT savings_goals_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_goals_user_system_key
  ON public.savings_goals (user_id, system_key)
  WHERE system_key IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE public.goal_contributions
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DROP TRIGGER IF EXISTS goal_contributions_updated_at ON public.goal_contributions;
CREATE TRIGGER goal_contributions_updated_at
  BEFORE UPDATE ON public.goal_contributions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 1.14 No-Spend Confirmations
ALTER TABLE public.no_spend_confirmations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

DROP TRIGGER IF EXISTS no_spend_confirmations_updated_at ON public.no_spend_confirmations;
CREATE TRIGGER no_spend_confirmations_updated_at
  BEFORE UPDATE ON public.no_spend_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- 2. NEW TABLES FOR PHASE 2.4 - 2.6 ENTITIES
-- ============================================================================

-- 2.1 Debt Write-Off / Recovery History (DebtWriteOffEntry[])
CREATE TABLE IF NOT EXISTS public.debt_write_off_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  debt_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('write_off', 'recover')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  revenue_already_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  transaction_id UUID,
  reason TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_write_off_entries_idempotency
  ON public.debt_write_off_entries (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2.2 Split Bills & Participants (Phase 2.5)
CREATE TABLE IF NOT EXISTS public.split_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date DATE NOT NULL,
  category_id UUID NOT NULL,
  account_id UUID NOT NULL,
  total_amount BIGINT NOT NULL CHECK (total_amount > 0),
  user_share_amount BIGINT NOT NULL DEFAULT 0 CHECK (user_share_amount >= 0 AND user_share_amount <= total_amount),
  split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'manual')),
  payment_transaction_id UUID NOT NULL,
  personal_share_transaction_id UUID,
  ledger_group_id UUID NOT NULL,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (id, user_id),
  FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (personal_share_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS split_bills_updated_at ON public.split_bills;
CREATE TRIGGER split_bills_updated_at
  BEFORE UPDATE ON public.split_bills
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_split_bills_user_idempotency
  ON public.split_bills (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.split_bill_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  split_bill_id UUID NOT NULL,
  name TEXT NOT NULL,
  share_amount BIGINT NOT NULL CHECK (share_amount >= 0),
  debt_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (split_bill_id, user_id) REFERENCES public.split_bills(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

-- 2.3 Custodial Funds, Multi-Account Allocations, & Returns (Phase 2.4)
CREATE TABLE IF NOT EXISTS public.custodial_funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  counterparty TEXT NOT NULL,
  description TEXT NOT NULL,
  initial_amount BIGINT NOT NULL CHECK (initial_amount > 0),
  remaining_amount BIGINT NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= initial_amount),
  received_date DATE NOT NULL,
  holding_account_id UUID NOT NULL,
  receipt_transaction_id UUID NOT NULL,
  ledger_group_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'voided')),
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (id, user_id),
  FOREIGN KEY (holding_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS custodial_funds_updated_at ON public.custodial_funds;
CREATE TRIGGER custodial_funds_updated_at
  BEFORE UPDATE ON public.custodial_funds
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_custodial_funds_user_idempotency
  ON public.custodial_funds (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.custodial_fund_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  custodial_fund_id UUID NOT NULL,
  account_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (custodial_fund_id, account_id),
  FOREIGN KEY (custodial_fund_id, user_id) REFERENCES public.custodial_funds(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.custodial_return_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  custodial_fund_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  account_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (custodial_fund_id, user_id) REFERENCES public.custodial_funds(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custodial_return_entries_idempotency
  ON public.custodial_return_entries (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2.4 Deferred Project Advances (DP Proyek), Allocations, Recognitions, & Refunds (Phase 2.4)
CREATE TABLE IF NOT EXISTS public.project_advances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  client_name TEXT NOT NULL,
  description TEXT NOT NULL,
  initial_amount BIGINT NOT NULL CHECK (initial_amount > 0),
  recognized_amount BIGINT NOT NULL DEFAULT 0 CHECK (recognized_amount >= 0),
  refunded_amount BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  remaining_amount BIGINT NOT NULL CHECK (remaining_amount >= 0),
  received_date DATE NOT NULL,
  holding_account_id UUID NOT NULL,
  receipt_transaction_id UUID NOT NULL,
  ledger_group_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'voided')),
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT project_advances_balance_equation_check CHECK (
    is_voided = TRUE OR (recognized_amount + refunded_amount + remaining_amount = initial_amount)
  ),
  UNIQUE (id, user_id),
  FOREIGN KEY (project_id, user_id) REFERENCES public.freelance_projects(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (holding_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS project_advances_updated_at ON public.project_advances;
CREATE TRIGGER project_advances_updated_at
  BEFORE UPDATE ON public.project_advances
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_advances_user_idempotency
  ON public.project_advances (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_advance_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_advance_id UUID NOT NULL,
  account_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (project_advance_id, account_id),
  FOREIGN KEY (project_advance_id, user_id) REFERENCES public.project_advances(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.project_advance_recognitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_advance_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  transaction_id UUID NOT NULL,
  allocation_deltas JSONB,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_advance_id, user_id) REFERENCES public.project_advances(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_advance_recognitions_idempotency
  ON public.project_advance_recognitions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_advance_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_advance_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  account_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_advance_id, user_id) REFERENCES public.project_advances(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_advance_refunds_idempotency
  ON public.project_advance_refunds (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2.5 Physical Assets & Lifecycle Sub-Tables (Phase 2.6)
CREATE TABLE IF NOT EXISTS public.physical_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('electronics', 'vehicle', 'gadget', 'equipment', 'furniture', 'other')),
  acquisition_date DATE NOT NULL,
  acquisition_value BIGINT NOT NULL CHECK (acquisition_value >= 0),
  condition TEXT NOT NULL CHECK (condition IN ('excellent', 'good', 'fair', 'damaged')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lent', 'sold', 'lost', 'voided')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'credit', 'credit_with_down_payment')),
  account_id UUID,
  down_payment_amount BIGINT CHECK (down_payment_amount IS NULL OR (down_payment_amount >= 0 AND down_payment_amount <= acquisition_value)),
  purchase_transaction_id UUID,
  down_payment_transaction_id UUID,
  purchase_debt_id UUID,
  ledger_group_id UUID NOT NULL,
  brand_or_model TEXT,
  serial_number TEXT,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (id, user_id),
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (purchase_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (down_payment_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (purchase_debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS physical_assets_updated_at ON public.physical_assets;
CREATE TRIGGER physical_assets_updated_at
  BEFORE UPDATE ON public.physical_assets
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_physical_assets_user_idempotency
  ON public.physical_assets (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.asset_disposals (
  asset_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  disposal_type TEXT NOT NULL DEFAULT 'sold' CHECK (disposal_type IN ('sold')),
  sold_date DATE NOT NULL,
  sale_price BIGINT NOT NULL CHECK (sale_price >= 0),
  acquisition_value_at_disposal BIGINT NOT NULL CHECK (acquisition_value_at_disposal >= 0),
  gain_or_loss BIGINT NOT NULL,
  proceeds_mode TEXT NOT NULL CHECK (proceeds_mode IN ('cash', 'receivable')),
  buyer_name TEXT,
  sale_account_id UUID,
  sale_transaction_id UUID,
  receivable_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id),
  FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (sale_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (receivable_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

-- 2.6 Physical Item Lending & Borrowing (Phase 2.6)
CREATE TABLE IF NOT EXISTS public.physical_item_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('borrowed', 'lent')),
  asset_id UUID,
  item_name TEXT NOT NULL,
  category TEXT CHECK (category IS NULL OR category IN ('electronics', 'vehicle', 'gadget', 'equipment', 'furniture', 'other')),
  counterparty_name TEXT NOT NULL,
  loan_date DATE NOT NULL,
  expected_return_date DATE,
  returned_date DATE,
  condition_given_or_received TEXT NOT NULL CHECK (condition_given_or_received IN ('excellent', 'good', 'fair', 'damaged')),
  condition_returned TEXT CHECK (condition_returned IS NULL OR condition_returned IN ('excellent', 'good', 'fair', 'damaged')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'lost', 'voided')),
  loss_record_id UUID,
  compensation_debt_id UUID,
  notes TEXT,
  idempotency_key TEXT,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT physical_item_loans_borrowed_no_asset_check CHECK (
    (direction = 'borrowed' AND asset_id IS NULL) OR
    (direction = 'lent' AND asset_id IS NOT NULL)
  ),
  CONSTRAINT physical_item_loans_dates_check CHECK (
    expected_return_date IS NULL OR expected_return_date >= loan_date
  ),
  UNIQUE (id, user_id),
  FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (compensation_debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS physical_item_loans_updated_at ON public.physical_item_loans;
CREATE TRIGGER physical_item_loans_updated_at
  BEFORE UPDATE ON public.physical_item_loans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_physical_item_loans_user_idempotency
  ON public.physical_item_loans (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2.7 Asset Loss & Recovery Records + Condition Logs
CREATE TABLE IF NOT EXISTS public.asset_loss_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL,
  lost_date DATE NOT NULL,
  reason TEXT NOT NULL,
  loss_amount BIGINT NOT NULL CHECK (loss_amount >= 0),
  loan_id UUID,
  liable_party TEXT,
  compensation_amount BIGINT CHECK (compensation_amount IS NULL OR compensation_amount >= 0),
  compensation_debt_id UUID,
  compensation_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  compensation_cancelled_at TIMESTAMPTZ,
  compensation_cancel_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id, user_id) REFERENCES public.physical_item_loans(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (compensation_debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS public.asset_recovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL,
  recovered_date DATE NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('excellent', 'good', 'fair', 'damaged')),
  loss_record_id UUID,
  compensation_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (loss_record_id, user_id) REFERENCES public.asset_loss_records(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS public.asset_condition_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id UUID,
  loan_id UUID,
  date DATE NOT NULL,
  previous_condition TEXT CHECK (previous_condition IS NULL OR previous_condition IN ('excellent', 'good', 'fair', 'damaged')),
  condition TEXT NOT NULL CHECK (condition IN ('excellent', 'good', 'fair', 'damaged')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_condition_logs_xor_parent_check CHECK (
    (asset_id IS NOT NULL AND loan_id IS NULL) OR
    (asset_id IS NULL AND loan_id IS NOT NULL)
  ),
  FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id, user_id) REFERENCES public.physical_item_loans(id, user_id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. CROSS-LEDGER COMPOSITE FOREIGN KEYS (TENANT-ISOLATED, LEGACY-CLEAN)
-- ============================================================================

-- 3.1 Drop conflicting legacy single-column FKs from 0001/0002 before enforcing
--     tenant-isolated composite (foreign_id, user_id) FKs.
DO $$
DECLARE
  fk_rec RECORD;
BEGIN
  FOR fk_rec IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public'
      AND c.contype = 'f'
      AND pg_catalog.array_length(c.conkey, 1) = 1
      AND c.confrelid <> 'auth.users'::regclass
      AND (
        (c.conrelid = 'public.transactions'::regclass AND a.attname IN ('category_id', 'account_id', 'project_id')) OR
        (c.conrelid = 'public.transfers'::regclass AND a.attname IN ('from_account_id', 'to_account_id')) OR
        (c.conrelid = 'public.project_payments'::regclass AND a.attname IN ('project_id', 'account_id', 'transaction_id')) OR
        (c.conrelid = 'public.project_expenses'::regclass AND a.attname IN ('project_id', 'account_id', 'transaction_id')) OR
        (c.conrelid = 'public.debt_payments'::regclass AND a.attname IN ('debt_id', 'account_id', 'transaction_id')) OR
        (c.conrelid = 'public.recurring_obligations'::regclass AND a.attname IN ('reallocated_to_goal_id')) OR
        (c.conrelid = 'public.obligation_logs'::regclass AND a.attname IN ('obligation_id', 'account_id', 'transaction_id')) OR
        (c.conrelid = 'public.goal_contributions'::regclass AND a.attname IN ('goal_id', 'from_account_id', 'to_account_id', 'transfer_id'))
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', fk_rec.tbl, fk_rec.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  -- Transactions -> Accounts, Categories, Projects, Debts, SplitBills, CustodialFunds, ProjectAdvances, Assets, Loans, ParentTx
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_account_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_category_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_category_tenant
      FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_project_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_project_tenant
      FOREIGN KEY (project_id, user_id) REFERENCES public.freelance_projects(id, user_id) ON DELETE SET NULL (project_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_debt_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_debt_tenant
      FOREIGN KEY (debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_split_bill_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_split_bill_tenant
      FOREIGN KEY (split_bill_id, user_id) REFERENCES public.split_bills(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_custodial_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_custodial_tenant
      FOREIGN KEY (custodial_fund_id, user_id) REFERENCES public.custodial_funds(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_project_advance_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_project_advance_tenant
      FOREIGN KEY (project_advance_id, user_id) REFERENCES public.project_advances(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_asset_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_asset_tenant
      FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_physical_loan_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_physical_loan_tenant
      FOREIGN KEY (physical_loan_id, user_id) REFERENCES public.physical_item_loans(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transactions'::regclass AND conname = 'fk_transactions_parent_tenant') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT fk_transactions_parent_tenant
      FOREIGN KEY (parent_transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Transfers -> From/To Accounts
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transfers'::regclass AND conname = 'fk_transfers_from_account_tenant') THEN
    ALTER TABLE public.transfers
      ADD CONSTRAINT fk_transfers_from_account_tenant
      FOREIGN KEY (from_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transfers'::regclass AND conname = 'fk_transfers_to_account_tenant') THEN
    ALTER TABLE public.transfers
      ADD CONSTRAINT fk_transfers_to_account_tenant
      FOREIGN KEY (to_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  -- Project Payments -> Project, Account, Transaction
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_payments'::regclass AND conname = 'fk_project_payments_project_tenant') THEN
    ALTER TABLE public.project_payments
      ADD CONSTRAINT fk_project_payments_project_tenant
      FOREIGN KEY (project_id, user_id) REFERENCES public.freelance_projects(id, user_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_payments'::regclass AND conname = 'fk_project_payments_account_tenant') THEN
    ALTER TABLE public.project_payments
      ADD CONSTRAINT fk_project_payments_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE SET NULL (account_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_payments'::regclass AND conname = 'fk_project_payments_transaction_tenant') THEN
    ALTER TABLE public.project_payments
      ADD CONSTRAINT fk_project_payments_transaction_tenant
      FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (transaction_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Project Expenses -> Project, Account, Transaction, Linked Receivable
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'fk_project_expenses_project_tenant') THEN
    ALTER TABLE public.project_expenses
      ADD CONSTRAINT fk_project_expenses_project_tenant
      FOREIGN KEY (project_id, user_id) REFERENCES public.freelance_projects(id, user_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'fk_project_expenses_account_tenant') THEN
    ALTER TABLE public.project_expenses
      ADD CONSTRAINT fk_project_expenses_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'fk_project_expenses_transaction_tenant') THEN
    ALTER TABLE public.project_expenses
      ADD CONSTRAINT fk_project_expenses_transaction_tenant
      FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (transaction_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_expenses'::regclass AND conname = 'fk_project_expenses_linked_receivable_tenant') THEN
    ALTER TABLE public.project_expenses
      ADD CONSTRAINT fk_project_expenses_linked_receivable_tenant
      FOREIGN KEY (linked_receivable_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE SET NULL (linked_receivable_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Debts cross-references
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_account_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_expense_category_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_expense_category_tenant
      FOREIGN KEY (expense_category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_transaction_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_transaction_tenant
      FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_project_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_project_tenant
      FOREIGN KEY (project_id, user_id) REFERENCES public.freelance_projects(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_project_payment_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_project_payment_tenant
      FOREIGN KEY (project_payment_id, user_id) REFERENCES public.project_payments(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_project_expense_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_project_expense_tenant
      FOREIGN KEY (project_expense_id, user_id) REFERENCES public.project_expenses(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_split_bill_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_split_bill_tenant
      FOREIGN KEY (split_bill_id, user_id) REFERENCES public.split_bills(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_linked_debt_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_linked_debt_tenant
      FOREIGN KEY (linked_debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_asset_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_asset_tenant
      FOREIGN KEY (asset_id, user_id) REFERENCES public.physical_assets(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debts'::regclass AND conname = 'fk_debts_physical_loan_tenant') THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT fk_debts_physical_loan_tenant
      FOREIGN KEY (physical_loan_id, user_id) REFERENCES public.physical_item_loans(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Debt Payments -> Debt, Account, Transaction
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debt_payments'::regclass AND conname = 'fk_debt_payments_debt_tenant') THEN
    ALTER TABLE public.debt_payments
      ADD CONSTRAINT fk_debt_payments_debt_tenant
      FOREIGN KEY (debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debt_payments'::regclass AND conname = 'fk_debt_payments_account_tenant') THEN
    ALTER TABLE public.debt_payments
      ADD CONSTRAINT fk_debt_payments_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.debt_payments'::regclass AND conname = 'fk_debt_payments_transaction_tenant') THEN
    ALTER TABLE public.debt_payments
      ADD CONSTRAINT fk_debt_payments_transaction_tenant
      FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (transaction_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Recurring Obligations -> Linked Debt & Reallocated Goal
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.recurring_obligations'::regclass AND conname = 'fk_obligations_linked_debt_tenant') THEN
    ALTER TABLE public.recurring_obligations
      ADD CONSTRAINT fk_obligations_linked_debt_tenant
      FOREIGN KEY (linked_debt_id, user_id) REFERENCES public.debts(id, user_id) ON DELETE SET NULL (linked_debt_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.recurring_obligations'::regclass AND conname = 'fk_obligations_goal_tenant') THEN
    ALTER TABLE public.recurring_obligations
      ADD CONSTRAINT fk_obligations_goal_tenant
      FOREIGN KEY (reallocated_to_goal_id, user_id) REFERENCES public.savings_goals(id, user_id) ON DELETE SET NULL (reallocated_to_goal_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Obligation Logs -> Obligation, Account, Transaction
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.obligation_logs'::regclass AND conname = 'fk_obligation_logs_obligation_tenant') THEN
    ALTER TABLE public.obligation_logs
      ADD CONSTRAINT fk_obligation_logs_obligation_tenant
      FOREIGN KEY (obligation_id, user_id) REFERENCES public.recurring_obligations(id, user_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.obligation_logs'::regclass AND conname = 'fk_obligation_logs_account_tenant') THEN
    ALTER TABLE public.obligation_logs
      ADD CONSTRAINT fk_obligation_logs_account_tenant
      FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE SET NULL (account_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.obligation_logs'::regclass AND conname = 'fk_obligation_logs_transaction_tenant') THEN
    ALTER TABLE public.obligation_logs
      ADD CONSTRAINT fk_obligation_logs_transaction_tenant
      FOREIGN KEY (transaction_id, user_id) REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (transaction_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Goal Contributions -> Goal, From Account, To Account, Transfer
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.goal_contributions'::regclass AND conname = 'fk_goal_contributions_goal_tenant') THEN
    ALTER TABLE public.goal_contributions
      ADD CONSTRAINT fk_goal_contributions_goal_tenant
      FOREIGN KEY (goal_id, user_id) REFERENCES public.savings_goals(id, user_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.goal_contributions'::regclass AND conname = 'fk_goal_contributions_from_account_tenant') THEN
    ALTER TABLE public.goal_contributions
      ADD CONSTRAINT fk_goal_contributions_from_account_tenant
      FOREIGN KEY (from_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.goal_contributions'::regclass AND conname = 'fk_goal_contributions_to_account_tenant') THEN
    ALTER TABLE public.goal_contributions
      ADD CONSTRAINT fk_goal_contributions_to_account_tenant
      FOREIGN KEY (to_account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE SET NULL (to_account_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.goal_contributions'::regclass AND conname = 'fk_goal_contributions_transfer_tenant') THEN
    ALTER TABLE public.goal_contributions
      ADD CONSTRAINT fk_goal_contributions_transfer_tenant
      FOREIGN KEY (transfer_id, user_id) REFERENCES public.transfers(id, user_id) ON DELETE SET NULL (transfer_id);
  END IF;

  -- Physical Item Loans -> Loss Record
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.physical_item_loans'::regclass AND conname = 'fk_physical_item_loans_loss_record_tenant') THEN
    ALTER TABLE public.physical_item_loans
      ADD CONSTRAINT fk_physical_item_loans_loss_record_tenant
      FOREIGN KEY (loss_record_id, user_id) REFERENCES public.asset_loss_records(id, user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ============================================================================
-- 4. PERFORMANCE INDEXES FOR SYNC & QUERIES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_debts_user_status ON public.debts (user_id, direction, status);
CREATE INDEX IF NOT EXISTS idx_custodial_funds_user_status ON public.custodial_funds (user_id, status);
CREATE INDEX IF NOT EXISTS idx_project_advances_user_project ON public.project_advances (user_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_split_bills_user_date ON public.split_bills (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_physical_assets_user_status ON public.physical_assets (user_id, status);
CREATE INDEX IF NOT EXISTS idx_physical_item_loans_user_status ON public.physical_item_loans (user_id, direction, status);

-- ============================================================================
-- 5. GRANULAR ROW LEVEL SECURITY (RLS) ON ALL USER TABLES
--    - Explicit SELECT, INSERT, UPDATE, DELETE policies
--    - Strictly restricted TO authenticated using (SELECT auth.uid())
--    - Zero public / anon financial table access
-- ============================================================================

-- Helper block to replace legacy FOR ALL policies cleanly on all mutable user-owned tables
DO $$
DECLARE
  tbl TEXT;
  mutable_tables TEXT[] := ARRAY[
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
BEGIN
  FOREACH tbl IN ARRAY mutable_tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_own', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_select_own', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert_own', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update_own', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete_own', tbl);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id)',
      tbl || '_select_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id)',
      tbl || '_insert_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id)',
      tbl || '_update_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id)',
      tbl || '_delete_own', tbl
    );
  END LOOP;
END $$;

-- Profiles RLS (uses id instead of user_id)
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;

CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_delete_own"
  ON public.profiles FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = id);

-- Append-Only / Immutable Audit Tables: change_logs & financial_mode_logs
-- SELECT & INSERT allowed for authenticated owner; UPDATE & DELETE denied to prevent tampering.
REVOKE ALL ON TABLE public.change_logs FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.change_logs TO authenticated;
ALTER TABLE public.change_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "change_logs_owner_all" ON public.change_logs;
DROP POLICY IF EXISTS "change_logs_select_own" ON public.change_logs;
DROP POLICY IF EXISTS "change_logs_insert_own" ON public.change_logs;
DROP POLICY IF EXISTS "change_logs_no_update" ON public.change_logs;
DROP POLICY IF EXISTS "change_logs_no_delete" ON public.change_logs;

CREATE POLICY "change_logs_select_own"
  ON public.change_logs FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "change_logs_insert_own"
  ON public.change_logs FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "change_logs_no_update"
  ON public.change_logs FOR UPDATE TO authenticated
  USING (FALSE)
  WITH CHECK (FALSE);

CREATE POLICY "change_logs_no_delete"
  ON public.change_logs FOR DELETE TO authenticated
  USING (FALSE);

REVOKE ALL ON TABLE public.financial_mode_logs FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.financial_mode_logs TO authenticated;
ALTER TABLE public.financial_mode_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "financial_mode_logs_own" ON public.financial_mode_logs;
DROP POLICY IF EXISTS "financial_mode_logs_select_own" ON public.financial_mode_logs;
DROP POLICY IF EXISTS "financial_mode_logs_insert_own" ON public.financial_mode_logs;
DROP POLICY IF EXISTS "financial_mode_logs_no_update" ON public.financial_mode_logs;
DROP POLICY IF EXISTS "financial_mode_logs_no_delete" ON public.financial_mode_logs;

CREATE POLICY "financial_mode_logs_select_own"
  ON public.financial_mode_logs FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "financial_mode_logs_insert_own"
  ON public.financial_mode_logs FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "financial_mode_logs_no_update"
  ON public.financial_mode_logs FOR UPDATE TO authenticated
  USING (FALSE)
  WITH CHECK (FALSE);

CREATE POLICY "financial_mode_logs_no_delete"
  ON public.financial_mode_logs FOR DELETE TO authenticated
  USING (FALSE);
