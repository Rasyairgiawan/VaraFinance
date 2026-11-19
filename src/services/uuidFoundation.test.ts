import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialFinanceState } from '../data/initialProfile';
import { computeAccountBalances, computeFinanceSnapshot } from '../engine/financeEngine';
import {
  addCategoryAction,
  addDebtAction,
  addProjectExpenseAction,
  addProjectPaymentAction,
  addTransactionAction,
  borrowPhysicalItemAction,
  confirmNoSpendDayAction,
  createProjectAction,
  createSplitBillAction,
  installGeneralPresetCategoriesAction,
  lendPhysicalAssetAction,
  payObligationAction,
  purchaseAssetAction,
  receiveCustodialFundAction,
  receiveProjectAdvanceAction,
  recognizeProjectAdvanceAction,
  recoverLostAssetAction,
  repayDebtAction,
  reportAssetLostAction,
  returnCustodialFundAction,
  sellAssetAction,
  updateSettingsAction,
  voidTransactionAction,
  writeOffReceivableAction,
} from '../hooks/financeActions';
import { FinanceState } from '../types/finance';
import { isStrictUUIDv4, isValidUUID } from '../utils/format';
import { findSystemAccount, findSystemCategory } from '../utils/systemEntityResolver';
import {
  buildFinanceCSVRows,
  getTransactionExpenseImpactLabel,
} from '../utils/transactionDisplay';
import { loginWithPassword, registerAccount } from './authService';
import {
  getPreUuidBackupKey,
  migrateFinanceStateToUUID,
  needsUuidMigration,
} from './financeMigration';
import {
  getStorageKeyForUser,
  loadLocalState,
  parseAndValidateBackupJSON,
  resetLocalState,
  saveLocalState,
} from './financeRepository';

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

function buildRichLegacyState(): FinanceState {
  let state = createInitialFinanceState('2026-11-10');
  state = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === 'acc-cash'
        ? { ...a, openingBalance: 300000 }
        : a.id === 'acc-business'
        ? { ...a, openingBalance: 500000 }
        : a
    ),
  };

  // Income, cigarette, hangout, snack, biz ops, debt payment
  state = addTransactionAction(state, {
    type: 'income',
    amount: 150000,
    categoryId: 'cat-income-allowance',
    accountId: 'acc-cash',
    date: '2026-11-12',
    description: 'Uang saku',
    incomeSource: 'daily_allowance',
  }).state;
  state = addTransactionAction(state, {
    type: 'expense',
    amount: 22000,
    categoryId: 'cat-cig',
    accountId: 'acc-cash',
    date: '2026-11-14',
    description: 'Rokok',
  }).state;
  state = addTransactionAction(state, {
    type: 'expense',
    amount: 30000,
    categoryId: 'cat-hangout',
    accountId: 'acc-cash',
    date: '2026-11-14',
    description: 'Ngopi',
  }).state;
  state = addTransactionAction(state, {
    type: 'expense',
    amount: 12000,
    categoryId: 'cat-other-exp',
    accountId: 'acc-cash',
    date: '2026-11-15',
    description: 'Jajan sore',
  }).state;
  state = confirmNoSpendDayAction(state, '2026-11-13', 'Hemat', '2026-11-15');

  const projRes = createProjectAction(state, {
    clientName: 'PT Maju',
    projectName: 'Landing Page',
    contractValue: 1000000,
    paymentScheme: 'dp_final',
    businessSharePct: 30,
  });
  state = projRes.state;
  state = addProjectPaymentAction(state, {
    projectId: projRes.project.id,
    paymentType: 'dp',
    amount: 400000,
    status: 'received',
    date: '2026-11-14',
    accountId: 'acc-business',
  });
  state = addProjectExpenseAction(state, {
    projectId: projRes.project.id,
    description: 'Domain',
    amount: 150000,
    date: '2026-11-14',
    accountId: 'acc-business',
  });

  state = repayDebtAction(state, {
    debtId: 'debt-friend-initial',
    amount: 10000,
    accountId: 'acc-cash',
    date: '2026-11-15',
  });

  state = payObligationAction(state, {
    obligationId: 'ob-kkn-weekly',
    amount: 30000,
    accountId: 'acc-cash',
    date: '2026-11-15',
  });

  state.settings.reminderSettings.reminderStates = {
    'rem-ob-ob-kkn-weekly': {
      status: 'snoozed',
      snoozedUntil: '2026-11-17',
      updatedAt: '2026-11-15T10:00:00Z',
    },
  };

  return state;
}

describe('Phase 3.2A — Runtime UUID Migration, SystemKey Resolution & Local Mode Foundation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMockLocalStorage(),
      configurable: true,
    });
  });

  it('initializes new local users directly with valid UUIDs and schemaVersion 3 without creating a pre-UUID backup', () => {
    const userId = 'usr-brand-new';
    const loaded = loadLocalState(userId);

    expect(loaded.schemaVersion).toBe(3);
    expect(needsUuidMigration(loaded)).toBe(false);
    expect(localStorage.getItem(getPreUuidBackupKey(userId))).toBeNull();

    for (const acc of loaded.accounts) {
      expect(isStrictUUIDv4(acc.id)).toBe(true);
      expect(acc.systemKey).toBeTruthy();
    }
    for (const cat of loaded.categories) {
      expect(isStrictUUIDv4(cat.id)).toBe(true);
      if (cat.isSystem) expect(cat.systemKey).toBeTruthy();
    }
    for (const ob of loaded.obligations) expect(isStrictUUIDv4(ob.id)).toBe(true);
    for (const d of loaded.debts) expect(isStrictUUIDv4(d.id)).toBe(true);
    for (const g of loaded.goals) expect(isStrictUUIDv4(g.id)).toBe(true);

    const reset = resetLocalState(userId);
    expect(reset.schemaVersion).toBe(3);
    expect(needsUuidMigration(reset)).toBe(false);
    expect(isStrictUUIDv4(reset.accounts[0].id)).toBe(true);
  });

  it('migrates legacy localStorage data automatically on load, preserves FinanceSnapshot invariants, and is strictly idempotent across reloads', () => {
    const userId = 'usr-legacy-1';
    const legacy = buildRichLegacyState();
    delete legacy.schemaVersion;

    const beforeSnapshot = computeFinanceSnapshot(legacy, '2026-11-15');
    const beforeBalances = Object.fromEntries(
      computeAccountBalances(legacy).map((a) => [a.systemKey ?? a.id, a.currentBalance])
    );

    const storageKey = getStorageKeyForUser(userId);
    localStorage.setItem(storageKey, JSON.stringify(legacy));
    expect(needsUuidMigration(legacy)).toBe(true);

    // First load performs migration and saves raw pre-UUID backup
    const firstLoad = loadLocalState(userId);
    expect(firstLoad.schemaVersion).toBe(3);
    expect(needsUuidMigration(firstLoad)).toBe(false);

    const backupKey = getPreUuidBackupKey(userId);
    const backupRaw = localStorage.getItem(backupKey);
    expect(backupRaw).not.toBeNull();
    const parsedBackup = JSON.parse(backupRaw!);
    expect(parsedBackup.data.accounts.some((a: { id: string }) => a.id === 'acc-cash')).toBe(true);

    // Every entity & foreign key is now a valid UUID
    for (const acc of firstLoad.accounts) expect(isValidUUID(acc.id)).toBe(true);
    for (const cat of firstLoad.categories) expect(isValidUUID(cat.id)).toBe(true);
    for (const tx of firstLoad.transactions) {
      expect(isValidUUID(tx.id)).toBe(true);
      expect(isValidUUID(tx.accountId)).toBe(true);
      expect(isValidUUID(tx.categoryId)).toBe(true);
    }
    const obUuid = firstLoad.obligations[0].id;
    expect(firstLoad.settings.reminderSettings.reminderStates?.[`rem-ob-${obUuid}`]).toBeDefined();

    // Snapshot & balances match 100% before vs after migration
    const afterSnapshot = computeFinanceSnapshot(firstLoad, '2026-11-15');
    const afterBalances = Object.fromEntries(
      computeAccountBalances(firstLoad).map((a) => [a.systemKey ?? a.id, a.currentBalance])
    );
    expect(afterBalances).toEqual(beforeBalances);
    expect(afterSnapshot.liquidPersonalBalance).toBe(beforeSnapshot.liquidPersonalBalance);
    expect(afterSnapshot.businessBalance).toBe(beforeSnapshot.businessBalance);
    expect(afterSnapshot.safeToSpend).toBe(beforeSnapshot.safeToSpend);
    expect(afterSnapshot.outstandingDebtTotal).toBe(beforeSnapshot.outstandingDebtTotal);
    expect(afterSnapshot.recognizedIncomeThisMonth).toBe(beforeSnapshot.recognizedIncomeThisMonth);
    expect(afterSnapshot.cigaretteAnalysis.weeklySpent).toBe(beforeSnapshot.cigaretteAnalysis.weeklySpent);
    expect(afterSnapshot.hangoutAnalysis.weeklySpent).toBe(beforeSnapshot.hangoutAnalysis.weeklySpent);
    expect(afterSnapshot.snackAnalysis.monthlySpent).toBe(beforeSnapshot.snackAnalysis.monthlySpent);
    expect(afterSnapshot.monthlyComparison.currentExpense).toBe(
      beforeSnapshot.monthlyComparison.currentExpense
    );
    expect(afterSnapshot.monthlyBudget.spent).toBe(beforeSnapshot.monthlyBudget.spent);
    expect(afterSnapshot.allocatedTotal).toBe(beforeSnapshot.allocatedTotal);
    expect(afterSnapshot.totalPersonalWealthNet).toBe(beforeSnapshot.totalPersonalWealthNet);

    // Reloading multiple times never regenerates IDs, duplicates entities, or overwrites backup
    const secondLoad = loadLocalState(userId);
    const thirdLoad = loadLocalState(userId);
    expect(secondLoad.accounts.map((a) => a.id)).toEqual(firstLoad.accounts.map((a) => a.id));
    expect(thirdLoad.categories.map((c) => c.id)).toEqual(firstLoad.categories.map((c) => c.id));
    expect(thirdLoad.transactions.map((t) => t.id)).toEqual(firstLoad.transactions.map((t) => t.id));
    expect(secondLoad.accounts.length).toBe(legacy.accounts.length);
    expect(secondLoad.categories.length).toBe(legacy.categories.length);
    expect(localStorage.getItem(backupKey)).toBe(backupRaw);
  });

  it('recovers safely if a previous migration crashed after writing backup, and never deletes/overwrites raw data on failure', () => {
    const userId = 'usr-crash-test';
    const storageKey = getStorageKeyForUser(userId);
    const backupKey = getPreUuidBackupKey(userId);
    const legacy = buildRichLegacyState();

    // Simulate crash scenario: backup already exists, primary storage still holds legacy state
    const preBackupEnvelope = {
      backedUpAt: '2026-11-15T09:00:00Z',
      sourceSchemaVersion: 1,
      data: legacy,
    };
    const serializedBackup = JSON.stringify(preBackupEnvelope);
    localStorage.setItem(backupKey, serializedBackup);
    localStorage.setItem(storageKey, JSON.stringify(legacy));

    const recovered = loadLocalState(userId);
    expect(recovered.schemaVersion).toBe(3);
    expect(isValidUUID(recovered.accounts[0].id)).toBe(true);
    expect(localStorage.getItem(backupKey)).toBe(serializedBackup);

    // Error handling: corrupt orphan FK must NOT clear or overwrite primary localStorage key
    const brokenUserId = 'usr-broken-fk';
    const brokenKey = getStorageKeyForUser(brokenUserId);
    const brokenState = buildRichLegacyState();
    brokenState.transactions[0].accountId = 'acc-does-not-exist';
    const rawBroken = JSON.stringify(brokenState);
    localStorage.setItem(brokenKey, rawBroken);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallback = loadLocalState(brokenUserId);
    errSpy.mockRestore();

    expect(localStorage.getItem(brokenKey)).toBe(rawBroken);
    expect(isValidUUID(fallback.accounts[0].id)).toBe(true);
  });

  it('resolves system accounts and categories via systemKey across engine, actions, and display even with arbitrary UUIDs, while preserving legacy ID fallback', () => {
    // 1. Arbitrary UUID state migrated from legacy
    const legacy = buildRichLegacyState();
    const migrated = migrateFinanceStateToUUID(legacy, { saveBackup: false }).migratedState;

    const cigCat = findSystemCategory(migrated.categories, 'cigarette', 'cat-cig')!;
    const hangCat = findSystemCategory(migrated.categories, 'hangout', 'cat-hangout')!;
    const snackCat = findSystemCategory(migrated.categories, 'other_expense', 'cat-other-exp')!;
    const bizOpsCat = findSystemCategory(migrated.categories, 'business_ops', 'cat-biz-ops')!;
    const debtCat = findSystemCategory(migrated.categories, 'debt_payment', 'cat-debt')!;
    const cashAcc = findSystemAccount(migrated.accounts, 'cash', 'acc-cash')!;
    const bizAcc = findSystemAccount(migrated.accounts, 'business', 'acc-business')!;

    expect(isValidUUID(cigCat.id)).toBe(true);
    expect(isValidUUID(cashAcc.id)).toBe(true);

    // Update settings syncs cigarette & hangout weekly limits via systemKey (not 'cat-cig')
    let next = updateSettingsAction(migrated, {
      cigaretteWeeklyLimit: 80000,
      hangoutWeeklyLimit: 70000,
    });
    expect(next.categories.find((c) => c.id === cigCat.id)?.weeklyLimit).toBe(80000);
    expect(next.categories.find((c) => c.id === hangCat.id)?.weeklyLimit).toBe(70000);

    const snapAfterSettings = computeFinanceSnapshot(next, '2026-11-15');
    expect(snapAfterSettings.cigaretteAnalysis.weeklyLimit).toBe(80000);
    expect(snapAfterSettings.hangoutAnalysis.weeklyLimit).toBe(70000);
    expect(snapAfterSettings.categoryBudgets.find((b) => b.categoryId === cigCat.id)?.weeklyLimit).toBe(80000);

    // Confirm no-spend day and verify discretionary expense vs debt/biz-ops exclusion via systemKey
    next = confirmNoSpendDayAction(next, '2026-11-16', 'Aman', '2026-11-16');
    const bizTxRes = addTransactionAction(next, {
      type: 'expense',
      amount: 25000,
      categoryId: bizOpsCat.id,
      accountId: bizAcc.id,
      date: '2026-11-16',
      description: 'Hosting',
    });
    next = bizTxRes.state;
    // biz_ops tx does NOT revoke no-spend and is NOT counted in personal expense impact label
    expect(getTransactionExpenseImpactLabel(bizTxRes.transaction, next.categories)).toBe(
      'Tidak dihitung pengeluaran'
    );

    const debtTxRes = addTransactionAction(next, {
      type: 'expense',
      amount: 10000,
      categoryId: debtCat.id,
      accountId: cashAcc.id,
      date: '2026-11-16',
      description: 'Cicil manual',
    });
    expect(getTransactionExpenseImpactLabel(debtTxRes.transaction, next.categories)).toBe(
      'Tidak dihitung pengeluaran'
    );

    // Add + void a discretionary snack expense -> reconciles no-spend via systemKey
    const snackRes = addTransactionAction(next, {
      type: 'expense',
      amount: 5000,
      categoryId: snackCat.id,
      accountId: cashAcc.id,
      date: '2026-11-16',
      description: 'Gorengan',
    });
    expect(getTransactionExpenseImpactLabel(snackRes.transaction, snackRes.state.categories)).toBe(
      'Menambah pengeluaran'
    );
    const voidedState = voidTransactionAction(
      snackRes.state,
      snackRes.transaction.id,
      'Salah catat'
    );
    expect(
      voidedState.noSpendConfirmations.find((n) => n.date === '2026-11-16')?.status
    ).toBe('confirmed');

    // Asset purchase + sell + project payment (omitting accountId -> resolves business via systemKey)
    const proj2 = createProjectAction(voidedState, {
      clientName: 'CV Dua',
      projectName: 'App',
      contractValue: 500000,
      paymentScheme: 'full',
      businessSharePct: 20,
    });
    const withProjPay = addProjectPaymentAction(proj2.state, {
      projectId: proj2.project.id,
      paymentType: 'full',
      amount: 500000,
      status: 'received',
      date: '2026-11-16',
    });
    expect(withProjPay.projectPayments[0].accountId).toBe(bizAcc.id);
    expect(isValidUUID(withProjPay.transactions[0].categoryId)).toBe(true);

    const assetBought = purchaseAssetAction(withProjPay, {
      name: 'Mikrofon',
      category: 'electronics',
      acquisitionDate: '2026-11-16',
      acquisitionValue: 50000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: cashAcc.id,
    });
    expect(isValidUUID(assetBought.transaction.categoryId)).toBe(true);

    const assetSold = sellAssetAction(assetBought.state, {
      assetId: assetBought.asset.id,
      salePrice: 40000,
      soldDate: '2026-11-16',
      proceedsMode: 'receivable',
      buyerName: 'Rekan',
    });
    const afterWriteOff = writeOffReceivableAction(assetSold.state, {
      debtId: assetSold.receivable!.id,
      reason: 'Tidak tertagih',
      date: '2026-11-16',
    });
    expect(afterWriteOff.transactions.every((t) => isValidUUID(t.categoryId) && isValidUUID(t.accountId))).toBe(true);

    const csvRows = buildFinanceCSVRows(afterWriteOff, computeFinanceSnapshot(afterWriteOff, '2026-11-16'));
    expect(csvRows.length).toBeGreaterThan(20);

    // 2. Legacy unmigrated ID fallback (without systemKey) still computes accurately
    const bareLegacy = createInitialFinanceState('2026-11-10');
    bareLegacy.categories = bareLegacy.categories.map(({ systemKey: _sk, ...rest }) => rest);
    bareLegacy.accounts = bareLegacy.accounts.map(({ systemKey: _sk, ...rest }) =>
      rest.id === 'acc-cash' ? { ...rest, openingBalance: 200000 } : rest
    );
    const withLegacyCig = addTransactionAction(bareLegacy, {
      type: 'expense',
      amount: 22000,
      categoryId: 'cat-cig',
      accountId: 'acc-cash',
      date: '2026-11-15',
      description: 'Rokok legacy',
    }).state;
    const legacySnap = computeFinanceSnapshot(withLegacyCig, '2026-11-15');
    expect(legacySnap.cigaretteAnalysis.weeklySpent).toBe(22000);
  });

  it('generates RFC 4122 UUID v4 for new categories without cat- prefix and avoids duplicate general presets', () => {
    const initial = loadLocalState('usr-cat-uuid');
    const afterCustom = addCategoryAction(initial, {
      name: 'Donasi Sosial',
      type: 'expense',
      classification: 'discretionary',
      weeklyLimit: 20000,
    });
    const addedCat = afterCustom.categories.find((c) => c.name === 'Donasi Sosial')!;
    expect(addedCat).toBeDefined();
    expect(addedCat.id.startsWith('cat-')).toBe(false);
    expect(isStrictUUIDv4(addedCat.id)).toBe(true);
    expect(addedCat.systemKey).toBeUndefined();

    // Install general presets -> assigns UUIDs & keeps systemKey
    const withPresets = installGeneralPresetCategoriesAction(afterCustom);
    const salaryCat = withPresets.categories.find((c) => c.systemKey === 'income_salary')!;
    expect(salaryCat).toBeDefined();
    expect(isStrictUUIDv4(salaryCat.id)).toBe(true);
    expect(salaryCat.id.startsWith('cat-')).toBe(false);

    // Calling installGeneralPresetCategoriesAction again does NOT create duplicates
    const afterReinstall = installGeneralPresetCategoriesAction(withPresets);
    expect(afterReinstall.categories.length).toBe(withPresets.categories.length);
  });

  it('migrates legacy backup JSON imports on parse and supports old + new Local Mode users cleanly', async () => {
    // Backup JSON migration on import
    const legacyBackup = createInitialFinanceState('2026-11-10');
    const migratedImport = parseAndValidateBackupJSON(JSON.stringify(legacyBackup));
    expect(migratedImport.schemaVersion).toBe(3);
    expect(isValidUUID(migratedImport.accounts[0].id)).toBe(true);

    // Old local user with legacy pre-UUID storage logs in and retains full data with UUIDs
    const oldReg = await registerAccount({
      username: 'old_local_user',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
    });
    expect(oldReg.session).not.toBeNull();
    const legacyData = buildRichLegacyState();
    saveLocalState(legacyData, oldReg.session!.userId);

    const oldLogin = await loginWithPassword({
      username: 'old_local_user',
      password: 'Password123',
    });
    const oldLoaded = loadLocalState(oldLogin.session.userId);
    expect(oldLoaded.schemaVersion).toBe(3);
    expect(oldLoaded.transactions.length).toBe(legacyData.transactions.length);
    expect(isValidUUID(oldLoaded.transactions[0].id)).toBe(true);

    // New local user registers and starts directly on UUID schema v3
    const newReg = await registerAccount({
      username: 'new_local_user',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '445566',
      confirmPin: '445566',
    });
    expect(newReg.session).not.toBeNull();
    const newLoaded = loadLocalState(newReg.session!.userId);
    expect(newLoaded.schemaVersion).toBe(3);
    expect(isStrictUUIDv4(newLoaded.accounts[0].id)).toBe(true);
    expect(localStorage.getItem(getPreUuidBackupKey(newReg.session!.userId))).toBeNull();
  });

  it('Phase 3.2A.1 (A): migrates rem-loan-* reminderStates accurately to migrated PhysicalItemLoan UUIDs and preserves reminder suppression', () => {
    const userId = 'usr-rem-loan';
    let legacy = createInitialFinanceState('2026-11-10');
    legacy = {
      ...legacy,
      accounts: legacy.accounts.map((a) =>
        a.id === 'acc-cash' ? { ...a, openingBalance: 1000000 } : a
      ),
    };

    const bought = purchaseAssetAction(legacy, {
      name: 'Kamera Sony',
      category: 'electronics',
      acquisitionDate: '2026-11-12',
      acquisitionValue: 300000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: 'acc-cash',
    });
    legacy = bought.state;

    const lent = lendPhysicalAssetAction(legacy, {
      assetId: bought.asset.id,
      borrowerName: 'Rafi',
      loanDate: '2026-11-13',
      expectedReturnDate: '2026-11-16',
    });
    legacy = lent.state;

    const borrowed = borrowPhysicalItemAction(legacy, {
      itemName: 'Tripod Velbon',
      category: 'electronics',
      ownerName: 'Dina',
      loanDate: '2026-11-11',
      expectedReturnDate: '2026-11-14',
      conditionReceived: 'good',
    });
    legacy = borrowed.state;

    const borrowedDisabled = borrowPhysicalItemAction(legacy, {
      itemName: 'Lensa 50mm',
      category: 'electronics',
      ownerName: 'Bima',
      loanDate: '2026-11-12',
      expectedReturnDate: '2026-11-17',
      conditionReceived: 'good',
    });
    legacy = borrowedDisabled.state;

    // Assign legacy non-UUID loan IDs + an uppercase UUID loan ID to verify both paths
    const legacyLoanId1 = 'loan-legacy-lent-1';
    const uppercaseUuidLoanId2 = 'B4A1E9D0-1122-4333-8444-5566778899AA';
    const legacyLoanId3 = 'loan-legacy-disabled-3';

    legacy = {
      ...legacy,
      physicalItemLoans: (legacy.physicalItemLoans ?? []).map((loan) => {
        if (loan.id === lent.loan.id) return { ...loan, id: legacyLoanId1 };
        if (loan.id === borrowed.loan.id) return { ...loan, id: uppercaseUuidLoanId2 };
        if (loan.id === borrowedDisabled.loan.id) return { ...loan, id: legacyLoanId3 };
        return loan;
      }),
    };

    // Without reminderStates, all 3 asset_loan reminders are active
    const unsuppressedSnap = computeFinanceSnapshot(legacy, '2026-11-15');
    expect(unsuppressedSnap.upcomingReminders.some((r) => r.id === `rem-loan-${legacyLoanId1}`)).toBe(true);
    expect(unsuppressedSnap.upcomingReminders.some((r) => r.id === `rem-loan-${uppercaseUuidLoanId2}`)).toBe(true);
    expect(unsuppressedSnap.upcomingReminders.some((r) => r.id === `rem-loan-${legacyLoanId3}`)).toBe(true);

    // Attach snoozed, completed, and disabled states for rem-loan-*
    legacy.settings.reminderSettings.reminderStates = {
      [`rem-loan-${legacyLoanId1}`]: {
        status: 'snoozed',
        snoozedUntil: '2026-11-18',
        updatedAt: '2026-11-15T10:00:00Z',
      },
      [`rem-loan-${uppercaseUuidLoanId2}`]: {
        status: 'completed',
        updatedAt: '2026-11-15T10:05:00Z',
      },
      [`rem-loan-${legacyLoanId3}`]: {
        status: 'disabled',
        updatedAt: '2026-11-15T10:10:00Z',
      },
    };
    delete legacy.schemaVersion;

    const beforeSuppressedSnap = computeFinanceSnapshot(legacy, '2026-11-15');
    expect(beforeSuppressedSnap.upcomingReminders.filter((r) => r.kind === 'asset_loan')).toHaveLength(0);

    localStorage.setItem(getStorageKeyForUser(userId), JSON.stringify(legacy));
    const migrated = loadLocalState(userId);

    const migratedLoan1 = migrated.physicalItemLoans!.find((l) => l.itemName === 'Kamera Sony')!;
    const migratedLoan2 = migrated.physicalItemLoans!.find((l) => l.itemName === 'Tripod Velbon')!;
    const migratedLoan3 = migrated.physicalItemLoans!.find((l) => l.itemName === 'Lensa 50mm')!;

    expect(isValidUUID(migratedLoan1.id)).toBe(true);
    expect(migratedLoan1.id).not.toBe(legacyLoanId1);
    expect(migratedLoan2.id).toBe(uppercaseUuidLoanId2.toLowerCase());
    expect(isValidUUID(migratedLoan3.id)).toBe(true);

    const remStates = migrated.settings.reminderSettings.reminderStates!;
    expect(remStates[`rem-loan-${legacyLoanId1}`]).toBeUndefined();
    expect(remStates[`rem-loan-${uppercaseUuidLoanId2}`]).toBeUndefined();
    expect(remStates[`rem-loan-${legacyLoanId3}`]).toBeUndefined();

    expect(remStates[`rem-loan-${migratedLoan1.id}`]).toEqual({
      status: 'snoozed',
      snoozedUntil: '2026-11-18',
      updatedAt: '2026-11-15T10:00:00Z',
    });
    expect(remStates[`rem-loan-${migratedLoan2.id}`]).toEqual({
      status: 'completed',
      updatedAt: '2026-11-15T10:05:00Z',
    });
    expect(remStates[`rem-loan-${migratedLoan3.id}`]).toEqual({
      status: 'disabled',
      updatedAt: '2026-11-15T10:10:00Z',
    });

    expect(needsUuidMigration(migrated)).toBe(false);
    const afterSuppressedSnap = computeFinanceSnapshot(migrated, '2026-11-15');
    expect(afterSuppressedSnap.upcomingReminders.filter((r) => r.kind === 'asset_loan')).toHaveLength(0);

    // Clearing reminderStates confirms migrated rem-loan-<uuid> is what financeEngine emits
    const unsuppressedAfter = computeFinanceSnapshot(
      {
        ...migrated,
        settings: {
          ...migrated.settings,
          reminderSettings: {
            ...migrated.settings.reminderSettings,
            reminderStates: {},
          },
        },
      },
      '2026-11-15'
    );
    expect(unsuppressedAfter.upcomingReminders.some((r) => r.id === `rem-loan-${migratedLoan1.id}`)).toBe(true);
    expect(unsuppressedAfter.upcomingReminders.some((r) => r.id === `rem-loan-${migratedLoan2.id}`)).toBe(true);
  });

  it('Phase 3.2A.1 (B): avoids false-positive migration on installGeneralPresetCategoriesAction sentinel while detecting real legacy changeLogs entityIds', () => {
    const userId = 'usr-sentinel-regression';
    const initial = loadLocalState(userId);
    const withPresets = installGeneralPresetCategoriesAction(initial);

    expect(withPresets.schemaVersion).toBe(3);
    expect(
      (withPresets.changeLogs ?? []).some(
        (log) => log.entityType === 'category' && log.entityId === 'presets'
      )
    ).toBe(true);

    // Must return false deterministically across repeated checks
    expect(needsUuidMigration(withPresets)).toBe(false);
    expect(needsUuidMigration(withPresets)).toBe(false);

    // Save & reload through repository: must NOT trigger migration or create pre-UUID backup
    saveLocalState(withPresets, userId);
    const reloaded = loadLocalState(userId);
    expect(localStorage.getItem(getPreUuidBackupKey(userId))).toBeNull();
    expect(reloaded.categories.map((c) => c.id)).toEqual(withPresets.categories.map((c) => c.id));
    expect(needsUuidMigration(reloaded)).toBe(false);

    // Real non-UUID entityId in changeLogs must still be flagged as needing migration
    const withLegacyCatLog: FinanceState = {
      ...reloaded,
      changeLogs: [
        ...(reloaded.changeLogs ?? []),
        {
          id: '44444444-4444-4444-8444-444444444444',
          timestamp: '2026-11-15T12:00:00Z',
          entityType: 'category',
          entityId: 'cat-food',
          action: 'update',
          summary: 'Legacy category changelog',
        },
      ],
    };
    expect(needsUuidMigration(withLegacyCatLog)).toBe(true);
    expect(needsUuidMigration(withLegacyCatLog)).toBe(true);

    const withLegacyTxLog: FinanceState = {
      ...reloaded,
      changeLogs: [
        ...(reloaded.changeLogs ?? []),
        {
          id: '55555555-5555-4555-8555-555555555555',
          timestamp: '2026-11-15T12:01:00Z',
          entityType: 'transaction',
          entityId: 'tx-legacy-1',
          action: 'create',
          summary: 'Legacy transaction changelog',
        },
      ],
    };
    expect(needsUuidMigration(withLegacyTxLog)).toBe(true);
  });

  it('Phase 3.2A.1 (C): needsUuidMigration() detects every synced field and nested FK across Phase 2.1-2.6 types', () => {
    let base = loadLocalState('usr-field-sync');
    const cashAcc = findSystemAccount(base.accounts, 'cash', 'acc-cash')!;
    const bankAcc = findSystemAccount(base.accounts, 'bank_personal', 'acc-bank')!;
    const bizAcc = findSystemAccount(base.accounts, 'business', 'acc-business')!;
    const snackCat = findSystemCategory(base.categories, 'other_expense', 'cat-other-exp')!;

    base = {
      ...base,
      accounts: base.accounts.map((a) =>
        a.id === cashAcc.id
          ? { ...a, openingBalance: 2000000 }
          : a.id === bankAcc.id
          ? { ...a, openingBalance: 1000000 }
          : a.id === bizAcc.id
          ? { ...a, openingBalance: 1000000 }
          : a
      ),
    };

    const proj = createProjectAction(base, {
      clientName: 'Client Sync',
      projectName: 'Sync Web',
      contractValue: 1000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    base = proj.state;

    const cfRes = receiveCustodialFundAction(base, {
      counterparty: 'Budi Titip',
      amount: 100000,
      accountId: cashAcc.id,
      date: '2026-11-14',
    });
    base = cfRes.state;

    const paRes = receiveProjectAdvanceAction(base, {
      projectId: proj.project.id,
      amount: 300000,
      accountId: bizAcc.id,
      date: '2026-11-14',
    });
    base = paRes.state;
    base = recognizeProjectAdvanceAction(base, {
      projectAdvanceId: paRes.projectAdvance.id,
      amount: 100000,
      date: '2026-11-15',
    });

    const sbRes = createSplitBillAction(base, {
      title: 'Makan Tim',
      totalAmount: 90000,
      categoryId: snackCat.id,
      accountId: cashAcc.id,
      date: '2026-11-15',
      splitMode: 'equal',
      userShareAmount: 30000,
      participants: [
        { name: 'Adi', shareAmount: 30000 },
        { name: 'Cici', shareAmount: 30000 },
      ],
    });
    base = sbRes.state;

    const assetRes = purchaseAssetAction(base, {
      name: 'Monitor 27',
      category: 'electronics',
      acquisitionDate: '2026-11-12',
      acquisitionValue: 400000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: cashAcc.id,
    });
    base = assetRes.state;

    const lentRes = lendPhysicalAssetAction(base, {
      assetId: assetRes.asset.id,
      borrowerName: 'Eko',
      loanDate: '2026-11-13',
      expectedReturnDate: '2026-11-16',
    });
    base = lentRes.state;

    const lostRes = reportAssetLostAction(base, {
      assetId: assetRes.asset.id,
      lostDate: '2026-11-14',
      reason: 'Tertinggal',
      requireCompensation: true,
      compensationAmount: 200000,
    });
    base = lostRes.state;

    const recRes = recoverLostAssetAction(base, {
      assetId: assetRes.asset.id,
      recoveredDate: '2026-11-15',
      condition: 'fair',
      cancelUnpaidCompensation: true,
    });
    base = recRes.state;

    base = {
      ...base,
      transfers: [
        ...base.transfers,
        {
          id: '11111111-1111-4111-8111-111111111111',
          fromAccountId: cashAcc.id,
          toAccountId: bankAcc.id,
          amount: 50000,
          date: '2026-11-15',
          createdAt: '2026-11-15T10:00:00Z',
          restrictedMovements: [
            {
              fundType: 'custodial',
              fundId: cfRes.custodialFund.id,
              amount: 50000,
            },
          ],
        },
      ],
      transactions: base.transactions.map((t, idx) =>
        idx === 0
          ? {
              ...t,
              assetId: assetRes.asset.id,
              parentTransactionId: sbRes.paymentTransaction.id,
            }
          : t
      ),
    };

    expect(needsUuidMigration(base)).toBe(false);

    const mutateAndAssert = (label: string, mutator: (draft: FinanceState) => void) => {
      const copy = structuredClone(base);
      mutator(copy);
      expect(needsUuidMigration(copy), `Expected needsUuidMigration=true for ${label}`).toBe(true);
    };

    mutateAndAssert('transactions.assetId', (s) => {
      s.transactions[0].assetId = 'asset-legacy';
    });
    mutateAndAssert('transactions.parentTransactionId', (s) => {
      s.transactions[0].parentTransactionId = 'tx-parent-legacy';
    });
    mutateAndAssert('transfers.restrictedMovements[].fundId', (s) => {
      s.transfers[0].restrictedMovements![0].fundId = 'cf-legacy';
    });
    mutateAndAssert('splitBills.paymentTransactionId', (s) => {
      s.splitBills![0].paymentTransactionId = 'tx-legacy';
    });
    mutateAndAssert('splitBills.personalShareTransactionId', (s) => {
      s.splitBills![0].personalShareTransactionId = 'tx-share-legacy';
    });
    mutateAndAssert('splitBills.ledgerGroupId', (s) => {
      s.splitBills![0].ledgerGroupId = 'lg-legacy';
    });
    mutateAndAssert('splitBills.participants[].debtId', (s) => {
      s.splitBills![0].participants[0].debtId = 'debt-legacy';
    });
    mutateAndAssert('custodialFunds.holdingAccountId', (s) => {
      s.custodialFunds![0].holdingAccountId = 'acc-legacy';
    });
    mutateAndAssert('custodialFunds.receiptTransactionId', (s) => {
      s.custodialFunds![0].receiptTransactionId = 'tx-legacy';
    });
    mutateAndAssert('custodialFunds.ledgerGroupId', (s) => {
      s.custodialFunds![0].ledgerGroupId = 'lg-legacy';
    });
    mutateAndAssert('custodialFunds.fundAllocations[].accountId', (s) => {
      s.custodialFunds![0].fundAllocations![0].accountId = 'acc-legacy';
    });
    mutateAndAssert('projectAdvances.projectId', (s) => {
      s.projectAdvances![0].projectId = 'proj-legacy';
    });
    mutateAndAssert('projectAdvances.holdingAccountId', (s) => {
      s.projectAdvances![0].holdingAccountId = 'acc-legacy';
    });
    mutateAndAssert('projectAdvances.receiptTransactionId', (s) => {
      s.projectAdvances![0].receiptTransactionId = 'tx-legacy';
    });
    mutateAndAssert('projectAdvances.ledgerGroupId', (s) => {
      s.projectAdvances![0].ledgerGroupId = 'lg-legacy';
    });
    mutateAndAssert('projectAdvances.fundAllocations[].accountId', (s) => {
      s.projectAdvances![0].fundAllocations![0].accountId = 'acc-legacy';
    });
    mutateAndAssert('projectAdvances.recognitions[].allocationDeltas[].accountId', (s) => {
      s.projectAdvances![0].recognitions[0].allocationDeltas![0].accountId = 'acc-legacy';
    });
    mutateAndAssert('physicalAssets.recoveryHistory[].id', (s) => {
      s.physicalAssets![0].recoveryHistory![0].id = 'rec-legacy';
    });
    mutateAndAssert('physicalAssets.recoveryHistory[].lossRecordId', (s) => {
      s.physicalAssets![0].recoveryHistory![0].lossRecordId = 'loss-legacy';
    });
    mutateAndAssert('physicalItemLoans.conditionHistory[].id', (s) => {
      s.physicalItemLoans![0].conditionHistory[0].id = 'cond-legacy';
    });
    mutateAndAssert('physicalItemLoans.assetId', (s) => {
      s.physicalItemLoans![0].assetId = 'asset-legacy';
    });
    mutateAndAssert('physicalItemLoans.lossRecordId', (s) => {
      s.physicalItemLoans![0].lossRecordId = 'loss-legacy';
    });
    mutateAndAssert('physicalItemLoans.compensationDebtId', (s) => {
      s.physicalItemLoans![0].compensationDebtId = 'debt-legacy';
    });
    mutateAndAssert('reminderStates.rem-loan-*', (s) => {
      s.settings.reminderSettings.reminderStates = {
        ...s.settings.reminderSettings.reminderStates,
        'rem-loan-loan-legacy': {
          status: 'snoozed',
          snoozedUntil: '2026-11-18',
          updatedAt: '2026-11-15T10:00:00Z',
        },
      };
    });
  });

  it('Phase 3.2A.1 (D): preserves complete FinanceSnapshot accounting parity before vs after migration across all Phase 2.1-2.6 domains', () => {
    const userId = 'usr-full-phase2-parity';
    const refDate = '2026-11-15';
    let state = buildRichLegacyState();
    state = {
      ...state,
      accounts: state.accounts.map((a) =>
        a.id === 'acc-cash'
          ? { ...a, openingBalance: 2500000 }
          : a.id === 'acc-bank'
          ? { ...a, openingBalance: 1500000 }
          : a.id === 'acc-savings'
          ? { ...a, openingBalance: 1000000 }
          : a.id === 'acc-business'
          ? { ...a, openingBalance: 2000000 }
          : a
      ),
    };

    // 1. Receivables (active personal loan receivable + written-off recognized receivable)
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'friend_advance',
      creditor: 'Nando',
      description: 'Talangan makan',
      amount: 80000,
      date: '2026-11-13',
      dueDate: '2026-11-20',
      accountId: 'acc-cash',
    });
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'Klien Lama',
      description: 'Tagihan mikro',
      amount: 120000,
      date: '2026-11-10',
      dueDate: '2026-11-14',
      accountId: 'acc-business',
      revenueAlreadyRecorded: true,
    });
    const writeOffTarget = state.debts.find((d) => d.creditor === 'Klien Lama')!;
    state = writeOffReceivableAction(state, {
      debtId: writeOffTarget.id,
      date: '2026-11-15',
      reason: 'Tidak tertagih',
    });

    // 2. Split Bill
    const sb = createSplitBillAction(state, {
      title: 'Ngopi Bareng',
      totalAmount: 90000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: '2026-11-15',
      splitMode: 'equal',
      userShareAmount: 30000,
      overrideReason: 'Traktir kopi bersama tim',
      participants: [
        { name: 'Rizal', shareAmount: 30000, dueDate: '2026-11-19' },
        { name: 'Tari', shareAmount: 30000, dueDate: '2026-11-19' },
      ],
    });
    state = sb.state;

    // 3. Custodial Funds (receive + partial return)
    const cf = receiveCustodialFundAction(state, {
      counterparty: 'Panitia Acara',
      description: 'Titipan dana konsumsi',
      amount: 350000,
      accountId: 'acc-bank',
      date: '2026-11-13',
    });
    state = cf.state;
    state = returnCustodialFundAction(state, {
      custodialFundId: cf.custodialFund.id,
      amount: 100000,
      accountId: 'acc-bank',
      date: '2026-11-14',
    });

    // 4. Project Advances (receive + partial recognition)
    const projId = state.projects[0].id;
    const pa = receiveProjectAdvanceAction(state, {
      projectId: projId,
      amount: 600000,
      accountId: 'acc-business',
      date: '2026-11-12',
      description: 'DP Proyek Tahap 2',
    });
    state = pa.state;
    state = recognizeProjectAdvanceAction(state, {
      projectAdvanceId: pa.projectAdvance.id,
      amount: 250000,
      date: '2026-11-15',
      accountId: 'acc-business',
    });

    // 5. Physical Assets & Physical Item Loans (cash + lent + credit w/ DP sold + lost w/ comp + recovered + borrowed overdue)
    const assetLent = purchaseAssetAction(state, {
      name: 'Mic Wireless',
      category: 'electronics',
      acquisitionDate: '2026-11-11',
      acquisitionValue: 300000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: 'acc-cash',
    });
    state = assetLent.state;
    const lentLoan = lendPhysicalAssetAction(state, {
      assetId: assetLent.asset.id,
      borrowerName: 'Fajar',
      loanDate: '2026-11-12',
      expectedReturnDate: '2026-11-16',
    });
    state = lentLoan.state;

    const assetSold = purchaseAssetAction(state, {
      name: 'Keyboard Mekanik',
      category: 'electronics',
      acquisitionDate: '2026-11-10',
      acquisitionValue: 400000,
      condition: 'good',
      paymentMethod: 'credit_with_down_payment',
      downPaymentAmount: 100000,
      accountId: 'acc-cash',
      creditor: 'Toko Gear',
      dueDate: '2026-12-01',
    });
    state = assetSold.state;
    state = sellAssetAction(state, {
      assetId: assetSold.asset.id,
      salePrice: 460000,
      soldDate: '2026-11-14',
      proceedsMode: 'cash',
      accountId: 'acc-bank',
    }).state;

    const assetLostActive = purchaseAssetAction(state, {
      name: 'Headset Studio',
      category: 'electronics',
      acquisitionDate: '2026-11-11',
      acquisitionValue: 250000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: 'acc-cash',
    });
    state = assetLostActive.state;
    state = reportAssetLostAction(state, {
      assetId: assetLostActive.asset.id,
      lostDate: '2026-11-14',
      reason: 'Hilang di studio',
      requireCompensation: true,
      liableParty: 'Yuda',
      compensationAmount: 200000,
      compensationDueDate: '2026-11-22',
    }).state;

    const assetRecovered = purchaseAssetAction(state, {
      name: 'Powerbank 20k',
      category: 'electronics',
      acquisitionDate: '2026-11-10',
      acquisitionValue: 180000,
      condition: 'good',
      paymentMethod: 'cash',
      accountId: 'acc-cash',
    });
    state = assetRecovered.state;
    state = reportAssetLostAction(state, {
      assetId: assetRecovered.asset.id,
      lostDate: '2026-11-12',
      reason: 'Terselip di tas',
      requireCompensation: false,
    }).state;
    state = recoverLostAssetAction(state, {
      assetId: assetRecovered.asset.id,
      recoveredDate: '2026-11-14',
      condition: 'good',
    }).state;

    const borrowedOverdue = borrowPhysicalItemAction(state, {
      itemName: 'Stabilizer Gimbal',
      category: 'electronics',
      ownerName: 'Hendra',
      loanDate: '2026-11-10',
      expectedReturnDate: '2026-11-13',
      conditionReceived: 'good',
    });
    state = borrowedOverdue.state;

    state.settings.reminderSettings.reminderStates = {
      ...state.settings.reminderSettings.reminderStates,
      [`rem-loan-${lentLoan.loan.id}`]: {
        status: 'snoozed',
        snoozedUntil: '2026-11-18',
        updatedAt: '2026-11-15T09:00:00Z',
      },
    };
    delete state.schemaVersion;

    // Snapshot BEFORE migration on identical fixture + reference date
    const beforeSnapshot = computeFinanceSnapshot(state, refDate);
    expect(beforeSnapshot.outstandingReceivableTotal).toBeGreaterThan(0);
    expect(beforeSnapshot.writtenOffReceivableTotal).toBeGreaterThan(0);
    expect(beforeSnapshot.custodialFundsHeldTotal).toBeGreaterThan(0);
    expect(beforeSnapshot.deferredProjectAdvancesTotal).toBeGreaterThan(0);
    expect(beforeSnapshot.physicalAssetsTotal).toBeGreaterThan(0);
    expect(beforeSnapshot.lentAssetsActiveCount).toBe(1);
    expect(beforeSnapshot.borrowedItemsActiveCount).toBe(1);
    expect(beforeSnapshot.overdueItemLoansCount).toBe(1);

    localStorage.setItem(getStorageKeyForUser(userId), JSON.stringify(state));
    const migrated = loadLocalState(userId);
    expect(migrated.schemaVersion).toBe(3);
    expect(needsUuidMigration(migrated)).toBe(false);

    // Snapshot AFTER migration on identical reference date
    const afterSnapshot = computeFinanceSnapshot(migrated, refDate);

    // Account balances & breakdown
    expect(
      afterSnapshot.accounts.map((a) => ({
        key: a.systemKey ?? a.name,
        currentBalance: a.currentBalance,
        openingBalance: a.openingBalance,
      }))
    ).toEqual(
      beforeSnapshot.accounts.map((a) => ({
        key: a.systemKey ?? a.name,
        currentBalance: a.currentBalance,
        openingBalance: a.openingBalance,
      }))
    );
    expect(afterSnapshot.accountBreakdown).toEqual(beforeSnapshot.accountBreakdown);
    expect(afterSnapshot.liquidPersonalBalance).toBe(beforeSnapshot.liquidPersonalBalance);
    expect(afterSnapshot.businessBalance).toBe(beforeSnapshot.businessBalance);
    expect(afterSnapshot.protectedAccountBalance).toBe(beforeSnapshot.protectedAccountBalance);
    expect(afterSnapshot.totalNetAssets).toBe(beforeSnapshot.totalNetAssets);

    // Custodial & deferred advances
    expect(afterSnapshot.custodialFundsHeldTotal).toBe(beforeSnapshot.custodialFundsHeldTotal);
    expect(afterSnapshot.custodialInLiquid).toBe(beforeSnapshot.custodialInLiquid);
    expect(afterSnapshot.custodialInProtected).toBe(beforeSnapshot.custodialInProtected);
    expect(afterSnapshot.custodialInBusiness).toBe(beforeSnapshot.custodialInBusiness);
    expect(afterSnapshot.deferredProjectAdvancesTotal).toBe(
      beforeSnapshot.deferredProjectAdvancesTotal
    );
    expect(afterSnapshot.deferredAdvanceRecognizedTotal).toBe(
      beforeSnapshot.deferredAdvanceRecognizedTotal
    );
    expect(afterSnapshot.deferredAdvanceRefundedTotal).toBe(
      beforeSnapshot.deferredAdvanceRefundedTotal
    );
    expect(afterSnapshot.deferredAdvancesInLiquid).toBe(beforeSnapshot.deferredAdvancesInLiquid);
    expect(afterSnapshot.deferredAdvancesInProtected).toBe(
      beforeSnapshot.deferredAdvancesInProtected
    );
    expect(afterSnapshot.deferredAdvancesInBusiness).toBe(
      beforeSnapshot.deferredAdvancesInBusiness
    );
    expect(afterSnapshot.personalLiquidOwnNet).toBe(beforeSnapshot.personalLiquidOwnNet);
    expect(afterSnapshot.protectedFreeBalance).toBe(beforeSnapshot.protectedFreeBalance);
    expect(afterSnapshot.businessFreeBalance).toBe(beforeSnapshot.businessFreeBalance);

    // Physical assets & physical item loans
    expect(afterSnapshot.physicalAssetsTotal).toBe(beforeSnapshot.physicalAssetsTotal);
    expect(afterSnapshot.physicalAssetsCount).toBe(beforeSnapshot.physicalAssetsCount);
    expect(afterSnapshot.lentAssetsActiveCount).toBe(beforeSnapshot.lentAssetsActiveCount);
    expect(afterSnapshot.borrowedItemsActiveCount).toBe(beforeSnapshot.borrowedItemsActiveCount);
    expect(afterSnapshot.lentLoansActiveCount).toBe(beforeSnapshot.lentLoansActiveCount);
    expect(afterSnapshot.overdueItemLoansCount).toBe(beforeSnapshot.overdueItemLoansCount);
    expect(afterSnapshot.assetSaleGainLossTotal).toBe(beforeSnapshot.assetSaleGainLossTotal);
    expect(afterSnapshot.assetCurrentLostValueTotal).toBe(
      beforeSnapshot.assetCurrentLostValueTotal
    );
    expect(afterSnapshot.assetHistoricalLossTotal).toBe(beforeSnapshot.assetHistoricalLossTotal);

    // Debts, receivables, obligations, reserves & Safe-to-Spend
    expect(afterSnapshot.outstandingDebtTotal).toBe(beforeSnapshot.outstandingDebtTotal);
    expect(afterSnapshot.outstandingReceivableTotal).toBe(
      beforeSnapshot.outstandingReceivableTotal
    );
    expect(afterSnapshot.writtenOffReceivableTotal).toBe(
      beforeSnapshot.writtenOffReceivableTotal
    );
    expect(afterSnapshot.writtenOffRecognizedLossTotal).toBe(
      beforeSnapshot.writtenOffRecognizedLossTotal
    );
    expect(afterSnapshot.writtenOffUnrecognizedTotal).toBe(
      beforeSnapshot.writtenOffUnrecognizedTotal
    );
    expect(afterSnapshot.linkedDebtObligationsExcludedTotal).toBe(
      beforeSnapshot.linkedDebtObligationsExcludedTotal
    );
    expect(afterSnapshot.reservedObligations).toBe(beforeSnapshot.reservedObligations);
    expect(afterSnapshot.unfundedObligations).toBe(beforeSnapshot.unfundedObligations);
    expect(afterSnapshot.reservedScheduledExpenses).toBe(
      beforeSnapshot.reservedScheduledExpenses
    );
    expect(afterSnapshot.unfundedScheduledExpenses).toBe(
      beforeSnapshot.unfundedScheduledExpenses
    );
    expect(afterSnapshot.allocatedTotal).toBe(beforeSnapshot.allocatedTotal);
    expect(afterSnapshot.essentialReserve).toBe(beforeSnapshot.essentialReserve);
    expect(afterSnapshot.protectedVirtualSavings).toBe(beforeSnapshot.protectedVirtualSavings);
    expect(afterSnapshot.fundingShortfall).toBe(beforeSnapshot.fundingShortfall);
    expect(afterSnapshot.rawDiscretionarySurplus).toBe(beforeSnapshot.rawDiscretionarySurplus);
    expect(afterSnapshot.safeToSpend).toBe(beforeSnapshot.safeToSpend);
    expect(afterSnapshot.totalPersonalWealthNet).toBe(beforeSnapshot.totalPersonalWealthNet);

    // Income, budgets, habits, mode, score, prediction, project summaries, reminders
    expect(afterSnapshot.recognizedIncomeThisMonth).toBe(
      beforeSnapshot.recognizedIncomeThisMonth
    );
    expect(afterSnapshot.cashReceiptsThisMonth).toBe(beforeSnapshot.cashReceiptsThisMonth);
    expect(afterSnapshot.dailyBudget).toEqual(beforeSnapshot.dailyBudget);
    expect(afterSnapshot.weeklyBudget).toEqual(beforeSnapshot.weeklyBudget);
    expect(afterSnapshot.monthlyBudget).toEqual(beforeSnapshot.monthlyBudget);
    expect(afterSnapshot.cigaretteAnalysis).toEqual(beforeSnapshot.cigaretteAnalysis);
    expect(afterSnapshot.hangoutAnalysis).toEqual(beforeSnapshot.hangoutAnalysis);
    expect(afterSnapshot.snackAnalysis).toEqual(beforeSnapshot.snackAnalysis);
    expect(afterSnapshot.discretionarySharePct).toBe(beforeSnapshot.discretionarySharePct);
    expect(afterSnapshot.modeEvaluation).toEqual(beforeSnapshot.modeEvaluation);
    expect(afterSnapshot.noSpendStats).toEqual(beforeSnapshot.noSpendStats);
    expect(afterSnapshot.weeklyComparison).toEqual(beforeSnapshot.weeklyComparison);
    expect(afterSnapshot.monthlyComparison).toEqual(beforeSnapshot.monthlyComparison);
    expect(afterSnapshot.disciplineScore).toBe(beforeSnapshot.disciplineScore);
    expect(afterSnapshot.disciplineScoreBreakdown).toEqual(
      beforeSnapshot.disciplineScoreBreakdown
    );
    expect(afterSnapshot.monthlyPrediction).toEqual(beforeSnapshot.monthlyPrediction);
    expect(
      afterSnapshot.projectSummaries.map((p) => ({
        name: p.project.projectName,
        receivedAmount: p.receivedAmount,
        totalExpenses: p.totalExpenses,
        netProfit: p.netProfit,
        recognizedAdvanceAmount: p.recognizedAdvanceAmount,
        unrecognizedAdvanceAmount: p.unrecognizedAdvanceAmount,
        refundedAdvanceAmount: p.refundedAdvanceAmount,
      }))
    ).toEqual(
      beforeSnapshot.projectSummaries.map((p) => ({
        name: p.project.projectName,
        receivedAmount: p.receivedAmount,
        totalExpenses: p.totalExpenses,
        netProfit: p.netProfit,
        recognizedAdvanceAmount: p.recognizedAdvanceAmount,
        unrecognizedAdvanceAmount: p.unrecognizedAdvanceAmount,
        refundedAdvanceAmount: p.refundedAdvanceAmount,
      }))
    );
    expect(
      afterSnapshot.categoryBudgets.map((b) => ({
        name: b.categoryName,
        weeklySpent: b.weeklySpent,
        monthlySpent: b.monthlySpent,
      }))
    ).toEqual(
      beforeSnapshot.categoryBudgets.map((b) => ({
        name: b.categoryName,
        weeklySpent: b.weeklySpent,
        monthlySpent: b.monthlySpent,
      }))
    );
    expect(
      afterSnapshot.upcomingReminders.map((r) => ({
        kind: r.kind,
        title: r.title,
        dueDate: r.dueDate,
        daysRemaining: r.daysRemaining,
        amount: r.amount,
        severity: r.severity,
      }))
    ).toEqual(
      beforeSnapshot.upcomingReminders.map((r) => ({
        kind: r.kind,
        title: r.title,
        dueDate: r.dueDate,
        daysRemaining: r.daysRemaining,
        amount: r.amount,
        severity: r.severity,
      }))
    );
  });
});

