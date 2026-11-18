import type { FinanceSnapshot } from '../engine/financeEngine';
import type { Account, FinanceState, Transaction } from '../types/finance';

export function getTransactionAccountDisplay(tx: Transaction, accounts: Account[]): string {
  if (tx.affectsAccountBalance === false) {
    return 'Non-Kas (Utang)';
  }
  return accounts.find((a) => a.id === tx.accountId)?.name ?? 'Akun';
}

export function getTransactionNatureBadge(tx: Transaction): string | null {
  if (tx.affectsAccountBalance === false || tx.transactionNature === 'debt_direct_expense') {
    return 'Non-Kas · Utang';
  }
  switch (tx.transactionNature) {
    case 'loan_disbursement':
      return 'Pinjaman Diberikan · Bukan Pengeluaran';
    case 'debt_receipt':
      return 'Dana Pinjaman Diterima';
    case 'receivable_collection':
      return 'Pelunasan Piutang';
    case 'debt_repayment':
      return 'Pelunasan Utang';
    case 'reconciliation':
      return 'Rekonsiliasi Saldo';
    default:
      if (tx.tags?.includes('rekonsiliasi')) {
        return 'Rekonsiliasi Saldo';
      }
      return null;
  }
}

export function getTransactionNatureLabel(tx: Transaction): string {
  if (tx.affectsAccountBalance === false || tx.transactionNature === 'debt_direct_expense') {
    return 'Utang Non-Kas (Dibayar Pihak Lain)';
  }
  switch (tx.transactionNature) {
    case 'loan_disbursement':
      return 'Pinjaman Diberikan';
    case 'debt_receipt':
      return 'Dana Pinjaman Diterima';
    case 'receivable_collection':
      return 'Pelunasan Piutang';
    case 'debt_repayment':
      return 'Pelunasan Utang';
    case 'reconciliation':
      return 'Rekonsiliasi Saldo';
    default:
      if (tx.tags?.includes('rekonsiliasi')) {
        return 'Rekonsiliasi Saldo';
      }
      return tx.type === 'income' ? 'Pemasukan Standar' : 'Pengeluaran Standar';
  }
}

export function getTransactionCashFlowKind(tx: Transaction): string {
  if (tx.affectsAccountBalance === false) {
    return 'Non-Kas';
  }
  if (tx.transactionNature === 'reconciliation' || tx.tags?.includes('rekonsiliasi')) {
    return 'Penyesuaian Saldo';
  }
  if (
    tx.transactionNature === 'debt_receipt' ||
    tx.transactionNature === 'loan_disbursement' ||
    tx.transactionNature === 'debt_repayment' ||
    (tx.transactionNature === 'receivable_collection' && tx.excludeFromIncomeStats)
  ) {
    return 'Arus Kas Pembiayaan / Utang-Piutang';
  }
  return tx.type === 'income' ? 'Kas Masuk' : 'Kas Keluar';
}

export function getTransactionTypeLabel(tx: Transaction): string {
  if (tx.affectsAccountBalance === false || tx.transactionNature === 'debt_direct_expense') {
    return 'Pengeluaran Non-Kas (Utang)';
  }
  if (tx.transactionNature === 'reconciliation' || tx.tags?.includes('rekonsiliasi')) {
    return 'Rekonsiliasi Saldo';
  }
  return tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
}

export function getTransactionBalanceImpactLabel(tx: Transaction): string {
  if (tx.isVoided) return 'Tidak berdampak (Void)';
  if (tx.affectsAccountBalance === false) return 'Tidak mengubah saldo akun (Non-Kas)';
  return tx.type === 'income' ? 'Menambah saldo akun' : 'Mengurangi saldo akun';
}

export function getTransactionIncomeImpactLabel(tx: Transaction): string {
  if (tx.isVoided) return 'Tidak berdampak (Void)';
  if (tx.type === 'income' && !tx.excludeFromIncomeStats) return 'Menambah pendapatan';
  return 'Tidak dihitung pendapatan';
}

export function getTransactionExpenseImpactLabel(tx: Transaction): string {
  if (tx.isVoided) return 'Tidak berdampak (Void)';
  if (
    tx.type === 'expense' &&
    !tx.excludeFromExpenseStats &&
    tx.categoryId !== 'cat-biz-ops' &&
    tx.categoryId !== 'cat-debt'
  ) {
    return 'Menambah pengeluaran';
  }
  return 'Tidak dihitung pengeluaran';
}

export function escapeCSV(val: string | number): string {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : '';
  }
  let s = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildFinanceCSVRows(state: FinanceState, snapshot: FinanceSnapshot): string[] {
  const rows: string[] = [
    'RINGKASAN LAPORAN KEUANGAN KENDALIUANG',
    `Tanggal Laporan,${escapeCSV(snapshot.nowISO)}`,
    `Saldo Likuid Pribadi,${escapeCSV(snapshot.liquidPersonalBalance)}`,
    `Kas Bisnis Freelance,${escapeCSV(snapshot.businessBalance)}`,
    `Dana Dialokasikan,${escapeCSV(snapshot.allocatedTotal)}`,
    `Dana Aman Dibelanjakan,${escapeCSV(snapshot.safeToSpend)}`,
    `Kekurangan Pendanaan,${escapeCSV(snapshot.fundingShortfall)}`,
    `Utang Aktif,${escapeCSV(snapshot.outstandingDebtTotal)}`,
    `Piutang Aktif,${escapeCSV(snapshot.outstandingReceivableTotal)}`,
    '',
    [
      'Tanggal',
      'Tipe',
      'Sifat Transaksi',
      'Jenis Arus Kas',
      'Deskripsi',
      'Kategori',
      'Akun',
      'Nominal',
      'Dampak terhadap saldo',
      'Dampak terhadap pendapatan',
      'Dampak terhadap pengeluaran',
      'Status',
      'Alasan Override',
    ].join(','),
  ];

  for (const tx of state.transactions) {
    const cat = state.categories.find((c) => c.id === tx.categoryId)?.name ?? '';
    const accLabel = getTransactionAccountDisplay(tx, state.accounts);
    rows.push(
      [
        escapeCSV(tx.date),
        escapeCSV(getTransactionTypeLabel(tx)),
        escapeCSV(getTransactionNatureLabel(tx)),
        escapeCSV(getTransactionCashFlowKind(tx)),
        escapeCSV(tx.description),
        escapeCSV(cat),
        escapeCSV(accLabel),
        escapeCSV(tx.amount),
        escapeCSV(getTransactionBalanceImpactLabel(tx)),
        escapeCSV(getTransactionIncomeImpactLabel(tx)),
        escapeCSV(getTransactionExpenseImpactLabel(tx)),
        escapeCSV(tx.isVoided ? 'Void' : 'Aktif'),
        escapeCSV(tx.overrideReason ?? ''),
      ].join(',')
    );
  }

  return rows;
}

export function buildFinanceCSVContent(state: FinanceState, snapshot: FinanceSnapshot): string {
  return buildFinanceCSVRows(state, snapshot).join('\n');
}
