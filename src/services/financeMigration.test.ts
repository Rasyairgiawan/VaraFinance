import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialFinanceState, GENERAL_CATEGORY_PRESETS } from '../data/initialProfile';
import { FinanceState } from '../types/finance';
import { isStrictUUIDv4, isValidUUID } from '../utils/format';
import {
  getPreUuidBackupKey,
  migrateFinanceStateToUUID,
  MigrationIntegrityError,
} from './financeMigration';

function createMockLocalStorage() {
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
    if (tx.isVoided === true || typeof tx.deletedAt === 'string') continue;
    if (tx.type === 'income') {
      expected[tx.accountId] = (expected[tx.accountId] ?? 0) + tx.amount;
    } else if (tx.type === 'expense') {
      expected[tx.accountId] = (expected[tx.accountId] ?? 0) - tx.amount;
    }
  }

  for (let i = 0; i < state.transfers.length; i++) {
    const tr = state.transfers[i];
    if (typeof tr.deletedAt === 'string') continue;
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

describe('financeMigration — Fase 1A Fondasi UUID, systemKey & Invarian Lokal', () => {
  beforeEach(() => {
    const mockStorage = createMockLocalStorage();
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

  it('memigrasikan seluruh entitas dan relasi FK, mempertahankan UUID lama, menyimpan backup mentah, dan tidak menyentuh localStorage aktif', () => {
    const userId = 'user-cloud-123';
    const activeStorageKey = `kendaliuang_state_v1_${userId}`;
    const legacyState = buildRichLegacyState();
    const rawSnapshotBefore = JSON.parse(JSON.stringify(legacyState));
    localStorage.setItem(activeStorageKey, JSON.stringify(legacyState));

    const result = migrateFinanceStateToUUID(legacyState, {
      userId,
      nowISO: '2026-11-16T08:00:00.000Z',
    });

    const { migratedState, idMap, backupKey, backupSaved, stats } = result;

    // 1. Pre-migration backup saved separately and active localStorage untouched
    expect(backupSaved).toBe(true);
    expect(backupKey).toBe(getPreUuidBackupKey(userId));
    expect(localStorage.getItem(backupKey)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(activeStorageKey)!)).toEqual(rawSnapshotBefore);
    expect(legacyState).toEqual(rawSnapshotBefore); // input never mutated

    // 2. Existing valid UUIDs (v4 & v1) are preserved unchanged
    expect(idMap.transactions['11111111-1111-4111-8111-111111111111']).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(idMap.projects['22222222-2222-1222-8222-222222222222']).toBe(
      '22222222-2222-1222-8222-222222222222'
    );
    expect(stats.preservedUuidsCount).toBe(2);
    expect(stats.mappedIdsCount).toBeGreaterThan(20);

    // 3. Legacy IDs mapped to strict UUID v4
    expect(isStrictUUIDv4(idMap.accounts['acc-cash'])).toBe(true);
    expect(isStrictUUIDv4(idMap.accounts['acc-custom-seabank'])).toBe(true);
    expect(isStrictUUIDv4(idMap.categories['cat-cig'])).toBe(true);
    expect(isStrictUUIDv4(idMap.categories['cat-custom-kopi'])).toBe(true);
    expect(isStrictUUIDv4(idMap.transactions['tx-legacy-expense-food'])).toBe(true);
    expect(isStrictUUIDv4(idMap.debts['debt-friend-initial'])).toBe(true);
    expect(isStrictUUIDv4(idMap.obligations['ob-kkn-weekly'])).toBe(true);
    expect(isStrictUUIDv4(idMap.goals['goal-emergency'])).toBe(true);

    // 4. All migrated FK references resolve accurately
    const migratedFoodTx = migratedState.transactions.find(
      (t) => t.id === idMap.transactions['tx-legacy-expense-food']
    )!;
    expect(migratedFoodTx.accountId).toBe(idMap.accounts['acc-cash']);
    expect(migratedFoodTx.categoryId).toBe(idMap.categories['cat-food']);

    const migratedDp = migratedState.debtPayments[0];
    expect(migratedDp.debtId).toBe(idMap.debts['debt-custom-hosting']);
    expect(migratedDp.accountId).toBe(idMap.accounts['acc-bank']);
    expect(migratedDp.transactionId).toBe(idMap.transactions['tx-legacy-debt-pay']);

    const migratedObKos = migratedState.obligations.find(
      (o) => o.id === idMap.obligations['ob-custom-kos']
    )!;
    expect(migratedObKos.reallocatedToGoalId).toBe(idMap.goals['goal-emergency']);

    const migratedGc = migratedState.goalContributions[0];
    expect(migratedGc.goalId).toBe(idMap.goals['goal-custom-laptop']);
    expect(migratedGc.fromAccountId).toBe(idMap.accounts['acc-custom-seabank']);
    expect(migratedGc.toAccountId).toBe(idMap.accounts['acc-savings']);
    expect(migratedGc.transferId).toBe(idMap.transfers['tr-legacy-goal']);

    // 5. Reminder states & changeLogs entityId remapping
    const remStates = migratedState.settings.reminderSettings.reminderStates!;
    expect(remStates[`rem-ob-${idMap.obligations['ob-kkn-weekly']}`]?.status).toBe('snoozed');
    expect(remStates[`rem-debt-${idMap.debts['debt-friend-initial']}`]?.status).toBe('completed');
    expect(remStates[`rem-custom-${idMap.customReminders['cr-legacy-1']}`]?.status).toBe('disabled');

    const migratedTxLog = migratedState.changeLogs!.find(
      (cl) => cl.id === idMap.changeLogs['cl-legacy-1']
    )!;
    expect(migratedTxLog.entityId).toBe(idMap.transactions['tx-legacy-expense-food']);
    const migratedSettingsLog = migratedState.changeLogs!.find(
      (cl) => cl.id === idMap.changeLogs['cl-legacy-settings']
    )!;
    expect(migratedSettingsLog.entityId).toBe('settings-budget');

    // 6. Independent Balance Oracle verification across EVERY account
    const oracleBefore = calculateBalancesOracle(legacyState);
    const oracleAfter = calculateBalancesOracle(migratedState);

    for (const oldAcc of legacyState.accounts) {
      const newAccId = idMap.accounts[oldAcc.id];
      expect(oracleAfter[newAccId]).toBe(oracleBefore[oldAcc.id]);
      expect(stats.accountBalancesBefore[oldAcc.id]).toBe(oracleBefore[oldAcc.id]);
      expect(stats.accountBalancesAfter[newAccId]).toBe(oracleAfter[newAccId]);
    }
  });

  it('menetapkan systemKey HANYA untuk entitas bawaan sistem dan membiarkan entitas buatan user tanpa systemKey', () => {
    const state = buildRichLegacyState();
    // Simulate a dirty custom entity that wrongly carried an unrecognized systemKey
    const customCat = state.categories.find((c) => c.id === 'cat-custom-kopi')!;
    customCat.systemKey = 'not_a_real_system_key';

    const { migratedState, idMap } = migrateFinanceStateToUUID(state, { saveBackup: false });

    // Built-in accounts have systemKey, custom account has undefined
    const cashAcc = migratedState.accounts.find((a) => a.id === idMap.accounts['acc-cash'])!;
    expect(cashAcc.systemKey).toBe('cash');
    const customAcc = migratedState.accounts.find(
      (a) => a.id === idMap.accounts['acc-custom-seabank']
    )!;
    expect(customAcc.systemKey).toBeUndefined();

    // Built-in category & preset category have systemKey, custom category has undefined
    const cigCat = migratedState.categories.find((c) => c.id === idMap.categories['cat-cig'])!;
    expect(cigCat.systemKey).toBe('cigarette');
    const salaryPresetCat = migratedState.categories.find(
      (c) => c.id === idMap.categories['cat-income-salary']
    )!;
    expect(salaryPresetCat.systemKey).toBe('income_salary');
    const migratedCustomCat = migratedState.categories.find(
      (c) => c.id === idMap.categories['cat-custom-kopi']
    )!;
    expect(migratedCustomCat.systemKey).toBeUndefined();

    // Built-in vs custom debt, obligation, goal
    expect(
      migratedState.debts.find((d) => d.id === idMap.debts['debt-friend-initial'])!.systemKey
    ).toBe('friend_initial');
    expect(
      migratedState.debts.find((d) => d.id === idMap.debts['debt-custom-hosting'])!.systemKey
    ).toBeUndefined();

    expect(
      migratedState.obligations.find((o) => o.id === idMap.obligations['ob-kkn-weekly'])!.systemKey
    ).toBe('kkn_weekly');
    expect(
      migratedState.obligations.find((o) => o.id === idMap.obligations['ob-custom-kos'])!.systemKey
    ).toBeUndefined();

    expect(
      migratedState.goals.find((g) => g.id === idMap.goals['goal-emergency'])!.systemKey
    ).toBe('emergency');
    expect(
      migratedState.goals.find((g) => g.id === idMap.goals['goal-custom-laptop'])!.systemKey
    ).toBeUndefined();
  });

  it('menolak migrasi secara eksplisit bila ditemukan foreign key yatim dan menjaga data asli tetap utuh', () => {
    const state = buildRichLegacyState();
    // Inject orphan FK on transaction and goalContribution without touching parent collections
    state.transactions.push({
      id: 'tx-orphan-acc',
      type: 'expense',
      amount: 15000,
      categoryId: 'cat-missing-ghost',
      accountId: 'acc-missing-deleted',
      date: '2026-11-15',
      description: 'Transaksi yatim',
      tags: [],
      isEssential: false,
      isDiscretionary: true,
      exceededBudget: false,
      createdAt: '2026-11-15T10:00:00Z',
    });

    const activeKey = 'kendaliuang_state_v1_user-orphan';
    const frozenSnapshot = JSON.parse(JSON.stringify(state));
    localStorage.setItem(activeKey, JSON.stringify(state));

    let caughtError: unknown = null;
    try {
      migrateFinanceStateToUUID(state, { userId: 'user-orphan' });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MigrationIntegrityError);
    const integrityErr = caughtError as MigrationIntegrityError;
    expect(integrityErr.code).toBe('ORPHAN_FOREIGN_KEY');
    expect(integrityErr.details.some((d) => d.includes('acc-missing-deleted'))).toBe(true);
    expect(integrityErr.details.some((d) => d.includes('cat-missing-ghost'))).toBe(true);

    // Original in-memory state and active localStorage key remain 100% untouched
    expect(state).toEqual(frozenSnapshot);
    expect(JSON.parse(localStorage.getItem(activeKey)!)).toEqual(frozenSnapshot);
    // Pre-migration backup exists
    expect(localStorage.getItem(getPreUuidBackupKey('user-orphan'))).not.toBeNull();
  });

  it('menolak migrasi bila ada primary key duplikat pada koleksi yang sama', () => {
    const state = buildRichLegacyState();
    state.accounts.push({ ...state.accounts[0] });
    const snapshot = JSON.parse(JSON.stringify(state));

    let caught: unknown = null;
    try {
      migrateFinanceStateToUUID(state, { saveBackup: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationIntegrityError);
    expect((caught as MigrationIntegrityError).code).toBe('DUPLICATE_PRIMARY_KEY');
    expect(state).toEqual(snapshot);
  });
});
