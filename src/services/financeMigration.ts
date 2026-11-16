import { getSystemKeyForLegacyId, SYSTEM_KEY_ALLOWLISTS } from '../data/initialProfile';
import {
  Account,
  AccountTransfer,
  Category,
  ChangeLogEntry,
  CustomReminder,
  Debt,
  DebtPayment,
  FinanceState,
  FreelanceProject,
  GoalContribution,
  ObligationLog,
  ProjectExpense,
  ProjectPayment,
  RecurringObligation,
  ReminderActionState,
  SavingsGoal,
  Transaction,
} from '../types/finance';
import { generateId, isValidUUID } from '../utils/format';

export const PRE_UUID_BACKUP_PREFIX = 'kendaliuang_pre_uuid_raw_v1';

export type MigrationErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_PRIMARY_KEY'
  | 'DUPLICATE_SYSTEM_KEY'
  | 'ORPHAN_FOREIGN_KEY'
  | 'INVALID_UUID'
  | 'INVARIANT_MISMATCH';

export class MigrationIntegrityError extends Error {
  readonly code: MigrationErrorCode;
  readonly details: string[];

  constructor(code: MigrationErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'MigrationIntegrityError';
    this.code = code;
    this.details = details;
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
  idMap: MigrationIdMaps;
  stats: MigrationStats;
}

export interface PreUuidBackupEnvelope {
  backedUpAt: string;
  sourceSchemaVersion: number;
  data: FinanceState;
}

export function getPreUuidBackupKey(userId?: string | null): string {
  return userId ? `${PRE_UUID_BACKUP_PREFIX}_${userId}` : PRE_UUID_BACKUP_PREFIX;
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

export function savePreMigrationRawBackup(
  rawStateClone: FinanceState,
  options?: { userId?: string | null; storage?: StorageAdapter | null; nowISO?: string }
): { backupKey: string; backupSaved: boolean } {
  const backupKey = getPreUuidBackupKey(options?.userId);
  const storage = options?.storage !== undefined ? options.storage : resolveDefaultStorage();
  if (!storage) {
    return { backupKey, backupSaved: false };
  }

  const envelope: PreUuidBackupEnvelope = {
    backedUpAt: options?.nowISO ?? new Date().toISOString(),
    sourceSchemaVersion: rawStateClone.schemaVersion ?? 1,
    data: rawStateClone,
  };

  storage.setItem(backupKey, JSON.stringify(envelope));
  return { backupKey, backupSaved: true };
}

function buildCollectionIdMap<T extends { id: string }>(
  items: T[],
  collectionName: string,
  statsCounter: { mappedIdsCount: number; preservedUuidsCount: number }
): Record<string, string> {
  const seenOldIds = new Set<string>();
  const duplicateErrors: string[] = [];
  const usedNewIds = new Set<string>();

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.trim().length === 0) {
      duplicateErrors.push(`${collectionName}: ditemukan entitas tanpa id string yang valid.`);
      continue;
    }
    if (seenOldIds.has(item.id)) {
      duplicateErrors.push(`${collectionName}: primary key duplikat "${item.id}".`);
      continue;
    }
    seenOldIds.add(item.id);
    if (isValidUUID(item.id)) {
      usedNewIds.add(item.id.toLowerCase());
    }
  }

  if (duplicateErrors.length > 0) {
    throw new MigrationIntegrityError(
      'DUPLICATE_PRIMARY_KEY',
      `Migrasi dibatalkan karena duplikasi atau ketidaksahan primary key pada ${collectionName}.`,
      duplicateErrors
    );
  }

  const map: Record<string, string> = {};
  for (const item of items) {
    if (isValidUUID(item.id)) {
      map[item.id] = item.id;
      statsCounter.preservedUuidsCount += 1;
    } else {
      let nextUuid = generateId();
      while (usedNewIds.has(nextUuid.toLowerCase())) {
        nextUuid = generateId();
      }
      usedNewIds.add(nextUuid.toLowerCase());
      map[item.id] = nextUuid;
      statsCounter.mappedIdsCount += 1;
    }
  }

  return map;
}

function resolveSystemKey(
  entityType: keyof typeof SYSTEM_KEY_ALLOWLISTS,
  oldId: string,
  existingSystemKey?: string
): string | undefined {
  const mapped = getSystemKeyForLegacyId(entityType, oldId);
  if (mapped) return mapped;

  if (existingSystemKey && SYSTEM_KEY_ALLOWLISTS[entityType].has(existingSystemKey)) {
    return existingSystemKey;
  }

  return undefined;
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
  targetMap: Record<string, string>,
  contextLabel: string,
  orphanErrors: string[]
): string {
  if (typeof oldValue !== 'string' || oldValue.trim().length === 0) {
    orphanErrors.push(`${contextLabel}: foreign key wajib kosong atau tidak valid.`);
    return '';
  }
  const mapped = targetMap[oldValue];
  if (!mapped) {
    orphanErrors.push(`${contextLabel}: referensi "${oldValue}" tidak ditemukan pada entitas induk.`);
    return '';
  }
  return mapped;
}

function resolveOptionalForeignKey(
  oldValue: unknown,
  targetMap: Record<string, string>,
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
  const mapped = targetMap[oldValue];
  if (!mapped) {
    orphanErrors.push(`${contextLabel}: referensi opsional "${oldValue}" tidak ditemukan pada entitas induk.`);
    return undefined;
  }
  return mapped;
}

function computeBalancesSnapshot(state: FinanceState): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const acc of state.accounts) {
    balances[acc.id] = acc.openingBalance;
  }

  for (const tx of state.transactions) {
    if (tx.isVoided || tx.deletedAt) continue;
    const prev = balances[tx.accountId] ?? 0;
    balances[tx.accountId] = tx.type === 'income' ? prev + tx.amount : prev - tx.amount;
  }

  for (const tr of state.transfers) {
    if (tr.deletedAt) continue;
    balances[tr.fromAccountId] = (balances[tr.fromAccountId] ?? 0) - tr.amount;
    balances[tr.toAccountId] = (balances[tr.toAccountId] ?? 0) + tr.amount;
  }

  return balances;
}

function remapReminderStates(
  reminderStates: Record<string, ReminderActionState> | undefined,
  idMap: MigrationIdMaps
): Record<string, ReminderActionState> | undefined {
  if (!reminderStates) return undefined;

  const remapped: Record<string, ReminderActionState> = {};
  for (const [key, value] of Object.entries(reminderStates)) {
    if (key.startsWith('rem-ob-')) {
      const oldId = key.slice('rem-ob-'.length);
      remapped[`rem-ob-${idMap.obligations[oldId] ?? oldId}`] = value;
    } else if (key.startsWith('rem-debt-')) {
      const oldId = key.slice('rem-debt-'.length);
      remapped[`rem-debt-${idMap.debts[oldId] ?? oldId}`] = value;
    } else if (key.startsWith('rem-goal-')) {
      const oldId = key.slice('rem-goal-'.length);
      remapped[`rem-goal-${idMap.goals[oldId] ?? oldId}`] = value;
    } else if (key.startsWith('rem-custom-')) {
      const oldId = key.slice('rem-custom-'.length);
      remapped[`rem-custom-${idMap.customReminders[oldId] ?? oldId}`] = value;
    } else {
      remapped[key] = value;
    }
  }
  return remapped;
}

function remapChangeLogEntityId(entry: ChangeLogEntry, idMap: MigrationIdMaps): string {
  switch (entry.entityType) {
    case 'account':
      return idMap.accounts[entry.entityId] ?? entry.entityId;
    case 'category':
      return idMap.categories[entry.entityId] ?? entry.entityId;
    case 'transaction':
      return idMap.transactions[entry.entityId] ?? entry.entityId;
    case 'debt':
    case 'receivable':
      return idMap.debts[entry.entityId] ?? entry.entityId;
    case 'obligation':
    case 'scheduled_expense':
      return idMap.obligations[entry.entityId] ?? entry.entityId;
    case 'goal':
      return idMap.goals[entry.entityId] ?? entry.entityId;
    default:
      return entry.entityId;
  }
}

function validateRawStateShape(rawState: unknown): asserts rawState is FinanceState {
  if (!rawState || typeof rawState !== 'object') {
    throw new MigrationIntegrityError('INVALID_INPUT', 'State keuangan tidak valid (bukan objek).');
  }
  const candidate = rawState as Partial<FinanceState>;
  const requiredArrays: Array<keyof FinanceState> = [
    'accounts',
    'categories',
    'transactions',
    'transfers',
    'projects',
    'projectPayments',
    'projectExpenses',
    'debts',
    'debtPayments',
    'obligations',
    'obligationLogs',
    'goals',
    'goalContributions',
    'noSpendConfirmations',
  ];

  const missing: string[] = [];
  if (!candidate.settings || typeof candidate.settings !== 'object') {
    missing.push('settings tidak ditemukan atau tidak valid.');
  }
  for (const key of requiredArrays) {
    if (!Array.isArray(candidate[key])) {
      missing.push(`koleksi "${key}" bukan array.`);
    }
  }

  if (missing.length > 0) {
    throw new MigrationIntegrityError(
      'INVALID_INPUT',
      'Struktur FinanceState belum lengkap untuk proses migrasi UUID.',
      missing
    );
  }
}

function verifyPostMigrationInvariants(
  before: FinanceState,
  after: FinanceState,
  idMap: MigrationIdMaps,
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
      if (seen.has(item.id)) {
        invariantErrors.push(`${name}: ID duplikat "${item.id}" setelah migrasi.`);
      }
      seen.add(item.id);
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
    ['obligations', before.obligations.length, after.obligations.length],
    ['obligationLogs', before.obligationLogs.length, after.obligationLogs.length],
    ['goals', before.goals.length, after.goals.length],
    ['goalContributions', before.goalContributions.length, after.goalContributions.length],
    ['noSpendConfirmations', before.noSpendConfirmations.length, after.noSpendConfirmations.length],
    ['changeLogs', (before.changeLogs ?? []).length, (after.changeLogs ?? []).length],
  ];

  for (const [name, bCount, aCount] of countPairs) {
    if (bCount !== aCount) {
      invariantErrors.push(`${name}: jumlah entitas berubah (${bCount} -> ${aCount}).`);
    }
  }

  for (const [oldAccId, newAccId] of Object.entries(idMap.accounts)) {
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
  const afterDebtIds = new Set(after.debts.map((d) => d.id));
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
  }

  for (const tr of after.transfers) {
    if (!afterAccountIds.has(tr.fromAccountId) || !afterAccountIds.has(tr.toAccountId)) {
      invariantErrors.push(`transfers[${tr.id}] memiliki accountId yatim pasca-migrasi.`);
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
  rawState: FinanceState,
  options: MigrateFinanceStateOptions = {}
): MigrateFinanceStateResult {
  validateRawStateShape(rawState);

  const nowISO = options.nowISO ?? new Date().toISOString();
  const clone = deepClone(rawState);
  const saveBackup = options.saveBackup ?? true;

  let backupKey = getPreUuidBackupKey(options.userId);
  let backupSaved = false;
  if (saveBackup) {
    const backupRes = savePreMigrationRawBackup(clone, {
      userId: options.userId,
      storage: options.storage,
      nowISO,
    });
    backupKey = backupRes.backupKey;
    backupSaved = backupRes.backupSaved;
  }

  const statsCounter = { mappedIdsCount: 0, preservedUuidsCount: 0 };

  const idMap: MigrationIdMaps = {
    accounts: buildCollectionIdMap(clone.accounts, 'accounts', statsCounter),
    categories: buildCollectionIdMap(clone.categories, 'categories', statsCounter),
    projects: buildCollectionIdMap(clone.projects, 'projects', statsCounter),
    debts: buildCollectionIdMap(clone.debts, 'debts', statsCounter),
    obligations: buildCollectionIdMap(clone.obligations, 'obligations', statsCounter),
    goals: buildCollectionIdMap(clone.goals, 'goals', statsCounter),
    transactions: buildCollectionIdMap(clone.transactions, 'transactions', statsCounter),
    transfers: buildCollectionIdMap(clone.transfers, 'transfers', statsCounter),
    projectPayments: buildCollectionIdMap(clone.projectPayments, 'projectPayments', statsCounter),
    projectExpenses: buildCollectionIdMap(clone.projectExpenses, 'projectExpenses', statsCounter),
    debtPayments: buildCollectionIdMap(clone.debtPayments, 'debtPayments', statsCounter),
    obligationLogs: buildCollectionIdMap(clone.obligationLogs, 'obligationLogs', statsCounter),
    goalContributions: buildCollectionIdMap(clone.goalContributions, 'goalContributions', statsCounter),
    changeLogs: buildCollectionIdMap(clone.changeLogs ?? [], 'changeLogs', statsCounter),
    customReminders: buildCollectionIdMap(
      clone.settings.reminderSettings?.customReminders ?? [],
      'customReminders',
      statsCounter
    ),
  };

  const orphanErrors: string[] = [];

  const accounts: Account[] = clone.accounts.map((acc) => {
    const systemKey = resolveSystemKey('account', acc.id, acc.systemKey);
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
    const systemKey = resolveSystemKey('category', cat.id, cat.systemKey);
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
    const systemKey = resolveSystemKey('debt', debt.id, debt.systemKey);
    const next: Debt = {
      ...debt,
      id: idMap.debts[debt.id],
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
    const systemKey = resolveSystemKey('goal', goal.id, goal.systemKey);
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
    const systemKey = resolveSystemKey('obligation', ob.id, ob.systemKey);
    const next: RecurringObligation = {
      ...ob,
      id: idMap.obligations[ob.id],
      reallocatedToGoalId: resolveOptionalForeignKey(
        ob.reallocatedToGoalId,
        idMap.goals,
        `obligations[${ob.id}].reallocatedToGoalId`,
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
      idMap.accounts,
      `transactions[${tx.id}].accountId`,
      orphanErrors
    ),
    categoryId: resolveRequiredForeignKey(
      tx.categoryId,
      idMap.categories,
      `transactions[${tx.id}].categoryId`,
      orphanErrors
    ),
    projectId: resolveOptionalForeignKey(
      tx.projectId,
      idMap.projects,
      `transactions[${tx.id}].projectId`,
      orphanErrors
    ),
    updatedAt: tx.updatedAt ?? nowISO,
  }));

  const transfers: AccountTransfer[] = clone.transfers.map((tr) => ({
    ...tr,
    id: idMap.transfers[tr.id],
    fromAccountId: resolveRequiredForeignKey(
      tr.fromAccountId,
      idMap.accounts,
      `transfers[${tr.id}].fromAccountId`,
      orphanErrors
    ),
    toAccountId: resolveRequiredForeignKey(
      tr.toAccountId,
      idMap.accounts,
      `transfers[${tr.id}].toAccountId`,
      orphanErrors
    ),
    updatedAt: tr.updatedAt ?? nowISO,
  }));

  const projectPayments: ProjectPayment[] = clone.projectPayments.map((pp) => ({
    ...pp,
    id: idMap.projectPayments[pp.id],
    projectId: resolveRequiredForeignKey(
      pp.projectId,
      idMap.projects,
      `projectPayments[${pp.id}].projectId`,
      orphanErrors
    ),
    accountId: resolveOptionalForeignKey(
      pp.accountId,
      idMap.accounts,
      `projectPayments[${pp.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      pp.transactionId,
      idMap.transactions,
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
      idMap.projects,
      `projectExpenses[${pe.id}].projectId`,
      orphanErrors
    ),
    accountId: resolveRequiredForeignKey(
      pe.accountId,
      idMap.accounts,
      `projectExpenses[${pe.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      pe.transactionId,
      idMap.transactions,
      `projectExpenses[${pe.id}].transactionId`,
      orphanErrors
    ),
    updatedAt: pe.updatedAt ?? nowISO,
  }));

  const debtPayments: DebtPayment[] = clone.debtPayments.map((dp) => ({
    ...dp,
    id: idMap.debtPayments[dp.id],
    debtId: resolveRequiredForeignKey(
      dp.debtId,
      idMap.debts,
      `debtPayments[${dp.id}].debtId`,
      orphanErrors
    ),
    accountId: resolveRequiredForeignKey(
      dp.accountId,
      idMap.accounts,
      `debtPayments[${dp.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      dp.transactionId,
      idMap.transactions,
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
      idMap.obligations,
      `obligationLogs[${ol.id}].obligationId`,
      orphanErrors
    ),
    accountId: resolveOptionalForeignKey(
      ol.accountId,
      idMap.accounts,
      `obligationLogs[${ol.id}].accountId`,
      orphanErrors
    ),
    transactionId: resolveOptionalForeignKey(
      ol.transactionId,
      idMap.transactions,
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
      idMap.goals,
      `goalContributions[${gc.id}].goalId`,
      orphanErrors
    ),
    fromAccountId: resolveRequiredForeignKey(
      gc.fromAccountId,
      idMap.accounts,
      `goalContributions[${gc.id}].fromAccountId`,
      orphanErrors
    ),
    toAccountId: resolveOptionalForeignKey(
      gc.toAccountId,
      idMap.accounts,
      `goalContributions[${gc.id}].toAccountId`,
      orphanErrors
    ),
    transferId: resolveOptionalForeignKey(
      gc.transferId,
      idMap.transfers,
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
        entityId: remapChangeLogEntityId(cl, idMap),
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
          idMap
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
    idMap,
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
