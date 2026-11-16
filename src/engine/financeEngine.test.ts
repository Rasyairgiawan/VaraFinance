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
  hashPinSHA256,
  payObligationAction,
  reallocateCompletedObligationAction,
  reconcileAccountAction,
  repayDebtAction,
  reserveObligationAction,
  syncExpiredObligationsAction,
  updateDebtAction,
  updateSettingsAction,
  voidTransactionAction,
} from '../hooks/financeActions';
import {
  createBackupPayload,
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
