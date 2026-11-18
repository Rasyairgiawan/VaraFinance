import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialFinanceState, GENERAL_CATEGORY_PRESETS } from '../data/initialProfile';
import { FinanceState } from '../types/finance';
import { isStrictUUIDv4, isValidUUID } from '../utils/format';
import {
  getPreUuidBackupKey,
  migrateFinanceStateToUUID,
  MigrationIntegrityError,
  StorageAdapter,
} from './financeMigration';

function createMockLocalStorage(): StorageAdapter & {
  removeItem: (k: string) => void;
  clear: () => void;
  key: (i: number) => string | null;
  readonly length: number;
} {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

/**
 * Independent balance oracle implemented separately from financeEngine and financeMigration.
 * Sums openingBalance + non-voided non-deleted income - non-voided non-deleted expense + incoming transfers - outgoing transfers.
 */
function calculateBalancesOracle(state: FinanceState): Record<string, number> {
  const expected: Record<string, number> = {};
  for (let i = 0; i < state.accounts.length; i++) {
    const acc = state.accounts[i];
    expected[acc.id] = acc.openingBalance;
  }

  for (let i = 0; i < state.transactions.length; i++) {
    const tx = state.transactions[i];
    if (tx.isVoided === true || Boolean(tx.deletedAt) || tx.affectsAccountBalance === false) continue;
    if (tx.type === 'income') {
      expected[tx.accountId] = (expected[tx.accountId] ?? 0) + tx.amount;
    } else if (tx.type === 'expense') {
      expected[tx.accountId] = (expected[tx.accountId] ?? 0) - tx.amount;
    }
  }

  for (let i = 0; i < state.transfers.length; i++) {
    const tr = state.transfers[i];
    if (Boolean(tr.deletedAt)) continue;
    expected[tr.fromAccountId] = (expected[tr.fromAccountId] ?? 0) - tr.amount;
    expected[tr.toAccountId] = (expected[tr.toAccountId] ?? 0) + tr.amount;
  }

  return expected;
}

function buildRichLegacyState(): FinanceState {
  const base = createInitialFinanceState('2026-11-01');
  base.accounts[0].openingBalance = 150000;
  base.accounts[1].openingBalance = 500000;
  base.accounts[4].openingBalance = 300000;

  // Custom user account (legacy prefix ID, must NOT receive systemKey)
  base.accounts.push({
    id: 'acc-custom-seabank',
    name: 'SeaBank Pribadi',
    accountType: 'bank',
    openingBalance: 250000,
    isBusiness: false,
    isProtected: false,
    status: 'active',
    createdAt: '2026-11-02T09:00:00Z',
  });

  // Add one preset category + one custom user category (with legacy prefix ID)
  const salaryPreset = GENERAL_CATEGORY_PRESETS[0];
  base.categories.push(
    { ...salaryPreset, isSystem: false, isArchived: false },
    {
      id: 'cat-custom-kopi',
      name: 'Kopi Kerja',
      type: 'expense',
      classification: 'discretionary',
      weeklyLimit: 40000,
      monthlyLimit: 160000,
      isSystem: false,
      isArchived: false,
    }
  );

  // Existing valid RFC UUIDs (one v4, one v1) that must be preserved untouched
  const existingUuidV4Tx = '11111111-1111-4111-8111-111111111111';
  const existingUuidV1Proj = '22222222-2222-1222-8222-222222222222';

  base.projects = [
    {
      id: existingUuidV1Proj,
      clientName: 'Klien UMKM',
      projectName: 'Landing Page Toko',
      contractValue: 2000000,
      paymentScheme: 'dp_final',
      status: 'active',
      businessSharePct: 30,
      personalSharePct: 70,
      createdAt: '2026-11-03T10:00:00Z',
    },
  ];

  // Custom debt & custom obligation
  base.debts.push({
    id: 'debt-custom-hosting',
    direction: 'payable',
    creditor: 'Vendor Domain',
    description: 'Tagihan perpanjangan domain',
    initialAmount: 180000,
    remainingAmount: 130000,
    priority: 2,
    status: 'active',
    createdAt: '2026-11-03T11:00:00Z',
  });

  base.obligations.push({
    id: 'ob-custom-kos',
    kind: 'obligation',
    name: 'Uang Kos',
    category: 'Tempat Tinggal / Kos / Sewa',
    amount: 750000,
    frequency: 'monthly',
    durationType: 'fixed_term',
    startDate: '2026-11-01',
    nextDueDate: '2026-12-01',
    endDate: '2027-06-01',
    status: 'completed',
    reservedAmount: 0,
    reminderEnabled: true,
    reminderDaysBefore: 3,
    reallocatedToGoalId: 'goal-emergency',
    isActive: false,
    createdAt: '2026-11-01T10:00:00Z',
  });

  base.goals.push({
    id: 'goal-custom-laptop',
    name: 'Upgrade RAM Laptop',
    goalType: 'business',
    targetAmount: 600000,
    currentAmount: 100000,
    virtualReservedInLiquid: 0,
    priority: 6,
    monthlyTarget: 100000,
    isProtected: true,
    createdAt: '2026-11-02T10:00:00Z',
  });

  base.transactions = [
    {
      id: existingUuidV4Tx,
      type: 'income',
      amount: 1000000,
      categoryId: 'cat-income-freelance',
      accountId: 'acc-business',
      date: '2026-11-05',
      description: 'DP Landing Page Toko',
      tags: ['freelance'],
      incomeSource: 'freelance',
      projectId: existingUuidV1Proj,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: '2026-11-05T10:00:00Z',
    },
    {
      id: 'tx-legacy-expense-food',
      type: 'expense',
      amount: 35000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: '2026-11-06',
      description: 'Makan siang',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: '2026-11-06T12:00:00Z',
    },
    {
      id: 'tx-legacy-voided',
      type: 'expense',
      amount: 999000,
      categoryId: 'cat-custom-kopi',
      accountId: 'acc-custom-seabank',
      date: '2026-11-07',
      description: 'Salah catat (sudah void)',
      tags: [],
      isEssential: false,
      isDiscretionary: true,
      exceededBudget: false,
      isVoided: true,
      voidedAt: '2026-11-07T12:05:00Z',
      voidReason: 'Salah nominal',
      createdAt: '2026-11-07T12:00:00Z',
    },
    {
      id: 'tx-legacy-proj-exp',
      type: 'expense',
      amount: 120000,
      categoryId: 'cat-biz-ops',
      accountId: 'acc-business',
      date: '2026-11-08',
      description: 'Beli template UI',
      tags: [],
      projectId: existingUuidV1Proj,
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: '2026-11-08T09:00:00Z',
    },
    {
      id: 'tx-legacy-debt-pay',
      type: 'expense',
      amount: 50000,
      categoryId: 'cat-debt',
      accountId: 'acc-bank',
      date: '2026-11-09',
      description: 'Cicil Domain',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: '2026-11-09T10:00:00Z',
    },
    {
      id: 'tx-legacy-ob-pay',
      type: 'expense',
      amount: 30000,
      categoryId: 'cat-college',
      accountId: 'acc-ewallet',
      date: '2026-11-10',
      description: 'Bayar Iuran KKN Mingguan',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: '2026-11-10T10:00:00Z',
    },
  ];

  base.transfers = [
    {
      id: 'tr-legacy-1',
      fromAccountId: 'acc-bank',
      toAccountId: 'acc-custom-seabank',
      amount: 100000,
      date: '2026-11-11',
      notes: 'Transfer ke SeaBank',
      createdAt: '2026-11-11T10:00:00Z',
    },
    {
      id: 'tr-legacy-goal',
      fromAccountId: 'acc-custom-seabank',
      toAccountId: 'acc-savings',
      amount: 100000,
      date: '2026-11-12',
      notes: 'Setoran target laptop',
      createdAt: '2026-11-12T10:00:00Z',
    },
  ];

  base.projectPayments = [
    {
      id: 'pp-legacy-1',
      projectId: existingUuidV1Proj,
      paymentType: 'dp',
      amount: 1000000,
      status: 'received',
      receivedDate: '2026-11-05',
      accountId: 'acc-business',
      transactionId: existingUuidV4Tx,
      createdAt: '2026-11-05T10:00:00Z',
    },
    {
      id: 'pp-legacy-expected',
      projectId: existingUuidV1Proj,
      paymentType: 'final',
      amount: 1000000,
      status: 'expected',
      expectedDate: '2026-11-25',
      createdAt: '2026-11-05T10:00:00Z',
    },
  ];

  base.projectExpenses = [
    {
      id: 'pe-legacy-1',
      projectId: existingUuidV1Proj,
      description: 'Beli template UI',
      amount: 120000,
      date: '2026-11-08',
      accountId: 'acc-business',
      transactionId: 'tx-legacy-proj-exp',
      createdAt: '2026-11-08T09:00:00Z',
    },
  ];

  base.debtPayments = [
    {
      id: 'dp-legacy-1',
      debtId: 'debt-custom-hosting',
      amount: 50000,
      date: '2026-11-09',
      accountId: 'acc-bank',
      transactionId: 'tx-legacy-debt-pay',
      createdAt: '2026-11-09T10:00:00Z',
    },
  ];

  base.obligationLogs = [
    {
      id: 'ol-legacy-1',
      obligationId: 'ob-kkn-weekly',
      action: 'pay',
      amount: 30000,
      date: '2026-11-10',
      accountId: 'acc-ewallet',
      transactionId: 'tx-legacy-ob-pay',
      createdAt: '2026-11-10T10:00:00Z',
    },
  ];

  base.goalContributions = [
    {
      id: 'gc-legacy-1',
      goalId: 'goal-custom-laptop',
      amount: 100000,
      date: '2026-11-12',
      fromAccountId: 'acc-custom-seabank',
      toAccountId: 'acc-savings',
      transferId: 'tr-legacy-goal',
      createdAt: '2026-11-12T10:00:00Z',
    },
  ];

  base.noSpendConfirmations = [
    {
      date: '2026-11-06',
      status: 'confirmed',
      confirmedAt: '2026-11-06T21:00:00Z',
    },
  ];

  base.settings.reminderSettings.customReminders = [
    {
      id: 'cr-legacy-1',
      title: 'Cek tagihan domain',
      date: '2026-11-20',
      enabled: true,
    },
  ];

  base.settings.reminderSettings.reminderStates = {
    'rem-ob-ob-kkn-weekly': {
      status: 'snoozed',
      snoozedUntil: '2026-11-18',
      updatedAt: '2026-11-15T08:00:00Z',
    },
    'rem-debt-debt-friend-initial': {
      status: 'completed',
      updatedAt: '2026-11-15T09:00:00Z',
    },
    'rem-custom-cr-legacy-1': {
      status: 'disabled',
      updatedAt: '2026-11-15T10:00:00Z',
    },
  };

  base.changeLogs = [
    {
      id: 'cl-legacy-1',
      entityType: 'transaction',
      entityId: 'tx-legacy-expense-food',
      action: 'create',
      summary: 'Catat makan siang',
      timestamp: '2026-11-06T12:00:00Z',
    },
    {
      id: 'cl-legacy-settings',
      entityType: 'budget',
      entityId: 'settings-budget',
      action: 'update',
      summary: 'Ubah anggaran',
      timestamp: '2026-11-06T13:00:00Z',
    },
  ];

  return base;
}

describe('financeMigration — Fase 1A.1 Hardening UUID, Backup, systemKey & Invarian', () => {
  let mockStorage: ReturnType<typeof createMockLocalStorage>;

  beforeEach(() => {
    mockStorage = createMockLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
    });
  });

  it('membedakan validasi UUID v4 ketat vs UUID RFC generik dengan akurat', () => {
    const uuidV4 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
    const uuidV1 = '22222222-2222-1222-8222-222222222222';
    const uuidV5 = '33333333-3333-5333-a333-333333333333';

    expect(isStrictUUIDv4(uuidV4)).toBe(true);
    expect(isValidUUID(uuidV4)).toBe(true);

    expect(isStrictUUIDv4(uuidV1)).toBe(false);
    expect(isValidUUID(uuidV1)).toBe(true);

    expect(isStrictUUIDv4(uuidV5)).toBe(false);
    expect(isValidUUID(uuidV5)).toBe(true);

    expect(isStrictUUIDv4('acc-cash')).toBe(false);
    expect(isValidUUID('acc-cash')).toBe(false);
    expect(isValidUUID('not-a-uuid')).toBe(false);
  });

  // Req 1: storage === null with saveBackup: true
  it('melempar BACKUP_FAILED secara eksplisit saat storage === null dengan saveBackup: true', () => {
    const state = buildRichLegacyState();
    const snapshot = JSON.parse(JSON.stringify(state));

    let caught: unknown = null;
    try {
      migrateFinanceStateToUUID(state, { saveBackup: true, storage: null });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationIntegrityError);
    expect((caught as MigrationIntegrityError).code).toBe('BACKUP_FAILED');
    expect(state).toEqual(snapshot);
  });

  // Req 2: storage.setItem() throwing QuotaExceededError
  it('membungkus QuotaExceededError dari storage.setItem menjadi BACKUP_FAILED dengan cause asli', () => {
    const state = buildRichLegacyState();
    const quotaErr = new Error('QuotaExceededError: Storage limit reached');
    quotaErr.name = 'QuotaExceededError';

    const failingStorage: StorageAdapter = {
      getItem: () => null,
      setItem: () => {
        throw quotaErr;
      },
    };

    let caught: unknown = null;
    try {
      migrateFinanceStateToUUID(state, {
        userId: 'usr-quota',
        saveBackup: true,
        storage: failingStorage,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationIntegrityError);
    const integrityErr = caught as MigrationIntegrityError;
    expect(integrityErr.code).toBe('BACKUP_FAILED');
    expect(integrityErr.message).toContain('QuotaExceededError');
    expect(integrityErr.cause).toBe(quotaErr);
  });

  // Req 3 & 4: Existing backup is never overwritten + malformed existing backup protection + re-running preserves original backup
  it('tidak pernah menimpa backup mentah yang sudah ada, menolak data backup rusak tanpa menimpa, dan menjaga backup asli saat migrasi ulang', () => {
    const legacyState = buildRichLegacyState();
    const userId = 'usr-preserve-backup';
    const backupKey = getPreUuidBackupKey(userId);

    // Run 1: saves original pre-UUID raw snapshot
    const run1 = migrateFinanceStateToUUID(legacyState, {
      userId,
      storage: mockStorage,
      nowISO: '2026-11-16T08:00:00.000Z',
    });
    expect(run1.backupSaved).toBe(true);
    expect(run1.preservedExistingBackup).toBe(false);
    const firstBackupRaw = mockStorage.getItem(backupKey)!;
    expect(firstBackupRaw).not.toBeNull();
    const parsedFirstBackup = JSON.parse(firstBackupRaw);
    expect(parsedFirstBackup.backedUpAt).toBe('2026-11-16T08:00:00.000Z');
    expect(parsedFirstBackup.data.accounts[0].id).toBe('acc-cash');

    // Run 2 (re-running on migrated UUID state): original raw backup MUST NOT be replaced
    const run2 = migrateFinanceStateToUUID(run1.migratedState, {
      userId,
      storage: mockStorage,
      nowISO: '2026-11-17T09:00:00.000Z',
    });
    expect(run2.backupSaved).toBe(true);
    expect(run2.preservedExistingBackup).toBe(true);
    expect(mockStorage.getItem(backupKey)).toBe(firstBackupRaw);

    // Malformed / unparseable existing backup must fail explicitly without overwriting
    const corruptStorage = createMockLocalStorage();
    const corruptKey = getPreUuidBackupKey('usr-corrupt-backup');
    corruptStorage.setItem(corruptKey, '{not-valid-json-maybe-recoverable');

    let caught: unknown = null;
    try {
      migrateFinanceStateToUUID(legacyState, {
        userId: 'usr-corrupt-backup',
        storage: corruptStorage,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationIntegrityError);
    expect((caught as MigrationIntegrityError).code).toBe('BACKUP_FAILED');
    expect(corruptStorage.getItem(corruptKey)).toBe('{not-valid-json-maybe-recoverable');
  });

  // Req 5: Whitespace-only user IDs and anonymous key separation
  it('menormalisasi backup key dengan trim() dan memisahkan key anonymous dari literal user ID', () => {
    const anonUndef = getPreUuidBackupKey(undefined);
    const anonNull = getPreUuidBackupKey(null);
    const anonEmpty = getPreUuidBackupKey('');
    const anonSpaces = getPreUuidBackupKey('   \t\n  ');

    expect(anonUndef).toBe(anonNull);
    expect(anonUndef).toBe(anonEmpty);
    expect(anonUndef).toBe(anonSpaces);

    const literalAnonymousUser = getPreUuidBackupKey('anonymous');
    expect(literalAnonymousUser).not.toBe(anonUndef);

    expect(getPreUuidBackupKey('  usr-123  ')).toBe(getPreUuidBackupKey('usr-123'));
    expect(getPreUuidBackupKey('usr-123')).not.toBe(anonUndef);
  });

  // Req 6, 7, 8, 9: systemKey rules
  it('menegakkan aturan systemKey secara ketat: nama sama tidak mendapat systemKey, fake allowlist pada non-UUID & isSystem=false ditolak, UUID sah dipertahankan, dan duplikat ditolak', () => {
    const state = buildRichLegacyState();

    // 6. Custom entities with exact same names as built-in entities
    state.accounts.push({
      id: 'acc-custom-same-name',
      name: 'Dompet Tunai',
      accountType: 'cash',
      openingBalance: 10000,
      isBusiness: false,
      isProtected: false,
      status: 'active',
      createdAt: '2026-11-12T10:00:00Z',
    });
    state.categories.push({
      id: 'cat-custom-same-name',
      name: 'Rokok',
      type: 'expense',
      classification: 'discretionary',
      weeklyLimit: 10000,
      monthlyLimit: 40000,
      isSystem: false,
      isArchived: false,
    });

    // 7a. Legacy non-UUID custom entity containing an allowlisted fake systemKey (even when built-in 'cat-cig' removed)
    const cigIdx = state.categories.findIndex((c) => c.id === 'cat-cig');
    const cigTxRef = state.transactions.some((t) => t.categoryId === 'cat-cig');
    expect(cigTxRef).toBe(false);
    state.categories.splice(cigIdx, 1);

    const customKopi = state.categories.find((c) => c.id === 'cat-custom-kopi')!;
    customKopi.systemKey = 'cigarette'; // allowlisted key on non-UUID custom entity!

    // 7b. Already UUID custom category (isSystem: false) with fake core systemKey 'food'
    state.categories.push({
      id: '99999999-9999-4999-8999-999999999999',
      systemKey: 'food',
      name: 'Makan Palsu',
      type: 'expense',
      classification: 'essential',
      weeklyLimit: 0,
      monthlyLimit: 0,
      isSystem: false,
      isArchived: false,
    });

    const { migratedState, idMap } = migrateFinanceStateToUUID(state, { saveBackup: false });

    // Same-name custom entities must NOT receive systemKey
    expect(
      migratedState.accounts.find((a) => a.id === idMap.accounts['acc-custom-same-name'])!.systemKey
    ).toBeUndefined();
    expect(
      migratedState.categories.find((c) => c.id === idMap.categories['cat-custom-same-name'])!
        .systemKey
    ).toBeUndefined();

    // Non-UUID custom entity with allowlisted fake key must NOT retain it
    expect(
      migratedState.categories.find((c) => c.id === idMap.categories['cat-custom-kopi'])!.systemKey
    ).toBeUndefined();

    // UUID custom category with isSystem: false must NOT retain core systemKey 'food'
    expect(
      migratedState.categories.find((c) => c.id === '99999999-9999-4999-8999-999999999999')!
        .systemKey
    ).toBeUndefined();

    // 8. Legitimate UUID system entities retain valid systemKey
    const uuidSystemState = JSON.parse(JSON.stringify(migratedState)) as FinanceState;
    const rerun = migrateFinanceStateToUUID(uuidSystemState, { saveBackup: false });
    expect(
      rerun.migratedState.accounts.find((a) => a.id === idMap.accounts['acc-cash'])!.systemKey
    ).toBe('cash');
    expect(
      rerun.migratedState.categories.find((c) => c.id === idMap.categories['cat-food'])!.systemKey
    ).toBe('food');
    expect(
      rerun.migratedState.categories.find((c) => c.id === idMap.categories['cat-income-salary'])!
        .systemKey
    ).toBe('income_salary');
    expect(
      rerun.migratedState.debts.find((d) => d.id === idMap.debts['debt-friend-initial'])!.systemKey
    ).toBe('friend_initial');
    expect(
      rerun.migratedState.obligations.find((o) => o.id === idMap.obligations['ob-kkn-weekly'])!
        .systemKey
    ).toBe('kkn_weekly');
    expect(
      rerun.migratedState.goals.find((g) => g.id === idMap.goals['goal-emergency'])!.systemKey
    ).toBe('emergency');

    // 9. Duplicate allowlisted systemKey conflict must be rejected without mutating original state
    const dupSysState = JSON.parse(JSON.stringify(migratedState)) as FinanceState;
    dupSysState.accounts.push({
      id: '88888888-8888-4888-8888-888888888888',
      systemKey: 'cash',
      name: 'Dompet Tunai Kedua',
      accountType: 'cash',
      openingBalance: 0,
      isBusiness: false,
      isProtected: false,
      status: 'active',
      createdAt: '2026-11-12T10:00:00Z',
    });
    const dupSnapshot = JSON.parse(JSON.stringify(dupSysState));

    let caughtDupSys: unknown = null;
    try {
      migrateFinanceStateToUUID(dupSysState, { saveBackup: false });
    } catch (err) {
      caughtDupSys = err;
    }
    expect(caughtDupSys).toBeInstanceOf(MigrationIntegrityError);
    expect((caughtDupSys as MigrationIntegrityError).code).toBe('DUPLICATE_SYSTEM_KEY');
    expect(dupSysState).toEqual(dupSnapshot);
  });

  // Req 10 & 11: Legacy v1 raw snapshot compatibility + malformed required collections rejection
  it('mendukung snapshot v1 tanpa koleksi opsional baru sambil menyimpan backup mentah persis sebelum normalisasi dan menolak koleksi wajib malformed', () => {
    const full = buildRichLegacyState();
    const rawV1: Partial<FinanceState> = {
      settings: full.settings,
      accounts: [full.accounts[0]],
      categories: [full.categories[5]], // cat-food
      transactions: [
        {
          id: 'tx-v1-1',
          type: 'expense',
          amount: 20000,
          categoryId: 'cat-food',
          accountId: 'acc-cash',
          date: '2026-11-01',
          description: 'Makan v1',
          tags: [],
          isEssential: true,
          isDiscretionary: false,
          exceededBudget: false,
          createdAt: '2026-11-01T12:00:00Z',
        },
      ],
      // Optional collections intentionally omitted (undefined)
    };
    const rawV1Snapshot = JSON.parse(JSON.stringify(rawV1));

    const res = migrateFinanceStateToUUID(rawV1, {
      userId: 'usr-v1',
      storage: mockStorage,
    });

    // Original input untouched
    expect(rawV1).toEqual(rawV1Snapshot);
    // Backup preserves exact raw v1 shape (no injected [] defaults)
    const savedBackup = JSON.parse(mockStorage.getItem(res.backupKey)!);
    expect(savedBackup.data).toEqual(rawV1Snapshot);
    expect('transfers' in savedBackup.data).toBe(false);
    expect('goalContributions' in savedBackup.data).toBe(false);

    // Migrated clone normalized optional collections cleanly
    expect(res.migratedState.transfers).toEqual([]);
    expect(res.migratedState.projects).toEqual([]);
    expect(res.migratedState.debts).toEqual([]);
    expect(res.migratedState.obligations).toEqual([]);
    expect(res.migratedState.goals).toEqual([]);
    expect(res.migratedState.noSpendConfirmations).toEqual([]);

    // Req 11: Malformed required collections & malformed optional property rejected
    const malformedCases: Array<unknown> = [
      null,
      [],
      { settings: null, accounts: [], categories: [], transactions: [] },
      { settings: full.settings, accounts: 'bad', categories: [], transactions: [] },
      { settings: full.settings, accounts: [], categories: {}, transactions: [] },
      { settings: full.settings, accounts: [], categories: [], transactions: 123 },
      { settings: full.settings, accounts: [], categories: [], transactions: [], debts: 'corrupt' },
    ];

    for (const bad of malformedCases) {
      let errCaught: unknown = null;
      try {
        migrateFinanceStateToUUID(bad as Partial<FinanceState>, { saveBackup: false });
      } catch (err) {
        errCaught = err;
      }
      expect(errCaught).toBeInstanceOf(MigrationIntegrityError);
      expect((errCaught as MigrationIntegrityError).code).toBe('INVALID_INPUT');
    }
  });

  // Req 12 & 13: Case-insensitive UUID duplicate detection & parent-child resolution
  it('menolak duplikat UUID berbeda casing dan menyelesaikan referensi FK UUID berbeda casing ke bentuk kanonik konsisten', () => {
    // 12. Duplicate UUID differing only by hex letter casing
    const dupCaseState = buildRichLegacyState();
    dupCaseState.accounts.push(
      {
        id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        name: 'Akun Upper',
        accountType: 'bank',
        openingBalance: 0,
        isBusiness: false,
        isProtected: false,
        status: 'active',
        createdAt: '2026-11-12T10:00:00Z',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Akun Lower',
        accountType: 'bank',
        openingBalance: 0,
        isBusiness: false,
        isProtected: false,
        status: 'active',
        createdAt: '2026-11-12T10:00:00Z',
      }
    );

    let dupErr: unknown = null;
    try {
      migrateFinanceStateToUUID(dupCaseState, { saveBackup: false });
    } catch (err) {
      dupErr = err;
    }
    expect(dupErr).toBeInstanceOf(MigrationIntegrityError);
    expect((dupErr as MigrationIntegrityError).code).toBe('DUPLICATE_PRIMARY_KEY');

    // 13. Parent UUID uppercase, child FK lowercase (and vice versa)
    const mixedCaseState = buildRichLegacyState();
    const upperAccUuid = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
    const lowerAccUuid = upperAccUuid.toLowerCase();
    const upperCatUuid = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    const lowerCatUuid = upperCatUuid.toLowerCase();

    mixedCaseState.accounts.push({
      id: upperAccUuid,
      name: 'Akun Mixed Case',
      accountType: 'ewallet',
      openingBalance: 100000,
      isBusiness: false,
      isProtected: false,
      status: 'active',
      createdAt: '2026-11-12T10:00:00Z',
    });
    mixedCaseState.categories.push({
      id: lowerCatUuid,
      name: 'Kategori Mixed Case',
      type: 'expense',
      classification: 'essential',
      weeklyLimit: 0,
      monthlyLimit: 0,
      isSystem: false,
      isArchived: false,
    });
    mixedCaseState.transactions.push({
      id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      type: 'expense',
      amount: 25000,
      categoryId: upperCatUuid, // uppercase ref to lowercase parent
      accountId: lowerAccUuid, // lowercase ref to uppercase parent
      date: '2026-11-13',
      description: 'Transaksi mixed-case UUID',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: '2026-11-13T10:00:00Z',
    });

    const oracleBefore = calculateBalancesOracle(mixedCaseState);
    // Note: in mixedCaseState oracle, account key is upperAccUuid while tx.accountId was lowerAccUuid;
    // compute expected balance explicitly for the mixed-case account as well:
    const res = migrateFinanceStateToUUID(mixedCaseState, { saveBackup: false });
    const migratedMixedAcc = res.migratedState.accounts.find((a) => a.id === lowerAccUuid)!;
    const migratedMixedTx = res.migratedState.transactions.find(
      (t) => t.id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    )!;
    expect(migratedMixedAcc).toBeDefined();
    expect(migratedMixedTx.accountId).toBe(lowerAccUuid);
    expect(migratedMixedTx.categoryId).toBe(lowerCatUuid);
    expect(res.stats.accountBalancesAfter[lowerAccUuid]).toBe(
      oracleBefore[upperAccUuid] + (oracleBefore[lowerAccUuid] ?? 0)
    );

    // Non-UUID legacy string IDs remain case-sensitive ('acc-Case' !== 'acc-case')
    const caseSensitiveLegacy = buildRichLegacyState();
    caseSensitiveLegacy.accounts.push(
      {
        id: 'acc-Case',
        name: 'Case Upper',
        accountType: 'cash',
        openingBalance: 1000,
        isBusiness: false,
        isProtected: false,
        status: 'active',
        createdAt: '2026-11-13T10:00:00Z',
      },
      {
        id: 'acc-case',
        name: 'Case Lower',
        accountType: 'cash',
        openingBalance: 2000,
        isBusiness: false,
        isProtected: false,
        status: 'active',
        createdAt: '2026-11-13T10:00:00Z',
      }
    );
    const resCase = migrateFinanceStateToUUID(caseSensitiveLegacy, { saveBackup: false });
    expect(resCase.idMap.accounts['acc-Case']).not.toBe(resCase.idMap.accounts['acc-case']);
  });

  // Req 14 & 15 & 16 & 17: Shared IDs across collections, re-run idempotency, deletedAt balances, and explicit FK assertions
  it('memisahkan namespace id antar-koleksi, idempoten saat re-run, mengabaikan deletedAt/voided pada saldo, dan memverifikasi seluruh relasi FK secara eksplisit', () => {
    const activeStorageKey = 'kendaliuang_state_v1_usr-full';
    const state = buildRichLegacyState();

    // 14. Same legacy ID shared between account and category
    state.accounts.push({
      id: 'shared-legacy-id',
      name: 'Akun Shared ID',
      accountType: 'cash',
      openingBalance: 80000,
      isBusiness: false,
      isProtected: false,
      status: 'active',
      createdAt: '2026-11-12T10:00:00Z',
    });
    state.categories.push({
      id: 'shared-legacy-id',
      name: 'Kategori Shared ID',
      type: 'expense',
      classification: 'essential',
      weeklyLimit: 0,
      monthlyLimit: 0,
      isSystem: false,
      isArchived: false,
    });
    state.transactions.push({
      id: 'tx-shared-id-check',
      type: 'expense',
      amount: 15000,
      categoryId: 'shared-legacy-id',
      accountId: 'shared-legacy-id',
      date: '2026-11-14',
      description: 'Pakai shared ID berbeda koleksi',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: '2026-11-14T10:00:00Z',
    });

    // 16. Soft-deleted transaction and soft-deleted transfer must not affect account balances
    state.transactions.push({
      id: 'tx-soft-deleted',
      type: 'expense',
      amount: 450000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: '2026-11-14',
      description: 'Transaksi terhapus lunak',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      deletedAt: '2026-11-14T11:00:00Z',
      createdAt: '2026-11-14T10:30:00Z',
    });
    state.transfers.push({
      id: 'tr-soft-deleted',
      fromAccountId: 'acc-bank',
      toAccountId: 'acc-cash',
      amount: 200000,
      date: '2026-11-14',
      notes: 'Transfer terhapus lunak',
      deletedAt: '2026-11-14T11:05:00Z',
      createdAt: '2026-11-14T10:35:00Z',
    });

    const rawSnapshot = JSON.parse(JSON.stringify(state));
    mockStorage.setItem(activeStorageKey, JSON.stringify(state));

    const res1 = migrateFinanceStateToUUID(state, {
      userId: 'usr-full',
      storage: mockStorage,
      nowISO: '2026-11-16T08:00:00.000Z',
    });

    const { migratedState, idMap } = res1;

    // Active storage and input untouched
    expect(state).toEqual(rawSnapshot);
    expect(JSON.parse(mockStorage.getItem(activeStorageKey)!)).toEqual(rawSnapshot);

    // 14. Shared ID mapped to distinct UUIDs without collision
    expect(idMap.accounts['shared-legacy-id']).not.toBe(idMap.categories['shared-legacy-id']);
    const sharedTx = migratedState.transactions.find(
      (t) => t.id === idMap.transactions['tx-shared-id-check']
    )!;
    expect(sharedTx.accountId).toBe(idMap.accounts['shared-legacy-id']);
    expect(sharedTx.categoryId).toBe(idMap.categories['shared-legacy-id']);

    // 17. Explicit relationship assertions for all dependent collections
    // transfers
    const tr1 = migratedState.transfers.find((t) => t.id === idMap.transfers['tr-legacy-1'])!;
    expect(tr1.fromAccountId).toBe(idMap.accounts['acc-bank']);
    expect(tr1.toAccountId).toBe(idMap.accounts['acc-custom-seabank']);

    // projectPayments
    const pp1 = migratedState.projectPayments.find(
      (p) => p.id === idMap.projectPayments['pp-legacy-1']
    )!;
    expect(pp1.projectId).toBe(idMap.projects['22222222-2222-1222-8222-222222222222']);
    expect(pp1.accountId).toBe(idMap.accounts['acc-business']);
    expect(pp1.transactionId).toBe(idMap.transactions['11111111-1111-4111-8111-111111111111']);
    const ppExp = migratedState.projectPayments.find(
      (p) => p.id === idMap.projectPayments['pp-legacy-expected']
    )!;
    expect(ppExp.projectId).toBe(idMap.projects['22222222-2222-1222-8222-222222222222']);
    expect(ppExp.accountId).toBeUndefined();
    expect(ppExp.transactionId).toBeUndefined();

    // projectExpenses
    const pe1 = migratedState.projectExpenses.find(
      (e) => e.id === idMap.projectExpenses['pe-legacy-1']
    )!;
    expect(pe1.projectId).toBe(idMap.projects['22222222-2222-1222-8222-222222222222']);
    expect(pe1.accountId).toBe(idMap.accounts['acc-business']);
    expect(pe1.transactionId).toBe(idMap.transactions['tx-legacy-proj-exp']);

    // debtPayments
    const dp1 = migratedState.debtPayments.find((d) => d.id === idMap.debtPayments['dp-legacy-1'])!;
    expect(dp1.debtId).toBe(idMap.debts['debt-custom-hosting']);
    expect(dp1.accountId).toBe(idMap.accounts['acc-bank']);
    expect(dp1.transactionId).toBe(idMap.transactions['tx-legacy-debt-pay']);

    // obligationLogs
    const ol1 = migratedState.obligationLogs.find(
      (l) => l.id === idMap.obligationLogs['ol-legacy-1']
    )!;
    expect(ol1.obligationId).toBe(idMap.obligations['ob-kkn-weekly']);
    expect(ol1.accountId).toBe(idMap.accounts['acc-ewallet']);
    expect(ol1.transactionId).toBe(idMap.transactions['tx-legacy-ob-pay']);

    // goalContributions
    const gc1 = migratedState.goalContributions.find(
      (g) => g.id === idMap.goalContributions['gc-legacy-1']
    )!;
    expect(gc1.goalId).toBe(idMap.goals['goal-custom-laptop']);
    expect(gc1.fromAccountId).toBe(idMap.accounts['acc-custom-seabank']);
    expect(gc1.toAccountId).toBe(idMap.accounts['acc-savings']);
    expect(gc1.transferId).toBe(idMap.transfers['tr-legacy-goal']);

    // 16. Balance oracle parity including voided & soft-deleted tx/transfers
    const oracleBefore = calculateBalancesOracle(state);
    const oracleAfter = calculateBalancesOracle(migratedState);
    expect(oracleBefore['acc-cash']).toBe(150000 - 35000); // soft-deleted tx (-450k) & transfer (+200k) ignored
    expect(oracleBefore['acc-custom-seabank']).toBe(250000 + 100000 - 100000); // voided -999k ignored

    for (const acc of state.accounts) {
      const mappedId = idMap.accounts[acc.id];
      expect(oracleAfter[mappedId]).toBe(oracleBefore[acc.id]);
      expect(res1.stats.accountBalancesAfter[mappedId]).toBe(oracleBefore[acc.id]);
    }

    // 15. Re-running migration on already-migrated result preserves every single ID and relation
    const res2 = migrateFinanceStateToUUID(migratedState, {
      userId: 'usr-full',
      storage: mockStorage,
      nowISO: '2026-11-17T08:00:00.000Z',
    });
    expect(res2.stats.mappedIdsCount).toBe(0);
    expect(res2.migratedState).toEqual({
      ...migratedState,
      // already had updatedAt so timestamps remain unchanged
    });
    expect(res2.preservedExistingBackup).toBe(true);
  });

  // Req 18: Orphan foreign keys rejected for all relevant entity types
  it('menolak foreign key yatim pada seluruh tipe entitas relasional tanpa mengubah data asli', () => {
    const mutations: Array<{ label: string; mutate: (s: FinanceState) => void }> = [
      {
        label: 'transactions.accountId',
        mutate: (s) => {
          s.transactions[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'transactions.categoryId',
        mutate: (s) => {
          s.transactions[0].categoryId = 'cat-ghost';
        },
      },
      {
        label: 'transactions.projectId',
        mutate: (s) => {
          s.transactions[0].projectId = 'proj-ghost';
        },
      },
      {
        label: 'transfers.fromAccountId',
        mutate: (s) => {
          s.transfers[0].fromAccountId = 'acc-ghost';
        },
      },
      {
        label: 'transfers.toAccountId',
        mutate: (s) => {
          s.transfers[0].toAccountId = 'acc-ghost';
        },
      },
      {
        label: 'projectPayments.projectId',
        mutate: (s) => {
          s.projectPayments[0].projectId = 'proj-ghost';
        },
      },
      {
        label: 'projectPayments.accountId',
        mutate: (s) => {
          s.projectPayments[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'projectPayments.transactionId',
        mutate: (s) => {
          s.projectPayments[0].transactionId = 'tx-ghost';
        },
      },
      {
        label: 'projectExpenses.projectId',
        mutate: (s) => {
          s.projectExpenses[0].projectId = 'proj-ghost';
        },
      },
      {
        label: 'projectExpenses.accountId',
        mutate: (s) => {
          s.projectExpenses[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'projectExpenses.transactionId',
        mutate: (s) => {
          s.projectExpenses[0].transactionId = 'tx-ghost';
        },
      },
      {
        label: 'debtPayments.debtId',
        mutate: (s) => {
          s.debtPayments[0].debtId = 'debt-ghost';
        },
      },
      {
        label: 'debtPayments.accountId',
        mutate: (s) => {
          s.debtPayments[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'debtPayments.transactionId',
        mutate: (s) => {
          s.debtPayments[0].transactionId = 'tx-ghost';
        },
      },
      {
        label: 'obligations.reallocatedToGoalId',
        mutate: (s) => {
          s.obligations[0].reallocatedToGoalId = 'goal-ghost';
        },
      },
      {
        label: 'obligationLogs.obligationId',
        mutate: (s) => {
          s.obligationLogs[0].obligationId = 'ob-ghost';
        },
      },
      {
        label: 'obligationLogs.accountId',
        mutate: (s) => {
          s.obligationLogs[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'obligationLogs.transactionId',
        mutate: (s) => {
          s.obligationLogs[0].transactionId = 'tx-ghost';
        },
      },
      {
        label: 'goalContributions.goalId',
        mutate: (s) => {
          s.goalContributions[0].goalId = 'goal-ghost';
        },
      },
      {
        label: 'goalContributions.fromAccountId',
        mutate: (s) => {
          s.goalContributions[0].fromAccountId = 'acc-ghost';
        },
      },
      {
        label: 'goalContributions.toAccountId',
        mutate: (s) => {
          s.goalContributions[0].toAccountId = 'acc-ghost';
        },
      },
      {
        label: 'goalContributions.transferId',
        mutate: (s) => {
          s.goalContributions[0].transferId = 'tr-ghost';
        },
      },
    ];

    for (const tc of mutations) {
      const state = buildRichLegacyState();
      tc.mutate(state);
      const snapshot = JSON.parse(JSON.stringify(state));

      let caught: unknown = null;
      try {
        migrateFinanceStateToUUID(state, { saveBackup: false });
      } catch (err) {
        caught = err;
      }

      expect(caught, `Harus gagal untuk ${tc.label}`).toBeInstanceOf(MigrationIntegrityError);
      expect((caught as MigrationIntegrityError).code, tc.label).toBe('ORPHAN_FOREIGN_KEY');
      expect(state).toEqual(snapshot);
    }
  });

  // Phase 2.3A: Non-cash transactions & extended Debt / tx.debtId FK migration tests
  it('mengabaikan transaksi affectsAccountBalance === false dalam snapshot saldo migrasi sambil tetap meremap tx.debtId', () => {
    const state = createInitialFinanceState('2026-11-16');
    state.accounts[0].openingBalance = 200000; // acc-cash

    state.debts.push({
      id: 'debt-direct-legacy',
      direction: 'payable',
      debtReceiptType: 'direct_expense',
      creditor: 'Warung Makan',
      description: 'Kasbon makan',
      initialAmount: 45000,
      remainingAmount: 45000,
      priority: 1,
      status: 'active',
      expenseCategoryId: 'cat-food',
      accountId: 'acc-cash',
      transactionId: 'tx-direct-noncash',
      createdAt: '2026-11-16T09:00:00Z',
    });

    state.transactions.push(
      {
        id: 'tx-cash-expense',
        type: 'expense',
        amount: 25000,
        categoryId: 'cat-food',
        accountId: 'acc-cash',
        date: '2026-11-16',
        description: 'Beli bensin tunai',
        tags: [],
        isEssential: true,
        isDiscretionary: false,
        exceededBudget: false,
        affectsAccountBalance: true,
        isVoided: false,
        createdAt: '2026-11-16T08:00:00Z',
      },
      {
        id: 'tx-direct-noncash',
        type: 'expense',
        amount: 45000,
        categoryId: 'cat-food',
        accountId: 'acc-cash',
        date: '2026-11-16',
        description: 'Makan kasbon (non-kas)',
        tags: ['utang_langsung'],
        debtId: 'debt-direct-legacy',
        transactionNature: 'debt_direct_expense',
        affectsAccountBalance: false,
        isEssential: true,
        isDiscretionary: false,
        exceededBudget: false,
        isVoided: false,
        createdAt: '2026-11-16T09:00:00Z',
      }
    );

    const res = migrateFinanceStateToUUID(state, { saveBackup: false });
    const mappedCashId = res.idMap.accounts['acc-cash'];
    const mappedDebtId = res.idMap.debts['debt-direct-legacy'];
    const mappedNonCashTxId = res.idMap.transactions['tx-direct-noncash'];

    // Only 200,000 - 25,000 = 175,000 (the 45,000 non-cash transaction must NOT affect balance)
    expect(res.stats.accountBalancesBefore['acc-cash']).toBe(175000);
    expect(res.stats.accountBalancesAfter[mappedCashId]).toBe(175000);

    const migratedTx = res.migratedState.transactions.find((t) => t.id === mappedNonCashTxId)!;
    expect(migratedTx.debtId).toBe(mappedDebtId);
    expect(migratedTx.affectsAccountBalance).toBe(false);

    const migratedDebt = res.migratedState.debts.find((d) => d.id === mappedDebtId)!;
    expect(migratedDebt.accountId).toBe(mappedCashId);
    expect(migratedDebt.expenseCategoryId).toBe(res.idMap.categories['cat-food']);
    expect(migratedDebt.transactionId).toBe(mappedNonCashTxId);
  });

  it('meremap seluruh foreign key Debt (accountId, expenseCategoryId, transactionId, projectId, projectPaymentId) dan tx.debtId serta idempoten saat re-run', () => {
    const state = buildRichLegacyState();
    const projId = '22222222-2222-1222-8222-222222222222';
    const existingMixedCaseRecUuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    state.transactions.push({
      id: 'tx-legacy-rec-origin',
      type: 'income',
      amount: 1000000,
      categoryId: 'cat-income-freelance',
      accountId: 'acc-business',
      date: '2026-11-05',
      description: 'Pengakuan piutang proyek',
      tags: ['piutang'],
      projectId: projId,
      debtId: existingMixedCaseRecUuid,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      affectsAccountBalance: false,
      isVoided: false,
      createdAt: '2026-11-05T10:05:00Z',
    });

    state.debts.push({
      id: existingMixedCaseRecUuid,
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'Klien UMKM',
      description: 'Termin akhir Landing Page Toko',
      initialAmount: 1000000,
      remainingAmount: 1000000,
      priority: 1,
      status: 'active',
      accountId: 'acc-business',
      expenseCategoryId: 'cat-income-freelance',
      transactionId: 'tx-legacy-rec-origin',
      projectId: projId,
      projectPaymentId: 'pp-legacy-expected',
      createdAt: '2026-11-05T10:05:00Z',
    });

    // Ensure existing legacy debt without optional FKs remains compatible
    const legacyPlainDebtId = 'debt-custom-hosting';

    const res1 = migrateFinanceStateToUUID(state, {
      saveBackup: false,
      nowISO: '2026-11-17T09:00:00.000Z',
    });

    const { migratedState, idMap } = res1;
    const migratedRec = migratedState.debts.find(
      (d) => d.id === idMap.debts[existingMixedCaseRecUuid]
    )!;
    const canonicalRecUuid = existingMixedCaseRecUuid.toLowerCase();
    expect(migratedRec.id).toBe(canonicalRecUuid);
    expect(migratedRec.accountId).toBe(idMap.accounts['acc-business']);
    expect(migratedRec.expenseCategoryId).toBe(idMap.categories['cat-income-freelance']);
    expect(migratedRec.transactionId).toBe(idMap.transactions['tx-legacy-rec-origin']);
    expect(migratedRec.projectId).toBe(idMap.projects[projId]);
    expect(migratedRec.projectPaymentId).toBe(idMap.projectPayments['pp-legacy-expected']);

    const migratedRecOriginTx = migratedState.transactions.find(
      (t) => t.id === idMap.transactions['tx-legacy-rec-origin']
    )!;
    expect(migratedRecOriginTx.debtId).toBe(canonicalRecUuid);

    const migratedPlainDebt = migratedState.debts.find(
      (d) => d.id === idMap.debts[legacyPlainDebtId]
    )!;
    expect(migratedPlainDebt.accountId).toBeUndefined();
    expect(migratedPlainDebt.expenseCategoryId).toBeUndefined();
    expect(migratedPlainDebt.transactionId).toBeUndefined();
    expect(migratedPlainDebt.projectId).toBeUndefined();
    expect(migratedPlainDebt.projectPaymentId).toBeUndefined();

    // Idempotency on second run
    const res2 = migrateFinanceStateToUUID(migratedState, {
      saveBackup: false,
      nowISO: '2026-11-17T10:00:00.000Z',
    });
    expect(res2.stats.mappedIdsCount).toBe(0);
    expect(res2.migratedState).toEqual(migratedState);
  });

  it('menolak foreign key yatim pada transactions.debtId dan seluruh FK pada debts', () => {
    const mutations: Array<{ label: string; mutate: (s: FinanceState) => void }> = [
      {
        label: 'transactions.debtId',
        mutate: (s) => {
          s.transactions[0].debtId = 'debt-ghost';
        },
      },
      {
        label: 'debts.accountId',
        mutate: (s) => {
          s.debts[0].accountId = 'acc-ghost';
        },
      },
      {
        label: 'debts.expenseCategoryId',
        mutate: (s) => {
          s.debts[0].expenseCategoryId = 'cat-ghost';
        },
      },
      {
        label: 'debts.transactionId',
        mutate: (s) => {
          s.debts[0].transactionId = 'tx-ghost';
        },
      },
      {
        label: 'debts.projectId',
        mutate: (s) => {
          s.debts[0].projectId = 'proj-ghost';
        },
      },
      {
        label: 'debts.projectPaymentId',
        mutate: (s) => {
          s.debts[0].projectPaymentId = 'pp-ghost';
        },
      },
    ];

    for (const tc of mutations) {
      const state = buildRichLegacyState();
      tc.mutate(state);

      let caught: unknown = null;
      try {
        migrateFinanceStateToUUID(state, { saveBackup: false });
      } catch (err) {
        caught = err;
      }

      expect(caught, `Harus gagal untuk ${tc.label}`).toBeInstanceOf(MigrationIntegrityError);
      expect((caught as MigrationIntegrityError).code, tc.label).toBe('ORPHAN_FOREIGN_KEY');
    }
  });
});
