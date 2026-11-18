import { describe, expect, it } from 'vitest';
import { createInitialFinanceState } from '../data/initialProfile';
import { buildCalendarEventsForMonth } from './calendarEvents';
import {
  computeFinanceSnapshot,
  computeProjectSummary,
  evaluateDisciplineForExpense,
  isPhysicalLoanOverdue,
  simulateExpenseImpact,
} from './financeEngine';
import {
  addAccountAction,
  addDebtAction,
  addGoalAction,
  addObligationAction,
  addProjectExpenseAction,
  addProjectPaymentAction,
  addTransactionAction,
  addTransferAction,
  archiveAccountAction,
  borrowPhysicalItemAction,
  cancelAssetCompensationAction,
  closeAccountAction,
  collectReceivableAction,
  confirmNoSpendDayAction,
  createFriendAdvanceAction,
  createLinkedBorrowLendAction,
  createProjectAction,
  createSplitBillAction,
  deleteAccountAction,
  deleteTransactionAction,
  findDefaultActiveDebt,
  getTransactionLinkInfo,
  hashPinSHA256,
  lendPhysicalAssetAction,
  markProjectPaymentReceivedAction,
  payObligationAction,
  purchaseAssetAction,
  purchaseAssetCashAction,
  purchaseAssetCreditAction,
  reallocateCompletedObligationAction,
  receiveCustodialFundAction,
  receiveProjectAdvanceAction,
  recognizeProjectAdvanceAction,
  reconcileAccountAction,
  recoverLostAssetAction,
  recoverReceivableAction,
  refundProjectAdvanceAction,
  repayDebtAction,
  reportAssetLostAction,
  reserveObligationAction,
  returnCustodialFundAction,
  returnPhysicalItemAction,
  sellAssetAction,
  syncExpiredObligationsAction,
  updateAssetConditionAction,
  updateDebtAction,
  updateSettingsAction,
  updateTransactionAction,
  voidCustodialReturnAction,
  voidDebtPaymentAction,
  voidProjectAdvanceRecognitionAction,
  voidProjectAdvanceRefundAction,
  voidSplitBillAction,
  voidTransactionAction,
  writeOffReceivableAction,
} from '../hooks/financeActions';
import {
  buildFinanceCSVContent,
  escapeCSV,
  getTransactionAccountDisplay,
  getTransactionNatureBadge,
} from '../utils/transactionDisplay';
import {
  createBackupPayload,
  hydrateFinanceState,
  mergeFinanceStatesById,
  parseAndValidateBackupJSON,
} from '../services/financeRepository';

describe('KendaliUang Financial Discipline Engine — Audit & Pengujian 12 Skenario Wajib', () => {
  it('Skenario 1: Pemasukan Rp25.000 pada kondisi awal Rp0 + utang Rp27.000 (tanpa dueDate default) + KKN Rp30.000', () => {
    const state0 = createInitialFinanceState('2026-11-16');
    const snap0 = computeFinanceSnapshot(state0, '2026-11-16');

    expect(snap0.liquidPersonalBalance).toBe(0);
    expect(snap0.outstandingDebtTotal).toBe(27000);
    expect(snap0.unfundedObligations).toBe(30000);
    expect(snap0.safeToSpend).toBe(0);
    expect(snap0.modeEvaluation.mode).toBe('recovery');
    expect(state0.debts.find((d) => d.id === 'debt-friend-initial')?.dueDate).toBeUndefined();

    const { state: state1 } = addTransactionAction(state0, {
      type: 'income',
      amount: 25000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Uang saku masuk kuliah',
      incomeSource: 'daily_allowance',
    });

    const snap1 = computeFinanceSnapshot(state1, '2026-11-16');
    expect(snap1.liquidPersonalBalance).toBe(25000);
    expect(snap1.accountBreakdown.cash).toBe(25000);
    expect(snap1.safeToSpend).toBe(0);
    expect(snap1.fundingShortfall).toBeGreaterThan(0);
  });

  it('Skenario 2: Pengeluaran esensial vs konsumtif — makan Rp15.000 tidak diblokir meski Recovery; rokok butuh alasan tertulis', () => {
    let state = createInitialFinanceState('2026-11-16');
    state = addTransactionAction(state, {
      type: 'income',
      amount: 25000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Pemasukan awal',
      incomeSource: 'daily_allowance',
    }).state;

    // Essential expense Rp15.000 passes without overrideReason even in Recovery mode
    const essentialCheck = evaluateDisciplineForExpense(state, {
      amount: 15000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: '2026-11-16',
    });
    expect(essentialCheck.requiresConfirmation).toBe(false);
    expect(essentialCheck.isEssentialBypass).toBe(true);
    state = addTransactionAction(state, {
      type: 'expense',
      amount: 15000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Makan siang',
    }).state;
    expect(computeFinanceSnapshot(state, '2026-11-16').liquidPersonalBalance).toBe(10000);

    // Discretionary cigarette purchase Rp22.000 requires written overrideReason
    expect(() =>
      addTransactionAction(state, {
        type: 'expense',
        amount: 22000,
        categoryId: 'cat-cig',
        accountId: 'acc-cash',
        date: '2026-11-16',
        description: 'Beli rokok',
      })
    ).toThrow();
  });

  it('Skenario 3: Duplikasi kewajiban KKN ditolak & kewajiban temporary selesai otomatis tanpa hapus riwayat', () => {
    let state = createInitialFinanceState('2026-11-16');
    expect(state.obligations.filter((o) => o.id === 'ob-kkn-weekly').length).toBe(1);

    // Adding duplicate active weekly KKN obligation throws
    expect(() =>
      addObligationAction(state, {
        name: 'Iuran KKN Mingguan',
        category: 'Pendidikan',
        amount: 30000,
        frequency: 'weekly',
        durationType: 'temporary',
        startDate: '2026-11-16',
        nextDueDate: '2026-11-23',
      })
    ).toThrow();

    // Fixed-term obligation auto-completes after endDate while preserving payment logs
    state = updateSettingsAction(state, { essentialReserveTarget: 0 });
    const created = addObligationAction(state, {
      name: 'Iuran Workshop Sementara',
      category: 'Pendidikan',
      amount: 50000,
      frequency: 'weekly',
      durationType: 'temporary',
      startDate: '2026-11-01',
      nextDueDate: '2026-11-20',
      endDate: '2026-11-22',
    });
    state = created.state;
    state = reserveObligationAction(state, created.obligation.id, 10000, '2026-11-16');

    state = syncExpiredObligationsAction(state, '2026-11-25');
    const expired = state.obligations.find((o) => o.id === created.obligation.id)!;
    expect(expired.status).toBe('completed');
    expect(expired.isActive).toBe(false);
    expect(state.obligationLogs.filter((l) => l.obligationId === created.obligation.id).length).toBe(1);
    expect(() => reserveObligationAction(state, created.obligation.id, 10000, '2026-11-25')).toThrow();
  });

  it('Skenario 4: Skor Disiplin menampilkan null ("Belum cukup data") jika transaksi < 2, lalu aktif setelah >= 2 aktivitas nyata', () => {
    let state = createInitialFinanceState('2026-11-16');
    const snapEmpty = computeFinanceSnapshot(state, '2026-11-16');
    expect(snapEmpty.hasEnoughDisciplineData).toBe(false);
    expect(snapEmpty.disciplineScore).toBeNull();
    expect(snapEmpty.disciplineScoreReason.toLowerCase()).toContain('belum cukup data');

    state = addTransactionAction(state, {
      type: 'income',
      amount: 50000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Masuk 1',
      incomeSource: 'daily_allowance',
    }).state;
    expect(computeFinanceSnapshot(state, '2026-11-16').disciplineScore).toBeNull();

    state = addTransactionAction(state, {
      type: 'expense',
      amount: 12000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Makan siang',
    }).state;

    const snapReady = computeFinanceSnapshot(state, '2026-11-16');
    expect(snapReady.hasEnoughDisciplineData).toBe(true);
    expect(typeof snapReady.disciplineScore).toBe('number');
    expect(snapReady.disciplineScore!).toBeGreaterThanOrEqual(0);
  });

  it('Skenario 5: Utang tanpa dueDate tidak memicu reminder/kalender palsu, dan dueDate bisa diedit maupun dihapus', () => {
    let state = createInitialFinanceState('2026-11-16');
    const snap0 = computeFinanceSnapshot(state, '2026-11-16');
    expect(snap0.upcomingReminders.some((r) => r.kind === 'debt')).toBe(false);

    const events0 = buildCalendarEventsForMonth(state, '2026-11');
    const allEvents0 = Array.from(events0.values()).flat();
    expect(allEvents0.some((e) => e.type === 'debt_due')).toBe(false);

    // Edit dueDate to tomorrow -> appears in reminder & calendar
    state = updateDebtAction(state, 'debt-friend-initial', { dueDate: '2026-11-17' });
    expect(computeFinanceSnapshot(state, '2026-11-16').upcomingReminders.some((r) => r.kind === 'debt')).toBe(true);
    const allEvents1 = Array.from(buildCalendarEventsForMonth(state, '2026-11').values()).flat();
    expect(allEvents1.some((e) => e.type === 'debt_due' && e.date === '2026-11-17')).toBe(true);

    // Remove dueDate -> cleanly clears reminder & calendar event
    state = updateDebtAction(state, 'debt-friend-initial', { dueDate: null });
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.dueDate).toBeUndefined();
    expect(computeFinanceSnapshot(state, '2026-11-16').upcomingReminders.some((r) => r.kind === 'debt')).toBe(false);
  });

  it('Skenario 6: Piutang belum lunas tidak dihitung kas/Safe-to-Spend sampai pelunasan aktual diterima', () => {
    let state = createInitialFinanceState('2026-11-16');
    state = addDebtAction(state, {
      direction: 'receivable',
      creditor: 'Budi',
      description: 'Pinjaman teman',
      amount: 100000,
    });

    const snapBefore = computeFinanceSnapshot(state, '2026-11-16');
    expect(snapBefore.outstandingReceivableTotal).toBe(100000);
    expect(snapBefore.outstandingDebtTotal).toBe(27000); // Only payable initial debt
    expect(snapBefore.liquidPersonalBalance).toBe(0);
    expect(snapBefore.safeToSpend).toBe(0);

    const rec = state.debts.find((d) => d.direction === 'receivable')!;
    state = collectReceivableAction(state, {
      debtId: rec.id,
      amount: 60000,
      accountId: 'acc-bank',
      date: '2026-11-16',
    });

    const snapAfter = computeFinanceSnapshot(state, '2026-11-16');
    expect(snapAfter.outstandingReceivableTotal).toBe(40000);
    expect(snapAfter.liquidPersonalBalance).toBe(60000);
    expect(snapAfter.accountBreakdown.bankPersonal).toBe(60000);
  });

  it('Skenario 7: Simulasi Keputusan Keuangan menghitung dampak Safe-to-Spend & proyeksi tanpa mengubah state/saldo', () => {
    let state = createInitialFinanceState('2026-11-16');
    state = updateSettingsAction(state, { essentialReserveTarget: 50000 });
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: '2026-11-16',
      description: 'Saldo awal',
      incomeSource: 'other',
    }).state;

    const beforeBalance = computeFinanceSnapshot(state, '2026-11-16').liquidPersonalBalance;
    const txCountBefore = state.transactions.length;

    const sim = simulateExpenseImpact(state, {
      amount: 60000,
      categoryId: 'cat-hangout',
      accountId: 'acc-bank',
      date: '2026-11-16',
    });

    expect(sim.safeToSpendBefore).toBe(93000); // 200k - 27k debt - 30k kkn - 50k essential
    expect(sim.safeToSpendAfter).toBe(33000);
    expect(sim.accountBalanceAfter).toBe(140000);
    // State strictly unchanged after simulation
    expect(computeFinanceSnapshot(state, '2026-11-16').liquidPersonalBalance).toBe(beforeBalance);
    expect(state.transactions.length).toBe(txCountBefore);
  });

  it('Skenario 8: Arsip, Tutup Akun (menolak saldo != 0), dan Rekonsiliasi Saldo bekerja dengan aman', () => {
    let state = createInitialFinanceState('2026-11-16');
    state = addAccountAction(state, {
      name: 'Dompet Uji',
      accountType: 'cash',
      openingBalance: 40000,
      isBusiness: false,
    });
    const acc = state.accounts.find((a) => a.name === 'Dompet Uji')!;

    // Closing non-zero account throws
    expect(() => closeAccountAction(state, acc.id)).toThrow();

    // Archive hides from activeAccounts while preserving totalNetAssets
    state = archiveAccountAction(state, acc.id);
    const snapArch = computeFinanceSnapshot(state, '2026-11-16');
    expect(snapArch.activeAccounts.some((a) => a.id === acc.id)).toBe(false);
    expect(snapArch.archivedBalanceTotal).toBe(40000);

    // Unarchive then reconcile down to 0, then close cleanly
    state = archiveAccountAction(state, acc.id);
    state = reconcileAccountAction(state, {
      accountId: acc.id,
      actualBalance: 0,
      date: '2026-11-16',
      note: 'Kosongkan dompet uji',
    });
    state = closeAccountAction(state, acc.id);
    expect(state.accounts.find((a) => a.id === acc.id)?.status).toBe('closed');

    // Unused account deletion check still works
    state = addAccountAction(state, {
      name: 'Akun Kosong Hapus',
      accountType: 'ewallet',
      openingBalance: 0,
      isBusiness: false,
    });
    const delAcc = state.accounts.find((a) => a.name === 'Akun Kosong Hapus')!;
    state = deleteAccountAction(state, delAcc.id);
    expect(state.accounts.some((a) => a.id === delAcc.id)).toBe(false);
  });

  it('Skenario 9: No-Spend Day menolak tanggal mendatang, tidak auto-count 0 transaksi, dan batal otomatis saat jajan', () => {
    let state = createInitialFinanceState('2026-11-16');

    expect(() => confirmNoSpendDayAction(state, '2026-11-20', 'Masa depan', '2026-11-16')).toThrow();

    const snap0 = computeFinanceSnapshot(state, '2026-11-16');
    expect(snap0.noSpendStats.weeklyNoSpendDays).toBe(0);
    expect(snap0.noSpendStats.periodLabel).toContain('Tgl 1–16');

    state = confirmNoSpendDayAction(state, '2026-11-16', 'Disiplin', '2026-11-16');
    expect(computeFinanceSnapshot(state, '2026-11-16').noSpendStats.todayIsNoSpend).toBe(true);

    // Discretionary expense invalidates it
    state = addTransactionAction(state, {
      type: 'expense',
      amount: 10000,
      categoryId: 'cat-other-exp',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Jajan es',
      overrideReason: 'Haus di jalan',
    }).state;
    expect(computeFinanceSnapshot(state, '2026-11-16').noSpendStats.todayIsNoSpend).toBe(false);
  });

  it('Skenario 10: Mode Pemulihan mengizinkan menyimpan target investasi tanpa merekomendasikan setoran investasi', () => {
    let state = createInitialFinanceState('2026-11-16');
    state = addGoalAction(state, {
      name: 'Reksa Dana Pasar Uang',
      goalType: 'investment',
      targetAmount: 2000000,
      monthlyTarget: 100000,
    });

    const snap = computeFinanceSnapshot(state, '2026-11-16');
    expect(snap.modeEvaluation.mode).toBe('recovery');
    expect(state.goals.some((g) => g.goalType === 'investment')).toBe(true);
    expect(snap.recommendations.some((r) => r.id === 'rec-recovery')).toBe(true);
    expect(snap.recommendations.some((r) => r.id === 'rec-growth-invest')).toBe(false);
  });

  it('Skenario 11: Audit Log, Void transaksi, Freelance profit & pengalihan kewajiban selesai menjaga integritas historis', () => {
    let state = createInitialFinanceState('2026-11-16');
    const created = createProjectAction(state, {
      clientName: 'UMKM Kopi',
      projectName: 'Toko Online',
      contractValue: 1000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = created.state;
    state = addProjectPaymentAction(state, {
      projectId: created.project.id,
      paymentType: 'dp',
      amount: 500000,
      status: 'received',
      date: '2026-11-16',
      accountId: 'acc-business',
    });
    state = addProjectExpenseAction(state, {
      projectId: created.project.id,
      description: 'Domain',
      amount: 100000,
      date: '2026-11-16',
      accountId: 'acc-business',
    });

    const txRes = addTransactionAction(state, {
      type: 'income',
      amount: 50000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Salah input saku',
      incomeSource: 'daily_allowance',
    });
    state = txRes.state;
    expect(computeFinanceSnapshot(state, '2026-11-16').liquidPersonalBalance).toBe(50000);

    // Void transaction removes effect on balance while retaining historical row + audit entry
    state = voidTransactionAction(state, txRes.transaction.id, 'Dobel catat');
    expect(computeFinanceSnapshot(state, '2026-11-16').liquidPersonalBalance).toBe(0);
    expect(state.transactions.find((t) => t.id === txRes.transaction.id)?.isVoided).toBe(true);

    // Changing budget settings logs audit without changing past tx amounts
    state = updateSettingsAction(state, { dailyBudgetLimit: 30000 });
    expect((state.changeLogs ?? []).some((l) => l.entityType === 'budget')).toBe(true);
    expect((state.changeLogs ?? []).some((l) => l.action === 'void')).toBe(true);
    expect(computeFinanceSnapshot(state, '2026-11-16').businessBalance).toBe(400000);

    // Completed obligation reallocates remaining reserve cleanly
    const oneTime = addObligationAction(state, {
      name: 'Biaya Ujian',
      category: 'Pendidikan',
      amount: 40000,
      frequency: 'once',
      durationType: 'one_time',
      startDate: '2026-11-16',
      nextDueDate: '2026-11-16',
      endDate: '2026-11-16',
    });
    state = oneTime.state;
    state = addTransactionAction(state, {
      type: 'income',
      amount: 60000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Dana ujian',
      incomeSource: 'other',
    }).state;
    state = reserveObligationAction(state, oneTime.obligation.id, 50000, '2026-11-16');
    state = payObligationAction(state, {
      obligationId: oneTime.obligation.id,
      amount: 40000,
      accountId: 'acc-cash',
      date: '2026-11-16',
    });
    const emGoal = state.goals.find((g) => g.goalType === 'emergency')!;
    state = reallocateCompletedObligationAction(state, {
      obligationId: oneTime.obligation.id,
      goalId: emGoal.id,
      fromAccountId: 'acc-cash',
      toAccountId: 'acc-savings',
      date: '2026-11-16',
    });
    expect(state.goals.find((g) => g.id === emGoal.id)?.currentAmount).toBe(10000);
  });

  it('Skenario 12: Backup/Restore, Merge Konflik Offline-Cloud, Transfer Bebas Pajak Ganda & Hash PIN Lokal', async () => {
    let local = createInitialFinanceState('2026-11-16');
    local = addTransactionAction(local, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: '2026-11-16',
      description: 'Masuk offline',
      incomeSource: 'other',
    }).state;
    local = addTransferAction(local, {
      fromAccountId: 'acc-bank',
      toAccountId: 'acc-ewallet',
      amount: 30000,
      date: '2026-11-16',
    });

    let remote = createInitialFinanceState('2026-11-16');
    remote = addTransactionAction(remote, {
      type: 'income',
      amount: 50000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Masuk perangkat lain',
      incomeSource: 'other',
    }).state;
    remote = repayDebtAction(remote, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-cash',
      date: '2026-11-16',
    });

    // Deterministic merge preserves transactions from both offline & cloud devices
    const merged = mergeFinanceStatesById(local, remote);
    expect(merged.transactions.some((t) => t.description === 'Masuk offline')).toBe(true);
    expect(merged.transactions.some((t) => t.description === 'Masuk perangkat lain')).toBe(true);
    expect(computeFinanceSnapshot(merged, '2026-11-16').liquidPersonalBalance).toBe(140000);

    // Backup round-trip + corrupt rejection
    const payload = createBackupPayload(merged);
    expect(payload.schemaVersion).toBe(3);
    const restored = parseAndValidateBackupJSON(JSON.stringify(payload));
    expect(restored.transactions.length).toBe(merged.transactions.length);
    expect(() => parseAndValidateBackupJSON('{bad-json')).toThrow();

    // PIN hash deterministic
    const h1 = await hashPinSHA256('2468');
    const h2 = await hashPinSHA256('2468');
    const h3 = await hashPinSHA256('9999');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe('Debt & Receivables Improvement — Pinjaman, Tagihan Proyek, Penerimaan Utang, Pelunasan & Idempotency', () => {
  const REF_DATE = '2026-11-16';

  it('1 & 2. Pinjaman Uang Pribadi dari Tunai (acc-cash) & Bank (acc-bank) mengurangi saldo akun terkait, menambah piutang, dan TIDAK dihitung sebagai pengeluaran konsumsi/anggaran', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 300000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Modal tunai awal',
      incomeSource: 'daily_allowance',
    }).state;
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: REF_DATE,
      description: 'Modal bank awal',
      incomeSource: 'other',
    }).state;

    // 1. Loan from acc-cash Rp100.000
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Rian',
      description: 'Pinjam uang tunai',
      amount: 100000,
      date: REF_DATE,
    });

    let snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(200000);
    expect(snap.outstandingReceivableTotal).toBe(100000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
    expect(snap.dailyBudget.spent).toBe(0);

    // 2. Loan from acc-bank Rp250.000
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-bank',
      creditor: 'Sari',
      description: 'Transfer pinjaman teman',
      amount: 250000,
      date: REF_DATE,
    });

    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(250000);
    expect(snap.outstandingReceivableTotal).toBe(350000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
    expect(snap.dailyBudget.spent).toBe(0);
  });

  it('3. Tagihan Proyek / Penjualan (project_sales) menambah piutang tanpa mengubah saldo kas/bank atau membuat transaksi kas keluar', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 400000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: REF_DATE,
      description: 'Saldo awal',
      incomeSource: 'other',
    }).state;
    const txCountBefore = state.transactions.length;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'PT Maju Jaya',
      description: 'Invoice Landing Page',
      amount: 750000,
      date: REF_DATE,
    });

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(0);
    expect(snap.accountBreakdown.bankPersonal).toBe(400000);
    expect(snap.outstandingReceivableTotal).toBe(750000);
    expect(state.transactions.length).toBe(txCountBefore);
  });

  it('4 & 14. Piutang legacy Nuleaf (Proyek Chatbot AI Rp500.000) tetap utuh pasca hidrasi, tidak mengurangi kas, dan piutang belum lunas tidak masuk Safe-to-Spend', () => {
    const base = createInitialFinanceState(REF_DATE);
    const nuleafLegacy = {
      id: 'debt-nuleaf-existing',
      direction: 'receivable' as const,
      creditor: 'Nuleaf',
      description: 'Proyek Chatbot AI',
      initialAmount: 500000,
      remainingAmount: 500000,
      priority: 1,
      status: 'active' as const,
      createdAt: '2026-11-10T08:00:00.000Z',
    };

    let state = hydrateFinanceState({
      ...base,
      debts: [...base.debts, nuleafLegacy],
    });
    state = updateSettingsAction(state, { essentialReserveTarget: 0 });
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Dana pribadi awal',
      incomeSource: 'other',
    }).state;

    // Also add personal loan & project receivable
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Doni',
      description: 'Pinjam tunai',
      amount: 50000,
      date: REF_DATE,
    });
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'Klien B',
      description: 'Tagihan Desain',
      amount: 300000,
      date: REF_DATE,
    });

    const nuleafRecord = state.debts.find((d) => d.creditor === 'Nuleaf')!;
    expect(nuleafRecord).toBeDefined();
    expect(nuleafRecord.description).toBe('Proyek Chatbot AI');
    expect(nuleafRecord.initialAmount).toBe(500000);
    expect(nuleafRecord.remainingAmount).toBe(500000);
    expect(nuleafRecord.status).toBe('active');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    // Cash: 200k initial - 50k personal loan = 150k (Nuleaf & Klien B did NOT reduce or add cash)
    expect(snap.accountBreakdown.cash).toBe(150000);
    expect(snap.outstandingReceivableTotal).toBe(850000);
    // Safe-to-Spend: 150k liquid - 27k initial debt - 30k kkn = 93k (excludes all unpaid receivables!)
    expect(snap.safeToSpend).toBe(93000);
  });

  it('5 & 6. Menerima utang ke Tunai (acc-cash) atau Bank (acc-bank) menambah saldo akun sekali dan mencatat utang tanpa menggelembungkan pendapatan bersih', () => {
    let state = createInitialFinanceState(REF_DATE);

    // 5. Borrowed cash received into acc-cash
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-cash',
      creditor: 'Andi',
      description: 'Pinjam uang tunai darurat',
      amount: 120000,
      date: REF_DATE,
    });

    let snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(120000);
    expect(snap.outstandingDebtTotal).toBe(27000 + 120000);
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(0);

    // 6. Borrowed money received via bank transfer into acc-bank
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-bank',
      creditor: 'Kakak',
      description: 'Transfer pinjaman',
      amount: 350000,
      date: REF_DATE,
    });

    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(350000);
    expect(snap.liquidPersonalBalance).toBe(470000);
    expect(snap.outstandingDebtTotal).toBe(27000 + 120000 + 350000);
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(0);
  });

  it('7. Pengeluaran dibayar langsung pihak lain (direct_expense) mencatat pengeluaran & utang tanpa mengubah saldo kas/bank dan tanpa transaksi masuk fiktif', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;
    const incomeCountBefore = state.transactions.filter((t) => t.type === 'income').length;

    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'direct_expense',
      expenseCategoryId: 'cat-food',
      creditor: 'Bima',
      description: 'Ditalangi makan siang',
      amount: 45000,
      date: REF_DATE,
    });

    const snap = computeFinanceSnapshot(state, REF_DATE);
    // Cash/bank untouched
    expect(snap.accountBreakdown.cash).toBe(200000);
    expect(snap.accountBreakdown.bankPersonal).toBe(0);
    // Real expense recorded in analytics/budget & debt increased
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(45000);
    expect(snap.dailyBudget.spent).toBe(45000);
    expect(snap.outstandingDebtTotal).toBe(27000 + 45000);
    // No fictitious incoming cash transaction created
    expect(state.transactions.filter((t) => t.type === 'income').length).toBe(incomeCountBefore);
    const linkedTx = state.transactions.find((t) => t.transactionNature === 'debt_direct_expense')!;
    expect(linkedTx.affectsAccountBalance).toBe(false);
  });

  it('8 & 9. Penagihan piutang penuh & sebagian memperbarui saldo, status/sisa, dan mencegah double-count pendapatan proyek', () => {
    let state = createInitialFinanceState(REF_DATE);

    // Create a project and mark payment already received (income counted once = Rp500.000)
    const projCreated = createProjectAction(state, {
      clientName: 'Nuleaf',
      projectName: 'Proyek Chatbot AI',
      contractValue: 500000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = projCreated.state;
    state = addProjectPaymentAction(state, {
      projectId: projCreated.project.id,
      paymentType: 'full',
      amount: 500000,
      status: 'received',
      date: REF_DATE,
      accountId: 'acc-business',
    });
    expect(computeFinanceSnapshot(state, REF_DATE).monthlyPrediction.confirmedIncomeThisMonth).toBe(500000);

    // Add a project receivable flagged revenueAlreadyRecorded: true (or linked to paid project)
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      projectId: projCreated.project.id,
      revenueAlreadyRecorded: true,
      creditor: 'Nuleaf',
      description: 'Proyek Chatbot AI (Tagihan)',
      amount: 500000,
      date: REF_DATE,
    });
    const projDebt = state.debts.find((d) => d.creditor === 'Nuleaf')!;

    // 9. Partial collection Rp200.000 into acc-bank
    state = collectReceivableAction(state, {
      debtId: projDebt.id,
      amount: 200000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    let snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(200000);
    expect(snap.outstandingReceivableTotal).toBe(300000);
    expect(state.debts.find((d) => d.id === projDebt.id)?.status).toBe('active');
    // Confirmed monthly income must remain 500.000 (not double counted!)
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(500000);

    // 8. Full collection of remaining Rp300.000 into acc-ewallet
    state = collectReceivableAction(state, {
      debtId: projDebt.id,
      amount: 300000,
      accountId: 'acc-ewallet',
      date: REF_DATE,
    });
    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.ewallet).toBe(300000);
    expect(snap.outstandingReceivableTotal).toBe(0);
    expect(state.debts.find((d) => d.id === projDebt.id)?.remainingAmount).toBe(0);
    expect(state.debts.find((d) => d.id === projDebt.id)?.status).toBe('paid');
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(500000);
  });

  it('10 & 11. Pelunasan utang sebagian dan penuh mengurangi saldo akun terpilih sekali dan memperbarui status utang', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: REF_DATE,
      description: 'Saldo bank',
      incomeSource: 'other',
    }).state;

    // 11. Partial repayment Rp10.000 on initial Rp27.000 debt
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    let snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(90000);
    expect(snap.outstandingDebtTotal).toBe(17000);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('active');

    // 10. Full repayment of remaining Rp17.000
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 17000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(73000);
    expect(snap.outstandingDebtTotal).toBe(0);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.remainingAmount).toBe(0);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('paid');
  });

  it('12. Saldo tidak mencukupi mencegah pinjaman pribadi maupun pelunasan utang tanpa mengubah state', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 20000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kecil',
      incomeSource: 'other',
    }).state;

    expect(() =>
      addDebtAction(state, {
        direction: 'receivable',
        receivableType: 'personal_loan',
        accountId: 'acc-cash',
        creditor: 'Tono',
        description: 'Pinjam melebihi saldo',
        amount: 50000,
        date: REF_DATE,
      })
    ).toThrow(/tidak mencukupi/i);

    expect(() =>
      repayDebtAction(state, {
        debtId: 'debt-friend-initial',
        amount: 27000,
        accountId: 'acc-cash',
        date: REF_DATE,
      })
    ).toThrow(/tidak mencukupi/i);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(20000);
    expect(snap.outstandingReceivableTotal).toBe(0);
    expect(snap.outstandingDebtTotal).toBe(27000);
  });

  it('13. Proteksi duplikasi (idempotencyKey) mencegah saldo, utang, dan piutang tercatat dua kali', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Modal awal',
      incomeSource: 'other',
    }).state;

    // Duplicate personal_loan creation
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Fajar',
      description: 'Pinjam 1x',
      amount: 100000,
      date: REF_DATE,
      idempotencyKey: 'idem-create-loan-1',
    });
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Fajar',
      description: 'Pinjam 1x',
      amount: 100000,
      date: REF_DATE,
      idempotencyKey: 'idem-create-loan-1',
    });

    expect(state.debts.filter((d) => d.creditor === 'Fajar').length).toBe(1);
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(400000);

    const loanId = state.debts.find((d) => d.creditor === 'Fajar')!.id;

    // Duplicate receivable collection
    state = collectReceivableAction(state, {
      debtId: loanId,
      amount: 40000,
      accountId: 'acc-cash',
      date: REF_DATE,
      idempotencyKey: 'idem-collect-1',
    });
    state = collectReceivableAction(state, {
      debtId: loanId,
      amount: 40000,
      accountId: 'acc-cash',
      date: REF_DATE,
      idempotencyKey: 'idem-collect-1',
    });

    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(440000);
    expect(state.debts.find((d) => d.id === loanId)?.remainingAmount).toBe(60000);

    // Duplicate debt repayment
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 15000,
      accountId: 'acc-cash',
      date: REF_DATE,
      idempotencyKey: 'idem-repay-1',
    });
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 15000,
      accountId: 'acc-cash',
      date: REF_DATE,
      idempotencyKey: 'idem-repay-1',
    });

    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(425000);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.remainingAmount).toBe(12000);
  });
});

describe('Phase 2.1 — Transaction Integrity & Accounting Safety Hardening', () => {
  const REF_DATE = '2026-11-16';

  it('1. Edit transaksi biasa memperbarui nominal, deskripsi, saldo akun, dan metrik dengan benar', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 300000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Pemasukan awal',
      incomeSource: 'other',
    }).state;

    const added = addTransactionAction(state, {
      type: 'expense',
      amount: 20000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Makan siang awal',
    });
    state = added.state;

    state = updateTransactionAction(state, added.transaction.id, {
      amount: 35000,
      description: 'Makan siang diperbarui',
      notes: 'Tambah lauk',
    });

    const updatedTx = state.transactions.find((t) => t.id === added.transaction.id)!;
    expect(updatedTx.amount).toBe(35000);
    expect(updatedTx.description).toBe('Makan siang diperbarui');
    expect(updatedTx.notes).toBe('Tambah lauk');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(265000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(35000);
  });

  it('2. Edit nominal/akun/kategori pada transaksi terikat (utang, pembayaran utang, proyek, kewajiban) ditolak', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Modal kas',
      incomeSource: 'other',
    }).state;

    // Debt origin (debt_receipt)
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-cash',
      creditor: 'Andi',
      description: 'Pinjam tunai',
      amount: 100000,
      date: REF_DATE,
    });
    const receiptTx = state.transactions.find((t) => t.transactionNature === 'debt_receipt')!;
    expect(() =>
      updateTransactionAction(state, receiptTx.id, { amount: 250000 })
    ).toThrow(/terhubung|dikunci/i);
    expect(() =>
      updateTransactionAction(state, receiptTx.id, { accountId: 'acc-bank' })
    ).toThrow(/terhubung|dikunci/i);

    // Debt repayment
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    const repayTx = state.transactions.find((t) => t.transactionNature === 'debt_repayment')!;
    expect(() =>
      updateTransactionAction(state, repayTx.id, { amount: 5000 })
    ).toThrow(/terhubung|dikunci/i);

    // Project payment & project expense
    const proj = createProjectAction(state, {
      clientName: 'Klien A',
      projectName: 'Web App',
      contractValue: 1000000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;
    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 400000,
      status: 'received',
      date: REF_DATE,
      accountId: 'acc-business',
    });
    state = addProjectExpenseAction(state, {
      projectId: proj.project.id,
      description: 'Beli domain',
      amount: 150000,
      date: REF_DATE,
      accountId: 'acc-business',
    });
    const projPayTx = state.projectPayments[0].transactionId!;
    const projExpTx = state.projectExpenses[0].transactionId!;
    expect(() =>
      updateTransactionAction(state, projPayTx, { amount: 999999 })
    ).toThrow(/ProjectPayment/i);
    expect(() =>
      updateTransactionAction(state, projExpTx, { categoryId: 'cat-food' })
    ).toThrow(/ProjectExpense/i);

    // Obligation log
    const ob = addObligationAction(state, {
      name: 'Listrik',
      category: 'Utilitas',
      amount: 50000,
      frequency: 'monthly',
      nextDueDate: REF_DATE,
    });
    state = ob.state;
    state = payObligationAction(state, {
      obligationId: ob.obligation.id,
      amount: 50000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    const obLogTx = state.obligationLogs.find((ol) => ol.transactionId)!.transactionId!;
    expect(() =>
      updateTransactionAction(state, obLogTx, { amount: 10000 })
    ).toThrow(/ObligationLog/i);
  });

  it('3. Void transaksi debt_receipt membatalkan transaksi & utang terkait serta memulihkan saldo (dan menolak jika sudah ada pembayaran aktif)', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;

    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-cash',
      creditor: 'Budi',
      description: 'Pinjam uang',
      amount: 200000,
      date: REF_DATE,
    });
    const receiptTx = state.transactions.find((t) => t.transactionNature === 'debt_receipt')!;
    const debtBudi = state.debts.find((d) => d.creditor === 'Budi')!;

    // Record a partial repayment first -> origin void must be blocked until payment is voided
    state = repayDebtAction(state, {
      debtId: debtBudi.id,
      amount: 50000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    expect(() => voidTransactionAction(state, receiptTx.id, 'Salah catat')).toThrow(
      /pembayaran aktif/i
    );

    // Void the repayment first, then void the origin debt_receipt
    const dpId = state.debtPayments.find((dp) => dp.debtId === debtBudi.id)!.id;
    state = voidDebtPaymentAction(state, dpId, 'Batalkan cicilan');
    state = voidTransactionAction(state, receiptTx.id, 'Batalkan pinjaman');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(100000);
    expect(snap.outstandingDebtTotal).toBe(27000); // Only initial friend debt remains
    expect(state.transactions.find((t) => t.id === receiptTx.id)?.isVoided).toBe(true);
    expect(state.debts.find((d) => d.id === debtBudi.id)?.isVoided).toBe(true);
    expect(state.debts.find((d) => d.id === debtBudi.id)?.remainingAmount).toBe(0);
  });

  it('4. Void transaksi loan_disbursement mengembalikan saldo akun sumber dan membatalkan piutang terkait', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 400000,
      categoryId: 'cat-income-other',
      accountId: 'acc-bank',
      date: REF_DATE,
      description: 'Saldo bank awal',
      incomeSource: 'other',
    }).state;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-bank',
      creditor: 'Dina',
      description: 'Pinjam dana darurat',
      amount: 150000,
      date: REF_DATE,
    });

    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.bankPersonal).toBe(250000);
    expect(computeFinanceSnapshot(state, REF_DATE).outstandingReceivableTotal).toBe(150000);

    const loanTx = state.transactions.find((t) => t.transactionNature === 'loan_disbursement')!;
    state = voidTransactionAction(state, loanTx.id, 'Pinjaman dibatalkan');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(400000);
    expect(snap.outstandingReceivableTotal).toBe(0);
    expect(state.transactions.find((t) => t.id === loanTx.id)?.isVoided).toBe(true);
    expect(state.debts.find((d) => d.creditor === 'Dina')?.isVoided).toBe(true);
  });

  it('5. Void transaksi debt_repayment memulihkan saldo akun, sisa utang, status utang, dan menandai DebtPayment void', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo awal',
      incomeSource: 'other',
    }).state;

    // Full payment of initial Rp27.000 debt
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 27000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('paid');
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(73000);

    const repayTx = state.transactions.find((t) => t.transactionNature === 'debt_repayment')!;
    state = voidTransactionAction(state, repayTx.id, 'Salah akun bayar');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(100000);
    expect(snap.outstandingDebtTotal).toBe(27000);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.remainingAmount).toBe(27000);
    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('active');
    expect(state.debtPayments.find((dp) => dp.transactionId === repayTx.id)?.isVoided).toBe(true);
  });

  it('6. Void transaksi receivable_collection memulihkan saldo akun, sisa piutang, dan status ProjectPayment expected', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Studio X',
      projectName: 'Redesign UI',
      contractValue: 600000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;

    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 600000,
      status: 'expected',
      date: REF_DATE,
    });
    const projPayId = state.projectPayments[0].id;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      projectId: proj.project.id,
      projectPaymentId: projPayId,
      revenueAlreadyRecorded: false,
      creditor: 'Studio X',
      description: 'Invoice #1',
      amount: 600000,
      date: REF_DATE,
    });
    const recDebt = state.debts.find((d) => d.creditor === 'Studio X')!;

    state = collectReceivableAction(state, {
      debtId: recDebt.id,
      amount: 600000,
      accountId: 'acc-business',
      date: REF_DATE,
    });

    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.business).toBe(600000);
    expect(state.projectPayments[0].status).toBe('received');

    const collectTx = state.transactions.find(
      (t) => t.transactionNature === 'receivable_collection'
    )!;
    state = voidTransactionAction(state, collectTx.id, 'Transfer batal');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.business).toBe(0);
    expect(snap.outstandingReceivableTotal).toBe(600000);
    expect(state.debts.find((d) => d.id === recDebt.id)?.status).toBe('active');
    expect(state.debts.find((d) => d.id === recDebt.id)?.remainingAmount).toBe(600000);
    expect(state.projectPayments[0].status).toBe('expected');
    expect(state.projectPayments[0].transactionId).toBeUndefined();
    expect(state.debtPayments.find((dp) => dp.transactionId === collectTx.id)?.isVoided).toBe(true);
  });

  it('7. Pembatalan ulang (idempotency) tidak membalik saldo atau utang/piutang dua kali', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;

    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 15000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    const dp = state.debtPayments[0];
    const txId = dp.transactionId!;

    const onceVoided = voidTransactionAction(state, txId, 'Batalkan sekali');
    const twiceVoidedTx = voidTransactionAction(onceVoided, txId, 'Batalkan kedua kali');
    const thriceVoidedDp = voidDebtPaymentAction(twiceVoidedTx, dp.id, 'Batalkan ketiga kali');

    expect(twiceVoidedTx).toBe(onceVoided);
    expect(thriceVoidedDp).toBe(onceVoided);

    const snap = computeFinanceSnapshot(thriceVoidedDp, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(200000);
    expect(snap.outstandingDebtTotal).toBe(27000);
  });

  it('8. Hapus permanen (deleteTransactionAction) transaksi terikat relasi ditolak', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 250000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;

    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-cash',
      creditor: 'Rudi',
      description: 'Utang kas',
      amount: 50000,
      date: REF_DATE,
    });
    const receiptTx = state.transactions.find((t) => t.transactionNature === 'debt_receipt')!;
    expect(() => deleteTransactionAction(state, receiptTx.id)).toThrow(/tidak boleh dihapus/i);

    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    const repayTx = state.transactions.find((t) => t.transactionNature === 'debt_repayment')!;
    expect(() => deleteTransactionAction(state, repayTx.id)).toThrow(/tidak boleh dihapus/i);
    expect(getTransactionLinkInfo(state, repayTx.id).isLinked).toBe(true);
  });

  it('9. Edit transaksi menjadi nominal 0 atau negatif ditolak', () => {
    let state = createInitialFinanceState(REF_DATE);
    const added = addTransactionAction(state, {
      type: 'expense',
      amount: 15000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Makan',
    });
    state = added.state;

    expect(() =>
      updateTransactionAction(state, added.transaction.id, { amount: 0 })
    ).toThrow(/lebih dari Rp0/i);
    expect(() =>
      updateTransactionAction(state, added.transaction.id, { amount: -25000 })
    ).toThrow(/lebih dari Rp0/i);
    expect(() =>
      updateTransactionAction(state, added.transaction.id, { amount: Number.NaN })
    ).toThrow(/lebih dari Rp0/i);
  });

  it('10. Edit transaksi ke akun closed atau archived ditolak', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addAccountAction(state, {
      name: 'Dompet Cadangan',
      accountType: 'ewallet',
      openingBalance: 0,
      isBusiness: false,
    });
    const closedId = state.accounts.find((a) => a.name === 'Dompet Cadangan')!.id;
    state = closeAccountAction(state, closedId);

    const added = addTransactionAction(state, {
      type: 'expense',
      amount: 15000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Makan',
    });
    state = added.state;

    expect(() =>
      updateTransactionAction(state, added.transaction.id, { accountId: closedId })
    ).toThrow(/ditutup|diarsipkan/i);

    state = addAccountAction(state, {
      name: 'Dompet Arsip',
      accountType: 'ewallet',
      openingBalance: 0,
      isBusiness: false,
    });
    const archId = state.accounts.find((a) => a.name === 'Dompet Arsip')!.id;
    state = archiveAccountAction(state, archId);
    expect(() =>
      updateTransactionAction(state, added.transaction.id, { accountId: archId })
    ).toThrow(/ditutup|diarsipkan/i);
  });

  it('11. Rekonsiliasi positif menyesuaikan saldo akun tetapi tidak dihitung sebagai pendapatan bulanan/mingguan', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Uang saku',
      incomeSource: 'daily_allowance',
    }).state;

    state = reconcileAccountAction(state, {
      accountId: 'acc-cash',
      actualBalance: 145000,
      date: REF_DATE,
      note: 'Selisih uang tunai di dompet',
    });

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(145000);
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(100000);
    expect(snap.weeklyComparison.currentIncome).toBe(100000);
    const recTx = state.transactions.find((t) => t.transactionNature === 'reconciliation')!;
    expect(recTx.excludeFromIncomeStats).toBe(true);
    expect(recTx.excludeFromExpenseStats).toBe(true);
  });

  it('12. Rekonsiliasi negatif menyesuaikan saldo akun, tidak dihitung pengeluaran, dan tidak membatalkan No-Spend Day', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Uang saku',
      incomeSource: 'daily_allowance',
    }).state;
    state = confirmNoSpendDayAction(state, REF_DATE, 'Disiplin hari ini');

    state = reconcileAccountAction(state, {
      accountId: 'acc-cash',
      actualBalance: 165000,
      date: REF_DATE,
      note: 'Koreksi fisik kas',
    });

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(165000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
    expect(snap.snackAnalysis.monthlySpent).toBe(0);
    expect(snap.noSpendStats.todayStatus.status).toBe('confirmed');
  });

  it('13. Perubahan kategori transaksi memperbarui stats, klasifikasi esensial/konsumtif, exceededBudget, dan anggaran dengan benar', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kas',
      incomeSource: 'other',
    }).state;

    // Essential food purchase -> change to cigarette (discretionary & exceeds weekly limit)
    const txRes = addTransactionAction(state, {
      type: 'expense',
      amount: 120000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Belanja',
    });
    state = txRes.state;
    let snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.weeklyBudget.discretionarySpent).toBe(0);

    state = updateTransactionAction(state, txRes.transaction.id, {
      categoryId: 'cat-cig',
    });
    const movedToCig = state.transactions.find((t) => t.id === txRes.transaction.id)!;
    expect(movedToCig.isEssential).toBe(false);
    expect(movedToCig.isDiscretionary).toBe(true);
    expect(movedToCig.exceededBudget).toBe(true);
    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.weeklyBudget.discretionarySpent).toBe(120000);
    expect(snap.cigaretteAnalysis.weeklySpent).toBe(120000);

    // Change back from cigarette to essential food -> clears discretionary stats & exceededBudget
    state = updateTransactionAction(state, txRes.transaction.id, {
      categoryId: 'cat-food',
    });
    const backToFood = state.transactions.find((t) => t.id === txRes.transaction.id)!;
    expect(backToFood.isEssential).toBe(true);
    expect(backToFood.isDiscretionary).toBe(false);
    expect(backToFood.exceededBudget).toBe(false);
    snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.weeklyBudget.discretionarySpent).toBe(0);
    expect(snap.cigaretteAnalysis.weeklySpent).toBe(0);
  });

  it('14. No-Spend Day pulih saat transaksi konsumtif di-void, dihapus, atau diubah menjadi esensial', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kas',
      incomeSource: 'other',
    }).state;
    state = confirmNoSpendDayAction(state, REF_DATE, 'Target no-spend');
    expect(computeFinanceSnapshot(state, REF_DATE).noSpendStats.todayStatus.status).toBe('confirmed');

    // A) Void restores confirmed No-Spend Day
    const txA = addTransactionAction(state, {
      type: 'expense',
      amount: 20000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kopi',
    });
    expect(computeFinanceSnapshot(txA.state, REF_DATE).noSpendStats.todayStatus.status).toBe(
      'invalidated'
    );
    const afterVoid = voidTransactionAction(txA.state, txA.transaction.id, 'Salah input');
    expect(computeFinanceSnapshot(afterVoid, REF_DATE).noSpendStats.todayStatus.status).toBe(
      'confirmed'
    );

    // B) Delete restores confirmed No-Spend Day
    const txB = addTransactionAction(afterVoid, {
      type: 'expense',
      amount: 20000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Jajan',
    });
    const afterDelete = deleteTransactionAction(txB.state, txB.transaction.id);
    expect(computeFinanceSnapshot(afterDelete, REF_DATE).noSpendStats.todayStatus.status).toBe(
      'confirmed'
    );

    // C) Category change from discretionary -> essential restores confirmed No-Spend Day
    const txC = addTransactionAction(afterDelete, {
      type: 'expense',
      amount: 20000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Ternyata makan pokok',
    });
    const afterEditCat = updateTransactionAction(txC.state, txC.transaction.id, {
      categoryId: 'cat-food',
    });
    expect(computeFinanceSnapshot(afterEditCat, REF_DATE).noSpendStats.todayStatus.status).toBe(
      'confirmed'
    );
  });

  it('15. Data lama tanpa metadata transactionNature atau flag akuntansi baru tetap terbaca dan dihitung normal', () => {
    const legacyRaw = createInitialFinanceState(REF_DATE);
    // Simulate legacy transaction object lacking new optional properties
    legacyRaw.transactions = [
      {
        id: 'legacy-inc-1',
        type: 'income',
        amount: 250000,
        categoryId: 'cat-income-allowance',
        accountId: 'acc-cash',
        date: REF_DATE,
        description: 'Pemasukan lama',
        tags: [],
        isEssential: false,
        isDiscretionary: false,
        exceededBudget: false,
        createdAt: '2026-11-16T08:00:00.000Z',
      },
      {
        id: 'legacy-exp-1',
        type: 'expense',
        amount: 50000,
        categoryId: 'cat-food',
        accountId: 'acc-cash',
        date: REF_DATE,
        description: 'Makan lama',
        tags: [],
        isEssential: true,
        isDiscretionary: false,
        exceededBudget: false,
        createdAt: '2026-11-16T09:00:00.000Z',
      },
    ];

    const hydrated = hydrateFinanceState(legacyRaw);
    const snap = computeFinanceSnapshot(hydrated, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(200000);
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(250000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(50000);
  });

  it('16. Tampilan Dashboard dan CSV membedakan transaksi non-kas tanpa menyebut akun kas sebagai sumber keluar dana', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'direct_expense',
      expenseCategoryId: 'cat-food',
      creditor: 'Bima',
      description: 'Makan siang dibayarkan Bima',
      amount: 45000,
      date: REF_DATE,
    });

    const nonCashTx = state.transactions.find(
      (t) => t.transactionNature === 'debt_direct_expense'
    )!;
    expect(getTransactionAccountDisplay(nonCashTx, state.accounts)).toBe('Non-Kas (Utang)');
    expect(getTransactionNatureBadge(nonCashTx)).toBe('Non-Kas · Utang');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    const csv = buildFinanceCSVContent(state, snap);
    const lines = csv.split('\n');
    const header = lines.find((l) => l.startsWith('Tanggal,Tipe,'))!;
    expect(header).toContain('Sifat Transaksi');
    expect(header).toContain('Jenis Arus Kas');
    expect(header).toContain('Akun');
    expect(header).toContain('Dampak terhadap saldo');
    expect(header).toContain('Dampak terhadap pendapatan');
    expect(header).toContain('Dampak terhadap pengeluaran');

    const dataRow = lines.find((l) => l.includes('Makan siang dibayarkan Bima'))!;
    expect(dataRow).toContain('Non-Kas (Utang)');
    expect(dataRow).toContain('Tidak mengubah saldo akun (Non-Kas)');
    expect(dataRow).toContain('Tidak dihitung pendapatan');
    expect(dataRow).toContain('Menambah pengeluaran');
    expect(dataRow).not.toContain('Dompet Tunai');
  });

  it('17. Pembayaran parsial berulang: batalkan satu pembayaran memulihkan sebagian sisa utang & saldo, pembayaran lain tetap aktif', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kas',
      incomeSource: 'other',
    }).state;

    // 3 partial payments on Rp27.000: Rp7.000, Rp10.000, Rp10.000 (paid)
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 7000,
      accountId: 'acc-cash',
      date: REF_DATE,
      notes: 'Cicilan 1',
    });
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-cash',
      date: REF_DATE,
      notes: 'Cicilan 2',
    });
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 10000,
      accountId: 'acc-cash',
      date: REF_DATE,
      notes: 'Cicilan 3',
    });

    expect(state.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('paid');
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(73000);

    // Void only the second partial payment (Rp10.000)
    const dp2 = state.debtPayments.find((p) => p.notes === 'Cicilan 2')!;
    state = voidDebtPaymentAction(state, dp2.id, 'Koreksi cicilan kedua');

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(83000);
    expect(snap.outstandingDebtTotal).toBe(10000);
    const updatedDebt = state.debts.find((d) => d.id === 'debt-friend-initial')!;
    expect(updatedDebt.remainingAmount).toBe(10000);
    expect(updatedDebt.status).toBe('active');
    expect(state.debtPayments.find((p) => p.id === dp2.id)?.isVoided).toBe(true);
    expect(state.debtPayments.filter((p) => !p.isVoided).length).toBe(2);
    expect(state.transactions.find((t) => t.id === dp2.transactionId)?.isVoided).toBe(true);
  });

  it('18. Pembayaran parsial berulang: batalkan seluruh pembayaran memulihkan utang & saldo penuh serta tetap idempotent', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kas',
      incomeSource: 'other',
    }).state;

    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 12000,
      accountId: 'acc-cash',
      date: REF_DATE,
      notes: 'Part 1',
    });
    state = repayDebtAction(state, {
      debtId: 'debt-friend-initial',
      amount: 15000,
      accountId: 'acc-cash',
      date: REF_DATE,
      notes: 'Part 2',
    });

    const dpIds = state.debtPayments.map((p) => p.id);
    for (const id of dpIds) {
      state = voidDebtPaymentAction(state, id, 'Batalkan semua cicilan');
    }

    // Re-voiding again must be a no-op (idempotent)
    const afterAllVoided = state;
    const afterRevoid = voidDebtPaymentAction(afterAllVoided, dpIds[0], 'Void ulang');
    expect(afterRevoid).toBe(afterAllVoided);

    const snap = computeFinanceSnapshot(afterRevoid, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(100000);
    expect(snap.outstandingDebtTotal).toBe(27000);
    const debt = afterRevoid.debts.find((d) => d.id === 'debt-friend-initial')!;
    expect(debt.remainingAmount).toBe(27000);
    expect(debt.status).toBe('active');
    expect(afterRevoid.debtPayments.every((p) => p.isVoided)).toBe(true);
  });

  it('19. Sinkronisasi ProjectPayment saat piutang proyek dicicil lalu termin PERTAMA di-void', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Klien Alpha',
      projectName: 'Aplikasi Kasir',
      contractValue: 600000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;

    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 600000,
      status: 'expected',
      date: REF_DATE,
    });
    const rootPpId = state.projectPayments[0].id;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      projectId: proj.project.id,
      projectPaymentId: rootPpId,
      revenueAlreadyRecorded: false,
      creditor: 'Klien Alpha',
      description: 'Tagihan Proyek',
      amount: 600000,
      date: REF_DATE,
    });
    const recDebtId = state.debts.find((d) => d.creditor === 'Klien Alpha')!.id;

    // Collect installment 1 (Rp200.000) and installment 2 (Rp400.000)
    state = collectReceivableAction(state, {
      debtId: recDebtId,
      amount: 200000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Termin 1',
    });
    state = collectReceivableAction(state, {
      debtId: recDebtId,
      amount: 400000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Termin 2',
    });

    const dpFirst = state.debtPayments.find((p) => p.notes === 'Termin 1')!;
    const dpLast = state.debtPayments.find((p) => p.notes === 'Termin 2')!;

    // Void the FIRST installment (Rp200.000)
    state = voidDebtPaymentAction(state, dpFirst.id, 'Termin 1 diretur');

    const snapAfterVoidFirst = computeFinanceSnapshot(state, REF_DATE);
    expect(snapAfterVoidFirst.accountBreakdown.business).toBe(400000);
    expect(snapAfterVoidFirst.outstandingReceivableTotal).toBe(200000);
    expect(snapAfterVoidFirst.monthlyPrediction.confirmedIncomeThisMonth).toBe(400000);

    const recAfter = state.debts.find((d) => d.id === recDebtId)!;
    expect(recAfter.remainingAmount).toBe(200000);
    expect(recAfter.status).toBe('active');

    const rootPpAfter = state.projectPayments.find((p) => p.id === rootPpId)!;
    expect(rootPpAfter.status).toBe('expected');
    expect(rootPpAfter.amount).toBe(200000);
    expect(rootPpAfter.transactionId).toBeUndefined();

    const activeReceivedPp = state.projectPayments.filter(
      (p) => !p.isVoided && p.status === 'received'
    );
    expect(activeReceivedPp).toHaveLength(1);
    expect(activeReceivedPp[0].amount).toBe(400000);
    expect(activeReceivedPp[0].transactionId).toBe(dpLast.transactionId);

    const projSummary = snapAfterVoidFirst.projectSummaries.find(
      (s) => s.project.id === proj.project.id
    )!;
    expect(projSummary.receivedAmount).toBe(400000);
    expect(projSummary.expectedAmount).toBe(200000);

    // Also void remaining installment -> expected returns to 600.000 and received becomes 0
    state = voidDebtPaymentAction(state, dpLast.id, 'Termin 2 juga dibatalkan');
    const snapAllVoided = computeFinanceSnapshot(state, REF_DATE);
    expect(snapAllVoided.accountBreakdown.business).toBe(0);
    expect(snapAllVoided.outstandingReceivableTotal).toBe(600000);
    expect(snapAllVoided.monthlyPrediction.confirmedIncomeThisMonth).toBe(0);
    expect(state.projectPayments.find((p) => p.id === rootPpId)?.amount).toBe(600000);
    expect(state.projectPayments.find((p) => p.id === rootPpId)?.status).toBe('expected');
    const projSummaryFinal = snapAllVoided.projectSummaries.find(
      (s) => s.project.id === proj.project.id
    )!;
    expect(projSummaryFinal.receivedAmount).toBe(0);
    expect(projSummaryFinal.expectedAmount).toBe(600000);
  });

  it('20. Sinkronisasi ProjectPayment saat piutang proyek dicicil lalu termin TERAKHIR di-void', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Klien Beta',
      projectName: 'Desain Brand',
      contractValue: 600000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;

    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 600000,
      status: 'expected',
      date: REF_DATE,
    });
    const rootPpId = state.projectPayments[0].id;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      projectId: proj.project.id,
      projectPaymentId: rootPpId,
      revenueAlreadyRecorded: false,
      creditor: 'Klien Beta',
      description: 'Tagihan Desain',
      amount: 600000,
      date: REF_DATE,
    });
    const recDebtId = state.debts.find((d) => d.creditor === 'Klien Beta')!.id;

    state = collectReceivableAction(state, {
      debtId: recDebtId,
      amount: 200000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Termin Awal',
    });
    state = collectReceivableAction(state, {
      debtId: recDebtId,
      amount: 400000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Termin Akhir',
    });

    const dpFirst = state.debtPayments.find((p) => p.notes === 'Termin Awal')!;
    const dpLast = state.debtPayments.find((p) => p.notes === 'Termin Akhir')!;

    // Void the LAST installment (Rp400.000)
    state = voidDebtPaymentAction(state, dpLast.id, 'Transfer akhir gagal kliring');

    // Re-voiding is idempotent
    expect(voidDebtPaymentAction(state, dpLast.id, 'Ulang')).toBe(state);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.business).toBe(200000);
    expect(snap.outstandingReceivableTotal).toBe(400000);
    expect(snap.monthlyPrediction.confirmedIncomeThisMonth).toBe(200000);

    const recAfter = state.debts.find((d) => d.id === recDebtId)!;
    expect(recAfter.remainingAmount).toBe(400000);
    expect(recAfter.status).toBe('active');

    const rootPpAfter = state.projectPayments.find((p) => p.id === rootPpId)!;
    expect(rootPpAfter.status).toBe('expected');
    expect(rootPpAfter.amount).toBe(400000);
    expect(rootPpAfter.transactionId).toBeUndefined();

    const activeReceivedPp = state.projectPayments.filter(
      (p) => !p.isVoided && p.status === 'received'
    );
    expect(activeReceivedPp).toHaveLength(1);
    expect(activeReceivedPp[0].amount).toBe(200000);
    expect(activeReceivedPp[0].transactionId).toBe(dpFirst.transactionId);

    const projSummary = snap.projectSummaries.find(
      (s) => s.project.id === proj.project.id
    )!;
    expect(projSummary.receivedAmount).toBe(200000);
    expect(projSummary.expectedAmount).toBe(400000);
  });

  it('21. Utang atau piutang yang sudah berstatus void tidak dapat diedit melalui updateDebtAction', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 300000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;

    // Create payable debt via cash_received then void its origin tx
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: 'acc-cash',
      creditor: 'Tono Void',
      description: 'Pinjam salah catat',
      amount: 100000,
      date: REF_DATE,
    });
    const voidedDebtId = state.debts.find((d) => d.creditor === 'Tono Void')!.id;
    const receiptTx = state.transactions.find((t) => t.debtId === voidedDebtId)!;
    state = voidTransactionAction(state, receiptTx.id, 'Salah catat');

    expect(() =>
      updateDebtAction(state, voidedDebtId, {
        creditor: 'Tono Edit',
        description: 'Coba ubah void',
      })
    ).toThrow(/void/i);

    // Also test voided receivable
    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Siti Void',
      description: 'Piutang batal',
      amount: 50000,
      date: REF_DATE,
    });
    const voidedRecId = state.debts.find((d) => d.creditor === 'Siti Void')!.id;
    const loanTx = state.transactions.find((t) => t.debtId === voidedRecId)!;
    state = voidTransactionAction(state, loanTx.id, 'Pinjaman batal');

    expect(() =>
      updateDebtAction(state, voidedRecId, { dueDate: '2026-12-31' })
    ).toThrow(/void/i);
  });

  it('22. Preset Bayar Utang (findDefaultActiveDebt) melewati utang void di awal array dan memilih utang aktif berikutnya', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-other',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'other',
    }).state;

    // Put a voided debt AND a receivable ahead of the real active payable debt
    state.debts = [
      {
        id: 'debt-void-first',
        direction: 'payable',
        creditor: 'Utang Void Pertama',
        description: 'Sudah void tapi status masih active',
        initialAmount: 90000,
        remainingAmount: 90000,
        priority: 1,
        status: 'active',
        isVoided: true,
        voidedAt: '2026-11-16T08:00:00.000Z',
        voidReason: 'Batal',
        createdAt: '2026-11-16T08:00:00.000Z',
      },
      {
        id: 'rec-first',
        direction: 'receivable',
        creditor: 'Piutang Aktif',
        description: 'Bukan utang payable',
        initialAmount: 50000,
        remainingAmount: 50000,
        priority: 1,
        status: 'active',
        createdAt: '2026-11-16T08:00:00.000Z',
      },
      ...state.debts,
    ];

    const selected = findDefaultActiveDebt(state.debts, 'payable');
    expect(selected).toBeDefined();
    expect(selected?.id).toBe('debt-friend-initial');
    expect(selected?.isVoided).not.toBe(true);

    // Repaying the selected debt succeeds cleanly
    const next = repayDebtAction(state, {
      debtId: selected!.id,
      amount: selected!.remainingAmount,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    expect(next.debts.find((d) => d.id === 'debt-friend-initial')?.status).toBe('paid');
  });

  it('23. escapeCSV dan buildFinanceCSVContent menetralkan CSV formula injection serta escape koma/kutip/newline/CR', () => {
    expect(escapeCSV('=HYPERLINK("https://evil.test","Klik")')).toBe(
      `"'=HYPERLINK(""https://evil.test"",""Klik"")"`
    );
    expect(escapeCSV('+cmd|"/C calc"!A0')).toBe(`"'+cmd|""/C calc""!A0"`);
    expect(escapeCSV('-2+3+cmd|calc')).toBe(`'-2+3+cmd|calc`);
    expect(escapeCSV('@SUM(1+1)*cmd')).toBe(`'@SUM(1+1)*cmd`);
    expect(escapeCSV('\t=1+1')).toBe(`'\t=1+1`);
    expect(escapeCSV('\r=1+1')).toBe(`"'\r=1+1"`);
    expect(escapeCSV('Normal, "dengan kutip"\nbaris2\rbaris3')).toBe(
      `"Normal, ""dengan kutip""\nbaris2\rbaris3"`
    );

    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'expense',
      amount: 15000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: '=HYPERLINK("http://x.test","Promo"), Gratis',
      overrideReason: '+SUM(A1:A2)\nBaris2',
    }).state;

    const snap = computeFinanceSnapshot(state, REF_DATE);
    const csv = buildFinanceCSVContent(state, snap);
    expect(csv).toContain(`"'=HYPERLINK(""http://x.test"",""Promo""), Gratis"`);
    expect(csv).toContain(`"'+SUM(A1:A2)\nBaris2"`);
  });

  it('24. escapeCSV dan buildFinanceCSVContent mempertahankan angka positif dan negatif sebagai nilai numerik tanpa prefix apostrof', () => {
    expect(escapeCSV(150000)).toBe('150000');
    expect(escapeCSV(-45000)).toBe('-45000');
    expect(escapeCSV(0)).toBe('0');

    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 100000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Pemasukan Uji CSV',
      incomeSource: 'daily_allowance',
    }).state;
    // Create negative Safe-to-Spend / funding shortfall condition cleanly via numeric cells
    const snap = computeFinanceSnapshot(state, REF_DATE);
    const csv = buildFinanceCSVContent(state, snap);
    const lines = csv.split('\n');
    const summaryCashLine = lines.find((l) => l.startsWith('Saldo Likuid Pribadi,'))!;
    expect(summaryCashLine).toBe('Saldo Likuid Pribadi,100000');

    const txRow = lines.find((l) => l.includes('Pemasukan Uji CSV'))!;
    expect(txRow).toContain(',100000,');
    expect(txRow).not.toContain(",'100000,");
  });
});

describe('VaraFinance Phase 2.3A — Two-Way Sync ProjectPayment <-> Debt & Protected Account Classification', () => {
  const REF_DATE = '2026-11-16';

  it('25. markProjectPaymentReceivedAction melunasi Debt piutang terkait via projectPaymentId, mencegah double-counting bila revenueAlreadyRecorded true, dan dapat dibatalkan penuh via voidDebtPaymentAction', () => {
    let state = createInitialFinanceState(REF_DATE);

    const proj = createProjectAction(state, {
      clientName: 'PT Sinar Jaya',
      projectName: 'Redesain Portal',
      contractValue: 1500000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;

    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'final',
      amount: 1000000,
      status: 'expected',
      date: '2026-11-25',
      notes: 'Termin akhir proyek',
    });
    const expectedPpId = state.projectPayments[0].id;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'PT Sinar Jaya',
      description: 'Piutang Termin Akhir Redesain Portal',
      amount: 1000000,
      date: REF_DATE,
      projectId: proj.project.id,
      projectPaymentId: expectedPpId,
      revenueAlreadyRecorded: true,
    });
    const recDebt = state.debts.find((d) => d.projectPaymentId === expectedPpId)!;
    expect(recDebt.status).toBe('active');
    expect(recDebt.remainingAmount).toBe(1000000);

    // Mark the expected ProjectPayment as received directly
    state = markProjectPaymentReceivedAction(state, expectedPpId, 'acc-business', '2026-11-20');

    const updatedPp = state.projectPayments.find((p) => p.id === expectedPpId)!;
    expect(updatedPp.status).toBe('received');
    expect(updatedPp.accountId).toBe('acc-business');
    expect(updatedPp.receivedDate).toBe('2026-11-20');
    expect(updatedPp.transactionId).toBeDefined();

    const updatedDebt = state.debts.find((d) => d.id === recDebt.id)!;
    expect(updatedDebt.status).toBe('paid');
    expect(updatedDebt.remainingAmount).toBe(0);

    const createdDp = state.debtPayments.find(
      (dp) => dp.debtId === recDebt.id && !dp.isVoided
    )!;
    expect(createdDp).toBeDefined();
    expect(createdDp.amount).toBe(1000000);
    expect(createdDp.transactionId).toBe(updatedPp.transactionId);

    const linkedTx = state.transactions.find((t) => t.id === updatedPp.transactionId)!;
    expect(linkedTx.debtId).toBe(recDebt.id);
    expect(linkedTx.transactionNature).toBe('receivable_collection');
    expect(linkedTx.excludeFromIncomeStats).toBe(true);
    expect(linkedTx.categoryId).toBe('cat-income-other');

    const snapPaid = computeFinanceSnapshot(state, '2026-11-20');
    expect(snapPaid.businessBalance).toBe(1000000);
    expect(snapPaid.outstandingReceivableTotal).toBe(0);

    // Symmetry check: voiding the DebtPayment reverses Debt, ProjectPayment, and Transaction together
    state = voidDebtPaymentAction(state, createdDp.id, 'Pembayaran ditolak bank');

    const revertedPp = state.projectPayments.find((p) => p.id === expectedPpId)!;
    expect(revertedPp.status).toBe('expected');
    expect(revertedPp.transactionId).toBeUndefined();
    expect(revertedPp.accountId).toBeUndefined();

    const revertedDebt = state.debts.find((d) => d.id === recDebt.id)!;
    expect(revertedDebt.status).toBe('active');
    expect(revertedDebt.remainingAmount).toBe(1000000);

    const snapReverted = computeFinanceSnapshot(state, '2026-11-20');
    expect(snapReverted.businessBalance).toBe(0);
    expect(snapReverted.outstandingReceivableTotal).toBe(1000000);
  });

  it('26. markProjectPaymentReceivedAction mengakui pendapatan cat-income-freelance saat revenueAlreadyRecorded false dan tidak mengaktifkan ulang Debt yang sudah void', () => {
    let state = createInitialFinanceState(REF_DATE);

    const proj = createProjectAction(state, {
      clientName: 'CV Maju',
      projectName: 'Audit UI',
      contractValue: 800000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;

    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 800000,
      status: 'expected',
      date: '2026-11-22',
    });
    const ppId = state.projectPayments[0].id;

    // Pre-existing voided debt pointing to same projectPaymentId + an active un-recorded-revenue receivable
    state.debts.push(
      {
        id: 'rec-void-stale',
        direction: 'receivable',
        receivableType: 'project_sales',
        creditor: 'CV Maju (Void)',
        description: 'Piutang void lama',
        initialAmount: 800000,
        remainingAmount: 0,
        priority: 1,
        status: 'active',
        isVoided: true,
        voidedAt: '2026-11-16T09:00:00Z',
        projectId: proj.project.id,
        projectPaymentId: ppId,
        createdAt: '2026-11-16T08:00:00Z',
      },
      {
        id: 'rec-active-project',
        direction: 'receivable',
        receivableType: 'project_sales',
        creditor: 'CV Maju',
        description: 'Piutang proyek cash-basis',
        initialAmount: 800000,
        remainingAmount: 800000,
        priority: 1,
        status: 'active',
        revenueAlreadyRecorded: false,
        projectId: proj.project.id,
        projectPaymentId: ppId,
        createdAt: '2026-11-16T10:00:00Z',
      }
    );

    state = markProjectPaymentReceivedAction(state, ppId, 'acc-business', '2026-11-18');

    const ppAfter = state.projectPayments.find((p) => p.id === ppId)!;
    const txAfter = state.transactions.find((t) => t.id === ppAfter.transactionId)!;
    expect(txAfter.categoryId).toBe('cat-income-freelance');
    expect(txAfter.excludeFromIncomeStats).toBe(false);
    expect(txAfter.debtId).toBe('rec-active-project');

    const voidDebtAfter = state.debts.find((d) => d.id === 'rec-void-stale')!;
    expect(voidDebtAfter.isVoided).toBe(true);
    expect(voidDebtAfter.remainingAmount).toBe(0);

    const activeDebtAfter = state.debts.find((d) => d.id === 'rec-active-project')!;
    expect(activeDebtAfter.status).toBe('paid');
    expect(activeDebtAfter.remainingAmount).toBe(0);
  });

  it('27. Akun cash, bank, dan ewallet dengan isProtected: true dikecualikan dari liquidPersonalBalance/accountBreakdown likuid dan dihitung pada protectedAccountBalance', () => {
    const state = createInitialFinanceState(REF_DATE);

    // Liquid accounts
    state.accounts[0].openingBalance = 100000; // acc-cash (isProtected: false)
    state.accounts[1].openingBalance = 200000; // acc-bank (isProtected: false)
    state.accounts[2].openingBalance = 50000; // acc-ewallet (isProtected: false)
    state.accounts[3].openingBalance = 400000; // acc-savings (isProtected: true)

    // Add protected accounts of types cash, bank, ewallet
    state.accounts.push(
      {
        id: 'acc-cash-vault',
        name: 'Brankas Darurat Tunai',
        accountType: 'cash',
        openingBalance: 300000,
        isBusiness: false,
        isProtected: true,
        status: 'active',
        createdAt: '2026-11-16T08:00:00Z',
      },
      {
        id: 'acc-bank-locked',
        name: 'Rekening Dana Cadangan',
        accountType: 'bank',
        openingBalance: 500000,
        isBusiness: false,
        isProtected: true,
        status: 'active',
        createdAt: '2026-11-16T08:00:00Z',
      },
      {
        id: 'acc-ewallet-locked',
        name: 'GoPay Proteksi',
        accountType: 'ewallet',
        openingBalance: 150000,
        isBusiness: false,
        isProtected: true,
        status: 'active',
        createdAt: '2026-11-16T08:00:00Z',
      }
    );

    const snap = computeFinanceSnapshot(state, REF_DATE);

    // Only unprotected personal accounts appear in liquid breakdown
    expect(snap.accountBreakdown.cash).toBe(100000);
    expect(snap.accountBreakdown.bankPersonal).toBe(200000);
    expect(snap.accountBreakdown.ewallet).toBe(50000);
    expect(snap.liquidPersonalBalance).toBe(350000);

    // All protected accounts (400k savings + 300k cash vault + 500k locked bank + 150k locked ewallet)
    expect(snap.protectedAccountBalance).toBe(1350000);

    // Total net assets remains 100% conserved (350k + 1,350k = 1,700k)
    expect(snap.totalNetAssets).toBe(1700000);

    // Consistent with simulateExpenseImpact: spending from protected bank does NOT reduce safeToSpendAfter
    const simProtected = simulateExpenseImpact(state, {
      amount: 100000,
      accountId: 'acc-bank-locked',
      categoryId: 'cat-food',
    });
    expect(simProtected.safeToSpendAfter).toBe(snap.safeToSpend);

    const simLiquid = simulateExpenseImpact(state, {
      amount: 100000,
      accountId: 'acc-bank',
      categoryId: 'cat-food',
    });
    expect(simLiquid.safeToSpendAfter).toBe(snap.safeToSpend - 100000);
  });
});

describe('VaraFinance Phase 2.4 — Custodial Funds, Project Advances & Receivable Write-Off (16 Pengujian Wajib)', () => {
  const REF_DATE = '2026-11-18';

  it('28. Penerimaan dana titipan menaikkan kas aktual tanpa masuk pendapatan atau Safe-to-Spend', () => {
    let state = createInitialFinanceState(REF_DATE);
    // Beri saldo pribadi awal Rp200.000 agar Safe-to-Spend terukur jelas
    state = addTransactionAction(state, {
      type: 'income',
      amount: 200000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas pribadi awal',
      incomeSource: 'daily_allowance',
    }).state;
    const before = computeFinanceSnapshot(state, REF_DATE);

    const res = receiveCustodialFundAction(state, {
      counterparty: 'Panitia Acara',
      description: 'Titipan dana konsumsi',
      amount: 500000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    state = res.state;

    const after = computeFinanceSnapshot(state, REF_DATE);
    expect(after.accountBreakdown.bankPersonal).toBe(before.accountBreakdown.bankPersonal + 500000);
    expect(after.liquidPersonalBalance).toBe(before.liquidPersonalBalance + 500000);
    expect(after.custodialFundsHeldTotal).toBe(500000);
    expect(after.custodialInLiquid).toBe(500000);
    expect(after.personalLiquidOwnNet).toBe(before.personalLiquidOwnNet);
    expect(after.monthlyPrediction.confirmedIncomeThisMonth).toBe(before.monthlyPrediction.confirmedIncomeThisMonth);
    expect(after.recognizedIncomeThisMonth).toBe(before.recognizedIncomeThisMonth);
    expect(after.cashReceiptsThisMonth).toBe(before.cashReceiptsThisMonth + 500000);
    expect(after.safeToSpend).toBe(before.safeToSpend);
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
    expect(res.transaction.excludeFromIncomeStats).toBe(true);
    expect(res.transaction.transactionNature).toBe('custodial_receipt');
  });

  it('29. Pengembalian dana titipan sebagian menyisakan histori dan memperbarui sisa kewajiban & kas secara proporsional', () => {
    let state = createInitialFinanceState(REF_DATE);
    const { state: s1, custodialFund } = receiveCustodialFundAction(state, {
      counterparty: 'Budi',
      description: 'Titipan beli barang',
      amount: 400000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    state = returnCustodialFundAction(s1, {
      custodialFundId: custodialFund.id,
      amount: 150000,
      accountId: 'acc-bank',
      date: REF_DATE,
      notes: 'Pengembalian tahap 1',
    });

    const updated = state.custodialFunds!.find((c) => c.id === custodialFund.id)!;
    expect(updated.status).toBe('active');
    expect(updated.remainingAmount).toBe(250000);
    expect(updated.returns).toHaveLength(1);
    expect(updated.returns[0].amount).toBe(150000);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(250000);
    expect(snap.custodialFundsHeldTotal).toBe(250000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
  });

  it('30. Pengembalian dana titipan penuh menandai returned, sisa Rp0, dan menolak pengembalian berlebih', () => {
    let state = createInitialFinanceState(REF_DATE);
    const { state: s1, custodialFund } = receiveCustodialFundAction(state, {
      counterparty: 'Rina',
      amount: 300000,
      accountId: 'acc-ewallet',
      date: REF_DATE,
    });

    expect(() =>
      returnCustodialFundAction(s1, {
        custodialFundId: custodialFund.id,
        amount: 350000,
        accountId: 'acc-ewallet',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa dana titipan/i);

    state = returnCustodialFundAction(s1, {
      custodialFundId: custodialFund.id,
      amount: 300000,
      accountId: 'acc-ewallet',
      date: REF_DATE,
    });

    const updated = state.custodialFunds!.find((c) => c.id === custodialFund.id)!;
    expect(updated.status).toBe('returned');
    expect(updated.remainingAmount).toBe(0);
    expect(updated.fundAllocations.reduce((s, a) => s + a.amount, 0)).toBe(0);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.ewallet).toBe(0);
    expect(snap.custodialFundsHeldTotal).toBe(0);
  });

  it('31. Dana titipan yang tersebar di beberapa akun (likuid, terproteksi, dan bisnis) dihitung akurat per klasifikasi akun', () => {
    let state = createInitialFinanceState(REF_DATE);
    state.accounts[1].openingBalance = 200000; // acc-bank (liquid)
    state.accounts[3].openingBalance = 0; // acc-savings (protected)
    state.accounts[4].openingBalance = 0; // acc-business (business)

    const rec = receiveCustodialFundAction(state, {
      counterparty: 'Tim Proyek Bersama',
      amount: 600000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    state = rec.state;

    // Pindahkan Rp200.000 ke akun terproteksi dan Rp100.000 ke akun bisnis secara eksplisit
    state = addTransferAction(state, {
      fromAccountId: 'acc-bank',
      toAccountId: 'acc-savings',
      amount: 200000,
      date: REF_DATE,
      restrictedAllocations: [{ fundType: 'custodial', fundId: rec.custodialFund.id, amount: 200000 }],
    });
    state = addTransferAction(state, {
      fromAccountId: 'acc-bank',
      toAccountId: 'acc-business',
      amount: 100000,
      date: REF_DATE,
      restrictedAllocations: [{ fundType: 'custodial', fundId: rec.custodialFund.id, amount: 100000 }],
    });

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.custodialFundsHeldTotal).toBe(600000);
    expect(snap.custodialInLiquid).toBe(300000);
    expect(snap.custodialInProtected).toBe(200000);
    expect(snap.custodialInBusiness).toBe(100000);
    expect(snap.personalLiquidOwnNet).toBe(200000); // 500k di acc-bank minus 300k titipan
    expect(snap.protectedFreeBalance).toBe(0); // 200k di acc-savings semua titipan
    expect(snap.businessFreeBalance).toBe(0); // 100k di acc-business semua titipan
  });

  it('32. Transfer akun dengan dana terikat memindahkan alokasi secara otomatis saat kas bebas di akun asal tidak cukup', () => {
    let state = createInitialFinanceState(REF_DATE);
    state.accounts[0].openingBalance = 100000; // acc-cash milik pribadi Rp100.000

    const rec = receiveCustodialFundAction(state, {
      counterparty: 'Klien Titip',
      amount: 300000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    state = rec.state;
    // acc-cash sekarang punya total Rp400.000 (Rp100k pribadi + Rp300k titipan)

    // Transfer Rp250.000 ke acc-bank tanpa mengisi restrictedAllocations eksplisit -> spillover Rp150.000 titipan ikut berpindah
    state = addTransferAction(state, {
      fromAccountId: 'acc-cash',
      toAccountId: 'acc-bank',
      amount: 250000,
      date: REF_DATE,
    });

    const updatedFund = state.custodialFunds!.find((c) => c.id === rec.custodialFund.id)!;
    const cashAlloc = updatedFund.fundAllocations.find((a) => a.accountId === 'acc-cash')?.amount ?? 0;
    const bankAlloc = updatedFund.fundAllocations.find((a) => a.accountId === 'acc-bank')?.amount ?? 0;
    expect(cashAlloc).toBe(150000);
    expect(bankAlloc).toBe(150000);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.custodialFundsHeldTotal).toBe(300000);
    expect(snap.accountBreakdown.cash).toBe(150000);
    expect(snap.accountBreakdown.bankPersonal).toBe(250000);
    expect(snap.personalLiquidOwnNet).toBe(100000);

    // Pengembalian dari acc-bank hanya boleh maksimal sesuai alokasinya (150k), tidak boleh 200k
    expect(() =>
      returnCustodialFundAction(state, {
        custodialFundId: rec.custodialFund.id,
        amount: 200000,
        accountId: 'acc-bank',
        date: REF_DATE,
      })
    ).toThrow(/Alokasi dana titipan pada akun/i);
  });

  it('33. Penerimaan DP proyek menaikkan kas dan kewajiban ditangguhkan tanpa langsung diakui sebagai pendapatan atau Safe-to-Spend', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'PT Kreatif',
      projectName: 'Redesign App',
      contractValue: 2000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;
    const before = computeFinanceSnapshot(state, REF_DATE);

    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 800000,
      accountId: 'acc-bank', // masuk ke rekening pribadi likuid
      date: REF_DATE,
    });
    state = advRes.state;

    const after = computeFinanceSnapshot(state, REF_DATE);
    expect(after.accountBreakdown.bankPersonal).toBe(before.accountBreakdown.bankPersonal + 800000);
    expect(after.deferredProjectAdvancesTotal).toBe(800000);
    expect(after.deferredAdvancesInLiquid).toBe(800000);
    expect(after.monthlyPrediction.confirmedIncomeThisMonth).toBe(0);
    expect(after.recognizedIncomeThisMonth).toBe(0);
    expect(after.cashReceiptsThisMonth).toBe(800000);
    expect(after.safeToSpend).toBe(before.safeToSpend);
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
    expect(advRes.transaction.excludeFromIncomeStats).toBe(true);
    expect(advRes.transaction.transactionNature).toBe('project_advance_receipt');
  });

  it('34. Pengakuan DP proyek bertahap multi-tahap mengakui pendapatan secara non-kas tanpa menggandakan kas', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'CV Digital',
      projectName: 'Sistem Inventory',
      contractValue: 1500000,
      paymentScheme: 'milestone',
      businessSharePct: 30,
    });
    state = proj.state;

    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 900000,
      accountId: 'acc-business',
      date: REF_DATE,
    });
    state = advRes.state;

    // Tahap 1: akui Rp400.000
    state = recognizeProjectAdvanceAction(state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 400000,
      date: REF_DATE,
      notes: 'Milestone wireframe selesai',
    });

    const snapMid = computeFinanceSnapshot(state, REF_DATE);
    expect(snapMid.accountBreakdown.business).toBe(900000); // kas TIDAK bertambah dua kali
    expect(snapMid.recognizedIncomeThisMonth).toBe(400000);
    expect(snapMid.monthlyPrediction.confirmedIncomeThisMonth).toBe(400000);
    expect(snapMid.deferredProjectAdvancesTotal).toBe(500000);
    expect(snapMid.businessFreeBalance).toBe(400000);

    // Tahap 2: akui sisa Rp500.000 -> status menjadi settled
    state = recognizeProjectAdvanceAction(state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 500000,
      date: REF_DATE,
      notes: 'Serah terima akhir',
    });

    const advFinal = state.projectAdvances!.find((p) => p.id === advRes.projectAdvance.id)!;
    expect(advFinal.status).toBe('settled');
    expect(advFinal.recognizedAmount).toBe(900000);
    expect(advFinal.remainingAmount).toBe(0);
    expect(advFinal.recognitions).toHaveLength(2);

    const snapFinal = computeFinanceSnapshot(state, REF_DATE);
    expect(snapFinal.accountBreakdown.business).toBe(900000);
    expect(snapFinal.recognizedIncomeThisMonth).toBe(900000);
    expect(snapFinal.deferredProjectAdvancesTotal).toBe(0);
    expect(snapFinal.businessFreeBalance).toBe(900000);

    const projSummary = snapFinal.projectSummaries.find((s) => s.project.id === proj.project.id)!;
    expect(projSummary.recognizedAdvanceAmount).toBe(900000);
    expect(projSummary.unrecognizedAdvanceAmount).toBe(0);
    expect(projSummary.receivedAmount).toBe(900000);
    expect(projSummary.outstandingReceivables).toBe(600000);
  });

  it('35. Pengembalian DP proyek sebagian mengurangi kas, sisa DP, dan mempertahankan riwayat refund', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Toko Sinar',
      projectName: 'Web Katalog',
      contractValue: 1000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;

    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 500000,
      accountId: 'acc-business',
      date: REF_DATE,
    });
    state = recognizeProjectAdvanceAction(advRes.state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 200000,
      date: REF_DATE,
    });
    state = refundProjectAdvanceAction(state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 100000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Pengurangan scope parsial',
    });

    const adv = state.projectAdvances!.find((p) => p.id === advRes.projectAdvance.id)!;
    expect(adv.recognizedAmount).toBe(200000);
    expect(adv.refundedAmount).toBe(100000);
    expect(adv.remainingAmount).toBe(200000);
    expect(adv.status).toBe('active');
    expect(adv.refunds).toHaveLength(1);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.business).toBe(400000);
    expect(snap.deferredProjectAdvancesTotal).toBe(200000);
    expect(snap.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
  });

  it('36. Pengembalian DP proyek penuh menandai settled, sisa Rp0, dan menolak refund berlebih', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Klien Batal',
      projectName: 'Branding',
      contractValue: 700000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;

    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 350000,
      accountId: 'acc-business',
      date: REF_DATE,
    });

    expect(() =>
      refundProjectAdvanceAction(advRes.state, {
        projectAdvanceId: advRes.projectAdvance.id,
        amount: 400000,
        accountId: 'acc-business',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa DP/i);

    state = refundProjectAdvanceAction(advRes.state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 350000,
      accountId: 'acc-business',
      date: REF_DATE,
      notes: 'Proyek dibatalkan klien',
    });

    const adv = state.projectAdvances!.find((p) => p.id === advRes.projectAdvance.id)!;
    expect(adv.status).toBe('settled');
    expect(adv.remainingAmount).toBe(0);
    expect(adv.refundedAmount).toBe(350000);
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.business).toBe(0);
    expect(computeFinanceSnapshot(state, REF_DATE).deferredProjectAdvancesTotal).toBe(0);
  });

  it('37. Mencegah pengakuan DP proyek melebihi sisa DP yang belum diakui', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Klien Guard',
      projectName: 'Landing Page',
      contractValue: 1000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;

    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 400000,
      accountId: 'acc-business',
      date: REF_DATE,
    });
    state = recognizeProjectAdvanceAction(advRes.state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 250000,
      date: REF_DATE,
    });

    expect(() =>
      recognizeProjectAdvanceAction(state, {
        projectAdvanceId: advRes.projectAdvance.id,
        amount: 200000,
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa DP/i);
  });

  it('38. Write-off piutang yang sudah diakui pendapatannya menghapus piutang tanpa mengubah kas dan mencatat write-off loss non-kas', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 300000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Saldo kas awal',
      incomeSource: 'daily_allowance',
    }).state;

    const proj = createProjectAction(state, {
      clientName: 'PT Gagal Bayar',
      projectName: 'Audit Sistem',
      contractValue: 1000000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = proj.state;
    state = addProjectPaymentAction(state, {
      projectId: proj.project.id,
      paymentType: 'full',
      amount: 1000000,
      status: 'expected',
      date: REF_DATE,
    });
    const ppId = state.projectPayments[0].id;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'PT Gagal Bayar',
      description: 'Tagihan invoice #01',
      amount: 1000000,
      date: REF_DATE,
      projectId: proj.project.id,
      projectPaymentId: ppId,
      revenueAlreadyRecorded: true,
    });
    const debtId = state.debts.find((d) => d.creditor === 'PT Gagal Bayar')!.id;
    const before = computeFinanceSnapshot(state, REF_DATE);

    state = writeOffReceivableAction(state, {
      debtId,
      date: REF_DATE,
      reason: 'Klien pailit dan tidak dapat ditagih',
    });

    const after = computeFinanceSnapshot(state, REF_DATE);
    const updatedDebt = state.debts.find((d) => d.id === debtId)!;
    expect(updatedDebt.status).toBe('written_off');
    expect(updatedDebt.remainingAmount).toBe(0);
    expect(updatedDebt.writtenOffAmount).toBe(1000000);
    expect(updatedDebt.writeOffHistory).toHaveLength(1);
    expect(after.accountBreakdown.cash).toBe(before.accountBreakdown.cash);
    expect(after.accountBreakdown.business).toBe(before.accountBreakdown.business);
    expect(after.outstandingReceivableTotal).toBe(0);
    expect(after.monthlyPrediction.expectedFreelanceReceivables).toBe(0);
    expect(after.writtenOffReceivableTotal).toBe(1000000);
    expect(after.writtenOffRecognizedLossTotal).toBe(1000000);
    expect(after.writtenOffUnrecognizedTotal).toBe(0);
    // Non-cash write-off tidak boleh merusak budget konsumtif/No-Spend Day
    expect(after.monthlyPrediction.confirmedExpenseThisMonth).toBe(before.monthlyPrediction.confirmedExpenseThisMonth);
    expect(state.transactions.some((t) => t.transactionNature === 'receivable_write_off' && t.affectsAccountBalance === false)).toBe(true);
  });

  it('39. Write-off piutang yang belum diakui pendapatannya (pinjaman pribadi & cash-basis) tidak menciptakan kerugian fiktif dan menjaga kas utuh', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 500000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Modal kas',
      incomeSource: 'daily_allowance',
    }).state;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: 'acc-cash',
      creditor: 'Teman X',
      description: 'Pinjaman uang pribadi',
      amount: 200000,
      date: REF_DATE,
    });
    const personalRecId = state.debts.find((d) => d.creditor === 'Teman X')!.id;
    const txCountBefore = state.transactions.length;
    const before = computeFinanceSnapshot(state, REF_DATE);
    expect(before.accountBreakdown.cash).toBe(300000);

    state = writeOffReceivableAction(state, {
      debtId: personalRecId,
      date: REF_DATE,
      reason: 'Dianggap tidak kembali',
    });

    const after = computeFinanceSnapshot(state, REF_DATE);
    expect(after.accountBreakdown.cash).toBe(300000); // kas tidak berubah saat write-off
    expect(after.outstandingReceivableTotal).toBe(0);
    expect(after.writtenOffReceivableTotal).toBe(200000);
    expect(after.writtenOffRecognizedLossTotal).toBe(0);
    expect(after.writtenOffUnrecognizedTotal).toBe(200000);
    expect(after.monthlyPrediction.confirmedExpenseThisMonth).toBe(0);
    expect(after.monthlyPrediction.confirmedIncomeThisMonth).toBe(before.monthlyPrediction.confirmedIncomeThisMonth);
    // Tidak ada transaksi kerugian pendapatan/pengeluaran fiktif yang dibuat
    expect(state.transactions.length).toBe(txCountBefore);
  });

  it('40. Pemulihan piutang yang pernah di-write-off mengaktifkan kembali piutang tanpa menghapus histori serta mendukung penagihan kas', () => {
    let state = createInitialFinanceState(REF_DATE);
    state = addTransactionAction(state, {
      type: 'income',
      amount: 400000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Kas awal',
      incomeSource: 'daily_allowance',
    }).state;

    state = addDebtAction(state, {
      direction: 'receivable',
      receivableType: 'project_sales',
      creditor: 'Klien Pulih',
      description: 'Tagihan terpulihkan',
      amount: 300000,
      date: REF_DATE,
      revenueAlreadyRecorded: true,
    });
    const recId = state.debts.find((d) => d.creditor === 'Klien Pulih')!.id;

    state = writeOffReceivableAction(state, {
      debtId: recId,
      date: REF_DATE,
      reason: 'Macet sementara',
    });
    expect(state.debts.find((d) => d.id === recId)?.status).toBe('written_off');

    state = recoverReceivableAction(state, {
      debtId: recId,
      date: REF_DATE,
      reason: 'Klien menghubungi kembali untuk membayar',
      collectAmount: 300000,
      accountId: 'acc-bank',
    });

    const debtFinal = state.debts.find((d) => d.id === recId)!;
    expect(debtFinal.status).toBe('paid');
    expect(debtFinal.remainingAmount).toBe(0);
    expect(debtFinal.writtenOffAmount).toBe(0);
    expect(debtFinal.writeOffHistory?.length).toBe(2);
    expect(debtFinal.writeOffHistory?.some((h) => h.action === 'write_off')).toBe(true);
    expect(debtFinal.writeOffHistory?.some((h) => h.action === 'recover')).toBe(true);
    // Transaksi write-off lama tetap ada sebagai arsip (voided), tidak dihapus
    const woTx = state.transactions.find((t) => t.transactionNature === 'receivable_write_off')!;
    expect(woTx.isVoided).toBe(true);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.bankPersonal).toBe(300000);
    expect(snap.writtenOffReceivableTotal).toBe(0);
  });

  it('41. Safe-to-Spend tidak melakukan double-counting antara Debt dan RecurringObligation yang tertaut via linkedDebtId', () => {
    let state = createInitialFinanceState(REF_DATE);
    // Hapus KKN awal agar perhitungan Safe-to-Spend fokus pada Debt + Obligation tertaut
    state.obligations = [];
    state.debts = [
      {
        id: 'debt-laptop-cicilan',
        direction: 'payable',
        creditor: 'Cicilan Laptop',
        description: 'Cicilan bulanan',
        initialAmount: 300000,
        remainingAmount: 300000,
        priority: 1,
        status: 'active',
        createdAt: `${REF_DATE}T08:00:00Z`,
      },
    ];
    state = addTransactionAction(state, {
      type: 'income',
      amount: 1000000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Pemasukan bulan ini',
      incomeSource: 'daily_allowance',
    }).state;

    // Tambah kewajiban terjadwal yang tertaut ke utang tersebut
    state = addObligationAction(state, {
      kind: 'obligation',
      name: 'Cicilan Laptop November',
      category: 'Utang',
      amount: 300000,
      frequency: 'monthly',
      nextDueDate: '2026-11-25',
      linkedDebtId: 'debt-laptop-cicilan',
    }).state;

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.outstandingDebtTotal).toBe(300000);
    expect(snap.unfundedObligations).toBe(0);
    expect(snap.linkedDebtObligationsExcludedTotal).toBe(300000);
    // Kas 1.000.000 - utang 300.000 - essentialReserve 50.000 = 650.000 (BUKAN 350.000!)
    expect(snap.safeToSpend).toBe(1000000 - 300000 - snap.essentialReserve);

    // Setelah reservedAmount disisihkan Rp100.000 untuk obligation tertaut, tetap tidak double-count
    const linkedObId = state.obligations[0].id;
    state = reserveObligationAction(state, linkedObId, 100000);
    const snapReserved = computeFinanceSnapshot(state, REF_DATE);
    expect(snapReserved.reservedObligations).toBe(0);
    expect(snapReserved.allocatedTotal).toBe(0);
    expect(snapReserved.safeToSpend).toBe(snap.safeToSpend);
  });

  it('42. Kompatibilitas data lama (state v1 tanpa custodialFunds, projectAdvances, linkedDebtId, writeOffHistory) berjalan normal', () => {
    const legacyState = createInitialFinanceState(REF_DATE);
    delete legacyState.custodialFunds;
    delete legacyState.projectAdvances;
    legacyState.transactions.push({
      id: 'legacy-tx-1',
      type: 'income',
      amount: 350000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Pemasukan lama',
      tags: [],
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: `${REF_DATE}T08:00:00Z`,
    });

    const hydrated = hydrateFinanceState(legacyState);
    expect(hydrated.custodialFunds).toEqual([]);
    expect(hydrated.projectAdvances).toEqual([]);

    const snap = computeFinanceSnapshot(hydrated, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(350000);
    expect(snap.custodialFundsHeldTotal).toBe(0);
    expect(snap.deferredProjectAdvancesTotal).toBe(0);
    expect(snap.writtenOffReceivableTotal).toBe(0);
    expect(snap.personalLiquidOwnNet).toBe(350000);
  });

  it('43. Void transaksi dan integritas relasi (ledgerGroupId, parentTransactionId, larangan hapus/void induk dengan anak aktif, dan pemulihan alokasi)', () => {
    let state = createInitialFinanceState(REF_DATE);
    const proj = createProjectAction(state, {
      clientName: 'Klien Relasi',
      projectName: 'Platform Web',
      contractValue: 1200000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = proj.state;

    // A) DP proyek + pengakuan parsial + refund parsial
    const advRes = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 600000,
      accountId: 'acc-business',
      date: REF_DATE,
    });
    state = recognizeProjectAdvanceAction(advRes.state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 200000,
      date: REF_DATE,
    });
    state = refundProjectAdvanceAction(state, {
      projectAdvanceId: advRes.projectAdvance.id,
      amount: 100000,
      accountId: 'acc-business',
      date: REF_DATE,
    });

    const advMid = state.projectAdvances!.find((p) => p.id === advRes.projectAdvance.id)!;
    const recTx = state.transactions.find((t) => t.transactionNature === 'project_advance_recognition')!;
    const refTx = state.transactions.find((t) => t.transactionNature === 'project_advance_refund')!;
    expect(recTx.parentTransactionId).toBe(advRes.transaction.id);
    expect(refTx.parentTransactionId).toBe(advRes.transaction.id);
    expect(recTx.ledgerGroupId).toBe(advRes.transaction.ledgerGroupId);
    expect(refTx.ledgerGroupId).toBe(advRes.transaction.ledgerGroupId);

    // Induk memiliki anak aktif -> delete dan void induk harus ditolak
    const linkInfo = getTransactionLinkInfo(state, advRes.transaction.id);
    expect(linkInfo.hasActiveChildren).toBe(true);
    expect(() => deleteTransactionAction(state, advRes.transaction.id)).toThrow(/anak/i);
    expect(() => voidTransactionAction(state, advRes.transaction.id, 'Coba void induk')).toThrow(
      /pengakuan pendapatan atau pengembalian aktif/i
    );

    // Void anak pengakuan dan refund via helper atau voidTransactionAction -> memulihkan saldo dan sisa DP
    state = voidTransactionAction(state, recTx.id, 'Batalkan pengakuan');
    state = voidProjectAdvanceRefundAction(state, advMid.id, advMid.refunds[0].id, 'Batalkan refund');

    const advRestored = state.projectAdvances!.find((p) => p.id === advMid.id)!;
    expect(advRestored.recognizedAmount).toBe(0);
    expect(advRestored.refundedAmount).toBe(0);
    expect(advRestored.remainingAmount).toBe(600000);
    expect(advRestored.fundAllocations[0].amount).toBe(600000);
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.business).toBe(600000);

    // Sekarang semua anak sudah di-void -> void induk penerimaan DP diizinkan
    state = voidTransactionAction(state, advRes.transaction.id, 'DP dibatalkan seluruhnya');
    expect(state.projectAdvances!.find((p) => p.id === advMid.id)?.status).toBe('voided');
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.business).toBe(0);

    // B) Dana titipan: void pengembalian memulihkan saldo & alokasi
    const cust = receiveCustodialFundAction(state, {
      counterparty: 'Andi',
      amount: 250000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    state = returnCustodialFundAction(cust.state, {
      custodialFundId: cust.custodialFund.id,
      amount: 100000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    expect(() =>
      voidTransactionAction(state, cust.transaction.id, 'Coba void titipan dengan return aktif')
    ).toThrow(/pengembalian aktif/i);

    const retEntry = state.custodialFunds!.find((c) => c.id === cust.custodialFund.id)!.returns[0];
    state = voidCustodialReturnAction(state, cust.custodialFund.id, retEntry.id, 'Koreksi return');
    expect(state.custodialFunds!.find((c) => c.id === cust.custodialFund.id)?.remainingAmount).toBe(250000);
    expect(computeFinanceSnapshot(state, REF_DATE).accountBreakdown.cash).toBe(250000);

    // Check unused import helper sanity for voidProjectAdvanceRecognitionAction directly too
    const adv2 = receiveProjectAdvanceAction(state, {
      projectId: proj.project.id,
      amount: 100000,
      accountId: 'acc-business',
      date: REF_DATE,
    });
    const sRec2 = recognizeProjectAdvanceAction(adv2.state, {
      projectAdvanceId: adv2.projectAdvance.id,
      amount: 100000,
      date: REF_DATE,
    });
    const recId2 = sRec2.projectAdvances!.find((p) => p.id === adv2.projectAdvance.id)!.recognitions[0].id;
    const sVoidRec2 = voidProjectAdvanceRecognitionAction(sRec2, adv2.projectAdvance.id, recId2, 'Uji helper');
    expect(sVoidRec2.projectAdvances!.find((p) => p.id === adv2.projectAdvance.id)?.remainingAmount).toBe(100000);
  });
});

describe('VaraFinance Phase 2.5 — Complex Transactions (Split Bill, Reimbursement, Friend Advance, Linked Borrow-Lend)', () => {
  const REF_DATE = '2026-11-18';

  function buildFundedState(cashAmount = 1000000, bankAmount = 1000000) {
    let state = createInitialFinanceState(REF_DATE);
    if (cashAmount > 0) {
      state = addTransactionAction(state, {
        type: 'income',
        amount: cashAmount,
        categoryId: 'cat-income-other',
        accountId: 'acc-cash',
        date: REF_DATE,
        description: 'Saldo kas awal pengujian',
      }).state;
    }
    if (bankAmount > 0) {
      state = addTransactionAction(state, {
        type: 'income',
        amount: bankAmount,
        categoryId: 'cat-income-other',
        accountId: 'acc-bank',
        date: REF_DATE,
        description: 'Saldo bank awal pengujian',
      }).state;
    }
    return state;
  }

  it('44. Split Bill equal: kas berkurang total, hanya userShare masuk pengeluaran pribadi & No-Spend, piutang peserta terbentuk', () => {
    let state = buildFundedState(500000, 0);
    // Konfirmasi No-Spend Day sebelum transaksi Split Bill (kategori diskresioner)
    state = confirmNoSpendDayAction(state, REF_DATE, 'Niat tanpa jajan');
    const snapBefore = computeFinanceSnapshot(state, REF_DATE);

    // Total Rp100.000 dibagi rata bertiga (user + A + B) -> remainder Rp1 masuk userShare (Rp33.334, A=Rp33.333, B=Rp33.333)
    const { state: afterSplit, splitBill, paymentTransaction } = createSplitBillAction(state, {
      title: 'Makan Siang Tim',
      totalAmount: 100000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'Teman A' }, { name: 'Teman B' }],
      overrideReason: 'Makan bersama tim proyek yang mendesak',
    });

    expect(splitBill.userShareAmount).toBe(33334);
    expect(splitBill.participants.map((p) => p.shareAmount)).toEqual([33333, 33333]);
    expect(paymentTransaction.amount).toBe(100000);
    expect(paymentTransaction.affectsAccountBalance).toBe(true);
    expect(paymentTransaction.excludeFromExpenseStats).toBe(true);

    const personalTx = afterSplit.transactions.find((t) => t.id === splitBill.personalShareTransactionId)!;
    expect(personalTx.amount).toBe(33334);
    expect(personalTx.affectsAccountBalance).toBe(false);
    expect(personalTx.excludeFromExpenseStats).toBe(false);
    expect(personalTx.transactionNature).toBe('split_bill_personal_share');

    const snapAfter = computeFinanceSnapshot(afterSplit, REF_DATE);
    // Kas turun penuh Rp100.000
    expect(snapAfter.accountBreakdown.cash).toBe(snapBefore.accountBreakdown.cash - 100000);
    // Pengeluaran pribadi hanya bertambah Rp33.334 (bukan Rp100.000)
    expect(snapAfter.dailyBudget.spent).toBe(snapBefore.dailyBudget.spent + 33334);
    // Piutang aktif bertambah Rp66.666
    expect(snapAfter.outstandingReceivableTotal).toBe(snapBefore.outstandingReceivableTotal + 66666);
    // Karena kategori hangout (diskresioner) & userShare > 0, No-Spend Day dibatalkan
    expect(snapAfter.noSpendStats.todayStatus.status).toBe('invalidated');
  });

  it('45. Split Bill equal dengan userShareAmount eksplisit Rp0: hanya membentuk piutang & kas keluar, tanpa beban konsumsi pribadi', () => {
    let state = buildFundedState(300000, 0);
    state = confirmNoSpendDayAction(state, REF_DATE, 'Tidak belanja pribadi');
    const snapBefore = computeFinanceSnapshot(state, REF_DATE);

    const { state: nextState, splitBill } = createSplitBillAction(state, {
      title: 'Pesan Kopi Teman',
      totalAmount: 60000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      userShareAmount: 0,
      participants: [{ name: 'Budi' }, { name: 'Cici' }],
    });

    expect(splitBill.userShareAmount).toBe(0);
    expect(splitBill.personalShareTransactionId).toBeUndefined();
    expect(splitBill.participants.map((p) => p.shareAmount)).toEqual([30000, 30000]);

    const snapAfter = computeFinanceSnapshot(nextState, REF_DATE);
    expect(snapAfter.accountBreakdown.cash).toBe(snapBefore.accountBreakdown.cash - 60000);
    expect(snapAfter.dailyBudget.spent).toBe(snapBefore.dailyBudget.spent);
    expect(snapAfter.outstandingReceivableTotal).toBe(snapBefore.outstandingReceivableTotal + 60000);
    // Porsi user = 0 -> status No-Spend Day tetap confirmed
    expect(snapAfter.noSpendStats.todayStatus.status).toBe('confirmed');
  });

  it('46. Split Bill manual: pembagian custom sesuai total membentuk piutang per peserta dengan akurasi penuh', () => {
    const state = buildFundedState(500000, 0);
    const { state: nextState, splitBill } = createSplitBillAction(state, {
      title: 'Belanja Patungan',
      totalAmount: 150000,
      categoryId: 'cat-food', // essential
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'manual',
      userShareAmount: 50000,
      participants: [
        { name: 'Rina', shareAmount: 70000, dueDate: '2026-11-25' },
        { name: 'Dono', shareAmount: 30000 },
      ],
    });

    expect(splitBill.userShareAmount).toBe(50000);
    const rinaDebt = nextState.debts.find((d) => d.id === splitBill.participants[0].debtId)!;
    const donoDebt = nextState.debts.find((d) => d.id === splitBill.participants[1].debtId)!;
    expect(rinaDebt.receivableType).toBe('split_bill');
    expect(rinaDebt.remainingAmount).toBe(70000);
    expect(rinaDebt.dueDate).toBe('2026-11-25');
    expect(donoDebt.remainingAmount).toBe(30000);

    const snap = computeFinanceSnapshot(nextState, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(350000);
    expect(snap.dailyBudget.spent).toBe(50000);
  });

  it('47. Split Bill manual mismatch: jumlah porsi tidak sama dengan total ditolak', () => {
    const state = buildFundedState(500000, 0);
    expect(() =>
      createSplitBillAction(state, {
        title: 'Tagihan Salah Hitung',
        totalAmount: 100000,
        categoryId: 'cat-food',
        accountId: 'acc-cash',
        date: REF_DATE,
        splitMode: 'manual',
        userShareAmount: 30000,
        participants: [
          { name: 'A', shareAmount: 40000 },
          { name: 'B', shareAmount: 20000 }, // total hanya 90.000
        ],
      })
    ).toThrow(/sama persis/i);
  });

  it('48. Split Bill overrideReason: wajib diisi saat porsi pribadi melebihi batas aman disiplin', () => {
    const state = buildFundedState(500000, 0);
    expect(() =>
      createSplitBillAction(state, {
        title: 'Nongkrong Mahal',
        totalAmount: 200000,
        categoryId: 'cat-hangout',
        accountId: 'acc-cash',
        date: REF_DATE,
        splitMode: 'manual',
        userShareAmount: 120000,
        participants: [{ name: 'Teman', shareAmount: 80000 }],
      })
    ).toThrow(/alasan tertulis wajib diisi/i);
  });

  it('49. Split Bill collection: pelunasan parsial & penuh menambah kas dan mengurangi piutang tanpa dihitung pendapatan baru', () => {
    const state0 = buildFundedState(500000, 0);
    const { state: s1, splitBill } = createSplitBillAction(state0, {
      title: 'Makan Tim',
      totalAmount: 90000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'Andi' }, { name: 'Budi' }],
    });

    const andiDebtId = splitBill.participants[0].debtId;
    const snapBeforeCollect = computeFinanceSnapshot(s1, REF_DATE);

    // Andi bayar parsial Rp15.000 ke Bank
    const s2 = collectReceivableAction(s1, {
      debtId: andiDebtId,
      amount: 15000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    expect(s2.debts.find((d) => d.id === andiDebtId)?.remainingAmount).toBe(15000);
    expect(s2.debts.find((d) => d.id === andiDebtId)?.status).toBe('active');

    // Andi lunasi sisa Rp15.000
    const s3 = collectReceivableAction(s2, {
      debtId: andiDebtId,
      amount: 15000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    expect(s3.debts.find((d) => d.id === andiDebtId)?.remainingAmount).toBe(0);
    expect(s3.debts.find((d) => d.id === andiDebtId)?.status).toBe('paid');

    const collectTxs = s3.transactions.filter((t) => t.debtId === andiDebtId && t.transactionNature === 'receivable_collection');
    expect(collectTxs).toHaveLength(2);
    expect(collectTxs.every((t) => t.excludeFromIncomeStats === true)).toBe(true);

    const snapAfter = computeFinanceSnapshot(s3, REF_DATE);
    expect(snapAfter.accountBreakdown.bankPersonal).toBe(snapBeforeCollect.accountBreakdown.bankPersonal + 30000);
    expect(snapAfter.outstandingReceivableTotal).toBe(snapBeforeCollect.outstandingReceivableTotal - 30000);
    expect(snapAfter.recognizedIncomeThisMonth).toBe(snapBeforeCollect.recognizedIncomeThisMonth);
  });

  it('50. Split Bill void atomik: membatalkan transaksi bayar, porsi pribadi, piutang peserta & memulihkan saldo serta No-Spend', () => {
    let state = buildFundedState(500000, 0);
    state = confirmNoSpendDayAction(state, REF_DATE, 'Tanpa jajan');
    const snapInitial = computeFinanceSnapshot(state, REF_DATE);

    const { state: s1, paymentTransaction, splitBill } = createSplitBillAction(state, {
      title: 'Kopi Bersama',
      totalAmount: 80000,
      categoryId: 'cat-hangout',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'Fajar' }],
      overrideReason: 'Traktir patungan dadakan',
    });

    const sVoided = voidTransactionAction(s1, paymentTransaction.id, 'Salah input tagihan');
    const sbVoided = sVoided.splitBills!.find((x) => x.id === splitBill.id)!;
    expect(sbVoided.isVoided).toBe(true);
    expect(sVoided.transactions.find((t) => t.id === paymentTransaction.id)?.isVoided).toBe(true);
    expect(sVoided.transactions.find((t) => t.id === splitBill.personalShareTransactionId)?.isVoided).toBe(true);
    expect(sVoided.debts.find((d) => d.id === splitBill.participants[0].debtId)?.isVoided).toBe(true);

    const snapAfterVoid = computeFinanceSnapshot(sVoided, REF_DATE);
    expect(snapAfterVoid.accountBreakdown.cash).toBe(snapInitial.accountBreakdown.cash);
    expect(snapAfterVoid.outstandingReceivableTotal).toBe(snapInitial.outstandingReceivableTotal);
    expect(snapAfterVoid.dailyBudget.spent).toBe(snapInitial.dailyBudget.spent);
    expect(snapAfterVoid.noSpendStats.todayStatus.status).toBe('confirmed');
  });

  it('51. Split Bill void & delete protection: diblokir saat peserta punya pelunasan atau write-off aktif', () => {
    const state0 = buildFundedState(500000, 0);
    const { state: s1, splitBill, paymentTransaction } = createSplitBillAction(state0, {
      title: 'Dinner Klien',
      totalAmount: 100000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'Gita' }],
    });

    const gitaDebtId = splitBill.participants[0].debtId;
    const sCollected = collectReceivableAction(s1, {
      debtId: gitaDebtId,
      amount: 20000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });

    expect(() => voidSplitBillAction(sCollected, splitBill.id, 'Coba void')).toThrow(/pembayaran piutang peserta aktif/i);
    expect(() => deleteTransactionAction(sCollected, paymentTransaction.id)).toThrow();

    // Batalkan pembayaran peserta terlebih dahulu -> void Split Bill berhasil
    const dpId = sCollected.debtPayments.find((p) => p.debtId === gitaDebtId && !p.isVoided)!.id;
    const sPaymentVoided = voidDebtPaymentAction(sCollected, dpId, 'Salah terima');
    const sSplitVoided = voidSplitBillAction(sPaymentVoided, splitBill.id, 'Sekarang aman di-void');
    expect(sSplitVoided.splitBills!.find((s) => s.id === splitBill.id)?.isVoided).toBe(true);
  });

  it('52. Project Expense project_cost vs pure_advance: project_cost potong netProfit, pure_advance buat piutang tanpa potong profit/konsumsi', () => {
    let state = buildFundedState(500000, 1000000);
    const projRes = createProjectAction(state, {
      clientName: 'PT Nusantara',
      projectName: 'Redesain Portal',
      contractValue: 2000000,
      paymentScheme: 'dp_final',
      businessSharePct: 30,
    });
    state = addProjectPaymentAction(projRes.state, {
      projectId: projRes.project.id,
      paymentType: 'dp',
      amount: 1000000,
      status: 'received',
      date: REF_DATE,
      accountId: 'acc-bank',
    });

    // 1. Biaya proyek nyata Rp200.000
    state = addProjectExpenseAction(state, {
      projectId: projRes.project.id,
      expenseKind: 'project_cost',
      description: 'Beli font lisensi',
      amount: 200000,
      date: REF_DATE,
      accountId: 'acc-bank',
    });

    // 2. Talangan biaya proyek Rp300.000 (pure_advance)
    const dailyBefore = computeFinanceSnapshot(state, REF_DATE).dailyBudget.spent;
    state = addProjectExpenseAction(state, {
      projectId: projRes.project.id,
      expenseKind: 'pure_advance',
      description: 'Biaya foto studio klien',
      amount: 300000,
      date: REF_DATE,
      accountId: 'acc-cash',
    });

    const summary = computeProjectSummary(
      projRes.project,
      state.projectPayments,
      state.projectExpenses,
      state.projectAdvances
    );
    expect(summary.totalExpenses).toBe(200000);
    expect(summary.reimbursableAdvancesTotal).toBe(300000);
    expect(summary.netProfit).toBe(800000); // 1.000.000 - 200.000 (300rb pure_advance TIDAK memotong profit)

    const reimReceivable = state.debts.find(
      (d) => d.projectId === projRes.project.id && d.receivableType === 'project_reimbursement'
    )!;
    expect(reimReceivable.reimbursementKind).toBe('pure_advance');
    expect(reimReceivable.remainingAmount).toBe(300000);

    const snap = computeFinanceSnapshot(state, REF_DATE);
    expect(snap.accountBreakdown.cash).toBe(200000); // 500rb - 300rb
    expect(snap.dailyBudget.spent).toBe(dailyBefore); // Tidak masuk pengeluaran pribadi
  });

  it('53. Project Expense pass_through: buat piutang pass_through, masuk reimbursableAdvancesTotal, dan tidak memotong netProfit', () => {
    let state = buildFundedState(0, 1000000);
    const projRes = createProjectAction(state, {
      clientName: 'CV Bintang',
      projectName: 'Setup Infrastruktur',
      contractValue: 1500000,
      paymentScheme: 'full',
      businessSharePct: 40,
    });
    state = addProjectPaymentAction(projRes.state, {
      projectId: projRes.project.id,
      paymentType: 'full',
      amount: 1500000,
      status: 'received',
      date: REF_DATE,
      accountId: 'acc-bank',
    });

    state = addProjectExpenseAction(state, {
      projectId: projRes.project.id,
      expenseKind: 'pass_through',
      description: 'Sewa domain & cloud 1 tahun',
      amount: 450000,
      date: REF_DATE,
      accountId: 'acc-bank',
      creditor: 'CV Bintang',
    });

    const pe = state.projectExpenses.find((e) => e.projectId === projRes.project.id)!;
    expect(pe.expenseKind).toBe('pass_through');
    expect(pe.linkedReceivableId).toBeTruthy();

    const recDebt = state.debts.find((d) => d.id === pe.linkedReceivableId)!;
    expect(recDebt.receivableType).toBe('project_reimbursement');
    expect(recDebt.reimbursementKind).toBe('pass_through');
    expect(recDebt.projectExpenseId).toBe(pe.id);

    const summary = computeProjectSummary(
      projRes.project,
      state.projectPayments,
      state.projectExpenses,
      state.projectAdvances
    );
    expect(summary.totalExpenses).toBe(0);
    expect(summary.reimbursableAdvancesTotal).toBe(450000);
    expect(summary.netProfit).toBe(1500000);
  });

  it('54. Project Reimbursement collection: menambah kas & melunasi piutang tanpa double-count pendapatan pribadi atau proyek', () => {
    let state = buildFundedState(600000, 0);
    const projRes = createProjectAction(state, {
      clientName: 'Klien Maju',
      projectName: 'Iklan Digital',
      contractValue: 1000000,
      paymentScheme: 'full',
      businessSharePct: 50,
    });
    state = addProjectPaymentAction(projRes.state, {
      projectId: projRes.project.id,
      paymentType: 'full',
      amount: 1000000,
      status: 'received',
      date: REF_DATE,
      accountId: 'acc-bank',
    });
    state = addProjectExpenseAction(state, {
      projectId: projRes.project.id,
      expenseKind: 'pure_advance',
      description: 'Cetak banner',
      amount: 250000,
      date: REF_DATE,
      accountId: 'acc-cash',
    });

    const reimDebt = state.debts.find((d) => d.receivableType === 'project_reimbursement')!;
    const snapBefore = computeFinanceSnapshot(state, REF_DATE);

    const sCollected = collectReceivableAction(state, {
      debtId: reimDebt.id,
      amount: 250000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });

    const collectTx = sCollected.transactions.find(
      (t) => t.debtId === reimDebt.id && t.transactionNature === 'reimbursement_collection'
    )!;
    expect(collectTx).toBeDefined();
    expect(collectTx.excludeFromIncomeStats).toBe(true);

    const snapAfter = computeFinanceSnapshot(sCollected, REF_DATE);
    expect(snapAfter.accountBreakdown.bankPersonal).toBe(snapBefore.accountBreakdown.bankPersonal + 250000);
    expect(snapAfter.recognizedIncomeThisMonth).toBe(snapBefore.recognizedIncomeThisMonth);
    expect(
      computeProjectSummary(
        projRes.project,
        sCollected.projectPayments,
        sCollected.projectExpenses,
        sCollected.projectAdvances
      ).receivedAmount
    ).toBe(1000000);
  });

  it('55. Project Reimbursement: overpayment ditolak & void talangan belum tertagih memulihkan kas serta ProjectExpense secara atomik', () => {
    let state = buildFundedState(400000, 0);
    const projRes = createProjectAction(state, {
      clientName: 'Studio A',
      projectName: 'Produksi',
      contractValue: 1000000,
      paymentScheme: 'full',
      businessSharePct: 30,
    });
    state = addProjectExpenseAction(projRes.state, {
      projectId: projRes.project.id,
      expenseKind: 'pure_advance',
      description: 'Sewa mic',
      amount: 150000,
      date: REF_DATE,
      accountId: 'acc-cash',
    });

    const reimDebt = state.debts.find((d) => d.receivableType === 'project_reimbursement')!;
    expect(() =>
      collectReceivableAction(state, {
        debtId: reimDebt.id,
        amount: 200000,
        accountId: 'acc-cash',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa piutang/i);

    const sVoided = voidTransactionAction(state, reimDebt.transactionId!, 'Klien batalkan kebutuhan sewa');
    expect(sVoided.debts.find((d) => d.id === reimDebt.id)?.isVoided).toBe(true);
    expect(sVoided.projectExpenses.find((pe) => pe.id === reimDebt.projectExpenseId)?.isVoided).toBe(true);
    expect(computeFinanceSnapshot(sVoided, REF_DATE).accountBreakdown.cash).toBe(400000);
  });

  it('56. Friend Advance: mengurangi kas, membuat piutang friend_advance, excludeFromExpenseStats & menjaga No-Spend Day', () => {
    let state = buildFundedState(500000, 0);
    state = confirmNoSpendDayAction(state, REF_DATE, 'Puasa jajan');
    const snapBefore = computeFinanceSnapshot(state, REF_DATE);

    state = createFriendAdvanceAction(state, {
      friendName: 'Bagas',
      amount: 125000,
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Titip bayar paket COD Bagas',
    });

    const advDebt = state.debts.find((d) => d.receivableType === 'friend_advance')!;
    expect(advDebt.creditor).toBe('Bagas');
    expect(advDebt.remainingAmount).toBe(125000);

    const advTx = state.transactions.find((t) => t.id === advDebt.transactionId)!;
    expect(advTx.transactionNature).toBe('friend_advance');
    expect(advTx.excludeFromExpenseStats).toBe(true);

    const snapAfter = computeFinanceSnapshot(state, REF_DATE);
    expect(snapAfter.accountBreakdown.cash).toBe(snapBefore.accountBreakdown.cash - 125000);
    expect(snapAfter.dailyBudget.spent).toBe(snapBefore.dailyBudget.spent);
    expect(snapAfter.noSpendStats.todayStatus.status).toBe('confirmed');
  });

  it('57. Friend Advance multi-teman & pelunasan bertahap: setiap teman terpisah dan pengembalian tidak dihitung income', () => {
    let state = buildFundedState(500000, 0);
    state = createFriendAdvanceAction(state, {
      friendName: 'Lina',
      amount: 100000,
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Tiket konser',
    });
    state = createFriendAdvanceAction(state, {
      friendName: 'Miko',
      amount: 80000,
      accountId: 'acc-cash',
      date: REF_DATE,
      description: 'Ongkir bersama',
    });

    const linaDebt = state.debts.find((d) => d.creditor === 'Lina' && d.receivableType === 'friend_advance')!;
    const mikoDebt = state.debts.find((d) => d.creditor === 'Miko' && d.receivableType === 'friend_advance')!;
    const snapBefore = computeFinanceSnapshot(state, REF_DATE);

    state = collectReceivableAction(state, {
      debtId: linaDebt.id,
      amount: 40000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    state = collectReceivableAction(state, {
      debtId: linaDebt.id,
      amount: 60000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });

    expect(state.debts.find((d) => d.id === linaDebt.id)?.status).toBe('paid');
    expect(state.debts.find((d) => d.id === mikoDebt.id)?.remainingAmount).toBe(80000);

    const snapAfter = computeFinanceSnapshot(state, REF_DATE);
    expect(snapAfter.accountBreakdown.bankPersonal).toBe(snapBefore.accountBreakdown.bankPersonal + 100000);
    expect(snapAfter.recognizedIncomeThisMonth).toBe(snapBefore.recognizedIncomeThisMonth);
  });

  it('58. Linked Borrow A -> Lend B (direct_passthrough): kas bersih 0, Net Worth 0, utang A & piutang B saling tertaut', () => {
    const state0 = buildFundedState(200000, 0);
    const snap0 = computeFinanceSnapshot(state0, REF_DATE);

    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'Asep',
      borrowerName: 'Beni',
      amount: 300000,
      date: REF_DATE,
      mode: 'direct_passthrough',
      description: 'Pinjam Asep langsung diteruskan ke Beni',
    });

    expect(payableDebt.direction).toBe('payable');
    expect(payableDebt.linkedDebtId).toBe(receivableDebt.id);
    expect(receivableDebt.direction).toBe('receivable');
    expect(receivableDebt.linkedDebtId).toBe(payableDebt.id);

    const tx = s1.transactions.find((t) => t.id === payableDebt.transactionId)!;
    expect(tx.transactionNature).toBe('linked_borrow_lend');
    expect(tx.affectsAccountBalance).toBe(false);

    const snap1 = computeFinanceSnapshot(s1, REF_DATE);
    expect(snap1.liquidPersonalBalance).toBe(snap0.liquidPersonalBalance);
    expect(snap1.totalNetAssets).toBe(snap0.totalNetAssets);
    expect(snap1.outstandingDebtTotal).toBe(snap0.outstandingDebtTotal + 300000);
    expect(snap1.outstandingReceivableTotal).toBe(snap0.outstandingReceivableTotal + 300000);
    // Net Worth (Total Net Assets + Receivable - Debt) tetap sama
    const netWorth0 = snap0.totalNetAssets + snap0.outstandingReceivableTotal - snap0.outstandingDebtTotal;
    const netWorth1 = snap1.totalNetAssets + snap1.outstandingReceivableTotal - snap1.outstandingDebtTotal;
    expect(netWorth1).toBe(netWorth0);
  });

  it('59. Linked Borrow A -> Lend B (via_account): kas masuk dari A & keluar ke B tercatat di akun masing-masing', () => {
    const state0 = buildFundedState(100000, 50000);
    const snap0 = computeFinanceSnapshot(state0, REF_DATE);

    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'Andi',
      borrowerName: 'Bayu',
      amount: 250000,
      date: REF_DATE,
      mode: 'via_account',
      receiveAccountId: 'acc-bank',
      disburseAccountId: 'acc-bank',
    });

    expect(payableDebt.linkedDebtId).toBe(receivableDebt.id);
    expect(receivableDebt.linkedDebtId).toBe(payableDebt.id);
    expect(payableDebt.transactionId).not.toBe(receivableDebt.transactionId);

    const disburseTx = s1.transactions.find((t) => t.id === receivableDebt.transactionId)!;
    expect(disburseTx.parentTransactionId).toBe(payableDebt.transactionId);

    const snap1 = computeFinanceSnapshot(s1, REF_DATE);
    expect(snap1.accountBreakdown.bankPersonal).toBe(snap0.accountBreakdown.bankPersonal); // +250rb - 250rb
    expect(snap1.outstandingDebtTotal).toBe(snap0.outstandingDebtTotal + 250000);
    expect(snap1.outstandingReceivableTotal).toBe(snap0.outstandingReceivableTotal + 250000);
  });

  it('60. Linked Borrow A -> Lend B: menagih piutang B menambah kas & melunasi B TANPA mengurangi/melunasi utang ke A', () => {
    const state0 = buildFundedState(200000, 0);
    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'Pemberi A',
      borrowerName: 'Peminjam B',
      amount: 300000,
      date: REF_DATE,
      mode: 'direct_passthrough',
    });

    const sCollected = collectReceivableAction(s1, {
      debtId: receivableDebt.id,
      amount: 300000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });

    expect(sCollected.debts.find((d) => d.id === receivableDebt.id)?.status).toBe('paid');
    expect(sCollected.debts.find((d) => d.id === receivableDebt.id)?.remainingAmount).toBe(0);
    // Utang ke A wajib tetap aktif penuh Rp300.000
    const updatedPayable = sCollected.debts.find((d) => d.id === payableDebt.id)!;
    expect(updatedPayable.status).toBe('active');
    expect(updatedPayable.remainingAmount).toBe(300000);
    expect(computeFinanceSnapshot(sCollected, REF_DATE).accountBreakdown.cash).toBe(500000);
  });

  it('61. Linked Borrow A -> Lend B: membayar utang ke A dilakukan secara independen tanpa mengubah piutang B', () => {
    const state0 = buildFundedState(500000, 0);
    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'Asep',
      borrowerName: 'Bobi',
      amount: 300000,
      date: REF_DATE,
      mode: 'direct_passthrough',
    });

    const sRepaid = repayDebtAction(s1, {
      debtId: payableDebt.id,
      amount: 200000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });

    expect(sRepaid.debts.find((d) => d.id === payableDebt.id)?.remainingAmount).toBe(100000);
    expect(sRepaid.debts.find((d) => d.id === payableDebt.id)?.status).toBe('active');
    expect(sRepaid.debts.find((d) => d.id === receivableDebt.id)?.remainingAmount).toBe(300000);
    expect(sRepaid.debts.find((d) => d.id === receivableDebt.id)?.status).toBe('active');
    expect(computeFinanceSnapshot(sRepaid, REF_DATE).accountBreakdown.cash).toBe(300000);
  });

  it('62. Linked Borrow A -> Lend B: write-off piutang B tidak menghapus utang A; pemulihan piutang B tetap mengaktifkan B', () => {
    const state0 = buildFundedState(200000, 0);
    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'Kreditor A',
      borrowerName: 'Debitur B',
      amount: 300000,
      date: REF_DATE,
      mode: 'direct_passthrough',
    });

    const sWriteOff = writeOffReceivableAction(s1, {
      debtId: receivableDebt.id,
      date: REF_DATE,
      reason: 'B menghilang',
    });

    expect(sWriteOff.debts.find((d) => d.id === receivableDebt.id)?.status).toBe('written_off');
    expect(sWriteOff.debts.find((d) => d.id === receivableDebt.id)?.remainingAmount).toBe(0);
    // Utang ke A harus tetap aktif penuh!
    expect(sWriteOff.debts.find((d) => d.id === payableDebt.id)?.status).toBe('active');
    expect(sWriteOff.debts.find((d) => d.id === payableDebt.id)?.remainingAmount).toBe(300000);

    const sRecovered = recoverReceivableAction(sWriteOff, {
      debtId: receivableDebt.id,
      date: REF_DATE,
      reason: 'B akhirnya bisa dihubungi',
    });
    expect(sRecovered.debts.find((d) => d.id === receivableDebt.id)?.status).toBe('active');
    expect(sRecovered.debts.find((d) => d.id === receivableDebt.id)?.remainingAmount).toBe(300000);
  });

  it('63. Linked Borrow A -> Lend B: void direct_passthrough atomik saat belum ada pelunasan, ditolak bila salah satu sudah terbayar', () => {
    const state0 = buildFundedState(500000, 0);
    const { state: s1, payableDebt, receivableDebt } = createLinkedBorrowLendAction(state0, {
      lenderName: 'A',
      borrowerName: 'B',
      amount: 200000,
      date: REF_DATE,
      mode: 'direct_passthrough',
    });

    // Jika B sudah membayar sebagian -> void transaksi induk harus diblokir
    const sPaidB = collectReceivableAction(s1, {
      debtId: receivableDebt.id,
      amount: 50000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    expect(() => voidTransactionAction(sPaidB, payableDebt.transactionId!, 'Coba void')).toThrow(/pembayaran aktif/i);

    // Void pada state bersih tanpa pelunasan -> membatalkan transaksi + utang A + piutang B atomik
    const sVoided = voidTransactionAction(s1, payableDebt.transactionId!, 'Batal akad A->B');
    expect(sVoided.transactions.find((t) => t.id === payableDebt.transactionId)?.isVoided).toBe(true);
    expect(sVoided.debts.find((d) => d.id === payableDebt.id)?.isVoided).toBe(true);
    expect(sVoided.debts.find((d) => d.id === receivableDebt.id)?.isVoided).toBe(true);
  });

  it('64. Overpayment rejection & delete protection: tolak kelebihan bayar dan cegah hapus permanen entitas Phase 2.5', () => {
    let state = buildFundedState(1000000, 0);

    // 1. Overpayment utang biasa
    expect(() =>
      repayDebtAction(state, {
        debtId: 'debt-friend-initial',
        amount: 50000, // sisa hanya 27.000
        accountId: 'acc-cash',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa utang/i);

    // 2. Overpayment friend advance & blokir hapus permanen
    state = createFriendAdvanceAction(state, {
      friendName: 'Cakra',
      amount: 100000,
      accountId: 'acc-cash',
      date: REF_DATE,
    });
    const cakraDebt = state.debts.find((d) => d.creditor === 'Cakra')!;
    expect(() =>
      collectReceivableAction(state, {
        debtId: cakraDebt.id,
        amount: 150000,
        accountId: 'acc-cash',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa piutang/i);
    expect(() => deleteTransactionAction(state, cakraDebt.transactionId!)).toThrow();

    // 3. Overpayment peserta Split Bill & blokir hapus permanen
    const { state: sSplit, splitBill } = createSplitBillAction(state, {
      title: 'Beli Pizza',
      totalAmount: 100000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'Deni' }],
    });
    expect(() =>
      collectReceivableAction(sSplit, {
        debtId: splitBill.participants[0].debtId,
        amount: 60000, // jatah Deni 50.000
        accountId: 'acc-cash',
        date: REF_DATE,
      })
    ).toThrow(/melebihi sisa piutang/i);
    expect(() => deleteTransactionAction(sSplit, splitBill.paymentTransactionId)).toThrow();
    expect(() => deleteTransactionAction(sSplit, splitBill.personalShareTransactionId!)).toThrow();

    // 4. Blokir hapus permanen transaksi Linked Borrow-Lend
    const { state: sLinked, payableDebt } = createLinkedBorrowLendAction(sSplit, {
      lenderName: 'Eko',
      borrowerName: 'Feri',
      amount: 100000,
      date: REF_DATE,
    });
    expect(() => deleteTransactionAction(sLinked, payableDebt.transactionId!)).toThrow();
  });

  it('65. Calendar & Transaction Display Phase 2.5: transaksi non-kas masuk tipe non_cash & label CSV/badge akurat', () => {
    let state = buildFundedState(500000, 0);

    // 1. Direct expense debt (non-cash)
    state = addDebtAction(state, {
      direction: 'payable',
      debtReceiptType: 'direct_expense',
      expenseCategoryId: 'cat-food',
      creditor: 'Warung Bu Siti',
      description: 'Makan hutang warung',
      amount: 25000,
      date: REF_DATE,
    });

    // 2. Split Bill (payment cash + personalShare non-cash)
    const splitRes = createSplitBillAction(state, {
      title: 'Bakso Bertiga',
      totalAmount: 90000,
      categoryId: 'cat-food',
      accountId: 'acc-cash',
      date: REF_DATE,
      splitMode: 'equal',
      participants: [{ name: 'A' }, { name: 'B' }],
    });
    state = splitRes.state;

    // 3. Linked A -> B non-cash passthrough
    const linkedRes = createLinkedBorrowLendAction(state, {
      lenderName: 'A',
      borrowerName: 'B',
      amount: 100000,
      date: REF_DATE,
    });
    state = linkedRes.state;

    const eventsMap = buildCalendarEventsForMonth(state, '2026-11');
    const dayEvents = eventsMap.get(REF_DATE) ?? [];
    const nonCashEvents = dayEvents.filter((ev) => ev.type === 'non_cash');

    // Harus terdapat 3 event non_cash (direct_expense, split_bill_personal_share, linked_borrow_lend)
    expect(nonCashEvents.length).toBeGreaterThanOrEqual(3);
    expect(nonCashEvents.some((ev) => ev.title.includes('Makan hutang warung'))).toBe(true);
    expect(nonCashEvents.some((ev) => ev.title.includes('Porsi Pribadi Split Bill'))).toBe(true);
    expect(nonCashEvents.some((ev) => ev.title.includes('Teruskan Pinjaman'))).toBe(true);

    // Pastikan tidak salah diklasifikasikan sebagai income/expense kas
    const linkedTx = state.transactions.find((t) => t.id === linkedRes.payableDebt.transactionId)!;
    expect(dayEvents.find((ev) => ev.id === `tx-${linkedTx.id}`)?.type).toBe('non_cash');

    // Verifikasi display helper & CSV
    expect(getTransactionAccountDisplay(linkedTx, state.accounts)).toContain('Non-Kas');
    expect(getTransactionNatureBadge(linkedTx)).toBe('Utang A → Piutang B');
    const personalTx = state.transactions.find(
      (t) => t.id === splitRes.splitBill.personalShareTransactionId
    )!;
    expect(getTransactionAccountDisplay(personalTx, state.accounts)).toContain('Porsi Pribadi Split Bill');
    expect(getTransactionNatureBadge(personalTx)).toBe('Non-Kas · Porsi Pribadi Split Bill');

    const csv = buildFinanceCSVContent(state, computeFinanceSnapshot(state, REF_DATE));
    expect(csv).toContain('Pembayaran Total Split Bill');
    expect(csv).toContain('Porsi Pribadi Split Bill (Non-Kas)');
    expect(csv).toContain('Pinjam dari A & Teruskan ke B');
  });
});

describe('VaraFinance Phase 2.6 — Asset Management & Physical Item Lending (20 Pengujian Wajib)', () => {
  const REF_DATE = '2026-11-18';

  function buildFundedAssetState(cashAmount = 5000000, bankAmount = 15000000) {
    let state = createInitialFinanceState(REF_DATE);
    if (cashAmount > 0) {
      state = addTransactionAction(state, {
        type: 'income',
        amount: cashAmount,
        categoryId: 'cat-income-other',
        accountId: 'acc-cash',
        date: REF_DATE,
        description: 'Kas tunai awal pengujian aset',
      }).state;
    }
    if (bankAmount > 0) {
      state = addTransactionAction(state, {
        type: 'income',
        amount: bankAmount,
        categoryId: 'cat-income-other',
        accountId: 'acc-bank',
        date: REF_DATE,
        description: 'Bank awal pengujian aset',
      }).state;
    }
    return state;
  }

  it('66. Pembelian aset tunai menurunkan kas, menambah physicalAssetsTotal, dan menjaga totalPersonalWealthNet tanpa masuk beban konsumsi', () => {
    let state = buildFundedAssetState(2000000, 12000000);
    state = confirmNoSpendDayAction(state, REF_DATE, 'Tidak jajan konsumtif hari ini');
    const before = computeFinanceSnapshot(state, REF_DATE);

    const { state: afterState, asset, transaction } = purchaseAssetCashAction(state, {
      name: 'Laptop Kerja ThinkPad',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 8500000,
      condition: 'excellent',
      accountId: 'acc-bank',
      brandOrModel: 'ThinkPad X1',
    });

    expect(asset.status).toBe('active');
    expect(asset.paymentMethod).toBe('cash');
    expect(asset.purchaseTransactionId).toBe(transaction.id);
    expect(transaction.transactionNature).toBe('asset_purchase_cash');
    expect(transaction.affectsAccountBalance).toBe(true);
    expect(transaction.excludeFromExpenseStats).toBe(true);

    const after = computeFinanceSnapshot(afterState, REF_DATE);
    expect(after.accountBreakdown.bankPersonal).toBe(before.accountBreakdown.bankPersonal - 8500000);
    expect(after.liquidPersonalBalance).toBe(before.liquidPersonalBalance - 8500000);
    expect(after.physicalAssetsTotal).toBe(8500000);
    expect(after.physicalAssetsCount).toBe(1);
    // Konversi kas -> aset fisik menjaga total kekayaan bersih tetap sama
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
    // Aset fisik TIDAK boleh menggelembungkan saldo keuangan atau Safe-to-Spend
    expect(after.totalNetAssets).toBe(before.totalNetAssets - 8500000);
    expect(after.safeToSpend).toBeLessThanOrEqual(before.safeToSpend - 8500000);
    // Tidak masuk pengeluaran konsumsi dan tidak membatalkan No-Spend Day
    expect(after.monthlyPrediction.confirmedExpenseThisMonth).toBe(before.monthlyPrediction.confirmedExpenseThisMonth);
    expect(after.noSpendStats.todayStatus.status).toBe('confirmed');
  });

  it('67. Pembelian aset kredit penuh tidak mengurangi kas, membentuk utang, menambah aset, dan menjaga kekayaan bersih', () => {
    const state = buildFundedAssetState(1000000, 2000000);
    const before = computeFinanceSnapshot(state, REF_DATE);

    const { state: nextState, asset, debt, transaction } = purchaseAssetCreditAction(state, {
      name: 'Smartphone Kerja',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 6000000,
      condition: 'excellent',
      creditor: 'Erafone Cicilan',
      dueDate: '2026-12-18',
    });

    expect(asset.paymentMethod).toBe('credit');
    expect(asset.purchaseDebtId).toBe(debt?.id);
    expect(debt?.direction).toBe('payable');
    expect(debt?.remainingAmount).toBe(6000000);
    expect(debt?.assetId).toBe(asset.id);
    expect(transaction.transactionNature).toBe('asset_purchase_credit');
    expect(transaction.affectsAccountBalance).toBe(false);
    expect(transaction.excludeFromExpenseStats).toBe(true);

    const after = computeFinanceSnapshot(nextState, REF_DATE);
    expect(after.liquidPersonalBalance).toBe(before.liquidPersonalBalance);
    expect(after.physicalAssetsTotal).toBe(6000000);
    expect(after.outstandingDebtTotal).toBe(before.outstandingDebtTotal + 6000000);
    // +6.000.000 aset fisik - 6.000.000 utang = net 0 perubahan kekayaan bersih
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
  });

  it('68. Pembelian aset kredit dengan DP memotong kas sebesar DP, mencatat utang sebesar sisa, dan mengakui nilai aset penuh', () => {
    const state = buildFundedAssetState(2000000, 10000000);
    const before = computeFinanceSnapshot(state, REF_DATE);

    const { state: nextState, asset, debt, transaction } = purchaseAssetCreditAction(state, {
      name: 'Sepeda Motor Operasional',
      category: 'vehicle',
      acquisitionDate: REF_DATE,
      acquisitionValue: 18000000,
      condition: 'good',
      creditor: 'Dealer Yamaha',
      downPaymentAmount: 4000000,
      accountId: 'acc-bank',
      dueDate: '2027-01-18',
    });

    expect(asset.paymentMethod).toBe('credit_with_down_payment');
    expect(asset.downPaymentAmount).toBe(4000000);
    expect(asset.downPaymentTransactionId).toBe(transaction.id);
    expect(transaction.transactionNature).toBe('asset_purchase_down_payment');
    expect(transaction.affectsAccountBalance).toBe(true);
    expect(transaction.amount).toBe(4000000);
    expect(debt?.initialAmount).toBe(14000000);

    const after = computeFinanceSnapshot(nextState, REF_DATE);
    expect(after.accountBreakdown.bankPersonal).toBe(before.accountBreakdown.bankPersonal - 4000000);
    expect(after.physicalAssetsTotal).toBe(18000000);
    expect(after.outstandingDebtTotal).toBe(before.outstandingDebtTotal + 14000000);
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
  });

  it('69. Pelunasan utang cicilan aset via repayDebtAction mengurangi kas & utang tanpa menggandakan nilai aset', () => {
    const state0 = buildFundedAssetState(0, 10000000);
    const { state: s1, asset, debt } = purchaseAssetCreditAction(state0, {
      name: 'Kamera Mirrorless',
      category: 'equipment',
      acquisitionDate: REF_DATE,
      acquisitionValue: 9000000,
      condition: 'excellent',
      creditor: 'Toko Kamera',
      downPaymentAmount: 3000000,
      accountId: 'acc-bank',
    });

    const snapMid = computeFinanceSnapshot(s1, REF_DATE);
    const s2 = repayDebtAction(s1, {
      debtId: debt!.id,
      amount: 2000000,
      accountId: 'acc-bank',
      date: REF_DATE,
      notes: 'Angsuran pertama kamera',
    });

    const snapAfter = computeFinanceSnapshot(s2, REF_DATE);
    expect(snapAfter.accountBreakdown.bankPersonal).toBe(snapMid.accountBreakdown.bankPersonal - 2000000);
    expect(snapAfter.outstandingDebtTotal).toBe(snapMid.outstandingDebtTotal - 2000000);
    // Nilai aset fisik tetap Rp9.000.000 (tidak bertambah menjadi 11.000.000 saat cicilan dibayar)
    expect(snapAfter.physicalAssetsTotal).toBe(9000000);
    expect(s2.physicalAssets!.find((a) => a.id === asset.id)?.acquisitionValue).toBe(9000000);
    // Total wealth net tidak berubah saat bayar utang (kas -2jt, utang -2jt)
    expect(snapAfter.totalPersonalWealthNet).toBe(snapMid.totalPersonalWealthNet);
  });

  it('70. Penjualan aset tunai dengan laba mengubah status menjadi sold, memindahkan nilai aset ke kas, dan menghitung gain tanpa masuk pendapatan', () => {
    const state0 = buildFundedAssetState(0, 10000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Keyboard Mekanik Vintage',
      category: 'electronics',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 1500000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const beforeSell = computeFinanceSnapshot(s1, REF_DATE);

    const { state: sSold, asset: soldAsset, transaction } = sellAssetAction(s1, {
      assetId: asset.id,
      salePrice: 2000000,
      soldDate: REF_DATE,
      proceedsMode: 'cash',
      accountId: 'acc-bank',
      buyerName: 'Kolektor',
    });

    expect(soldAsset.status).toBe('sold');
    expect(soldAsset.disposal?.gainOrLoss).toBe(500000);
    expect(soldAsset.disposal?.acquisitionValueAtDisposal).toBe(1500000);
    expect(transaction.transactionNature).toBe('asset_sale_proceeds');
    expect(transaction.excludeFromIncomeStats).toBe(true);

    const afterSell = computeFinanceSnapshot(sSold, REF_DATE);
    expect(afterSell.physicalAssetsTotal).toBe(0);
    expect(afterSell.physicalAssetsCount).toBe(0);
    expect(afterSell.accountBreakdown.bankPersonal).toBe(beforeSell.accountBreakdown.bankPersonal + 2000000);
    expect(afterSell.recognizedIncomeThisMonth).toBe(beforeSell.recognizedIncomeThisMonth);
    expect(afterSell.assetSaleGainLossTotal).toBe(500000);
    // Kekayaan bersih bertambah sebesar laba penjualan Rp500.000
    expect(afterSell.totalPersonalWealthNet).toBe(beforeSell.totalPersonalWealthNet + 500000);
    // Histori perolehan tetap tersimpan
    expect(sSold.transactions.some((t) => t.id === asset.purchaseTransactionId && !t.isVoided)).toBe(true);
  });

  it('71. Penjualan aset sebagai piutang dengan rugi membentuk piutang asset_sale dan pelunasannya tidak dihitung pendapatan', () => {
    const state0 = buildFundedAssetState(0, 10000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Tablet Desain',
      category: 'electronics',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 5000000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const beforeSell = computeFinanceSnapshot(s1, REF_DATE);

    const { state: s2, asset: soldAsset, transaction, receivable } = sellAssetAction(s1, {
      assetId: asset.id,
      salePrice: 4000000,
      soldDate: REF_DATE,
      proceedsMode: 'receivable',
      buyerName: 'Desainer Partner',
      dueDate: '2026-12-01',
    });

    expect(soldAsset.status).toBe('sold');
    expect(soldAsset.disposal?.gainOrLoss).toBe(-1000000);
    expect(transaction.affectsAccountBalance).toBe(false);
    expect(receivable?.receivableType).toBe('asset_sale');
    expect(receivable?.remainingAmount).toBe(4000000);
    expect(receivable?.assetId).toBe(asset.id);

    const midSnap = computeFinanceSnapshot(s2, REF_DATE);
    expect(midSnap.accountBreakdown.bankPersonal).toBe(beforeSell.accountBreakdown.bankPersonal);
    expect(midSnap.physicalAssetsTotal).toBe(0);
    expect(midSnap.outstandingReceivableTotal).toBe(4000000);
    expect(midSnap.assetSaleGainLossTotal).toBe(-1000000);
    expect(midSnap.totalPersonalWealthNet).toBe(beforeSell.totalPersonalWealthNet - 1000000);

    // Terima pelunasan piutang penjualan aset
    const s3 = collectReceivableAction(s2, {
      debtId: receivable!.id,
      amount: 4000000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    const collectTx = s3.transactions.find(
      (t) => t.debtId === receivable!.id && t.transactionNature === 'receivable_collection'
    )!;
    expect(collectTx.excludeFromIncomeStats).toBe(true);

    const finalSnap = computeFinanceSnapshot(s3, REF_DATE);
    expect(finalSnap.accountBreakdown.bankPersonal).toBe(beforeSell.accountBreakdown.bankPersonal + 4000000);
    expect(finalSnap.outstandingReceivableTotal).toBe(0);
    expect(finalSnap.recognizedIncomeThisMonth).toBe(beforeSell.recognizedIncomeThisMonth);
    expect(finalSnap.totalPersonalWealthNet).toBe(midSnap.totalPersonalWealthNet);
  });

  it('72. Aset berstatus sedang dipinjamkan (lent) tidak boleh dijual sebelum dikembalikan', () => {
    const state0 = buildFundedAssetState(0, 10000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Proyektor Mini',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 3000000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: s2 } = lendPhysicalAssetAction(s1, {
      assetId: asset.id,
      borrowerName: 'Komunitas Kampus',
      loanDate: REF_DATE,
      expectedReturnDate: '2026-11-25',
    });

    expect(() =>
      sellAssetAction(s2, {
        assetId: asset.id,
        salePrice: 2500000,
        soldDate: REF_DATE,
        proceedsMode: 'cash',
        accountId: 'acc-bank',
      })
    ).toThrow(/sedang dipinjamkan/i);
  });

  it('73. Pencatatan kehilangan aset tanpa ganti rugi mengeluarkan aset dari kekayaan tanpa merusak kas', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Powerbank Anker',
      category: 'electronics',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 800000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const beforeLoss = computeFinanceSnapshot(s1, REF_DATE);

    const { state: sLost, asset: lostAsset, lossRecord, compensationDebt } = reportAssetLostAction(s1, {
      assetId: asset.id,
      lostDate: REF_DATE,
      reason: 'Tertinggal di stasiun kereta',
      requireCompensation: false,
    });

    expect(lostAsset.status).toBe('lost');
    expect(lossRecord.lossAmount).toBe(800000);
    expect(compensationDebt).toBeUndefined();

    const afterLoss = computeFinanceSnapshot(sLost, REF_DATE);
    expect(afterLoss.physicalAssetsTotal).toBe(0);
    expect(afterLoss.assetCurrentLostValueTotal).toBe(800000);
    expect(afterLoss.assetHistoricalLossTotal).toBe(800000);
    expect(afterLoss.accountBreakdown.bankPersonal).toBe(beforeLoss.accountBreakdown.bankPersonal);
    expect(afterLoss.totalPersonalWealthNet).toBe(beforeLoss.totalPersonalWealthNet - 800000);
    expect(afterLoss.monthlyPrediction.confirmedExpenseThisMonth).toBe(beforeLoss.monthlyPrediction.confirmedExpenseThisMonth);
  });

  it('74. Kehilangan aset yang sedang dipinjamkan dengan piutang ganti rugi menandai pinjaman lost dan mengecualikan pelunasan dari income stats', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Tripod Karbon',
      category: 'equipment',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 1200000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: s2, loan } = lendPhysicalAssetAction(s1, {
      assetId: asset.id,
      borrowerName: 'Riko',
      loanDate: '2026-11-10',
      expectedReturnDate: '2026-11-15',
    });

    const { state: s3, asset: lostAsset, compensationDebt } = reportAssetLostAction(s2, {
      assetId: asset.id,
      lostDate: REF_DATE,
      reason: 'Hilang saat pemotretan luar kota oleh peminjam',
      requireCompensation: true,
      compensationAmount: 1000000,
    });

    expect(lostAsset.status).toBe('lost');
    expect(s3.physicalItemLoans!.find((l) => l.id === loan.id)?.status).toBe('lost');
    expect(compensationDebt?.receivableType).toBe('asset_loss_compensation');
    expect(compensationDebt?.creditor).toBe('Riko');
    expect(compensationDebt?.physicalLoanId).toBe(loan.id);

    const snapBeforeCollect = computeFinanceSnapshot(s3, REF_DATE);
    expect(snapBeforeCollect.outstandingReceivableTotal).toBe(1000000);
    expect(snapBeforeCollect.physicalAssetsTotal).toBe(0);

    const sCollected = collectReceivableAction(s3, {
      debtId: compensationDebt!.id,
      amount: 1000000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    const compTx = sCollected.transactions.find((t) => t.debtId === compensationDebt!.id)!;
    expect(compTx.excludeFromIncomeStats).toBe(true);
    expect(computeFinanceSnapshot(sCollected, REF_DATE).recognizedIncomeThisMonth).toBe(
      snapBeforeCollect.recognizedIncomeThisMonth
    );
  });

  it('75. Pemulihan aset hilang mengaktifkan kembali nilai aset tanpa double counting sambil mempertahankan histori kehilangan', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Headphone Studio',
      category: 'electronics',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 1800000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: sLost } = reportAssetLostAction(s1, {
      assetId: asset.id,
      lostDate: '2026-11-12',
      reason: 'Tidak ditemukan di kantor',
    });

    const { state: sRecovered, asset: recAsset, recoveryRecord } = recoverLostAssetAction(sLost, {
      assetId: asset.id,
      recoveredDate: REF_DATE,
      condition: 'fair',
      notes: 'Ditemukan di ruang arsip lantai 2',
    });

    expect(recAsset.status).toBe('active');
    expect(recAsset.condition).toBe('fair');
    expect(recAsset.lossHistory).toHaveLength(1);
    expect(recAsset.recoveryHistory).toHaveLength(1);
    expect(recoveryRecord.lossRecordId).toBe(recAsset.lossHistory[0].id);

    const snap = computeFinanceSnapshot(sRecovered, REF_DATE);
    expect(snap.physicalAssetsTotal).toBe(1800000);
    expect(snap.physicalAssetsCount).toBe(1);
    expect(snap.assetCurrentLostValueTotal).toBe(0);
    expect(snap.assetHistoricalLossTotal).toBe(1800000);
  });

  it('76. Pemulihan aset dengan cancelUnpaidCompensation membatalkan piutang ganti rugi belum terbayar, tetapi menolak pembatalan bila sudah ada pembayaran', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Monitor Portable',
      category: 'electronics',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 2200000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: sLost, compensationDebt } = reportAssetLostAction(s1, {
      assetId: asset.id,
      lostDate: '2026-11-12',
      reason: 'Tertukar saat acara',
      requireCompensation: true,
      liableParty: 'Panitia Acara',
      compensationAmount: 2000000,
    });

    // Kasus A: Belum ada pembayaran -> boleh langsung cancelUnpaidCompensation
    const { state: sRecCancel, asset: recAsset } = recoverLostAssetAction(sLost, {
      assetId: asset.id,
      recoveredDate: REF_DATE,
      condition: 'good',
      cancelUnpaidCompensation: true,
    });
    expect(sRecCancel.debts.find((d) => d.id === compensationDebt!.id)?.isVoided).toBe(true);
    expect(recAsset.lossHistory[0].compensationCancelled).toBe(true);
    expect(computeFinanceSnapshot(sRecCancel, REF_DATE).outstandingReceivableTotal).toBe(0);

    // Kasus B: Sudah ada pelunasan parsial -> pembatalan piutang wajib ditolak
    const sPartialPaid = collectReceivableAction(sLost, {
      debtId: compensationDebt!.id,
      amount: 500000,
      accountId: 'acc-bank',
      date: REF_DATE,
    });
    expect(() =>
      recoverLostAssetAction(sPartialPaid, {
        assetId: asset.id,
        recoveredDate: REF_DATE,
        condition: 'good',
        cancelUnpaidCompensation: true,
      })
    ).toThrow(/penerimaan pembayaran aktif/i);

    expect(() =>
      cancelAssetCompensationAction(sPartialPaid, { assetId: asset.id })
    ).toThrow(/penerimaan pembayaran/i);
  });

  it('77. Meminjam barang milik orang lain (borrowed) TIDAK boleh masuk physicalAssets maupun mengubah kas, utang, atau Safe-to-Spend', () => {
    const state0 = buildFundedAssetState(1000000, 2000000);
    const before = computeFinanceSnapshot(state0, REF_DATE);

    const { state: s1, loan } = borrowPhysicalItemAction(state0, {
      itemName: 'Kamera Sony A7IV (Pinjam)',
      category: 'electronics',
      ownerName: 'Dika',
      loanDate: REF_DATE,
      expectedReturnDate: '2026-11-25',
      conditionReceived: 'good',
      notes: 'Dipinjam untuk liputan 1 minggu',
    });

    expect(loan.direction).toBe('borrowed');
    expect(loan.assetId).toBeUndefined();
    expect(s1.physicalAssets ?? []).toHaveLength(0);

    const after = computeFinanceSnapshot(s1, REF_DATE);
    expect(after.physicalAssetsTotal).toBe(0);
    expect(after.physicalAssetsCount).toBe(0);
    expect(after.borrowedItemsActiveCount).toBe(1);
    expect(after.lentLoansActiveCount).toBe(0);
    expect(after.liquidPersonalBalance).toBe(before.liquidPersonalBalance);
    expect(after.safeToSpend).toBe(before.safeToSpend);
    expect(after.outstandingDebtTotal).toBe(before.outstandingDebtTotal);
    expect(after.outstandingReceivableTotal).toBe(before.outstandingReceivableTotal);
    expect(after.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
  });

  it('78. Meminjamkan aset milik pengguna ke orang lain (lent) mempertahankan status kepemilikan dan nilai aset di physicalAssetsTotal', () => {
    const state0 = buildFundedAssetState(0, 8000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Mic Wireless DJI',
      category: 'equipment',
      acquisitionDate: '2026-11-05',
      acquisitionValue: 3500000,
      condition: 'excellent',
      accountId: 'acc-bank',
    });
    const beforeLend = computeFinanceSnapshot(s1, REF_DATE);

    const { state: s2, loan, asset: lentAsset } = lendPhysicalAssetAction(s1, {
      assetId: asset.id,
      borrowerName: 'Nadia',
      loanDate: REF_DATE,
      expectedReturnDate: '2026-11-22',
    });

    expect(lentAsset.status).toBe('lent');
    expect(loan.direction).toBe('lent');
    expect(loan.assetId).toBe(asset.id);

    const afterLend = computeFinanceSnapshot(s2, REF_DATE);
    expect(afterLend.physicalAssetsTotal).toBe(3500000);
    expect(afterLend.physicalAssetsCount).toBe(1);
    expect(afterLend.lentAssetsActiveCount).toBe(1);
    expect(afterLend.lentLoansActiveCount).toBe(1);
    expect(afterLend.liquidPersonalBalance).toBe(beforeLend.liquidPersonalBalance);
    expect(afterLend.safeToSpend).toBe(beforeLend.safeToSpend);
    expect(afterLend.totalPersonalWealthNet).toBe(beforeLend.totalPersonalWealthNet);
  });

  it('79. Pengembalian barang pinjaman (lent & borrowed) memulihkan status aset, memperbarui conditionHistory, dan memvalidasi tanggal', () => {
    const state0 = buildFundedAssetState(0, 6000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Lensa 35mm',
      category: 'equipment',
      acquisitionDate: '2026-11-01',
      acquisitionValue: 4000000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: s2, loan: lentLoan } = lendPhysicalAssetAction(s1, {
      assetId: asset.id,
      borrowerName: 'Bagas',
      loanDate: '2026-11-10',
      expectedReturnDate: '2026-11-15',
    });
    const { state: s3, loan: borrowedLoan } = borrowPhysicalItemAction(s2, {
      itemName: 'Stabilizer Gimbal',
      category: 'equipment',
      ownerName: 'Fauzan',
      loanDate: '2026-11-11',
      expectedReturnDate: '2026-11-16',
      conditionReceived: 'good',
    });

    // Tolak tanggal kembali lebih awal dari tanggal pinjam
    expect(() =>
      returnPhysicalItemAction(s3, {
        loanId: lentLoan.id,
        returnedDate: '2026-11-09',
        conditionReturned: 'good',
      })
    ).toThrow(/lebih awal/i);

    const s4 = returnPhysicalItemAction(s3, {
      loanId: lentLoan.id,
      returnedDate: REF_DATE,
      conditionReturned: 'fair',
      notes: 'Sedikit goresan halus pada bodi',
    });
    const restoredAsset = s4.physicalAssets!.find((a) => a.id === asset.id)!;
    expect(restoredAsset.status).toBe('active');
    expect(restoredAsset.condition).toBe('fair');
    expect(restoredAsset.conditionHistory[0].note).toContain('Bagas');
    expect(s4.physicalItemLoans!.find((l) => l.id === lentLoan.id)?.status).toBe('returned');

    const s5 = returnPhysicalItemAction(s4, {
      loanId: borrowedLoan.id,
      returnedDate: REF_DATE,
      conditionReturned: 'good',
    });
    expect(s5.physicalItemLoans!.find((l) => l.id === borrowedLoan.id)?.status).toBe('returned');
    const snap = computeFinanceSnapshot(s5, REF_DATE);
    expect(snap.lentLoansActiveCount).toBe(0);
    expect(snap.borrowedItemsActiveCount).toBe(0);
    expect(snap.physicalAssetsTotal).toBe(4000000);
  });

  it('80. Isolasi kekayaan bersih vs saldo keuangan likuid & Safe-to-Spend setelah memiliki aset fisik besar', () => {
    const state0 = buildFundedAssetState(100000, 10000000);
    const before = computeFinanceSnapshot(state0, REF_DATE);

    const { state: s1 } = purchaseAssetCashAction(state0, {
      name: 'Workstation PC',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 9900000,
      condition: 'excellent',
      accountId: 'acc-bank',
    });

    const snap = computeFinanceSnapshot(s1, REF_DATE);
    // Saldo likuid tersisa Rp200.000 meskipun punya aset PC Rp9.900.000
    expect(snap.liquidPersonalBalance).toBe(200000);
    expect(snap.totalNetAssets).toBe(200000);
    expect(snap.physicalAssetsTotal).toBe(9900000);
    expect(snap.totalPersonalWealthNet).toBe(before.totalPersonalWealthNet);
    // Safe-to-Spend TIDAK pernah boleh meminjam nilai aset fisik
    expect(snap.safeToSpend).toBeLessThanOrEqual(200000);
  });

  it('81. Deteksi keterlambatan peminjaman barang (isPhysicalLoanOverdue), pengingat aktif (rem-loan-*), dan rekomendasi overdue', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, loan } = borrowPhysicalItemAction(state0, {
      itemName: 'Obeng Presisi Set',
      category: 'equipment',
      ownerName: 'Hendra',
      loanDate: '2026-11-05',
      expectedReturnDate: '2026-11-12', // sudah lewat relatif thd 2026-11-18
      conditionReceived: 'good',
    });

    const storedLoan = s1.physicalItemLoans!.find((l) => l.id === loan.id)!;
    expect(isPhysicalLoanOverdue(storedLoan, REF_DATE)).toBe(true);
    expect(isPhysicalLoanOverdue(storedLoan, '2026-11-12')).toBe(false);

    const snap = computeFinanceSnapshot(s1, REF_DATE);
    expect(snap.overdueItemLoansCount).toBe(1);
    expect(
      snap.upcomingReminders.some(
        (r) =>
          r.id === `rem-loan-${loan.id}` &&
          r.kind === 'asset_loan' &&
          r.daysRemaining < 0 &&
          r.severity === 'critical'
      )
    ).toBe(true);
    expect(snap.recommendations.some((rec) => rec.id === 'rec-overdue-item-loans')).toBe(true);
  });

  it('82. Kalender bulanan menampilkan deadline pengembalian barang (asset_loan_due) pada tanggal target yang sesuai', () => {
    const state0 = buildFundedAssetState(0, 5000000);
    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Drone Lipat',
      category: 'electronics',
      acquisitionDate: '2026-11-02',
      acquisitionValue: 4500000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: s2, loan } = lendPhysicalAssetAction(s1, {
      assetId: asset.id,
      borrowerName: 'Sari',
      loanDate: '2026-11-10',
      expectedReturnDate: '2026-11-25',
    });

    const eventsMap = buildCalendarEventsForMonth(s2, '2026-11');
    const nov25 = eventsMap.get('2026-11-25') ?? [];
    expect(
      nov25.some(
        (ev) =>
          ev.type === 'asset_loan_due' &&
          ev.id === `loan-${loan.id}` &&
          ev.title.includes('Drone Lipat') &&
          Boolean(ev.detail?.includes('Sari'))
      )
    ).toBe(true);
  });

  it('83. Helper tampilan transaksi dan ekspor CSV Phase 2.6 menampilkan badge aset dan baris kekayaan bersih dengan akurat', () => {
    const state0 = buildFundedAssetState(0, 10000000);
    const { state: s1, transaction: cashTx } = purchaseAssetCashAction(state0, {
      name: 'Kursi Ergonomis',
      category: 'furniture',
      acquisitionDate: REF_DATE,
      acquisitionValue: 2500000,
      condition: 'excellent',
      accountId: 'acc-bank',
    });
    const { state: s2, asset: creditAsset, transaction: creditTx } = purchaseAssetCreditAction(s1, {
      name: 'Meja Kerja Kayu',
      category: 'furniture',
      acquisitionDate: REF_DATE,
      acquisitionValue: 1800000,
      condition: 'excellent',
      creditor: 'Pengrajin Lokal',
    });
    const { state: s3, transaction: saleTx } = sellAssetAction(s2, {
      assetId: creditAsset.id,
      salePrice: 2000000,
      soldDate: REF_DATE,
      proceedsMode: 'cash',
      accountId: 'acc-bank',
      buyerName: 'Studio Partner',
    });

    expect(getTransactionNatureBadge(cashTx)).toBe('Pembelian Aset Fisik · Bukan Konsumsi');
    expect(getTransactionNatureBadge(creditTx)).toBe('Non-Kas · Pembelian Aset Kredit');
    expect(getTransactionAccountDisplay(creditTx, s3.accounts)).toContain('Pembelian Aset Kredit');
    expect(getTransactionNatureBadge(saleTx)).toBe('Pelepasan/Penjualan Aset · Bukan Penghasilan Operasional');

    const snap = computeFinanceSnapshot(s3, REF_DATE);
    const csv = buildFinanceCSVContent(s3, snap);
    expect(csv).toContain('Pembelian Aset Fisik (Tunai)');
    expect(csv).toContain('Pembelian Aset Fisik (Kredit Penuh Non-Kas)');
    expect(csv).toContain('Penjualan / Pelepasan Aset Fisik');
    expect(csv).toContain('Total Nilai Aset Fisik Dimiliki');
    expect(csv).toContain('Kekayaan Bersih Pribadi');
  });

  it('84. Proteksi integritas Void & Delete transaksi pembelian/penjualan aset bekerja atomik dan menolak saat punya turunan aktif', () => {
    const state0 = buildFundedAssetState(0, 15000000);

    // 1. Pembelian tunai bersih -> delete permanen ditolak, void atomik mengembalikan saldo & voided aset
    const { state: s1, asset: cashAsset, transaction: cashTx } = purchaseAssetCashAction(state0, {
      name: 'Speaker Monitor',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 2000000,
      condition: 'excellent',
      accountId: 'acc-bank',
    });
    expect(getTransactionLinkInfo(s1, cashTx.id).isLinked).toBe(true);
    expect(() => deleteTransactionAction(s1, cashTx.id)).toThrow();

    const sVoidCash = voidTransactionAction(s1, cashTx.id, 'Batal beli speaker');
    expect(sVoidCash.physicalAssets!.find((a) => a.id === cashAsset.id)?.isVoided).toBe(true);
    expect(sVoidCash.physicalAssets!.find((a) => a.id === cashAsset.id)?.status).toBe('voided');
    expect(computeFinanceSnapshot(sVoidCash, REF_DATE).physicalAssetsTotal).toBe(0);
    expect(computeFinanceSnapshot(sVoidCash, REF_DATE).accountBreakdown.bankPersonal).toBe(15000000);

    // 2. Pembelian aset yang sudah punya riwayat kehilangan/pinjaman/penjualan tidak boleh langsung di-void
    const { state: sSold, transaction: saleTx } = sellAssetAction(s1, {
      assetId: cashAsset.id,
      salePrice: 2200000,
      soldDate: REF_DATE,
      proceedsMode: 'cash',
      accountId: 'acc-bank',
    });
    expect(() => voidTransactionAction(sSold, cashTx.id, 'Coba void beli padahal sudah dijual')).toThrow(
      /pelepasan|hilang|peminjaman/i
    );

    // Void transaksi penjualan mengembalikan status aset menjadi active & menghapus laba jual
    const sVoidSale = voidTransactionAction(sSold, saleTx.id, 'Pembeli membatalkan transaksi');
    const restoredAfterSaleVoid = sVoidSale.physicalAssets!.find((a) => a.id === cashAsset.id)!;
    expect(restoredAfterSaleVoid.status).toBe('active');
    expect(restoredAfterSaleVoid.disposal).toBeUndefined();
    expect(computeFinanceSnapshot(sVoidSale, REF_DATE).physicalAssetsTotal).toBe(2000000);
    expect(computeFinanceSnapshot(sVoidSale, REF_DATE).accountBreakdown.bankPersonal).toBe(13000000);
  });

  it('85. Repository hydrateFinanceState & mergeFinanceStatesById menjaga backward compatibility dan menggabungkan physicalAssets serta physicalItemLoans', () => {
    const legacyState = buildFundedAssetState(500000, 1000000);
    delete legacyState.physicalAssets;
    delete legacyState.physicalItemLoans;

    const hydrated = hydrateFinanceState(legacyState);
    expect(hydrated.physicalAssets).toEqual([]);
    expect(hydrated.physicalItemLoans).toEqual([]);

    const { state: stateA, asset: assetA } = purchaseAssetCashAction(hydrated, {
      name: 'Kamera A',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 600000,
      condition: 'good',
      accountId: 'acc-bank',
    });
    const { state: stateB, loan: loanB } = borrowPhysicalItemAction(hydrated, {
      itemName: 'Buku Referensi',
      category: 'other',
      ownerName: 'Perpustakaan Pribadi Riko',
      loanDate: REF_DATE,
      conditionReceived: 'good',
    });

    const merged = mergeFinanceStatesById(stateA, stateB);
    expect(merged.physicalAssets?.some((a) => a.id === assetA.id)).toBe(true);
    expect(merged.physicalItemLoans?.some((l) => l.id === loanB.id)).toBe(true);
  });

  it('86. Validasi batas input Phase 2.6: tolak nilai <= 0, DP >= nilai aset, duplikat pinjam aset, dan catat log kondisi', () => {
    const state0 = buildFundedAssetState(1000000, 5000000);

    expect(() =>
      purchaseAssetCashAction(state0, {
        name: 'Aset Nol',
        category: 'other',
        acquisitionDate: REF_DATE,
        acquisitionValue: 0,
        condition: 'excellent',
        accountId: 'acc-bank',
      })
    ).toThrow(/lebih dari Rp0/i);

    expect(() =>
      purchaseAssetAction(state0, {
        name: 'Aset DP Invalid',
        category: 'electronics',
        acquisitionDate: REF_DATE,
        acquisitionValue: 1000000,
        condition: 'excellent',
        paymentMethod: 'credit_with_down_payment',
        creditor: 'Toko',
        downPaymentAmount: 1000000, // >= nilai total
        accountId: 'acc-bank',
      })
    ).toThrow(/lebih kecil dari nilai total/i);

    const { state: s1, asset } = purchaseAssetCashAction(state0, {
      name: 'Tablet Gambar',
      category: 'electronics',
      acquisitionDate: REF_DATE,
      acquisitionValue: 1200000,
      condition: 'excellent',
      accountId: 'acc-bank',
    });

    const sCond = updateAssetConditionAction(s1, {
      assetId: asset.id,
      condition: 'good',
      date: REF_DATE,
      note: 'Sudah dipakai 2 minggu dengan kondisi baik',
    });
    expect(sCond.physicalAssets![0].condition).toBe('good');
    expect(sCond.physicalAssets![0].conditionHistory).toHaveLength(2);

    const { state: sLent } = lendPhysicalAssetAction(sCond, {
      assetId: asset.id,
      borrowerName: 'Tono',
      loanDate: REF_DATE,
    });
    expect(() =>
      lendPhysicalAssetAction(sLent, {
        assetId: asset.id,
        borrowerName: 'Orang Lain',
        loanDate: REF_DATE,
      })
    ).toThrow(/sudah berstatus dipinjamkan/i);
  });
});





