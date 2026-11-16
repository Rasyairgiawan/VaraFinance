-- Migration 0003: Audit fixes, Account lifecycle, Utang/Piutang, Scheduled Expenses,
-- Category/Goal archiving, Voided transactions, and Immutable Change Logs.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS security_pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS projection_assumptions JSONB DEFAULT '{"expectedExtraIncome":0,"dailyDiscretionaryOverride":null,"includeDebtInProjection":true,"includeObligationsInProjection":true,"includeScheduledExpenses":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS sync_meta JSONB DEFAULT '{}'::jsonb;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'closed')),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'payable' CHECK (direction IN ('payable', 'receivable'));

ALTER TABLE public.recurring_obligations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'obligation' CHECK (kind IN ('obligation', 'scheduled_expense')),
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Allow 'yearly' frequency in recurring_obligations
ALTER TABLE public.recurring_obligations DROP CONSTRAINT IF EXISTS recurring_obligations_frequency_check;
ALTER TABLE public.recurring_obligations
  ADD CONSTRAINT recurring_obligations_frequency_check CHECK (frequency IN ('once', 'weekly', 'monthly', 'yearly'));

ALTER TABLE public.freelance_projects
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.savings_goals
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.change_logs (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  note TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.change_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'change_logs' AND policyname = 'change_logs_owner_all'
  ) THEN
    CREATE POLICY change_logs_owner_all ON public.change_logs
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
