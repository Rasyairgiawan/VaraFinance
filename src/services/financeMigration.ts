import {
  createInitialFinanceState,
  getSystemKeyForLegacyId,
  SYSTEM_KEY_ALLOWLISTS,
} from '../data/initialProfile';
import {
  Account,
  AccountTransfer,
  Category,
  ChangeLogEntry,
  CustodialFund,
  CustomReminder,
  Debt,
  DebtPayment,
  FinanceState,
  FreelanceProject,
  GoalContribution,
  ObligationLog,
  PhysicalAsset,
  PhysicalItemLoan,
  ProjectAdvance,
  ProjectExpense,
  ProjectPayment,
  RecurringObligation,
  ReminderActionState,
  ReminderSettings,
  SavingsGoal,
  SplitBill,
  Transaction,
} from '../types/finance';
import { generateId, isValidUUID } from '../utils/format';

export const PRE_UUID_BACKUP_PREFIX = 'kendaliuang_pre_uuid_raw_v1';

const PRESET_CATEGORY_SYSTEM_KEYS = new Set([
  'income_salary',
  'income_business',
  'income_passive',
  'housing',
  'utilities',
  'installment',
  'family',
  'tax_insurance',
]);

export type MigrationErrorCode =
  | 'INVALID_INPUT'
  | 'BACKUP_FAILED'
  | 'DUPLICATE_PRIMARY_KEY'
  | 'DUPLICATE_SYSTEM_KEY'
  | 'ORPHAN_FOREIGN_KEY'
  | 'INVALID_UUID'
  | 'INVARIANT_MISMATCH';

export class MigrationIntegrityError extends Error {
  readonly code: MigrationErrorCode;
  readonly details: string[];
  override readonly cause?: unknown;

  constructor(
    code: MigrationErrorCode,
    message: string,
    details: string[] = [],
    cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationIntegrityError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MigrationIdMaps {
  accounts: Record<string, string>;
  categories: Record<string, string>;
  projects: Record<string, string>;
  debts: Record<string, string>;
  obligations: Record<string, string>;
  goals: Record<string, string>;
  splitBills: Record<string, string>;
  custodialFunds: Record<string, string>;
  projectAdvances: Record<string, string>;
  physicalAssets: Record<string, string>;
  physicalItemLoans: Record<string, string>;
  transactions: Record<string, string>;
  transfers: Record<string, string>;
  projectPayments: Record<string, string>;
  projectExpenses: Record<string, string>;
  debtPayments: Record<string, string>;
  obligationLogs: Record<string, string>;
  goalContributions: Record<string, string>;
  changeLogs: Record<string, string>;
  customReminders: Record<string, string>;
}

export interface MigrationStats {
  mappedIdsCount: number;
  preservedUuidsCount: number;
  entityCounts: Record<string, number>;
  accountBalancesBefore: Record<string, number>;
  accountBalancesAfter: Record<string, number>;
}

export interface MigrateFinanceStateOptions {
  userId?: string | null;
  saveBackup?: boolean;
  storage?: StorageAdapter | null;
  nowISO?: string;
}

export interface MigrateFinanceStateResult {
  migratedState: FinanceState;
  backupKey: string;
  backupSaved: boolean;
  preservedExistingBackup?: boolean;
  idMap: MigrationIdMaps;
  stats: MigrationStats;
}

export interface PreUuidBackupEnvelope {
  backedUpAt: string;
  sourceSchemaVersion: number;
  data: Record<string, unknown>;
}

interface CollectionLookup {
  exactMap: Record<string, string>;
  lowerUuidMap: Record<string, string>;
}

export function getPreUuidBackupKey(userId?: string | null): string {
  const normalized = typeof userId === 'string' ? userId.trim() : '';
  if (!normalized) {
    return PRE_UUID_BACKUP_PREFIX;
  }
  return `${PRE_UUID_BACKUP_PREFIX}__user_${normalized}`;
}

function resolveDefaultStorage(): StorageAdapter | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
    return null;
  } catch {
    return null;
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isValidExistingBackupPayload(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const rec = parsed as Record<string, unknown>;
  // Valid PreUuidBackupEnvelope
  if (
    typeof rec.backedUpAt === 'string' &&
    rec.data &&
    typeof rec.data === 'object' &&
    !Array.isArray(rec.data)
  ) {
    const dataRec = rec.data as Record<string, unknown>;
    return (
      Boolean(dataRec.settings && typeof dataRec.settings === 'object' && !Array.isArray(dataRec.settings)) &&
      Array.isArray(dataRec.accounts) &&
      Array.isArray(dataRec.categories) &&
      Array.isArray(dataRec.transactions)
    );
  }
  return false;
}

export function savePreMigrationRawBackup(
  rawStateClone: unknown,
  options?: { userId?: string | null; storage?: StorageAdapter | null; nowISO?: string }
): { backupKey: string; backupSaved: boolean; preservedExistingBackup: boolean } {
  const backupKey = getPreUuidBackupKey(options?.userId);
  const storage = options?.storage !== undefined ? options.storage : resolveDefaultStorage();
  if (!storage) {
    throw new MigrationIntegrityError(
      'BACKUP_FAILED',
      `Penyimpanan backup tidak tersedia untuk key "${backupKey}". Migrasi dibatalkan agar data mentah tetap aman.`
    );
  }

  let existingRaw: string | null = null;
  try {
    existingRaw = storage.getItem(backupKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MigrationIntegrityError(
      'BACKUP_FAILED',
      `Gagal membaca status backup pra-migrasi pada "${backupKey}": ${reason}`,
      [reason],
      err
    );
  }

  if (existingRaw !== null) {
    let parsedExisting: unknown;
    try {
      parsedExisting = JSON.parse(existingRaw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MigrationIntegrityError(
        'BACKUP_FAILED',
        `Key backup "${backupKey}" sudah berisi data rusak/malformed dan tidak akan ditimpa diam-diam.`,
        [reason],
        err
      );
    }

    if (!isValidExistingBackupPayload(parsedExisting)) {
      throw new MigrationIntegrityError(
        'BACKUP_FAILED',
        `Key backup "${backupKey}" berisi struktur tidak dikenal dan tidak akan ditimpa diam-diam karena berpotensi berisi data pengguna yang dapat dipulihkan.`
      );
    }

    return {
      backupKey,
      backupSaved: true,
      preservedExistingBackup: true,
    };
  }

  const rawRec = (rawStateClone ?? {}) as Record<string, unknown>;
  const envelope: PreUuidBackupEnvelope = {
    backedUpAt: options?.nowISO ?? new Date().toISOString(),
    sourceSchemaVersion:
      typeof rawRec.schemaVersion === 'number' ? rawRec.schemaVersion : 1,
    data: rawRec,
  };

  try {
    storage.setItem(backupKey, JSON.stringify(envelope));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MigrationIntegrityError(
      'BACKUP_FAILED',
      `Gagal menyimpan backup mentah pra-migrasi ke "${backupKey}": ${reason}`,
      [reason],
      err
    );
  }

  return {
    backupKey,
    backupSaved: true,
    preservedExistingBackup: false,
  };
}

function buildCollectionLookup<T extends { id: string }>(
  items: T[],
  collectionName: string,
  statsCounter: { mappedIdsCount: number; preservedUuidsCount: number }
): CollectionLookup {
  const seenCanonicalIds = new Set<string>();
  const duplicateErrors: string[] = [];
  const usedNewUuids = new Set<string>();

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.trim().length === 0) {
      duplicateErrors.push(`${collectionName}: ditemukan entitas tanpa id string yang valid.`);
      continue;
    }
    const isUuid = isValidUUID(item.id);
    const canonicalKey = isUuid ? item.id.toLowerCase() : item.id;
    if (seenCanonicalIds.has(canonicalKey)) {
      duplicateErrors.push(`${collectionName}: primary key duplikat "${item.id}".`);
      continue;
    }
    seenCanonicalIds.add(canonicalKey);
    if (isUuid) {
      usedNewUuids.add(canonicalKey);
    }
  }

  if (duplicateErrors.length > 0) {
    throw new MigrationIntegrityError(
      'DUPLICATE_PRIMARY_KEY',
      `Migrasi dibatalkan karena duplikasi atau ketidaksahan primary key pada ${collectionName}.`,
      duplicateErrors
    );
  }

  const exactMap: Record<string, string> = {};
  const lowerUuidMap: Record<string, string> = {};

  for (const item of items) {
    if (isValidUUID(item.id)) {
      const canonical = item.id.toLowerCase();
      exactMap[item.id] = canonical;
      lowerUuidMap[canonical] = canonical;
      statsCounter.preservedUuidsCount += 1;
    } else {
      let nextUuid = generateId().toLowerCase();
      while (usedNewUuids.has(nextUuid)) {
        nextUuid = generateId().toLowerCase();
      }
      usedNewUuids.add(nextUuid);
      exactMap[item.id] = nextUuid;
      lowerUuidMap[nextUuid] = nextUuid;
      statsCounter.mappedIdsCount += 1;
    }
  }

  return { exactMap, lowerUuidMap };
}

function lookupIdFromCollection(oldId: string, lookup: CollectionLookup): string | undefined {
  if (Object.prototype.hasOwnProperty.call(lookup.exactMap, oldId)) {
    return lookup.exactMap[oldId];
  }
  if (isValidUUID(oldId)) {
    const lower = oldId.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lookup.lowerUuidMap, lower)) {
      return lookup.lowerUuidMap[lower];
    }
  }
  return undefined;
}

function resolveSystemKey(
  entityType: keyof typeof SYSTEM_KEY_ALLOWLISTS,
  oldId: string,
  options?: { existingSystemKey?: string; isSystem?: boolean }
): string | undefined {
  const mapped = getSystemKeyForLegacyId(entityType, oldId);
  if (mapped) {
    return mapped;
  }

  // Legacy non-UUID custom entities must NEVER inherit or retain an allowlisted existingSystemKey
  if (!isValidUUID(oldId)) {
    return undefined;
  }

  const existingSystemKey = options?.existingSystemKey;
  if (!existingSystemKey || !SYSTEM_KEY_ALLOWLISTS[entityType].has(existingSystemKey)) {
    return undefined;
  }

  // Respect isSystem flag on categories: custom categories (isSystem === false) cannot hold core system keys
  if (entityType === 'category' && options?.isSystem === false) {
    if (!PRESET_CATEGORY_SYSTEM_KEYS.has(existingSystemKey)) {
      return undefined;
    }
  }

  return existingSystemKey;
}

function assertUniqueSystemKeys<T extends { id: string; systemKey?: string }>(
  items: T[],
  collectionName: string
): void {
  const seenKeys = new Map<string, string>();
  const duplicates: string[] = [];
  for (const item of items) {
    if (!item.systemKey) continue;
    const prevId = seenKeys.get(item.systemKey);
    if (prevId) {
      duplicates.push(
        `${collectionName}: systemKey "${item.systemKey}" dipakai ganda oleh "${prevId}" dan "${item.id}".`
      );
    } else {
      seenKeys.set(item.systemKey, item.id);
    }
  }
  if (duplicates.length > 0) {
    throw new MigrationIntegrityError(
      'DUPLICATE_SYSTEM_KEY',
      `Migrasi dibatalkan karena konflik systemKey pada ${collectionName}.`,
      duplicates
    );
  }
}

function resolveRequiredForeignKey(
  oldValue: unknown,
  targetLookup: CollectionLookup,
  contextLabel: string,
  orphanErrors: string[]
): string {
  if (typeof oldValue !== 'string' || oldValue.trim().length === 0) {
    orphanErrors.push(`${contextLabel}: foreign key wajib kosong atau tidak valid.`);
    return '';
  }
  const mapped = lookupIdFromCollection(oldValue, targetLookup);
  if (!mapped) {
    orphanErrors.push(`${contextLabel}: referensi "${oldValue}" tidak ditemukan pada entitas induk.`);
    return '';
  }
  return mapped;
}

function resolveOptionalForeignKey(
  oldValue: unknown,
  targetLookup: CollectionLookup,
  contextLabel: string,
  orphanErrors: string[]
): string | undefined {
  if (oldValue === undefined || oldValue === null || oldValue === '') {
    return undefined;
  }
  if (typeof oldValue !== 'string') {
    orphanErrors.push(`${contextLabel}: foreign key opsional bukan string.`);
    return undefined;
  }
  const mapped = lookupIdFromCollection(oldValue, targetLookup);
  if (!mapped) {
    orphanErrors.push(`${contextLabel}: referensi opsional "${oldValue}" tidak ditemukan pada entitas induk.`);
    return undefined;
  }
  return mapped;
}

function computeBalancesSnapshot(state: FinanceState): Record<string, number> {
  const balances: Record<string, number> = {};
  const exactAccountIds = new Set<string>();
  const lowerUuidAccountMap = new Map<string, string>();

  for (const acc of state.accounts) {
    balances[acc.id] = acc.openingBalance;
    exactAccountIds.add(acc.id);
    if (isValidUUID(acc.id)) {
      lowerUuidAccountMap.set(acc.id.toLowerCase(), acc.id);
    }
  }

  const resolveAccountBalanceKey = (accountId: string): string => {
    if (exactAccountIds.has(accountId)) {
      return accountId;
    }
    if (isValidUUID(accountId)) {
      return lowerUuidAccountMap.get(accountId.toLowerCase()) ?? accountId;
    }
    return accountId;
  };

  for (const tx of state.transactions) {
    if (tx.isVoided || Boolean(tx.deletedAt) || tx.affectsAccountBalance === false) continue;
    const accKey = resolveAccountBalanceKey(tx.accountId);
    const prev = balances[accKey] ?? 0;
    balances[accKey] = tx.type === 'income' ? prev + tx.amount : prev - tx.amount;
  }

  for (const tr of state.transfers) {
    if (Boolean(tr.deletedAt)) continue;
    const fromKey = resolveAccountBalanceKey(tr.fromAccountId);
    const toKey = resolveAccountBalanceKey(tr.toAccountId);
    balances[fromKey] = (balances[fromKey] ?? 0) - tr.amount;
    balances[toKey] = (balances[toKey] ?? 0) + tr.amount;
  }

  return balances;
}

function remapReminderStates(
  reminderStates: Record<string, ReminderActionState> | undefined,
  lookups: {
    obligations: CollectionLookup;
    debts: CollectionLookup;
    goals: CollectionLookup;
    customReminders: CollectionLookup;
    physicalItemLoans: CollectionLookup;
  }
): Record<string, ReminderActionState> | undefined {
  if (!reminderStates) return undefined;

  const remapped: Record<string, ReminderActionState> = {};
  for (const [key, value] of Object.entries(reminderStates)) {
    if (key.startsWith('rem-ob-')) {
      const oldId = key.slice('rem-ob-'.length);
      remapped[`rem-ob-${lookupIdFromCollection(oldId, lookups.obligations) ?? oldId}`] = value;
    } else if (key.startsWith('rem-debt-')) {
      const oldId = key.slice('rem-debt-'.length);
      remapped[`rem-debt-${lookupIdFromCollection(oldId, lookups.debts) ?? oldId}`] = value;
    } else if (key.startsWith('rem-goal-')) {
      const oldId = key.slice('rem-goal-'.length);
      remapped[`rem-goal-${lookupIdFromCollection(oldId, lookups.goals) ?? oldId}`] = value;
    } else if (key.startsWith('rem-custom-')) {
      const oldId = key.slice('rem-custom-'.length);
      remapped[`rem-custom-${lookupIdFromCollection(oldId, lookups.customReminders) ?? oldId}`] = value;
    } else if (key.startsWith('rem-loan-')) {
      const oldId = key.slice('rem-loan-'.length);
      remapped[`rem-loan-${lookupIdFromCollection(oldId, lookups.physicalItemLoans) ?? oldId}`] = value;
    } else {
      remapped[key] = value;
    }
  }
  return remapped;
}

function remapChangeLogEntityId(
  entry: ChangeLogEntry,
  lookups: {
    accounts: CollectionLookup;
    categories: CollectionLookup;
    transactions: CollectionLookup;
    debts: CollectionLookup;
    obligations: CollectionLookup;
    goals: CollectionLookup;
    splitBills: CollectionLookup;
    custodialFunds: CollectionLookup;
    projectAdvances: CollectionLookup;
    physicalAssets: CollectionLookup;
    physicalItemLoans: CollectionLookup;
  }
): string {
  switch (entry.entityType) {
    case 'account':
      return lookupIdFromCollection(entry.entityId, lookups.accounts) ?? entry.entityId;
    case 'category':
      return lookupIdFromCollection(entry.entityId, lookups.categories) ?? entry.entityId;
    case 'transaction':
      return lookupIdFromCollection(entry.entityId, lookups.transactions) ?? entry.entityId;
    case 'debt':
    case 'receivable':
      return lookupIdFromCollection(entry.entityId, lookups.debts) ?? entry.entityId;
    case 'obligation':
    case 'scheduled_expense':
      return lookupIdFromCollection(entry.entityId, lookups.obligations) ?? entry.entityId;
    case 'goal':
      return lookupIdFromCollection(entry.entityId, lookups.goals) ?? entry.entityId;
    case 'split_bill':
      return lookupIdFromCollection(entry.entityId, lookups.splitBills) ?? entry.entityId;
    case 'custodial':
      return lookupIdFromCollection(entry.entityId, lookups.custodialFunds) ?? entry.entityId;
    case 'project_advance':
      return lookupIdFromCollection(entry.entityId, lookups.projectAdvances) ?? entry.entityId;
    case 'physical_asset':
      return lookupIdFromCollection(entry.entityId, lookups.physicalAssets) ?? entry.entityId;
    case 'physical_loan':
      return lookupIdFromCollection(entry.entityId, lookups.physicalItemLoans) ?? entry.entityId;
    default:
      return entry.entityId;
  }
}

const REQUIRED_CORE_ARRAYS: ReadonlyArray<keyof FinanceState> = [
  'accounts',
  'categories',
  'transactions',
];

const OPTIONAL_LEGACY_ARRAYS: ReadonlyArray<keyof FinanceState> = [
  'transfers',
  'projects',
  'projectPayments',
  'projectExpenses',
  'debts',
  'debtPayments',
  'splitBills',
  'custodialFunds',
  'projectAdvances',
  'physicalAssets',
  'physicalItemLoans',
  'obligations',
  'obligationLogs',
  'goals',
  'goalContributions',
  'noSpendConfirmations',
  'changeLogs',
];

function validateRawStateShape(rawState: unknown): asserts rawState is Partial<FinanceState> {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    throw new MigrationIntegrityError('INVALID_INPUT', 'State keuangan tidak valid (bukan objek).');
  }

  const candidate = rawState as Record<string, unknown>;
  const errors: string[] = [];

  if (!candidate.settings || typeof candidate.settings !== 'object' || Array.isArray(candidate.settings)) {
    errors.push('settings tidak ditemukan atau tidak valid.');
  } else {
    const rs = (candidate.settings as Record<string, unknown>).reminderSettings;
    if (rs !== undefined) {
      if (!rs || typeof rs !== 'object' || Array.isArray(rs)) {
        errors.push('settings.reminderSettings tidak valid.');
      } else {
        const cr = (rs as Record<string, unknown>).customReminders;
        if (cr !== undefined && !Array.isArray(cr)) {
          errors.push('settings.reminderSettings.customReminders bukan array.');
        }
      }
    }
  }

  for (const key of REQUIRED_CORE_ARRAYS) {
    if (!Array.isArray(candidate[key])) {
      errors.push(`koleksi wajib "${key}" tidak ditemukan atau bukan array.`);
    }
  }

  for (const key of OPTIONAL_LEGACY_ARRAYS) {
    if (candidate[key] !== undefined && !Array.isArray(candidate[key])) {
      errors.push(`koleksi "${key}" ada tetapi bukan array yang valid.`);
    }
  }

  if (errors.length > 0) {
    throw new MigrationIntegrityError(
      'INVALID_INPUT',
      'Struktur FinanceState tidak valid untuk proses migrasi UUID.',
      errors
    );
  }
}

function normalizeCloneForMigration(rawClone: Partial<FinanceState>): FinanceState {
  const rawSettings = rawClone.settings!;
  const defaultReminderSettings: ReminderSettings = {
    enabled: true,
    obligationDaysBefore: 3,
    debtDueDaysBefore: 3,
    dailyNoSpendReminder: true,
    cigaretteLimitAlert: true,
    customReminders: [],
  };

  return {
    ...(rawClone as FinanceState),
    settings: {
      ...rawSettings,
      reminderSettings: rawSettings.reminderSettings
        ? {
            ...rawSettings.reminderSettings,
            customReminders: rawSettings.reminderSettings.customReminders ?? [],
          }
        : defaultReminderSettings,
    },
    accounts: rawClone.accounts ?? [],
    categories: rawClone.categories ?? [],
    transactions: rawClone.transactions ?? [],
    transfers: rawClone.transfers ?? [],
    projects: rawClone.projects ?? [],
    projectPayments: rawClone.projectPayments ?? [],
    projectExpenses: rawClone.projectExpenses ?? [],
    debts: rawClone.debts ?? [],
    debtPayments: rawClone.debtPayments ?? [],
    ...(rawClone.splitBills !== undefined ? { splitBills: rawClone.splitBills } : {}),
    ...(rawClone.custodialFunds !== undefined ? { custodialFunds: rawClone.custodialFunds } : {}),
    ...(rawClone.projectAdvances !== undefined ? { projectAdvances: rawClone.projectAdvances } : {}),
    ...(rawClone.physicalAssets !== undefined ? { physicalAssets: rawClone.physicalAssets } : {}),
    ...(rawClone.physicalItemLoans !== undefined ? { physicalItemLoans: rawClone.physicalItemLoans } : {}),
    obligations: rawClone.obligations ?? [],
    obligationLogs: rawClone.obligationLogs ?? [],
    goals: rawClone.goals ?? [],
    goalContributions: rawClone.goalContributions ?? [],
    noSpendConfirmations: rawClone.noSpendConfirmations ?? [],
    ...(rawClone.changeLogs !== undefined ? { changeLogs: rawClone.changeLogs } : {}),
  };
}

function verifyPostMigrationInvariants(
  before: FinanceState,
  after: FinanceState,
  lookups: {
    accounts: CollectionLookup;
  },
  balancesBefore: Record<string, number>,
  balancesAfter: Record<string, number>
): void {
  const invariantErrors: string[] = [];

  const uuidCollections: Array<[string, Array<{ id: string }>]> = [
    ['accounts', after.accounts],
    ['categories', after.categories],
    ['projects', after.projects],
    ['debts', after.debts],
    ['obligations', after.obligations],
    ['goals', after.goals],
    ['splitBills', after.splitBills ?? []],
    ['custodialFunds', after.custodialFunds ?? []],
    ['projectAdvances', after.projectAdvances ?? []],
    ['physicalAssets', after.physicalAssets ?? []],
    ['physicalItemLoans', after.physicalItemLoans ?? []],
    ['transactions', after.transactions],
    ['transfers', after.transfers],
    ['projectPayments', after.projectPayments],
    ['projectExpenses', after.projectExpenses],
    ['debtPayments', after.debtPayments],
    ['obligationLogs', after.obligationLogs],
    ['goalContributions', after.goalContributions],
    ['changeLogs', after.changeLogs ?? []],
    ['customReminders', after.settings.reminderSettings?.customReminders ?? []],
  ];

  for (const [name, list] of uuidCollections) {
    const seen = new Set<string>();
    for (const item of list) {
      if (!isValidUUID(item.id)) {
        invariantErrors.push(`${name}: ID "${item.id}" bukan UUID valid setelah migrasi.`);
      }
      const canonical = item.id.toLowerCase();
      if (seen.has(canonical)) {
        invariantErrors.push(`${name}: ID duplikat "${item.id}" setelah migrasi.`);
      }
      seen.add(canonical);
    }
  }

  const countPairs: Array<[string, number, number]> = [
    ['accounts', before.accounts.length, after.accounts.length],
    ['categories', before.categories.length, after.categories.length],
    ['transactions', before.transactions.length, after.transactions.length],
    ['transfers', before.transfers.length, after.transfers.length],
    ['projects', before.projects.length, after.projects.length],
    ['projectPayments', before.projectPayments.length, after.projectPayments.length],
    ['projectExpenses', before.projectExpenses.length, after.projectExpenses.length],
    ['debts', before.debts.length, after.debts.length],
    ['debtPayments', before.debtPayments.length, after.debtPayments.length],
    ['splitBills', (before.splitBills ?? []).length, (after.splitBills ?? []).length],
    ['custodialFunds', (before.custodialFunds ?? []).length, (after.custodialFunds ?? []).length],
    ['projectAdvances', (before.projectAdvances ?? []).length, (after.projectAdvances ?? []).length],
    ['physicalAssets', (before.physicalAssets ?? []).length, (after.physicalAssets ?? []).length],
    ['physicalItemLoans', (before.physicalItemLoans ?? []).length, (after.physicalItemLoans ?? []).length],
    ['obligations', before.obligations.length, after.obligations.length],
    ['obligationLogs', before.obligationLogs.length, after.obligationLogs.length],
    ['goals', before.goals.length, after.goals.length],
    ['goalContributions', before.goalContributions.length, after.goalContributions.length],
    ['noSpendConfirmations', before.noSpendConfirmations.length, after.noSpendConfirmations.length],
    ['changeLogs', (before.changeLogs ?? []).length, (after.changeLogs ?? []).length],
    [
      'customReminders',
      (before.settings.reminderSettings?.customReminders ?? []).length,
      (after.settings.reminderSettings?.customReminders ?? []).length,
    ],
  ];

  for (const [name, bCount, aCount] of countPairs) {
    if (bCount !== aCount) {
      invariantErrors.push(`${name}: jumlah entitas berubah (${bCount} -> ${aCount}).`);
    }
  }

  for (const [oldAccId, newAccId] of Object.entries(lookups.accounts.exactMap)) {
    const balBefore = balancesBefore[oldAccId];
    const balAfter = balancesAfter[newAccId];
    if (balBefore !== balAfter) {
      invariantErrors.push(
        `Saldo akun "${oldAccId}" -> "${newAccId}" berubah (${balBefore} -> ${balAfter}).`
      );
    }
  }

  const afterAccountIds = new Set(after.accounts.map((a) => a.id));
  const afterCategoryIds = new Set(after.categories.map((c) => c.id));
  const afterProjectIds = new Set(after.projects.map((p) => p.id));
  const afterProjectPaymentIds = new Set(after.projectPayments.map((pp) => pp.id));
  const afterProjectExpenseIds = new Set(after.projectExpenses.map((pe) => pe.id));
  const afterDebtIds = new Set(after.debts.map((d) => d.id));
  const afterSplitBillIds = new Set((after.splitBills ?? []).map((sb) => sb.id));
  const afterCustodialIds = new Set((after.custodialFunds ?? []).map((cf) => cf.id));
  const afterAdvanceIds = new Set((after.projectAdvances ?? []).map((pa) => pa.id));
  const afterAssetIds = new Set((after.physicalAssets ?? []).map((pa) => pa.id));
  const afterPhysicalLoanIds = new Set((after.physicalItemLoans ?? []).map((pl) => pl.id));
  const afterObligationIds = new Set(after.obligations.map((o) => o.id));
  const afterGoalIds = new Set(after.goals.map((g) => g.id));
  const afterTxIds = new Set(after.transactions.map((t) => t.id));
  const afterTransferIds = new Set(after.transfers.map((tr) => tr.id));

  for (const tx of after.transactions) {
    if (!afterAccountIds.has(tx.accountId)) {
      invariantErrors.push(`transactions[${tx.id}].accountId "${tx.accountId}" yatim pasca-migrasi.`);
    }
    if (!afterCategoryIds.has(tx.categoryId)) {
      invariantErrors.push(`transactions[${tx.id}].categoryId "${tx.categoryId}" yatim pasca-migrasi.`);
    }
    if (tx.projectId && !afterProjectIds.has(tx.projectId)) {
      invariantErrors.push(`transactions[${tx.id}].projectId "${tx.projectId}" yatim pasca-migrasi.`);
    }
    if (tx.debtId && !afterDebtIds.has(tx.debtId)) {
      invariantErrors.push(`transactions[${tx.id}].debtId "${tx.debtId}" yatim pasca-migrasi.`);
    }
    if (tx.splitBillId && !afterSplitBillIds.has(tx.splitBillId)) {
      invariantErrors.push(`transactions[${tx.id}].splitBillId "${tx.splitBillId}" yatim pasca-migrasi.`);
    }
    if (tx.custodialFundId && !afterCustodialIds.has(tx.custodialFundId)) {
      invariantErrors.push(`transactions[${tx.id}].custodialFundId "${tx.custodialFundId}" yatim pasca-migrasi.`);
    }
    if (tx.projectAdvanceId && !afterAdvanceIds.has(tx.projectAdvanceId)) {
      invariantErrors.push(`transactions[${tx.id}].projectAdvanceId "${tx.projectAdvanceId}" yatim pasca-migrasi.`);
    }
    if (tx.assetId && !afterAssetIds.has(tx.assetId)) {
      invariantErrors.push(`transactions[${tx.id}].assetId "${tx.assetId}" yatim pasca-migrasi.`);
    }
    if (tx.physicalLoanId && !afterPhysicalLoanIds.has(tx.physicalLoanId)) {
      invariantErrors.push(`transactions[${tx.id}].physicalLoanId "${tx.physicalLoanId}" yatim pasca-migrasi.`);
    }
    if (tx.parentTransactionId && !afterTxIds.has(tx.parentTransactionId)) {
      invariantErrors.push(`transactions[${tx.id}].parentTransactionId "${tx.parentTransactionId}" yatim pasca-migrasi.`);
    }
  }

  for (const debt of after.debts) {
    if (debt.accountId && !afterAccountIds.has(debt.accountId)) {
      invariantErrors.push(`debts[${debt.id}].accountId "${debt.accountId}" yatim pasca-migrasi.`);
    }
    if (debt.expenseCategoryId && !afterCategoryIds.has(debt.expenseCategoryId)) {
      invariantErrors.push(
        `debts[${debt.id}].expenseCategoryId "${debt.expenseCategoryId}" yatim pasca-migrasi.`
      );
    }
    if (debt.transactionId && !afterTxIds.has(debt.transactionId)) {
      invariantErrors.push(
        `debts[${debt.id}].transactionId "${debt.transactionId}" yatim pasca-migrasi.`
      );
    }
    if (debt.projectId && !afterProjectIds.has(debt.projectId)) {
      invariantErrors.push(`debts[${debt.id}].projectId "${debt.projectId}" yatim pasca-migrasi.`);
    }
    if (debt.projectPaymentId && !afterProjectPaymentIds.has(debt.projectPaymentId)) {
      invariantErrors.push(
        `debts[${debt.id}].projectPaymentId "${debt.projectPaymentId}" yatim pasca-migrasi.`
      );
    }
    if (debt.projectExpenseId && !afterProjectExpenseIds.has(debt.projectExpenseId)) {
      invariantErrors.push(
        `debts[${debt.id}].projectExpenseId "${debt.projectExpenseId}" yatim pasca-migrasi.`
      );
    }
    if (debt.splitBillId && !afterSplitBillIds.has(debt.splitBillId)) {
      invariantErrors.push(
        `debts[${debt.id}].splitBillId "${debt.splitBillId}" yatim pasca-migrasi.`
      );
    }
    if (debt.linkedDebtId && !afterDebtIds.has(debt.linkedDebtId)) {
      invariantErrors.push(
        `debts[${debt.id}].linkedDebtId "${debt.linkedDebtId}" yatim pasca-migrasi.`
      );
    }
    if (debt.assetId && !afterAssetIds.has(debt.assetId)) {
      invariantErrors.push(
        `debts[${debt.id}].assetId "${debt.assetId}" yatim pasca-migrasi.`
      );
    }
    if (debt.physicalLoanId && !afterPhysicalLoanIds.has(debt.physicalLoanId)) {
      invariantErrors.push(
        `debts[${debt.id}].physicalLoanId "${debt.physicalLoanId}" yatim pasca-migrasi.`
      );
    }
    for (const wh of debt.writeOffHistory ?? []) {
      if (wh.transactionId && !afterTxIds.has(wh.transactionId)) {
        invariantErrors.push(
          `debts[${debt.id}].writeOffHistory[${wh.id}].transactionId "${wh.transactionId}" yatim pasca-migrasi.`
        );
      }
    }
  }

  for (const sb of after.splitBills ?? []) {
    if (!afterAccountIds.has(sb.accountId)) {
      invariantErrors.push(`splitBills[${sb.id}].accountId yatim pasca-migrasi.`);
    }
    if (!afterCategoryIds.has(sb.categoryId)) {
      invariantErrors.push(`splitBills[${sb.id}].categoryId yatim pasca-migrasi.`);
    }
    if (!afterTxIds.has(sb.paymentTransactionId)) {
      invariantErrors.push(`splitBills[${sb.id}].paymentTransactionId yatim pasca-migrasi.`);
    }
    if (sb.personalShareTransactionId && !afterTxIds.has(sb.personalShareTransactionId)) {
      invariantErrors.push(`splitBills[${sb.id}].personalShareTransactionId yatim pasca-migrasi.`);
    }
    for (const part of sb.participants) {
      if (!isValidUUID(part.id)) {
        invariantErrors.push(`splitBills[${sb.id}].participants[${part.id}] bukan UUID valid pasca-migrasi.`);
      }
      if (!afterDebtIds.has(part.debtId)) {
        invariantErrors.push(`splitBills[${sb.id}].participants[${part.id}].debtId yatim pasca-migrasi.`);
      }
    }
  }

  for (const cf of after.custodialFunds ?? []) {
    if (!afterAccountIds.has(cf.holdingAccountId)) {
      invariantErrors.push(`custodialFunds[${cf.id}].holdingAccountId yatim pasca-migrasi.`);
    }
    if (!afterTxIds.has(cf.receiptTransactionId)) {
      invariantErrors.push(`custodialFunds[${cf.id}].receiptTransactionId yatim pasca-migrasi.`);
    }
    for (const alloc of cf.fundAllocations ?? []) {
      if (!afterAccountIds.has(alloc.accountId)) {
        invariantErrors.push(`custodialFunds[${cf.id}].fundAllocations.accountId "${alloc.accountId}" yatim pasca-migrasi.`);
      }
    }
    for (const ret of cf.returns ?? []) {
      if (!afterAccountIds.has(ret.accountId) || !afterTxIds.has(ret.transactionId)) {
        invariantErrors.push(`custodialFunds[${cf.id}].returns[${ret.id}] memiliki FK yatim pasca-migrasi.`);
      }
    }
  }

  for (const pa of after.projectAdvances ?? []) {
    if (!afterProjectIds.has(pa.projectId)) {
      invariantErrors.push(`projectAdvances[${pa.id}].projectId yatim pasca-migrasi.`);
    }
    if (!afterAccountIds.has(pa.holdingAccountId)) {
      invariantErrors.push(`projectAdvances[${pa.id}].holdingAccountId yatim pasca-migrasi.`);
    }
    if (!afterTxIds.has(pa.receiptTransactionId)) {
      invariantErrors.push(`projectAdvances[${pa.id}].receiptTransactionId yatim pasca-migrasi.`);
    }
    for (const alloc of pa.fundAllocations ?? []) {
      if (!afterAccountIds.has(alloc.accountId)) {
        invariantErrors.push(`projectAdvances[${pa.id}].fundAllocations.accountId "${alloc.accountId}" yatim pasca-migrasi.`);
      }
    }
    for (const rec of pa.recognitions ?? []) {
      if (!afterTxIds.has(rec.transactionId)) {
        invariantErrors.push(`projectAdvances[${pa.id}].recognitions[${rec.id}].transactionId yatim pasca-migrasi.`);
      }
      for (const delta of rec.allocationDeltas ?? []) {
        if (!afterAccountIds.has(delta.accountId)) {
          invariantErrors.push(`projectAdvances[${pa.id}].recognitions[${rec.id}].allocationDeltas.accountId yatim pasca-migrasi.`);
        }
      }
    }
    for (const ref of pa.refunds ?? []) {
      if (!afterAccountIds.has(ref.accountId) || !afterTxIds.has(ref.transactionId)) {
        invariantErrors.push(`projectAdvances[${pa.id}].refunds[${ref.id}] memiliki FK yatim pasca-migrasi.`);
      }
    }
  }

  for (const asset of after.physicalAssets ?? []) {
    if (asset.accountId && !afterAccountIds.has(asset.accountId)) {
      invariantErrors.push(`physicalAssets[${asset.id}].accountId yatim pasca-migrasi.`);
    }
    if (asset.purchaseTransactionId && !afterTxIds.has(asset.purchaseTransactionId)) {
      invariantErrors.push(`physicalAssets[${asset.id}].purchaseTransactionId yatim pasca-migrasi.`);
    }
    if (asset.downPaymentTransactionId && !afterTxIds.has(asset.downPaymentTransactionId)) {
      invariantErrors.push(`physicalAssets[${asset.id}].downPaymentTransactionId yatim pasca-migrasi.`);
    }
    if (asset.purchaseDebtId && !afterDebtIds.has(asset.purchaseDebtId)) {
      invariantErrors.push(`physicalAssets[${asset.id}].purchaseDebtId yatim pasca-migrasi.`);
    }
    if (asset.disposal) {
      if (asset.disposal.saleAccountId && !afterAccountIds.has(asset.disposal.saleAccountId)) {
        invariantErrors.push(`physicalAssets[${asset.id}].disposal.saleAccountId yatim pasca-migrasi.`);
      }
      if (asset.disposal.saleTransactionId && !afterTxIds.has(asset.disposal.saleTransactionId)) {
        invariantErrors.push(`physicalAssets[${asset.id}].disposal.saleTransactionId yatim pasca-migrasi.`);
      }
      if (asset.disposal.receivableId && !afterDebtIds.has(asset.disposal.receivableId)) {
        invariantErrors.push(`physicalAssets[${asset.id}].disposal.receivableId yatim pasca-migrasi.`);
      }
    }
    for (const lr of asset.lossHistory ?? []) {
      if (lr.loanId && !afterPhysicalLoanIds.has(lr.loanId)) {
        invariantErrors.push(`physicalAssets[${asset.id}].lossHistory[${lr.id}].loanId yatim pasca-migrasi.`);
      }
      if (lr.compensationDebtId && !afterDebtIds.has(lr.compensationDebtId)) {
        invariantErrors.push(`physicalAssets[${asset.id}].lossHistory[${lr.id}].compensationDebtId yatim pasca-migrasi.`);
      }
    }
  }

  for (const loan of after.physicalItemLoans ?? []) {
    if (loan.assetId && !afterAssetIds.has(loan.assetId)) {
      invariantErrors.push(`physicalItemLoans[${loan.id}].assetId yatim pasca-migrasi.`);
    }
    if (loan.compensationDebtId && !afterDebtIds.has(loan.compensationDebtId)) {
      invariantErrors.push(`physicalItemLoans[${loan.id}].compensationDebtId yatim pasca-migrasi.`);
    }
  }

  for (const tr of after.transfers) {
    if (!afterAccountIds.has(tr.fromAccountId) || !afterAccountIds.has(tr.toAccountId)) {
      invariantErrors.push(`transfers[${tr.id}] memiliki accountId yatim pasca-migrasi.`);
    }
    for (const mv of tr.restrictedMovements ?? []) {
      if (mv.fundType === 'custodial' && !afterCustodialIds.has(mv.fundId)) {
        invariantErrors.push(`transfers[${tr.id}].restrictedMovements.fundId "${mv.fundId}" (custodial) yatim pasca-migrasi.`);
      }
      if (mv.fundType === 'project_advance' && !afterAdvanceIds.has(mv.fundId)) {
        invariantErrors.push(`transfers[${tr.id}].restrictedMovements.fundId "${mv.fundId}" (project_advance) yatim pasca-migrasi.`);
      }
    }
  }

  for (const pp of after.projectPayments) {
    if (!afterProjectIds.has(pp.projectId)) {
      invariantErrors.push(`projectPayments[${pp.id}].projectId yatim pasca-migrasi.`);
    }
    if (pp.accountId && !afterAccountIds.has(pp.accountId)) {
      invariantErrors.push(`projectPayments[${pp.id}].accountId yatim pasca-migrasi.`);
    }
    if (pp.transactionId && !afterTxIds.has(pp.transactionId)) {
      invariantErrors.push(`projectPayments[${pp.id}].transactionId yatim pasca-migrasi.`);
    }
  }

  for (const pe of after.projectExpenses) {
    if (!afterProjectIds.has(pe.projectId) || !afterAccountIds.has(pe.accountId)) {
      invariantErrors.push(`projectExpenses[${pe.id}] memiliki FK induk yatim pasca-migrasi.`);
    }
    if (pe.transactionId && !afterTxIds.has(pe.transactionId)) {
      invariantErrors.push(`projectExpenses[${pe.id}].transactionId yatim pasca-migrasi.`);
    }
    if (pe.linkedReceivableId && !afterDebtIds.has(pe.linkedReceivableId)) {
      invariantErrors.push(`projectExpenses[${pe.id}].linkedReceivableId "${pe.linkedReceivableId}" yatim pasca-migrasi.`);
    }
  }

  for (const dp of after.debtPayments) {
    if (!afterDebtIds.has(dp.debtId) || !afterAccountIds.has(dp.accountId)) {
      invariantErrors.push(`debtPayments[${dp.id}] memiliki FK induk yatim pasca-migrasi.`);
    }
    if (dp.transactionId && !afterTxIds.has(dp.transactionId)) {
      invariantErrors.push(`debtPayments[${dp.id}].transactionId yatim pasca-migrasi.`);
    }
  }

  for (const ob of after.obligations) {
    if (ob.reallocatedToGoalId && !afterGoalIds.has(ob.reallocatedToGoalId)) {
      invariantErrors.push(`obligations[${ob.id}].reallocatedToGoalId yatim pasca-migrasi.`);
    }
    if (ob.linkedDebtId && !afterDebtIds.has(ob.linkedDebtId)) {
      invariantErrors.push(`obligations[${ob.id}].linkedDebtId "${ob.linkedDebtId}" yatim pasca-migrasi.`);
    }
  }

  for (const ol of after.obligationLogs) {
    if (!afterObligationIds.has(ol.obligationId)) {
      invariantErrors.push(`obligationLogs[${ol.id}].obligationId yatim pasca-migrasi.`);
    }
    if (ol.accountId && !afterAccountIds.has(ol.accountId)) {
      invariantErrors.push(`obligationLogs[${ol.id}].accountId yatim pasca-migrasi.`);
    }
    if (ol.transactionId && !afterTxIds.has(ol.transactionId)) {
      invariantErrors.push(`obligationLogs[${ol.id}].transactionId yatim pasca-migrasi.`);
    }
  }

  for (const gc of after.goalContributions) {
    if (!afterGoalIds.has(gc.goalId) || !afterAccountIds.has(gc.fromAccountId)) {
      invariantErrors.push(`goalContributions[${gc.id}] memiliki FK induk yatim pasca-migrasi.`);
    }
    if (gc.toAccountId && !afterAccountIds.has(gc.toAccountId)) {
      invariantErrors.push(`goalContributions[${gc.id}].toAccountId yatim pasca-migrasi.`);
    }
    if (gc.transferId && !afterTransferIds.has(gc.transferId)) {
      invariantErrors.push(`goalContributions[${gc.id}].transferId yatim pasca-migrasi.`);
    }
  }

  if (invariantErrors.length > 0) {
    throw new MigrationIntegrityError(
      'INVARIANT_MISMATCH',
      'Validasi invarian pasca-migrasi gagal.',
      invariantErrors
    );
  }
}

/**
 * Pure clone-based UUID migration utility.
 * Does NOT overwrite active localStorage state keys and is NOT automatically invoked on app boot.
 */
export function migrateFinanceStateToUUID(
  rawState: FinanceState | Partial<FinanceState>,
  options: MigrateFinanceStateOptions = {}
): MigrateFinanceStateResult {
  validateRawStateShape(rawState);

  const nowISO = options.nowISO ?? new Date().toISOString();
  // Clone raw input BEFORE any defaults/normalization so backup captures exact raw snapshot
  const rawClone = deepClone(rawState);
  const saveBackup = options.saveBackup ?? true;

  let backupKey = getPreUuidBackupKey(options.userId);
  let backupSaved = false;
  let preservedExistingBackup = false;

  if (saveBackup) {
    const backupRes = savePreMigrationRawBackup(rawClone, {
      userId: options.userId,
      storage: options.storage,
      nowISO,
    });
    backupKey = backupRes.backupKey;
    backupSaved = backupRes.backupSaved;
    preservedExistingBackup = backupRes.preservedExistingBackup;
  }

  // Normalize missing optional collections explicitly ONLY on working clone after raw backup
  const clone = normalizeCloneForMigration(rawClone);

  const statsCounter = { mappedIdsCount: 0, preservedUuidsCount: 0 };

  const lookups = {
    accounts: buildCollectionLookup(clone.accounts, 'accounts', statsCounter),
    categories: buildCollectionLookup(clone.categories, 'categories', statsCounter),
    projects: buildCollectionLookup(clone.projects, 'projects', statsCounter),
    debts: buildCollectionLookup(clone.debts, 'debts', statsCounter),
    obligations: buildCollectionLookup(clone.obligations, 'obligations', statsCounter),
    goals: buildCollectionLookup(clone.goals, 'goals', statsCounter),
    splitBills: buildCollectionLookup(clone.splitBills ?? [], 'splitBills', statsCounter),
    custodialFunds: buildCollectionLookup(clone.custodialFunds ?? [], 'custodialFunds', statsCounter),
    projectAdvances: buildCollectionLookup(clone.projectAdvances ?? [], 'projectAdvances', statsCounter),
    physicalAssets: buildCollectionLookup(clone.physicalAssets ?? [], 'physicalAssets', statsCounter),
    physicalItemLoans: buildCollectionLookup(clone.physicalItemLoans ?? [], 'physicalItemLoans', statsCounter),
    transactions: buildCollectionLookup(clone.transactions, 'transactions', statsCounter),
    transfers: buildCollectionLookup(clone.transfers, 'transfers', statsCounter),
    projectPayments: buildCollectionLookup(clone.projectPayments, 'projectPayments', statsCounter),
    projectExpenses: buildCollectionLookup(clone.projectExpenses, 'projectExpenses', statsCounter),
    debtPayments: buildCollectionLookup(clone.debtPayments, 'debtPayments', statsCounter),
    obligationLogs: buildCollectionLookup(clone.obligationLogs, 'obligationLogs', statsCounter),
    goalContributions: buildCollectionLookup(clone.goalContributions, 'goalContributions', statsCounter),
    changeLogs: buildCollectionLookup(clone.changeLogs ?? [], 'changeLogs', statsCounter),
    customReminders: buildCollectionLookup(
      clone.settings.reminderSettings?.customReminders ?? [],
      'customReminders',
      statsCounter
    ),
  };

  const idMap: MigrationIdMaps = {
    accounts: lookups.accounts.exactMap,
    categories: lookups.categories.exactMap,
    projects: lookups.projects.exactMap,
    debts: lookups.debts.exactMap,
    obligations: lookups.obligations.exactMap,
    goals: lookups.goals.exactMap,
    splitBills: lookups.splitBills.exactMap,
    custodialFunds: lookups.custodialFunds.exactMap,
    projectAdvances: lookups.projectAdvances.exactMap,
    physicalAssets: lookups.physicalAssets.exactMap,
    physicalItemLoans: lookups.physicalItemLoans.exactMap,
    transactions: lookups.transactions.exactMap,
    transfers: lookups.transfers.exactMap,
    projectPayments: lookups.projectPayments.exactMap,
    projectExpenses: lookups.projectExpenses.exactMap,
    debtPayments: lookups.debtPayments.exactMap,
    obligationLogs: lookups.obligationLogs.exactMap,
    goalContributions: lookups.goalContributions.exactMap,
    changeLogs: lookups.changeLogs.exactMap,
    customReminders: lookups.customReminders.exactMap,
  };

  const ledgerGroupMap = new Map<string, string>();
  const resolveLedgerGroupId = (oldGroupId: string | undefined): string | undefined => {
    if (!oldGroupId) return undefined;
    if (isValidUUID(oldGroupId)) return oldGroupId.toLowerCase();
    const existing = ledgerGroupMap.get(oldGroupId);
    if (existing) return existing;
    const generated = generateId().toLowerCase();
    ledgerGroupMap.set(oldGroupId, generated);
    return generated;
  };
  const remapNestedEntryId = (oldId: string): string => {
    if (isValidUUID(oldId)) return oldId.toLowerCase();
    return generateId().toLowerCase();
  };

  const orphanErrors: string[] = [];

  const accounts: Account[] = clone.accounts.map((acc) => {
    const systemKey = resolveSystemKey('account', acc.id, {
      existingSystemKey: acc.systemKey,
    });
    const next: Account = {
      ...acc,
      id: idMap.accounts[acc.id],
      updatedAt: acc.updatedAt ?? nowISO,
    };
    if (systemKey) {
      next.systemKey = systemKey;
    } else {
      delete next.systemKey;
    }
    return next;
  });
  assertUniqueSystemKeys(accounts, 'accounts');

  const categories: Category[] = clone.categories.map((cat) => {
    const systemKey = resolveSystemKey('category', cat.id, {
      existingSystemKey: cat.systemKey,
      isSystem: cat.isSystem,
    });
    const next: Category = {
      ...cat,
      id: idMap.categories[cat.id],
      updatedAt: cat.updatedAt ?? nowISO,
    };
    if (systemKey) {
      next.systemKey = systemKey;
    } else {
      delete next.systemKey;
    }
    return next;
  });
  assertUniqueSystemKeys(categories, 'categories');

  const projects: FreelanceProject[] = clone.projects.map((proj) => ({
    ...proj,
    id: idMap.projects[proj.id],
    updatedAt: proj.updatedAt ?? nowISO,
  }));

  const debts: Debt[] = clone.debts.map((debt) => {
    const systemKey = resolveSystemKey('debt', debt.id, {
      existingSystemKey: debt.systemKey,
    });
    const next: Debt = {
      ...debt,
      id: idMap.debts[debt.id],
      accountId: resolveOptionalForeignKey(
        debt.accountId,
        lookups.accounts,
        `debts[${debt.id}].accountId`,
        orphanErrors
      ),
      expenseCategoryId: resolveOptionalForeignKey(
        debt.expenseCategoryId,
        lookups.categories,
        `debts[${debt.id}].expenseCategoryId`,
        orphanErrors
      ),
      transactionId: resolveOptionalForeignKey(
        debt.transactionId,
        lookups.transactions,
        `debts[${debt.id}].transactionId`,
        orphanErrors
      ),
      projectId: resolveOptionalForeignKey(
        debt.projectId,
        lookups.projects,
        `debts[${debt.id}].projectId`,
        orphanErrors
      ),
      projectPaymentId: resolveOptionalForeignKey(
        debt.projectPaymentId,
        lookups.projectPayments,
        `debts[${debt.id}].projectPaymentId`,
        orphanErrors
      ),
      projectExpenseId: resolveOptionalForeignKey(
        debt.projectExpenseId,
        lookups.projectExpenses,
        `debts[${debt.id}].projectExpenseId`,
        orphanErrors
      ),
      splitBillId: resolveOptionalForeignKey(
        debt.splitBillId,
        lookups.splitBills,
        `debts[${debt.id}].splitBillId`,
        orphanErrors
      ),
      linkedDebtId: resolveOptionalForeignKey(
        debt.linkedDebtId,
        lookups.debts,
        `debts[${debt.id}].linkedDebtId`,
        orphanErrors
      ),
      assetId: resolveOptionalForeignKey(
        debt.assetId,
        lookups.physicalAssets,
        `debts[${debt.id}].assetId`,
        orphanErrors
      ),
      physicalLoanId: resolveOptionalForeignKey(
        debt.physicalLoanId,
        lookups.physicalItemLoans,
        `debts[${debt.id}].physicalLoanId`,
        orphanErrors
      ),
      ...(debt.writeOffHistory !== undefined
        ? {
            writeOffHistory: debt.writeOffHistory.map((wh) => ({
              ...wh,
              id: remapNestedEntryId(wh.id),
              transactionId: resolveOptionalForeignKey(
                wh.transactionId,
                lookups.transactions,
                `debts[${debt.id}].writeOffHistory[${wh.id}].transactionId`,
                orphanErrors
              ),
            })),
          }
        : {}),
      updatedAt: debt.updatedAt ?? nowISO,
    };
    if (systemKey) {
      next.systemKey = systemKey;
    } else {
      delete next.systemKey;
    }
    return next;
  });
  assertUniqueSystemKeys(debts, 'debts');

  const goals: SavingsGoal[] = clone.goals.map((goal) => {
    const systemKey = resolveSystemKey('goal', goal.id, {
      existingSystemKey: goal.systemKey,
    });
    const next: SavingsGoal = {
      ...goal,
      id: idMap.goals[goal.id],
      updatedAt: goal.updatedAt ?? nowISO,
    };
    if (systemKey) {
      next.systemKey = systemKey;
    } else {
      delete next.systemKey;
    }
    return next;
  });
  assertUniqueSystemKeys(goals, 'goals');

  const obligations: RecurringObligation[] = clone.obligations.map((ob) => {
    const systemKey = resolveSystemKey('obligation', ob.id, {
      existingSystemKey: ob.systemKey,
    });
    const next: RecurringObligation = {
      ...ob,
      id: idMap.obligations[ob.id],
      reallocatedToGoalId: resolveOptionalForeignKey(
        ob.reallocatedToGoalId,
        lookups.goals,
        `obligations[${ob.id}].reallocatedToGoalId`,
        orphanErrors
      ),
      linkedDebtId: resolveOptionalForeignKey(
        ob.linkedDebtId,
        lookups.debts,
        `obligations[${ob.id}].linkedDebtId`,
        orphanErrors
      ),
      updatedAt: ob.updatedAt ?? nowISO,
    };
    if (systemKey) {
      next.systemKey = systemKey;
    } else {
      delete next.systemKey;
    }
    return next;
  });
  assertUniqueSystemKeys(obligations, 'obligations');

  const transactions: Transaction[] = clone.transactions.map((tx) => ({
    ...tx,
    id: idMap.transactions[tx.id],
    accountId: resolveRequiredForeignKey(
      tx.accountId,
      lookups.accounts,
      `transactions[${tx.id}].accountId`,
      orphanErrors
    ),
    categoryId: resolveRequiredForeignKey(
      tx.categoryId,
      lookups.categories,
      `transactions[${tx.id}].categoryId`,
      orphanErrors
    ),
    projectId: resolveOptionalForeignKey(
      tx.projectId,
      lookups.projects,
      `transactions[${tx.id}].projectId`,
      orphanErrors
    ),
    debtId: resolveOptionalForeignKey(
      tx.debtId,
      lookups.debts,
      `transactions[${tx.id}].debtId`,
      orphanErrors
    ),
    splitBillId: resolveOptionalForeignKey(
      tx.splitBillId,
      lookups.splitBills,
      `transactions[${tx.id}].splitBillId`,
      orphanErrors
    ),
    custodialFundId: resolveOptionalForeignKey(
      tx.custodialFundId,
      lookups.custodialFunds,
      `transactions[${tx.id}].custodialFundId`,
      orphanErrors
    ),
    projectAdvanceId: resolveOptionalForeignKey(
      tx.projectAdvanceId,
      lookups.projectAdvances,
      `transactions[${tx.id}].projectAdvanceId`,
      orphanErrors
    ),
    assetId: resolveOptionalForeignKey(
      tx.assetId,
      lookups.physicalAssets,
      `transactions[${tx.id}].assetId`,
      orphanErrors
    ),
    physicalLoanId: resolveOptionalForeignKey(
      tx.physicalLoanId,
      lookups.physicalItemLoans,
      `transactions[${tx.id}].physicalLoanId`,
      orphanErrors
    ),
    parentTransactionId: resolveOptionalForeignKey(
      tx.parentTransactionId,
      lookups.transactions,
      `transactions[${tx.id}].parentTransactionId`,
      orphanErrors
    ),
    ledgerGroupId: resolveLedgerGroupId(tx.ledgerGroupId),
    updatedAt: tx.updatedAt ?? nowISO,
  }));

  const splitBills: SplitBill[] | undefined = clone.splitBills
    ? clone.splitBills.map((sb) => ({
        ...sb,
        id: idMap.splitBills[sb.id],
        categoryId: resolveRequiredForeignKey(
          sb.categoryId,
          lookups.categories,
          `splitBills[${sb.id}].categoryId`,
          orphanErrors
        ),
        accountId: resolveRequiredForeignKey(
          sb.accountId,
          lookups.accounts,
          `splitBills[${sb.id}].accountId`,
          orphanErrors
        ),
        paymentTransactionId: resolveRequiredForeignKey(
          sb.paymentTransactionId,
          lookups.transactions,
          `splitBills[${sb.id}].paymentTransactionId`,
          orphanErrors
        ),
        personalShareTransactionId: resolveOptionalForeignKey(
          sb.personalShareTransactionId,
          lookups.transactions,
          `splitBills[${sb.id}].personalShareTransactionId`,
          orphanErrors
        ),
        ledgerGroupId: resolveLedgerGroupId(sb.ledgerGroupId) ?? generateId().toLowerCase(),
        participants: sb.participants.map((p) => ({
          ...p,
          id: remapNestedEntryId(p.id),
          debtId: resolveRequiredForeignKey(
            p.debtId,
            lookups.debts,
            `splitBills[${sb.id}].participants[${p.id}].debtId`,
            orphanErrors
          ),
        })),
        updatedAt: sb.updatedAt ?? nowISO,
      }))
    : undefined;

  const custodialFunds: CustodialFund[] | undefined = clone.custodialFunds
    ? clone.custodialFunds.map((cf) => ({
        ...cf,
        id: idMap.custodialFunds[cf.id],
        holdingAccountId: resolveRequiredForeignKey(
          cf.holdingAccountId,
          lookups.accounts,
          `custodialFunds[${cf.id}].holdingAccountId`,
          orphanErrors
        ),
        receiptTransactionId: resolveRequiredForeignKey(
          cf.receiptTransactionId,
          lookups.transactions,
          `custodialFunds[${cf.id}].receiptTransactionId`,
          orphanErrors
        ),
        ledgerGroupId: resolveLedgerGroupId(cf.ledgerGroupId) ?? generateId().toLowerCase(),
        fundAllocations: (cf.fundAllocations ?? []).map((alloc) => ({
          ...alloc,
          accountId: resolveRequiredForeignKey(
            alloc.accountId,
            lookups.accounts,
            `custodialFunds[${cf.id}].fundAllocations.accountId`,
            orphanErrors
          ),
        })),
        returns: (cf.returns ?? []).map((ret) => ({
          ...ret,
          id: remapNestedEntryId(ret.id),
          accountId: resolveRequiredForeignKey(
            ret.accountId,
            lookups.accounts,
            `custodialFunds[${cf.id}].returns[${ret.id}].accountId`,
            orphanErrors
          ),
          transactionId: resolveRequiredForeignKey(
            ret.transactionId,
            lookups.transactions,
            `custodialFunds[${cf.id}].returns[${ret.id}].transactionId`,
            orphanErrors
          ),
        })),
        updatedAt: cf.updatedAt ?? nowISO,
      }))
    : undefined;

  const projectAdvances: ProjectAdvance[] | undefined = clone.projectAdvances
    ? clone.projectAdvances.map((pa) => ({
        ...pa,
        id: idMap.projectAdvances[pa.id],
        projectId: resolveRequiredForeignKey(
          pa.projectId,
          lookups.projects,
          `projectAdvances[${pa.id}].projectId`,
          orphanErrors
        ),
        holdingAccountId: resolveRequiredForeignKey(
          pa.holdingAccountId,
          lookups.accounts,
          `projectAdvances[${pa.id}].holdingAccountId`,
          orphanErrors
        ),
        receiptTransactionId: resolveRequiredForeignKey(
          pa.receiptTransactionId,
          lookups.transactions,
          `projectAdvances[${pa.id}].receiptTransactionId`,
          orphanErrors
        ),
        ledgerGroupId: resolveLedgerGroupId(pa.ledgerGroupId) ?? generateId().toLowerCase(),
        fundAllocations: (pa.fundAllocations ?? []).map((alloc) => ({
          ...alloc,
          accountId: resolveRequiredForeignKey(
            alloc.accountId,
            lookups.accounts,
            `projectAdvances[${pa.id}].fundAllocations.accountId`,
            orphanErrors
          ),
        })),
        recognitions: (pa.recognitions ?? []).map((rec) => ({
          ...rec,
          id: remapNestedEntryId(rec.id),
          transactionId: resolveRequiredForeignKey(
            rec.transactionId,
            lookups.transactions,
            `projectAdvances[${pa.id}].recognitions[${rec.id}].transactionId`,
            orphanErrors
          ),
          ...(rec.allocationDeltas !== undefined
            ? {
                allocationDeltas: rec.allocationDeltas.map((delta) => ({
                  ...delta,
                  accountId: resolveRequiredForeignKey(
                    delta.accountId,
                    lookups.accounts,
                    `projectAdvances[${pa.id}].recognitions[${rec.id}].allocationDeltas.accountId`,
                    orphanErrors
                  ),
                })),
              }
            : {}),
        })),
        refunds: (pa.refunds ?? []).map((ref) => ({
          ...ref,
          id: remapNestedEntryId(ref.id),
          accountId: resolveRequiredForeignKey(
            ref.accountId,
            lookups.accounts,
            `projectAdvances[${pa.id}].refunds[${ref.id}].accountId`,
            orphanErrors
          ),
          transactionId: resolveRequiredForeignKey(
            ref.transactionId,
            lookups.transactions,
            `projectAdvances[${pa.id}].refunds[${ref.id}].transactionId`,
            orphanErrors
          ),
        })),
        updatedAt: pa.updatedAt ?? nowISO,
      }))
    : undefined;

  const lossRecordIdMap = new Map<string, string>();
  const resolveLossRecordId = (oldLossId: string | undefined): string | undefined => {
    if (!oldLossId) return undefined;
    const direct = lossRecordIdMap.get(oldLossId);
    if (direct) return direct;
    if (isValidUUID(oldLossId)) {
      return lossRecordIdMap.get(oldLossId.toLowerCase()) ?? oldLossId.toLowerCase();
    }
    return oldLossId;
  };
  const physicalAssets: PhysicalAsset[] | undefined = clone.physicalAssets
    ? clone.physicalAssets.map((pa) => {
        const remappedLosses = (pa.lossHistory ?? []).map((lr) => {
          const nextLossId = remapNestedEntryId(lr.id);
          lossRecordIdMap.set(lr.id, nextLossId);
          if (isValidUUID(lr.id)) {
            lossRecordIdMap.set(lr.id.toLowerCase(), nextLossId);
          }
          return {
            ...lr,
            id: nextLossId,
            loanId: resolveOptionalForeignKey(
              lr.loanId,
              lookups.physicalItemLoans,
              `physicalAssets[${pa.id}].lossHistory[${lr.id}].loanId`,
              orphanErrors
            ),
            compensationDebtId: resolveOptionalForeignKey(
              lr.compensationDebtId,
              lookups.debts,
              `physicalAssets[${pa.id}].lossHistory[${lr.id}].compensationDebtId`,
              orphanErrors
            ),
          };
        });
        return {
          ...pa,
          id: idMap.physicalAssets[pa.id],
          accountId: resolveOptionalForeignKey(
            pa.accountId,
            lookups.accounts,
            `physicalAssets[${pa.id}].accountId`,
            orphanErrors
          ),
          purchaseTransactionId: resolveOptionalForeignKey(
            pa.purchaseTransactionId,
            lookups.transactions,
            `physicalAssets[${pa.id}].purchaseTransactionId`,
            orphanErrors
          ),
          downPaymentTransactionId: resolveOptionalForeignKey(
            pa.downPaymentTransactionId,
            lookups.transactions,
            `physicalAssets[${pa.id}].downPaymentTransactionId`,
            orphanErrors
          ),
          purchaseDebtId: resolveOptionalForeignKey(
            pa.purchaseDebtId,
            lookups.debts,
            `physicalAssets[${pa.id}].purchaseDebtId`,
            orphanErrors
          ),
          ledgerGroupId: resolveLedgerGroupId(pa.ledgerGroupId) ?? generateId().toLowerCase(),
          conditionHistory: (pa.conditionHistory ?? []).map((ch) => ({
            ...ch,
            id: remapNestedEntryId(ch.id),
          })),
          ...(pa.disposal !== undefined
            ? {
                disposal: {
                  ...pa.disposal,
                  saleAccountId: resolveOptionalForeignKey(
                    pa.disposal.saleAccountId,
                    lookups.accounts,
                    `physicalAssets[${pa.id}].disposal.saleAccountId`,
                    orphanErrors
                  ),
                  saleTransactionId: resolveOptionalForeignKey(
                    pa.disposal.saleTransactionId,
                    lookups.transactions,
                    `physicalAssets[${pa.id}].disposal.saleTransactionId`,
                    orphanErrors
                  ),
                  receivableId: resolveOptionalForeignKey(
                    pa.disposal.receivableId,
                    lookups.debts,
                    `physicalAssets[${pa.id}].disposal.receivableId`,
                    orphanErrors
                  ),
                },
              }
            : {}),
          lossHistory: remappedLosses,
          recoveryHistory: (pa.recoveryHistory ?? []).map((rr) => ({
            ...rr,
            id: remapNestedEntryId(rr.id),
            lossRecordId: resolveLossRecordId(rr.lossRecordId),
          })),
          updatedAt: pa.updatedAt ?? nowISO,
        };
      })
    : undefined;

  const physicalItemLoans: PhysicalItemLoan[] | undefined = clone.physicalItemLoans
    ? clone.physicalItemLoans.map((pl) => ({
        ...pl,
        id: idMap.physicalItemLoans[pl.id],
        assetId: resolveOptionalForeignKey(
          pl.assetId,
          lookups.physicalAssets,
          `physicalItemLoans[${pl.id}].assetId`,
          orphanErrors
        ),
        compensationDebtId: resolveOptionalForeignKey(
          pl.compensationDebtId,
          lookups.debts,
          `physicalItemLoans[${pl.id}].compensationDebtId`,
          orphanErrors
        ),
        lossRecordId: resolveLossRecordId(pl.lossRecordId),
        conditionHistory: (pl.conditionHistory ?? []).map((ch) => ({
          ...ch,
          id: remapNestedEntryId(ch.id),
        })),
        updatedAt: pl.updatedAt ?? nowISO,
      }))
    : undefined;

  const transfers: AccountTransfer[] = clone.transfers.map((tr) => ({
    ...tr,
    id: idMap.transfers[tr.id],
    fromAccountId: resolveRequiredForeignKey(
      tr.fromAccountId,
      lookups.accounts,
      `transfers[${tr.id}].fromAccountId`,
      orphanErrors
    ),
    toAccountId: resolveRequiredForeignKey(
      tr.toAccountId,
      lookups.accounts,
      `transfers[${tr.id}].toAccountId`,
      orphanErrors
    ),
    ...(tr.restrictedMovements !== undefined
      ? {
          restrictedMovements: tr.restrictedMovements.map((mv) => ({
            ...mv,
            fundId: resolveRequiredForeignKey(
              mv.fundId,
              mv.fundType === 'custodial' ? lookups.custodialFunds : lookups.projectAdvances,
              `transfers[${tr.id}].restrictedMovements.fundId`,
              orphanErrors
            ),
          })),
        }
      : {}),
    updatedAt: tr.updatedAt ?? nowISO,
  }));

  const projectPayments: ProjectPayment[] = clone.projectPayments.map((pp) => ({
    ...pp,
    id: idMap.projectPayments[pp.id],
    projectId: resolveRequiredForeignKey(
      pp.projectId,
      lookups.projects,
      `projectPayments[${pp.id}].projectId`,
      orphanErrors
    ),
    accountId: resolveOptionalForeignKey(
      pp.accountId,
      lookups.accounts,
      `projectPayments[${pp.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      pp.transactionId,
      lookups.transactions,
      `projectPayments[${pp.id}].transactionId`,
      orphanErrors
    ),
    updatedAt: pp.updatedAt ?? nowISO,
  }));

  const projectExpenses: ProjectExpense[] = clone.projectExpenses.map((pe) => ({
    ...pe,
    id: idMap.projectExpenses[pe.id],
    projectId: resolveRequiredForeignKey(
      pe.projectId,
      lookups.projects,
      `projectExpenses[${pe.id}].projectId`,
      orphanErrors
    ),
    accountId: resolveRequiredForeignKey(
      pe.accountId,
      lookups.accounts,
      `projectExpenses[${pe.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      pe.transactionId,
      lookups.transactions,
      `projectExpenses[${pe.id}].transactionId`,
      orphanErrors
    ),
    linkedReceivableId: resolveOptionalForeignKey(
      pe.linkedReceivableId,
      lookups.debts,
      `projectExpenses[${pe.id}].linkedReceivableId`,
      orphanErrors
    ),
    updatedAt: pe.updatedAt ?? nowISO,
  }));

  const debtPayments: DebtPayment[] = clone.debtPayments.map((dp) => ({
    ...dp,
    id: idMap.debtPayments[dp.id],
    debtId: resolveRequiredForeignKey(
      dp.debtId,
      lookups.debts,
      `debtPayments[${dp.id}].debtId`,
      orphanErrors
    ),
    accountId: resolveRequiredForeignKey(
      dp.accountId,
      lookups.accounts,
      `debtPayments[${dp.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      dp.transactionId,
      lookups.transactions,
      `debtPayments[${dp.id}].transactionId`,
      orphanErrors
    ),
    updatedAt: dp.updatedAt ?? nowISO,
  }));

  const obligationLogs: ObligationLog[] = clone.obligationLogs.map((ol) => ({
    ...ol,
    id: idMap.obligationLogs[ol.id],
    obligationId: resolveRequiredForeignKey(
      ol.obligationId,
      lookups.obligations,
      `obligationLogs[${ol.id}].obligationId`,
      orphanErrors
    ),
    accountId: resolveOptionalForeignKey(
      ol.accountId,
      lookups.accounts,
      `obligationLogs[${ol.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      ol.transactionId,
      lookups.transactions,
      `obligationLogs[${ol.id}].transactionId`,
      orphanErrors
    ),
    updatedAt: ol.updatedAt ?? nowISO,
  }));

  const goalContributions: GoalContribution[] = clone.goalContributions.map((gc) => ({
    ...gc,
    id: idMap.goalContributions[gc.id],
    goalId: resolveRequiredForeignKey(
      gc.goalId,
      lookups.goals,
      `goalContributions[${gc.id}].goalId`,
      orphanErrors
    ),
    fromAccountId: resolveRequiredForeignKey(
      gc.fromAccountId,
      lookups.accounts,
      `goalContributions[${gc.id}].fromAccountId`,
      orphanErrors
    ),
    toAccountId: resolveOptionalForeignKey(
      gc.toAccountId,
      lookups.accounts,
      `goalContributions[${gc.id}].toAccountId`,
      orphanErrors
    ),
    transferId: resolveOptionalForeignKey(
      gc.transferId,
      lookups.transfers,
      `goalContributions[${gc.id}].transferId`,
      orphanErrors
    ),
    updatedAt: gc.updatedAt ?? nowISO,
  }));

  if (orphanErrors.length > 0) {
    throw new MigrationIntegrityError(
      'ORPHAN_FOREIGN_KEY',
      `Migrasi dibatalkan karena ditemukan ${orphanErrors.length} foreign key yatim/tidak valid.`,
      orphanErrors
    );
  }

  const changeLogs: ChangeLogEntry[] | undefined = clone.changeLogs
    ? clone.changeLogs.map((cl) => ({
        ...cl,
        id: idMap.changeLogs[cl.id],
        entityId: remapChangeLogEntityId(cl, lookups),
      }))
    : undefined;

  const customReminders: CustomReminder[] | undefined = clone.settings.reminderSettings
    ?.customReminders
    ? clone.settings.reminderSettings.customReminders.map((cr) => ({
        ...cr,
        id: idMap.customReminders[cr.id],
      }))
    : undefined;

  const migratedState: FinanceState = {
    ...clone,
    schemaVersion: 3,
    settings: {
      ...clone.settings,
      reminderSettings: {
        ...clone.settings.reminderSettings,
        customReminders: customReminders ?? [],
        reminderStates: remapReminderStates(
          clone.settings.reminderSettings?.reminderStates,
          lookups
        ),
      },
    },
    accounts,
    categories,
    transactions,
    transfers,
    projects,
    projectPayments,
    projectExpenses,
    debts,
    debtPayments,
    ...(splitBills !== undefined ? { splitBills } : {}),
    ...(custodialFunds !== undefined ? { custodialFunds } : {}),
    ...(projectAdvances !== undefined ? { projectAdvances } : {}),
    ...(physicalAssets !== undefined ? { physicalAssets } : {}),
    ...(physicalItemLoans !== undefined ? { physicalItemLoans } : {}),
    obligations,
    obligationLogs,
    goals,
    goalContributions,
    noSpendConfirmations: clone.noSpendConfirmations.map((ns) => ({
      ...ns,
      updatedAt: ns.updatedAt ?? ns.confirmedAt ?? nowISO,
    })),
    ...(changeLogs !== undefined ? { changeLogs } : {}),
  };

  const accountBalancesBefore = computeBalancesSnapshot(clone);
  const accountBalancesAfter = computeBalancesSnapshot(migratedState);

  verifyPostMigrationInvariants(
    clone,
    migratedState,
    lookups,
    accountBalancesBefore,
    accountBalancesAfter
  );

  const entityCounts: Record<string, number> = {
    accounts: migratedState.accounts.length,
    categories: migratedState.categories.length,
    transactions: migratedState.transactions.length,
    transfers: migratedState.transfers.length,
    projects: migratedState.projects.length,
    projectPayments: migratedState.projectPayments.length,
    projectExpenses: migratedState.projectExpenses.length,
    debts: migratedState.debts.length,
    debtPayments: migratedState.debtPayments.length,
    splitBills: (migratedState.splitBills ?? []).length,
    custodialFunds: (migratedState.custodialFunds ?? []).length,
    projectAdvances: (migratedState.projectAdvances ?? []).length,
    physicalAssets: (migratedState.physicalAssets ?? []).length,
    physicalItemLoans: (migratedState.physicalItemLoans ?? []).length,
    obligations: migratedState.obligations.length,
    obligationLogs: migratedState.obligationLogs.length,
    goals: migratedState.goals.length,
    goalContributions: migratedState.goalContributions.length,
    noSpendConfirmations: migratedState.noSpendConfirmations.length,
    changeLogs: (migratedState.changeLogs ?? []).length,
  };

  return {
    migratedState,
    backupKey,
    backupSaved,
    preservedExistingBackup,
    idMap,
    stats: {
      mappedIdsCount: statsCounter.mappedIdsCount,
      preservedUuidsCount: statsCounter.preservedUuidsCount,
      entityCounts,
      accountBalancesBefore,
      accountBalancesAfter,
    },
  };
}

const REMINDER_ENTITY_KEY_RE = /^(rem-ob-|rem-debt-|rem-goal-|rem-custom-|rem-loan-)(.+)$/;

const NON_ENTITY_CHANGELOG_SENTINELS: Readonly<Record<string, ReadonlySet<string>>> = {
  category: new Set(['presets']),
};

function hasNonUuidString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !isValidUUID(value);
}

/**
 * Determines whether a raw or hydrated FinanceState requires UUID migration
 * (either pre-v3 schemaVersion or any non-UUID primary/foreign/nested/reminder key).
 */
export function needsUuidMigration(rawState: unknown): boolean {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return false;
  }
  const rec = rawState as Record<string, unknown>;
  if (typeof rec.schemaVersion !== 'number' || rec.schemaVersion < 3) {
    return true;
  }

  const checkCollectionIds = (arr: unknown): boolean => {
    if (!Array.isArray(arr)) return false;
    for (const item of arr) {
      if (
        item &&
        typeof item === 'object' &&
        hasNonUuidString((item as Record<string, unknown>).id)
      ) {
        return true;
      }
    }
    return false;
  };

  const checkItemFields = (arr: unknown, fields: string[]): boolean => {
    if (!Array.isArray(arr)) return false;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (hasNonUuidString(obj.id)) return true;
      for (const f of fields) {
        if (hasNonUuidString(obj[f])) return true;
      }
    }
    return false;
  };

  const checkFundAllocations = (arr: unknown): boolean => {
    if (!Array.isArray(arr)) return false;
    for (const alloc of arr) {
      if (
        alloc &&
        typeof alloc === 'object' &&
        hasNonUuidString((alloc as Record<string, unknown>).accountId)
      ) {
        return true;
      }
    }
    return false;
  };

  if (checkCollectionIds(rec.accounts)) return true;
  if (checkCollectionIds(rec.categories)) return true;
  if (checkCollectionIds(rec.projects)) return true;
  if (checkCollectionIds(rec.goals)) return true;

  if (
    checkItemFields(rec.transactions, [
      'accountId',
      'categoryId',
      'projectId',
      'debtId',
      'splitBillId',
      'custodialFundId',
      'projectAdvanceId',
      'assetId',
      'physicalLoanId',
      'ledgerGroupId',
      'parentTransactionId',
    ])
  ) {
    return true;
  }
  if (checkItemFields(rec.transfers, ['fromAccountId', 'toAccountId'])) return true;
  if (Array.isArray(rec.transfers)) {
    for (const tr of rec.transfers) {
      if (!tr || typeof tr !== 'object') continue;
      const movements = (tr as Record<string, unknown>).restrictedMovements;
      if (Array.isArray(movements)) {
        for (const mv of movements) {
          if (
            mv &&
            typeof mv === 'object' &&
            hasNonUuidString((mv as Record<string, unknown>).fundId)
          ) {
            return true;
          }
        }
      }
    }
  }

  if (checkItemFields(rec.projectPayments, ['projectId', 'accountId', 'transactionId'])) {
    return true;
  }
  if (
    checkItemFields(rec.projectExpenses, [
      'projectId',
      'accountId',
      'transactionId',
      'linkedReceivableId',
    ])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.debts, [
      'accountId',
      'expenseCategoryId',
      'transactionId',
      'projectId',
      'projectPaymentId',
      'projectExpenseId',
      'splitBillId',
      'linkedDebtId',
      'assetId',
      'physicalLoanId',
    ])
  ) {
    return true;
  }
  if (checkItemFields(rec.debtPayments, ['debtId', 'accountId', 'transactionId'])) return true;
  if (checkItemFields(rec.obligations, ['reallocatedToGoalId', 'linkedDebtId'])) return true;
  if (checkItemFields(rec.obligationLogs, ['obligationId', 'accountId', 'transactionId'])) {
    return true;
  }
  if (
    checkItemFields(rec.goalContributions, ['goalId', 'fromAccountId', 'toAccountId', 'transferId'])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.splitBills, [
      'categoryId',
      'accountId',
      'paymentTransactionId',
      'personalShareTransactionId',
      'ledgerGroupId',
    ])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.custodialFunds, [
      'holdingAccountId',
      'receiptTransactionId',
      'ledgerGroupId',
    ])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.projectAdvances, [
      'projectId',
      'holdingAccountId',
      'receiptTransactionId',
      'ledgerGroupId',
    ])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.physicalAssets, [
      'accountId',
      'purchaseTransactionId',
      'downPaymentTransactionId',
      'purchaseDebtId',
      'ledgerGroupId',
    ])
  ) {
    return true;
  }
  if (
    checkItemFields(rec.physicalItemLoans, ['assetId', 'lossRecordId', 'compensationDebtId'])
  ) {
    return true;
  }
  if (checkCollectionIds(rec.changeLogs)) return true;

  if (Array.isArray(rec.debts)) {
    for (const d of rec.debts) {
      if (
        d &&
        typeof d === 'object' &&
        checkItemFields((d as Record<string, unknown>).writeOffHistory, ['transactionId'])
      ) {
        return true;
      }
    }
  }
  if (Array.isArray(rec.splitBills)) {
    for (const sb of rec.splitBills) {
      if (
        sb &&
        typeof sb === 'object' &&
        checkItemFields((sb as Record<string, unknown>).participants, ['debtId'])
      ) {
        return true;
      }
    }
  }
  if (Array.isArray(rec.custodialFunds)) {
    for (const cf of rec.custodialFunds) {
      if (!cf || typeof cf !== 'object') continue;
      const cfRec = cf as Record<string, unknown>;
      if (checkFundAllocations(cfRec.fundAllocations)) return true;
      if (checkItemFields(cfRec.returns, ['accountId', 'transactionId'])) return true;
    }
  }
  if (Array.isArray(rec.projectAdvances)) {
    for (const pa of rec.projectAdvances) {
      if (!pa || typeof pa !== 'object') continue;
      const paRec = pa as Record<string, unknown>;
      if (checkFundAllocations(paRec.fundAllocations)) return true;
      if (checkItemFields(paRec.recognitions, ['transactionId'])) return true;
      if (checkItemFields(paRec.refunds, ['accountId', 'transactionId'])) return true;
      if (Array.isArray(paRec.recognitions)) {
        for (const r of paRec.recognitions) {
          if (r && typeof r === 'object') {
            if (checkFundAllocations((r as Record<string, unknown>).allocationDeltas)) {
              return true;
            }
          }
        }
      }
    }
  }
  if (Array.isArray(rec.physicalAssets)) {
    for (const pa of rec.physicalAssets) {
      if (!pa || typeof pa !== 'object') continue;
      const paRec = pa as Record<string, unknown>;
      if (checkCollectionIds(paRec.conditionHistory)) return true;
      if (checkItemFields(paRec.lossHistory, ['loanId', 'compensationDebtId'])) return true;
      if (checkItemFields(paRec.recoveryHistory, ['lossRecordId'])) return true;
      if (paRec.disposal && typeof paRec.disposal === 'object') {
        const disp = paRec.disposal as Record<string, unknown>;
        if (
          hasNonUuidString(disp.saleAccountId) ||
          hasNonUuidString(disp.saleTransactionId) ||
          hasNonUuidString(disp.receivableId)
        ) {
          return true;
        }
      }
    }
  }
  if (Array.isArray(rec.physicalItemLoans)) {
    for (const loan of rec.physicalItemLoans) {
      if (
        loan &&
        typeof loan === 'object' &&
        checkCollectionIds((loan as Record<string, unknown>).conditionHistory)
      ) {
        return true;
      }
    }
  }

  if (rec.settings && typeof rec.settings === 'object') {
    const rs = (rec.settings as Record<string, unknown>).reminderSettings;
    if (rs && typeof rs === 'object') {
      const rsRec = rs as Record<string, unknown>;
      if (checkCollectionIds(rsRec.customReminders)) return true;
      if (rsRec.reminderStates && typeof rsRec.reminderStates === 'object') {
        for (const k of Object.keys(rsRec.reminderStates as Record<string, unknown>)) {
          const m = REMINDER_ENTITY_KEY_RE.exec(k);
          if (m && !isValidUUID(m[2])) {
            return true;
          }
        }
      }
    }
  }

  if (Array.isArray(rec.changeLogs)) {
    const uuidEntityTypes = new Set([
      'account',
      'category',
      'transaction',
      'debt',
      'receivable',
      'obligation',
      'scheduled_expense',
      'goal',
      'split_bill',
      'custodial',
      'project_advance',
      'physical_asset',
      'physical_loan',
    ]);
    for (const cl of rec.changeLogs) {
      if (!cl || typeof cl !== 'object') continue;
      const clRec = cl as Record<string, unknown>;
      if (
        typeof clRec.entityType === 'string' &&
        uuidEntityTypes.has(clRec.entityType) &&
        typeof clRec.entityId === 'string'
      ) {
        const sentinelSet = NON_ENTITY_CHANGELOG_SENTINELS[clRec.entityType];
        if (!(sentinelSet && sentinelSet.has(clRec.entityId)) && hasNonUuidString(clRec.entityId)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function createUuidInitialFinanceState(nowDateISO?: string): FinanceState {
  const initialLegacy = createInitialFinanceState(nowDateISO);
  return migrateFinanceStateToUUID(initialLegacy, {
    saveBackup: false,
  }).migratedState;
}

