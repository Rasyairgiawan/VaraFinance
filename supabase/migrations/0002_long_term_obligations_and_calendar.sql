-- KendaliUang: Migration 0002
-- Penyempurnaan Kewajiban Jangka Panjang, Pengingat, dan Konfirmasi No-Spend Day

-- 1. Tambah pengaturan pengingat pada profiles
alter table public.profiles
  add column if not exists reminder_settings jsonb not null default '{"enabled":true,"obligationDaysBefore":3,"debtDueDaysBefore":3,"dailyNoSpendReminder":true,"cigaretteLimitAlert":true,"customReminders":[]}'::jsonb;

-- 2. Tambah atribut lengkap kewajiban jangka panjang pada recurring_obligations
alter table public.recurring_obligations
  add column if not exists duration_type text not null default 'indefinite'
    check (duration_type in ('temporary', 'indefinite', 'fixed_term', 'one_time')),
  add column if not exists start_date date not null default current_date,
  add column if not exists end_date date,
  add column if not exists status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'cancelled')),
  add column if not exists reminder_enabled boolean not null default true,
  add column if not exists reminder_days_before integer not null default 3 check (reminder_days_before >= 0),
  add column if not exists reallocated_to_goal_id uuid references public.savings_goals(id) on delete set null;

-- Update frequency check to allow 'once' as well
alter table public.recurring_obligations
  drop constraint if exists recurring_obligations_frequency_check;

alter table public.recurring_obligations
  add constraint recurring_obligations_frequency_check
    check (frequency in ('once', 'weekly', 'monthly'));

-- 3. Tabel konfirmasi manual Hari Tanpa Jajan (No-Spend Day)
create table if not exists public.no_spend_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'revoked')),
  note text,
  confirmed_at timestamptz not null default now(),
  unique (user_id, date)
);

alter table public.no_spend_confirmations enable row level security;

create policy "no_spend_confirmations_own"
  on public.no_spend_confirmations
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
