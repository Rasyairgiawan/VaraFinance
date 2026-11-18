import { describe, expect, it } from 'vitest';
import { createInitialFinanceState } from '../data/initialProfile';
import { buildCalendarEventsForMonth } from './calendarEvents';
import {
  computeFinanceSnapshot,
  evaluateDisciplineForExpense,
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
  closeAccountAction,
  collectReceivableAction,
  confirmNoSpendDayAction,
  createProjectAction,
  deleteAccountAction,
  deleteTransactionAction,
  findDefaultActiveDebt,
  getTransactionLinkInfo,
  hashPinSHA256,
  markProjectPaymentReceivedAction,
  payObligationAction,
  reallocateCompletedObligationAction,
  reconcileAccountAction,
  repayDebtAction,
  reserveObligationAction,
  syncExpiredObligationsAction,
  updateDebtAction,
  updateSettingsAction,
  updateTransactionAction,
  voidDebtPaymentAction,
  voidTransactionAction,
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


