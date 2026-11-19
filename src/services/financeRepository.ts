import { createInitialFinanceState, DEFAULT_PROJECTION_ASSUMPTIONS } from '../data/initialProfile';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  createUuidInitialFinanceState,
  migrateFinanceStateToUUID,
  needsUuidMigration,
} from './financeMigration';
import { FinanceState, RecurringObligation } from '../types/finance';
import { generateId, todayISO } from '../utils/format';

const STORAGE_KEY = 'kendaliuang_state_v1';
const LAST_SYNC_KEY = 'kendaliuang_last_sync_v1';
const DEVICE_ID_KEY = 'kendaliuang_device_id_v1';

export function getStorageKeyForUser(userId?: string | null): string {
  if (!userId) return STORAGE_KEY;
  return `${STORAGE_KEY}_${userId}`;
}

export function getLastSyncKeyForUser(userId?: string | null): string {
  if (!userId) return LAST_SYNC_KEY;
  return `${LAST_SYNC_KEY}_${userId}`;
}

export function migrateLegacyLocalStateToUser(userId: string): boolean {
  try {
    const userKey = getStorageKeyForUser(userId);
    const existingUserRaw = localStorage.getItem(userKey);
    if (existingUserRaw) return false;
    const legacyRaw = localStorage.getItem(STORAGE_KEY);
    if (!legacyRaw) return false;
    localStorage.setItem(userKey, legacyRaw);
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface SyncStatus {
  mode: 'cloud' | 'local_demo';
  authenticatedEmail: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conflictDetected?: boolean;
  conflictDetail?: string | null;
}

export interface BackupPayload {
  app: 'VaraFinance' | 'KendaliUang';
  schemaVersion: number;
  exportedAt: string;
  data: FinanceState;
}

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = `dev-${generateId()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'local-device';
  }
}

function deduplicateActiveObligations(list: RecurringObligation[]): RecurringObligation[] {
  const seen = new Map<string, RecurringObligation>();
  const result: RecurringObligation[] = [];

  for (const item of list) {
    if (item.status !== 'active' || item.isArchived) {
      result.push(item);
      continue;
    }
    const key = `${(item.kind ?? 'obligation')}|${item.name.trim().toLowerCase()}|${item.frequency}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      result.push(item);
    } else {
      // Merge reservedAmount into the primary definition rather than keeping duplicate active rows
      existing.reservedAmount = Math.max(existing.reservedAmount, item.reservedAmount);
    }
  }
  return result;
}

export function hydrateFinanceState(rawState: Partial<FinanceState>): FinanceState {
  const isV3OrHigher = typeof rawState.schemaVersion === 'number' && rawState.schemaVersion >= 3;
  const needsBaseFill =
    !Array.isArray(rawState.obligations) ||
    !Array.isArray(rawState.accounts) ||
    rawState.accounts.length === 0 ||
    !Array.isArray(rawState.categories) ||
    rawState.categories.length === 0 ||
    !Array.isArray(rawState.debts) ||
    !Array.isArray(rawState.goals);
  const base = needsBaseFill
    ? isV3OrHigher
      ? createUuidInitialFinanceState()
      : createInitialFinanceState()
    : createInitialFinanceState();
  const now = todayISO();

  const rawObs = Array.isArray(rawState.obligations)
    ? rawState.obligations.map((o) => ({
        ...o,
        kind: o.kind ?? ('obligation' as const),
        durationType: o.durationType ?? (o.frequency === 'once' ? 'one_time' : o.endDate ? 'fixed_term' : 'indefinite'),
        startDate: o.startDate ?? o.createdAt?.slice(0, 10) ?? now,
        status: o.status ?? (o.isActive ? 'active' : 'paused'),
        reminderEnabled: o.reminderEnabled ?? true,
        reminderDaysBefore: o.reminderDaysBefore ?? 3,
        isActive: (o.status ?? (o.isActive ? 'active' : 'paused')) === 'active',
        isArchived: o.isArchived ?? false,
      }))
    : base.obligations;

  return {
    ...(typeof rawState.schemaVersion === 'number' ? { schemaVersion: rawState.schemaVersion } : {}),
    settings: {
      ...base.settings,
      ...(rawState.settings ?? {}),
      allowanceAllocationRules: {
        ...base.settings.allowanceAllocationRules,
        ...(rawState.settings?.allowanceAllocationRules ?? {}),
      },
      freelanceAllocationRules: {
        ...base.settings.freelanceAllocationRules,
        ...(rawState.settings?.freelanceAllocationRules ?? {}),
      },
      reminderSettings: {
        ...base.settings.reminderSettings,
        ...(rawState.settings?.reminderSettings ?? {}),
        customReminders: rawState.settings?.reminderSettings?.customReminders ?? [],
        reminderStates: rawState.settings?.reminderSettings?.reminderStates ?? {},
      },
    },
    accounts:
      Array.isArray(rawState.accounts) && rawState.accounts.length > 0
        ? rawState.accounts.map((a) => ({
            ...a,
            status: a.status ?? 'active',
          }))
        : base.accounts,
    categories:
      Array.isArray(rawState.categories) && rawState.categories.length > 0
        ? rawState.categories.map((c) => ({
            ...c,
            isArchived: c.isArchived ?? false,
          }))
        : base.categories,
    transactions: Array.isArray(rawState.transactions) ? rawState.transactions : [],
    transfers: Array.isArray(rawState.transfers) ? rawState.transfers : [],
    projects: Array.isArray(rawState.projects)
      ? rawState.projects.map((p) => ({ ...p, isArchived: p.isArchived ?? false }))
      : [],
    projectPayments: Array.isArray(rawState.projectPayments) ? rawState.projectPayments : [],
    projectExpenses: Array.isArray(rawState.projectExpenses) ? rawState.projectExpenses : [],
    debts: Array.isArray(rawState.debts)
      ? rawState.debts.map((d) => ({
          ...d,
          direction: d.direction ?? 'payable',
        }))
      : base.debts,
    debtPayments: Array.isArray(rawState.debtPayments) ? rawState.debtPayments : [],
    splitBills: Array.isArray(rawState.splitBills) ? rawState.splitBills : [],
    custodialFunds: Array.isArray(rawState.custodialFunds) ? rawState.custodialFunds : [],
    projectAdvances: Array.isArray(rawState.projectAdvances) ? rawState.projectAdvances : [],
    physicalAssets: Array.isArray(rawState.physicalAssets) ? rawState.physicalAssets : [],
    physicalItemLoans: Array.isArray(rawState.physicalItemLoans) ? rawState.physicalItemLoans : [],
    obligations: deduplicateActiveObligations(rawObs),
    obligationLogs: Array.isArray(rawState.obligationLogs) ? rawState.obligationLogs : [],
    goals: Array.isArray(rawState.goals)
      ? rawState.goals.map((g) => ({ ...g, isArchived: g.isArchived ?? false }))
      : base.goals,
    goalContributions: Array.isArray(rawState.goalContributions) ? rawState.goalContributions : [],
    noSpendConfirmations: Array.isArray(rawState.noSpendConfirmations)
      ? rawState.noSpendConfirmations
      : [],
    changeLogs: Array.isArray(rawState.changeLogs) ? rawState.changeLogs : [],
    projectionAssumptions: {
      ...DEFAULT_PROJECTION_ASSUMPTIONS,
      ...(rawState.projectionAssumptions ?? {}),
    },
    syncMeta: rawState.syncMeta ?? {
      lastModifiedAt: new Date().toISOString(),
      deviceId: getOrCreateDeviceId(),
      version: 1,
    },
  };
}

function unionById<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of secondary) map.set(item.id, item);
  for (const item of primary) map.set(item.id, item);
  return Array.from(map.values());
}

/**
 * Deterministic offline-first + cloud conflict merge:
 * Merges ledger collections by ID so neither offline nor cloud records are lost,
 * preferring the newer timestamped state for mutable settings/summaries.
 */
export function mergeFinanceStatesById(local: FinanceState, remote: FinanceState): FinanceState {
  const localTime = Date.parse(local.syncMeta?.lastModifiedAt ?? '1970-01-01T00:00:00Z');
  const remoteTime = Date.parse(remote.syncMeta?.lastModifiedAt ?? '1970-01-01T00:00:00Z');
  const preferLocal = localTime > remoteTime;
  const primary = preferLocal ? local : remote;
  const secondary = preferLocal ? remote : local;

  const nsMap = new Map(secondary.noSpendConfirmations.map((c) => [c.date, c]));
  for (const c of primary.noSpendConfirmations) nsMap.set(c.date, c);

  return hydrateFinanceState({
    settings: primary.settings,
    projectionAssumptions: primary.projectionAssumptions,
    accounts: unionById(primary.accounts, secondary.accounts),
    categories: unionById(primary.categories, secondary.categories),
    transactions: unionById(primary.transactions, secondary.transactions),
    transfers: unionById(primary.transfers, secondary.transfers),
    projects: unionById(primary.projects, secondary.projects),
    projectPayments: unionById(primary.projectPayments, secondary.projectPayments),
    projectExpenses: unionById(primary.projectExpenses, secondary.projectExpenses),
    debts: unionById(primary.debts, secondary.debts),
    debtPayments: unionById(primary.debtPayments, secondary.debtPayments),
    splitBills: unionById(primary.splitBills ?? [], secondary.splitBills ?? []),
    custodialFunds: unionById(primary.custodialFunds ?? [], secondary.custodialFunds ?? []),
    projectAdvances: unionById(primary.projectAdvances ?? [], secondary.projectAdvances ?? []),
    physicalAssets: unionById(primary.physicalAssets ?? [], secondary.physicalAssets ?? []),
    physicalItemLoans: unionById(primary.physicalItemLoans ?? [], secondary.physicalItemLoans ?? []),
    obligations: unionById(primary.obligations, secondary.obligations),
    obligationLogs: unionById(primary.obligationLogs, secondary.obligationLogs),
    goals: unionById(primary.goals, secondary.goals),
    goalContributions: unionById(primary.goalContributions, secondary.goalContributions),
    noSpendConfirmations: Array.from(nsMap.values()),
    changeLogs: unionById(primary.changeLogs ?? [], secondary.changeLogs ?? []).sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
    ),
    syncMeta: {
      lastModifiedAt: new Date().toISOString(),
      deviceId: getOrCreateDeviceId(),
      version: Math.max(local.syncMeta?.version ?? 1, remote.syncMeta?.version ?? 1) + 1,
    },
  });
}

export function hasUnsyncedLocalChanges(local: FinanceState, lastSyncedAt: string | null): boolean {
  if (!lastSyncedAt) {
    return local.transactions.length > 0 || (local.changeLogs?.length ?? 0) > 0;
  }
  const localMod = Date.parse(local.syncMeta?.lastModifiedAt ?? '1970-01-01T00:00:00Z');
  const synced = Date.parse(lastSyncedAt);
  return localMod > synced + 2000;
}

export function getLastSyncedTimestamp(userId?: string | null): string | null {
  try {
    return localStorage.getItem(getLastSyncKeyForUser(userId)) ?? localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

export function createBackupPayload(state: FinanceState): BackupPayload {
  return {
    app: 'VaraFinance',
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    data: state,
  };
}

export function parseAndValidateBackupJSON(jsonText: string): FinanceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Berkas bukan JSON yang valid.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Struktur berkas backup tidak valid.');
  }

  const candidate =
    'data' in parsed &&
    ((parsed as BackupPayload).app === 'VaraFinance' ||
      (parsed as BackupPayload).app === 'KendaliUang')
      ? (parsed as BackupPayload).data
      : (parsed as Partial<FinanceState>);

  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !candidate.settings ||
    !Array.isArray(candidate.accounts) ||
    !Array.isArray(candidate.categories) ||
    !Array.isArray(candidate.transactions)
  ) {
    throw new Error(
      'Berkas tidak memiliki struktur data VaraFinance yang lengkap (settings, accounts, categories, transactions).'
    );
  }

  if (candidate.accounts.length === 0) {
    throw new Error('Berkas backup harus memiliki minimal 1 akun.');
  }

  const normalizedCandidate = needsUuidMigration(candidate)
    ? migrateFinanceStateToUUID(candidate, { saveBackup: false }).migratedState
    : candidate;

  return hydrateFinanceState(normalizedCandidate);
}

export function loadLocalState(userId?: string | null): FinanceState {
  const key = getStorageKeyForUser(userId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      const initial = createUuidInitialFinanceState();
      localStorage.setItem(key, JSON.stringify(initial));
      return initial;
    }

    const parsed = JSON.parse(raw) as Partial<FinanceState>;
    const normalized = needsUuidMigration(parsed)
      ? migrateFinanceStateToUUID(parsed, { userId, saveBackup: true }).migratedState
      : parsed;

    const hydrated = hydrateFinanceState(normalized);
    localStorage.setItem(key, JSON.stringify(hydrated));
    return hydrated;
  } catch (err) {
    console.error('Gagal memuat atau memigrasi state lokal:', err);
    // Crash-safe: jangan pernah menghapus/menimpa key existing saat gagal parse/migrasi
    return createUuidInitialFinanceState();
  }
}

export function saveLocalState(state: FinanceState, userId?: string | null): void {
  const key = getStorageKeyForUser(userId);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.error('Gagal menyimpan state ke localStorage:', err);
  }
}

export function resetLocalState(userId?: string | null): FinanceState {
  const initial = createUuidInitialFinanceState();
  saveLocalState(initial, userId);
  return initial;
}

export async function pullFromSupabase(userId: string): Promise<FinanceState | null> {
  if (!supabase || !isSupabaseConfigured) return null;

  const [
    profileRes,
    accountsRes,
    categoriesRes,
    txRes,
    transfersRes,
    projectsRes,
    projPayRes,
    projExpRes,
    debtsRes,
    debtPayRes,
    obsRes,
    obLogsRes,
    goalsRes,
    goalContribRes,
    noSpendRes,
    changeLogsRes,
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabase.from('accounts').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('categories').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('transactions').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('transfers').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('freelance_projects').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    supabase.from('project_payments').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('project_expenses').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('debts').select('*').eq('user_id', userId).order('priority'),
    supabase.from('debt_payments').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('recurring_obligations').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('obligation_logs').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('savings_goals').select('*').eq('user_id', userId).order('priority'),
    supabase.from('goal_contributions').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('no_spend_confirmations').select('*').eq('user_id', userId).order('date', { ascending: false }),
    supabase.from('change_logs').select('*').eq('user_id', userId).order('timestamp', { ascending: false }),
  ]);

  if (profileRes.error) throw profileRes.error;
  if (!profileRes.data) {
    const localExisting = loadLocalState(userId);
    await pushStateToSupabase(userId, localExisting);
    return localExisting;
  }

  const p = profileRes.data;
  const state = hydrateFinanceState({
    settings: {
      fullName: p.full_name,
      username: p.username ?? undefined,
      onboardingCompleted: p.onboarding_completed,
      dailyBudgetLimit: Number(p.daily_budget_limit),
      weeklyBudgetLimit: Number(p.weekly_budget_limit),
      monthlyBudgetLimit: Number(p.monthly_budget_limit),
      cigaretteWeeklyLimit: Number(p.cigarette_weekly_limit),
      hangoutWeeklyLimit: Number(p.hangout_weekly_limit),
      essentialReserveTarget: Number(p.essential_reserve_target),
      emergencyFundTarget: Number(p.emergency_fund_target),
      allowanceAllocationRules: p.allowance_allocation_rules,
      freelanceAllocationRules: p.freelance_allocation_rules,
      reminderSettings: p.reminder_settings,
      securityPinHash: p.security_pin_hash ?? undefined,
      pinEnabled: p.pin_enabled ?? Boolean(p.security_pin_hash),
      requirePinOnReopen: p.require_pin_on_reopen ?? true,
      autoLockMinutes: typeof p.auto_lock_minutes === 'number' ? p.auto_lock_minutes : 5,
    },
    projectionAssumptions: p.projection_assumptions ?? undefined,
    syncMeta: p.sync_meta ?? undefined,
    accounts: (accountsRes.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      accountType: a.account_type,
      openingBalance: Number(a.opening_balance),
      isBusiness: a.is_business,
      isProtected: a.is_protected,
      status: a.status ?? 'active',
      archivedAt: a.archived_at ?? undefined,
      closedAt: a.closed_at ?? undefined,
      createdAt: a.created_at,
    })),
    categories: (categoriesRes.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      classification: c.classification,
      weeklyLimit: Number(c.weekly_limit),
      monthlyLimit: Number(c.monthly_limit),
      isSystem: c.is_system,
      isArchived: c.is_archived ?? false,
    })),
    transactions: (txRes.data ?? []).map((t) => ({
      id: t.id,
      type: t.type,
      amount: Number(t.amount),
      categoryId: t.category_id,
      accountId: t.account_id,
      date: t.date,
      description: t.description,
      notes: t.notes ?? undefined,
      tags: t.tags ?? [],
      incomeSource: t.income_source ?? undefined,
      projectId: t.project_id ?? undefined,
      isEssential: t.is_essential,
      isDiscretionary: t.is_discretionary,
      exceededBudget: t.exceeded_budget,
      overrideReason: t.override_reason ?? undefined,
      isVoided: t.is_voided ?? false,
      voidedAt: t.voided_at ?? undefined,
      voidReason: t.void_reason ?? undefined,
      createdAt: t.created_at,
    })),
    transfers: (transfersRes.data ?? []).map((tr) => ({
      id: tr.id,
      fromAccountId: tr.from_account_id,
      toAccountId: tr.to_account_id,
      amount: Number(tr.amount),
      date: tr.date,
      notes: tr.notes ?? undefined,
      createdAt: tr.created_at,
    })),
    projects: (projectsRes.data ?? []).map((pr) => ({
      id: pr.id,
      clientName: pr.client_name,
      projectName: pr.project_name,
      contractValue: Number(pr.contract_value),
      paymentScheme: pr.payment_scheme,
      status: pr.status,
      businessSharePct: pr.business_share_pct,
      personalSharePct: pr.personal_share_pct,
      notes: pr.notes ?? undefined,
      isArchived: pr.is_archived ?? false,
      createdAt: pr.created_at,
    })),
    projectPayments: (projPayRes.data ?? []).map((pp) => ({
      id: pp.id,
      projectId: pp.project_id,
      paymentType: pp.payment_type,
      amount: Number(pp.amount),
      status: pp.status,
      expectedDate: pp.expected_date ?? undefined,
      receivedDate: pp.received_date ?? undefined,
      accountId: pp.account_id ?? undefined,
      transactionId: pp.transaction_id ?? undefined,
      notes: pp.notes ?? undefined,
      createdAt: pp.created_at,
    })),
    projectExpenses: (projExpRes.data ?? []).map((pe) => ({
      id: pe.id,
      projectId: pe.project_id,
      description: pe.description,
      amount: Number(pe.amount),
      date: pe.date,
      accountId: pe.account_id,
      transactionId: pe.transaction_id ?? undefined,
      createdAt: pe.created_at,
    })),
    debts: (debtsRes.data ?? []).map((d) => ({
      id: d.id,
      direction: d.direction ?? 'payable',
      creditor: d.creditor,
      description: d.description,
      initialAmount: Number(d.initial_amount),
      remainingAmount: Number(d.remaining_amount),
      dueDate: d.due_date ?? undefined,
      priority: d.priority,
      status: d.status,
      createdAt: d.created_at,
    })),
    debtPayments: (debtPayRes.data ?? []).map((dp) => ({
      id: dp.id,
      debtId: dp.debt_id,
      amount: Number(dp.amount),
      date: dp.date,
      accountId: dp.account_id,
      transactionId: dp.transaction_id ?? undefined,
      notes: dp.notes ?? undefined,
      createdAt: dp.created_at,
    })),
    obligations: (obsRes.data ?? []).map((o) => ({
      id: o.id,
      kind: o.kind ?? 'obligation',
      name: o.name,
      category: o.category,
      amount: Number(o.amount),
      frequency: o.frequency,
      durationType: o.duration_type ?? 'indefinite',
      startDate: o.start_date ?? o.created_at?.slice(0, 10),
      nextDueDate: o.next_due_date,
      endDate: o.end_date ?? undefined,
      status: o.status ?? (o.is_active ? 'active' : 'paused'),
      reservedAmount: Number(o.reserved_amount),
      reminderEnabled: o.reminder_enabled ?? true,
      reminderDaysBefore: o.reminder_days_before ?? 3,
      reallocatedToGoalId: o.reallocated_to_goal_id ?? undefined,
      isActive: o.is_active,
      isArchived: o.is_archived ?? false,
      createdAt: o.created_at,
    })),
    obligationLogs: (obLogsRes.data ?? []).map((ol) => ({
      id: ol.id,
      obligationId: ol.obligation_id,
      action: ol.action,
      amount: Number(ol.amount),
      date: ol.date,
      accountId: ol.account_id ?? undefined,
      transactionId: ol.transaction_id ?? undefined,
      notes: ol.notes ?? undefined,
      createdAt: ol.created_at,
    })),
    goals: (goalsRes.data ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      goalType: g.goal_type,
      targetAmount: Number(g.target_amount),
      currentAmount: Number(g.current_amount),
      virtualReservedInLiquid: Number(g.virtual_reserved_in_liquid),
      targetDate: g.target_date ?? undefined,
      priority: g.priority,
      monthlyTarget: Number(g.monthly_target),
      isProtected: g.is_protected,
      isArchived: g.is_archived ?? false,
      createdAt: g.created_at,
    })),
    goalContributions: (goalContribRes.data ?? []).map((gc) => ({
      id: gc.id,
      goalId: gc.goal_id,
      amount: Number(gc.amount),
      date: gc.date,
      fromAccountId: gc.from_account_id,
      toAccountId: gc.to_account_id ?? undefined,
      transferId: gc.transfer_id ?? undefined,
      notes: gc.notes ?? undefined,
      createdAt: gc.created_at,
    })),
    noSpendConfirmations: (noSpendRes.data ?? []).map((ns) => ({
      date: ns.date,
      status: ns.status,
      note: ns.note ?? undefined,
      confirmedAt: ns.confirmed_at,
    })),
    changeLogs: (changeLogsRes.data ?? []).map((cl) => ({
      id: cl.id,
      entityType: cl.entity_type,
      entityId: cl.entity_id,
      action: cl.action,
      summary: cl.summary,
      beforeValue: cl.before_value ?? undefined,
      afterValue: cl.after_value ?? undefined,
      note: cl.note ?? undefined,
      timestamp: cl.timestamp,
    })),
  });

  return state;
}

export async function pushStateToSupabase(userId: string, state: FinanceState): Promise<void> {
  if (!supabase || !isSupabaseConfigured) return;

  const { error: profileErr } = await supabase.from('profiles').upsert({
    id: userId,
    full_name: state.settings.fullName,
    username: state.settings.username ?? null,
    onboarding_completed: state.settings.onboardingCompleted,
    daily_budget_limit: state.settings.dailyBudgetLimit,
    weekly_budget_limit: state.settings.weeklyBudgetLimit,
    monthly_budget_limit: state.settings.monthlyBudgetLimit,
    cigarette_weekly_limit: state.settings.cigaretteWeeklyLimit,
    hangout_weekly_limit: state.settings.hangoutWeeklyLimit,
    essential_reserve_target: state.settings.essentialReserveTarget,
    emergency_fund_target: state.settings.emergencyFundTarget,
    allowance_allocation_rules: state.settings.allowanceAllocationRules,
    freelance_allocation_rules: state.settings.freelanceAllocationRules,
    reminder_settings: state.settings.reminderSettings,
    security_pin_hash: state.settings.securityPinHash ?? null,
    pin_enabled: state.settings.pinEnabled ?? Boolean(state.settings.securityPinHash),
    require_pin_on_reopen: state.settings.requirePinOnReopen ?? true,
    auto_lock_minutes: state.settings.autoLockMinutes ?? 5,
    projection_assumptions: state.projectionAssumptions ?? null,
    sync_meta: state.syncMeta ?? null,
  });
  if (profileErr) throw profileErr;

  if (state.accounts.length > 0) {
    const { error } = await supabase.from('accounts').upsert(
      state.accounts.map((a) => ({
        id: a.id,
        user_id: userId,
        name: a.name,
        account_type: a.accountType,
        opening_balance: a.openingBalance,
        is_business: a.isBusiness,
        is_protected: a.isProtected,
        status: a.status ?? 'active',
        archived_at: a.archivedAt ?? null,
        closed_at: a.closedAt ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.categories.length > 0) {
    const { error } = await supabase.from('categories').upsert(
      state.categories.map((c) => ({
        id: c.id,
        user_id: userId,
        name: c.name,
        type: c.type,
        classification: c.classification,
        weekly_limit: c.weeklyLimit,
        monthly_limit: c.monthlyLimit,
        is_system: c.isSystem,
        is_archived: c.isArchived ?? false,
      }))
    );
    if (error) throw error;
  }

  if (state.projects.length > 0) {
    const { error } = await supabase.from('freelance_projects').upsert(
      state.projects.map((pr) => ({
        id: pr.id,
        user_id: userId,
        client_name: pr.clientName,
        project_name: pr.projectName,
        contract_value: pr.contractValue,
        payment_scheme: pr.paymentScheme,
        status: pr.status,
        business_share_pct: pr.businessSharePct,
        personal_share_pct: pr.personalSharePct,
        notes: pr.notes ?? null,
        is_archived: pr.isArchived ?? false,
      }))
    );
    if (error) throw error;
  }

  if (state.transactions.length > 0) {
    const { error } = await supabase.from('transactions').upsert(
      state.transactions.map((t) => ({
        id: t.id,
        user_id: userId,
        type: t.type,
        amount: t.amount,
        category_id: t.categoryId,
        account_id: t.accountId,
        date: t.date,
        description: t.description,
        notes: t.notes ?? null,
        tags: t.tags,
        income_source: t.incomeSource ?? null,
        project_id: t.projectId ?? null,
        is_essential: t.isEssential,
        is_discretionary: t.isDiscretionary,
        exceeded_budget: t.exceededBudget,
        override_reason: t.overrideReason ?? null,
        is_voided: t.isVoided ?? false,
        voided_at: t.voidedAt ?? null,
        void_reason: t.voidReason ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.transfers.length > 0) {
    const { error } = await supabase.from('transfers').upsert(
      state.transfers.map((tr) => ({
        id: tr.id,
        user_id: userId,
        from_account_id: tr.fromAccountId,
        to_account_id: tr.toAccountId,
        amount: tr.amount,
        date: tr.date,
        notes: tr.notes ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.projectPayments.length > 0) {
    const { error } = await supabase.from('project_payments').upsert(
      state.projectPayments.map((pp) => ({
        id: pp.id,
        user_id: userId,
        project_id: pp.projectId,
        payment_type: pp.paymentType,
        amount: pp.amount,
        status: pp.status,
        expected_date: pp.expectedDate ?? null,
        received_date: pp.receivedDate ?? null,
        account_id: pp.accountId ?? null,
        transaction_id: pp.transactionId ?? null,
        notes: pp.notes ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.projectExpenses.length > 0) {
    const { error } = await supabase.from('project_expenses').upsert(
      state.projectExpenses.map((pe) => ({
        id: pe.id,
        user_id: userId,
        project_id: pe.projectId,
        description: pe.description,
        amount: pe.amount,
        date: pe.date,
        account_id: pe.accountId,
        transaction_id: pe.transactionId ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.debts.length > 0) {
    const { error } = await supabase.from('debts').upsert(
      state.debts.map((d) => ({
        id: d.id,
        user_id: userId,
        direction: d.direction ?? 'payable',
        creditor: d.creditor,
        description: d.description,
        initial_amount: d.initialAmount,
        remaining_amount: d.remainingAmount,
        due_date: d.dueDate ?? null,
        priority: d.priority,
        status: d.status,
      }))
    );
    if (error) throw error;
  }

  if (state.debtPayments.length > 0) {
    const { error } = await supabase.from('debt_payments').upsert(
      state.debtPayments.map((dp) => ({
        id: dp.id,
        user_id: userId,
        debt_id: dp.debtId,
        amount: dp.amount,
        date: dp.date,
        account_id: dp.accountId,
        transaction_id: dp.transactionId ?? null,
        notes: dp.notes ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.obligations.length > 0) {
    const { error } = await supabase.from('recurring_obligations').upsert(
      state.obligations.map((o) => ({
        id: o.id,
        user_id: userId,
        kind: o.kind ?? 'obligation',
        name: o.name,
        category: o.category,
        amount: o.amount,
        frequency: o.frequency,
        duration_type: o.durationType,
        start_date: o.startDate,
        next_due_date: o.nextDueDate,
        end_date: o.endDate ?? null,
        status: o.status,
        reserved_amount: o.reservedAmount,
        reminder_enabled: o.reminderEnabled,
        reminder_days_before: o.reminderDaysBefore,
        reallocated_to_goal_id: o.reallocatedToGoalId ?? null,
        is_active: o.status === 'active',
        is_archived: o.isArchived ?? false,
      }))
    );
    if (error) throw error;
  }

  if (state.obligationLogs.length > 0) {
    const { error } = await supabase.from('obligation_logs').upsert(
      state.obligationLogs.map((ol) => ({
        id: ol.id,
        user_id: userId,
        obligation_id: ol.obligationId,
        action: ol.action,
        amount: ol.amount,
        date: ol.date,
        account_id: ol.accountId ?? null,
        transaction_id: ol.transactionId ?? null,
        notes: ol.notes ?? null,
      }))
    );
    if (error) throw error;
  }

  if (state.goals.length > 0) {
    const { error } = await supabase.from('savings_goals').upsert(
      state.goals.map((g) => ({
        id: g.id,
        user_id: userId,
        name: g.name,
        goal_type: g.goalType,
        target_amount: g.targetAmount,
        current_amount: g.currentAmount,
        virtual_reserved_in_liquid: g.virtualReservedInLiquid,
        target_date: g.targetDate ?? null,
        priority: g.priority,
        monthly_target: g.monthlyTarget,
        is_protected: g.isProtected,
        is_archived: g.isArchived ?? false,
      }))
    );
    if (error) throw error;
  }

  if (state.goalContributions.length > 0) {
    const { error } = await supabase.from('goal_contributions').upsert(
      state.goalContributions.map((gc) => ({
        id: gc.id,
        user_id: userId,
        goal_id: gc.goalId,
        amount: gc.amount,
        date: gc.date,
        from_account_id: gc.fromAccountId,
        to_account_id: gc.toAccountId ?? null,
        transfer_id: gc.transferId ?? null,
        notes: gc.notes ?? null,
      }))
    );
    if (error) throw error;
  }

  if ((state.noSpendConfirmations ?? []).length > 0) {
    const { error } = await supabase.from('no_spend_confirmations').upsert(
      state.noSpendConfirmations.map((ns) => ({
        user_id: userId,
        date: ns.date,
        status: ns.status,
        note: ns.note ?? null,
        confirmed_at: ns.confirmedAt,
      })),
      { onConflict: 'user_id,date' }
    );
    if (error) throw error;
  }

  if ((state.changeLogs ?? []).length > 0) {
    const { error } = await supabase.from('change_logs').upsert(
      (state.changeLogs ?? []).slice(0, 200).map((cl) => ({
        id: cl.id,
        user_id: userId,
        entity_type: cl.entityType,
        entity_id: cl.entityId,
        action: cl.action,
        summary: cl.summary,
        before_value: cl.beforeValue ?? null,
        after_value: cl.afterValue ?? null,
        note: cl.note ?? null,
        timestamp: cl.timestamp,
      }))
    );
    if (error) throw error;
  }

  localStorage.setItem(getLastSyncKeyForUser(userId), new Date().toISOString());
}
