-- KendaliUang: Personal Finance Management & Financial Discipline System
-- Supabase PostgreSQL Initial Schema + Row Level Security (RLS)
-- Jalankan SQL ini melalui Supabase SQL Editor atau Supabase CLI (`supabase db push`)

create extension if not exists "pgcrypto";

-- Helper trigger for updated_at (search_path hardened)
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

-- 1. Profiles & Financial Settings
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'Pengguna',
  onboarding_completed boolean not null default false,
  daily_budget_limit bigint not null default 0 check (daily_budget_limit >= 0),
  weekly_budget_limit bigint not null default 0 check (weekly_budget_limit >= 0),
  monthly_budget_limit bigint not null default 0 check (monthly_budget_limit >= 0),
  cigarette_weekly_limit bigint not null default 0 check (cigarette_weekly_limit >= 0),
  hangout_weekly_limit bigint not null default 0 check (hangout_weekly_limit >= 0),
  essential_reserve_target bigint not null default 0 check (essential_reserve_target >= 0),
  emergency_fund_target bigint not null default 500000 check (emergency_fund_target >= 0),
  allowance_allocation_rules jsonb not null default '{"obligations":35,"debt":25,"essential":20,"emergency":10,"personal_savings":5,"discretionary":5}'::jsonb,
  freelance_allocation_rules jsonb not null default '{"business":25,"obligations":20,"debt":20,"emergency":15,"personal_savings":10,"investment":5,"discretionary":5}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.handle_updated_at();

-- 2. Accounts & Wallets
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('cash', 'bank', 'ewallet', 'savings', 'investment')),
  opening_balance bigint not null default 0,
  is_business boolean not null default false,
  is_protected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists accounts_updated_at on public.accounts;
create trigger accounts_updated_at
  before update on public.accounts
  for each row execute function public.handle_updated_at();

-- 3. Categories
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('income', 'expense')),
  classification text not null check (classification in ('essential', 'discretionary', 'obligation', 'debt', 'savings', 'business', 'income')),
  weekly_limit bigint not null default 0 check (weekly_limit >= 0),
  monthly_limit bigint not null default 0 check (monthly_limit >= 0),
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

-- 4. Freelance Website Projects
create table if not exists public.freelance_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null,
  project_name text not null,
  contract_value bigint not null check (contract_value >= 0),
  payment_scheme text not null check (payment_scheme in ('full', 'dp_final', 'milestone', 'custom')),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  business_share_pct integer not null default 30 check (business_share_pct >= 0 and business_share_pct <= 100),
  personal_share_pct integer not null default 70 check (personal_share_pct >= 0 and personal_share_pct <= 100),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists freelance_projects_updated_at on public.freelance_projects;
create trigger freelance_projects_updated_at
  before update on public.freelance_projects
  for each row execute function public.handle_updated_at();

-- 5. Transactions (Income & Expense only — Transfers stored separately)
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount bigint not null check (amount > 0),
  category_id uuid not null references public.categories(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete restrict,
  date date not null default current_date,
  description text not null,
  notes text,
  tags text[] not null default '{}',
  income_source text check (income_source in ('daily_allowance', 'freelance', 'other')),
  project_id uuid references public.freelance_projects(id) on delete set null,
  is_essential boolean not null default false,
  is_discretionary boolean not null default false,
  exceeded_budget boolean not null default false,
  override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_user_date on public.transactions(user_id, date desc);

drop trigger if exists transactions_updated_at on public.transactions;
create trigger transactions_updated_at
  before update on public.transactions
  for each row execute function public.handle_updated_at();

-- 6. Account Transfers (Never counted as income or expense)
create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_account_id uuid not null references public.accounts(id) on delete restrict,
  to_account_id uuid not null references public.accounts(id) on delete restrict,
  amount bigint not null check (amount > 0),
  date date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);

-- 7. Project Payments (Expected vs Received)
create table if not exists public.project_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.freelance_projects(id) on delete cascade,
  payment_type text not null check (payment_type in ('full', 'dp', 'installment', 'final')),
  amount bigint not null check (amount > 0),
  status text not null check (status in ('expected', 'received')),
  expected_date date,
  received_date date,
  account_id uuid references public.accounts(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

-- 8. Project Operational Expenses
create table if not exists public.project_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.freelance_projects(id) on delete cascade,
  description text not null,
  amount bigint not null check (amount > 0),
  date date not null default current_date,
  account_id uuid not null references public.accounts(id) on delete restrict,
  transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 9. Debts & Repayments
create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  creditor text not null,
  description text not null,
  initial_amount bigint not null check (initial_amount > 0),
  remaining_amount bigint not null check (remaining_amount >= 0),
  due_date date,
  priority integer not null default 1,
  status text not null default 'active' check (status in ('active', 'paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists debts_updated_at on public.debts;
create trigger debts_updated_at
  before update on public.debts
  for each row execute function public.handle_updated_at();

create table if not exists public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  debt_id uuid not null references public.debts(id) on delete cascade,
  amount bigint not null check (amount > 0),
  date date not null default current_date,
  account_id uuid not null references public.accounts(id) on delete restrict,
  transaction_id uuid references public.transactions(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

-- 10. Recurring Obligations (e.g. Weekly KKN Rp30.000)
create table if not exists public.recurring_obligations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null default 'Kuliah & KKN',
  amount bigint not null check (amount > 0),
  frequency text not null check (frequency in ('weekly', 'monthly')),
  next_due_date date not null default current_date,
  reserved_amount bigint not null default 0 check (reserved_amount >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists recurring_obligations_updated_at on public.recurring_obligations;
create trigger recurring_obligations_updated_at
  before update on public.recurring_obligations
  for each row execute function public.handle_updated_at();

create table if not exists public.obligation_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  obligation_id uuid not null references public.recurring_obligations(id) on delete cascade,
  action text not null check (action in ('reserve', 'pay')),
  amount bigint not null check (amount > 0),
  date date not null default current_date,
  account_id uuid references public.accounts(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

-- 11. Savings & Financial Goals
create table if not exists public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  goal_type text not null check (goal_type in ('emergency', 'personal', 'smartphone', 'business', 'investment', 'buffer')),
  target_amount bigint not null check (target_amount > 0),
  current_amount bigint not null default 0 check (current_amount >= 0),
  virtual_reserved_in_liquid bigint not null default 0 check (virtual_reserved_in_liquid >= 0),
  target_date date,
  priority integer not null default 1,
  monthly_target bigint not null default 0 check (monthly_target >= 0),
  is_protected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists savings_goals_updated_at on public.savings_goals;
create trigger savings_goals_updated_at
  before update on public.savings_goals
  for each row execute function public.handle_updated_at();

create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.savings_goals(id) on delete cascade,
  amount bigint not null check (amount > 0),
  date date not null default current_date,
  from_account_id uuid not null references public.accounts(id) on delete restrict,
  to_account_id uuid references public.accounts(id) on delete set null,
  transfer_id uuid references public.transfers(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

-- 12. Financial Mode History & Income Allocation Logs
create table if not exists public.financial_mode_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('recovery', 'stabilization', 'saving', 'growth')),
  reasons jsonb not null default '[]'::jsonb,
  liquid_balance bigint not null,
  safe_to_spend bigint not null,
  evaluated_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) — STRICT PER-USER OWNERSHIP
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.categories enable row level security;
alter table public.freelance_projects enable row level security;
alter table public.transactions enable row level security;
alter table public.transfers enable row level security;
alter table public.project_payments enable row level security;
alter table public.project_expenses enable row level security;
alter table public.debts enable row level security;
alter table public.debt_payments enable row level security;
alter table public.recurring_obligations enable row level security;
alter table public.obligation_logs enable row level security;
alter table public.savings_goals enable row level security;
alter table public.goal_contributions enable row level security;
alter table public.financial_mode_logs enable row level security;

drop policy if exists "profiles_own" on public.profiles;
create policy "profiles_own" on public.profiles for all to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists "accounts_own" on public.accounts;
create policy "accounts_own" on public.accounts for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "categories_own" on public.categories;
create policy "categories_own" on public.categories for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "freelance_projects_own" on public.freelance_projects;
create policy "freelance_projects_own" on public.freelance_projects for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "transactions_own" on public.transactions;
create policy "transactions_own" on public.transactions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "transfers_own" on public.transfers;
create policy "transfers_own" on public.transfers for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "project_payments_own" on public.project_payments;
create policy "project_payments_own" on public.project_payments for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "project_expenses_own" on public.project_expenses;
create policy "project_expenses_own" on public.project_expenses for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "debts_own" on public.debts;
create policy "debts_own" on public.debts for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "debt_payments_own" on public.debt_payments;
create policy "debt_payments_own" on public.debt_payments for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "recurring_obligations_own" on public.recurring_obligations;
create policy "recurring_obligations_own" on public.recurring_obligations for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "obligation_logs_own" on public.obligation_logs;
create policy "obligation_logs_own" on public.obligation_logs for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "savings_goals_own" on public.savings_goals;
create policy "savings_goals_own" on public.savings_goals for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "goal_contributions_own" on public.goal_contributions;
create policy "goal_contributions_own" on public.goal_contributions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "financial_mode_logs_own" on public.financial_mode_logs;
create policy "financial_mode_logs_own" on public.financial_mode_logs for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
