import type { FinanceSnapshot } from '../engine/financeEngine';
import type { Account, Category, FinanceState, Transaction } from '../types/finance';
import { matchesCategorySystemKey } from './systemEntityResolver';

export function getTransactionAccountDisplay(tx: Transaction, accounts: Account[]): string {
  if (tx.affectsAccountBalance === false) {
    if (tx.transactionNature === 'project_advance_recognition') {
      return 'Non-Kas (Pengakuan DP Proyek)';
    }
    if (tx.transactionNature === 'receivable_write_off') {
      return 'Non-Kas (Hapus Buku Piutang)';
    }
    if (tx.transactionNature === 'split_bill_personal_share') {
      return 'Non-Kas (Porsi Pribadi Split Bill)';
    }
    if (tx.transactionNature === 'linked_borrow_lend') {
      return 'Non-Kas (Teruskan Pinjaman A→B)';
    }
    if (tx.transactionNature === 'asset_purchase_credit') {
      return 'Non-Kas (Pembelian Aset Kredit)';
    }
    if (tx.transactionNature === 'asset_sale_proceeds') {
      return 'Non-Kas (Piutang Penjualan Aset)';
    }
    return 'Non-Kas (Utang)';
  }
  return accounts.find((a) => a.id === tx.accountId)?.name ?? 'Akun';
}

export function getTransactionNatureBadge(tx: Transaction): string | null {
  switch (tx.transactionNature) {
    case 'project_advance_recognition':
      return 'Non-Kas · Pengakuan Pendapatan DP';
    case 'receivable_write_off':
      return 'Non-Kas · Hapus Buku Piutang';
    case 'custodial_receipt':
      return 'Dana Titipan · Bukan Penghasilan';
    case 'custodial_return':
      return 'Pengembalian Dana Titipan';
    case 'project_advance_receipt':
      return 'DP Proyek Belum Diakui · Kewajiban';
    case 'project_advance_refund':
      return 'Pengembalian DP Proyek';
    case 'loan_disbursement':
      return 'Pinjaman Diberikan · Bukan Pengeluaran';
    case 'debt_receipt':
      return 'Dana Pinjaman Diterima';
    case 'receivable_collection':
      return 'Pelunasan Piutang';
    case 'debt_repayment':
      return 'Pelunasan Utang';
    case 'split_bill_payment':
      return 'Split Bill · Pembayaran Total';
    case 'split_bill_personal_share':
      return 'Non-Kas · Porsi Pribadi Split Bill';
    case 'friend_advance':
      return 'Talangan Teman · Bukan Konsumsi';
    case 'project_reimbursement_advance':
      return 'Talangan Proyek · Menunggu Klien';
    case 'reimbursement_collection':
      return 'Penggantian Biaya · Bukan Pendapatan Baru';
    case 'linked_borrow_lend':
      return 'Utang A → Piutang B';
    case 'asset_purchase_cash':
      return 'Pembelian Aset Fisik · Bukan Konsumsi';
    case 'asset_purchase_credit':
      return 'Non-Kas · Pembelian Aset Kredit';
    case 'asset_purchase_down_payment':
      return 'Uang Muka Aset Fisik · Bukan Konsumsi';
    case 'asset_sale_proceeds':
      return 'Pelepasan/Penjualan Aset · Bukan Penghasilan Operasional';
    case 'reconciliation':
      return 'Rekonsiliasi Saldo';
    case 'debt_direct_expense':
      return 'Non-Kas · Utang';
    default:
      if (tx.affectsAccountBalance === false) {
        return 'Non-Kas · Utang';
      }
      if (tx.tags?.includes('rekonsiliasi')) {
        return 'Rekonsiliasi Saldo';
      }
      return null;
  }
}

export function getTransactionNatureLabel(tx: Transaction): string {
  switch (tx.transactionNature) {
    case 'project_advance_recognition':
      return 'Pengakuan Pendapatan DP Proyek (Non-Kas)';
    case 'receivable_write_off':
      return 'Penghapusbukuan Piutang (Non-Kas)';
    case 'custodial_receipt':
      return 'Penerimaan Dana Titipan';
    case 'custodial_return':
      return 'Pengembalian Dana Titipan';
    case 'project_advance_receipt':
      return 'Penerimaan DP Proyek (Belum Diakui)';
    case 'project_advance_refund':
      return 'Pengembalian DP Proyek';
    case 'loan_disbursement':
      return 'Pinjaman Diberikan';
    case 'debt_receipt':
      return 'Dana Pinjaman Diterima';
    case 'receivable_collection':
      return 'Pelunasan Piutang';
    case 'debt_repayment':
      return 'Pelunasan Utang';
    case 'split_bill_payment':
      return 'Pembayaran Total Split Bill';
    case 'split_bill_personal_share':
      return 'Porsi Pribadi Split Bill (Non-Kas)';
    case 'friend_advance':
      return 'Talangan Kebutuhan Teman';
    case 'project_reimbursement_advance':
      return 'Talangan / Biaya Diteruskan ke Klien';
    case 'reimbursement_collection':
      return 'Penerimaan Penggantian Biaya (Reimbursement)';
    case 'linked_borrow_lend':
      return 'Pinjam dari A & Teruskan ke B';
    case 'asset_purchase_cash':
      return 'Pembelian Aset Fisik (Tunai)';
    case 'asset_purchase_credit':
      return 'Pembelian Aset Fisik (Kredit Penuh Non-Kas)';
    case 'asset_purchase_down_payment':
      return 'Uang Muka Pembelian Aset Fisik';
    case 'asset_sale_proceeds':
      return 'Penjualan / Pelepasan Aset Fisik';
    case 'reconciliation':
      return 'Rekonsiliasi Saldo';
    case 'debt_direct_expense':
      return 'Utang Non-Kas (Dibayar Pihak Lain)';
    default:
      if (tx.affectsAccountBalance === false) {
        return 'Utang Non-Kas (Dibayar Pihak Lain)';
      }
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
    tx.transactionNature === 'custodial_receipt' ||
    tx.transactionNature === 'custodial_return'
  ) {
    return 'Arus Kas Dana Titipan (Pihak Ketiga)';
  }
  if (
    tx.transactionNature === 'project_advance_receipt' ||
    tx.transactionNature === 'project_advance_refund'
  ) {
    return 'Arus Kas DP Proyek (Belum Diakui)';
  }
  if (
    tx.transactionNature === 'split_bill_payment' ||
    tx.transactionNature === 'friend_advance' ||
    tx.transactionNature === 'project_reimbursement_advance' ||
    tx.transactionNature === 'reimbursement_collection' ||
    tx.transactionNature === 'linked_borrow_lend'
  ) {
    return 'Arus Kas Talangan / Piutang / Split Bill';
  }
  if (
    tx.transactionNature === 'asset_purchase_cash' ||
    tx.transactionNature === 'asset_purchase_down_payment' ||
    tx.transactionNature === 'asset_sale_proceeds'
  ) {
    return 'Arus Kas Aset Fisik';
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
  if (tx.transactionNature === 'project_advance_recognition') {
    return 'Pengakuan Pendapatan Non-Kas';
  }
  if (tx.transactionNature === 'receivable_write_off') {
    return 'Penghapusbukuan Non-Kas';
  }
  if (tx.transactionNature === 'split_bill_personal_share') {
    return 'Pengeluaran Non-Kas (Porsi Split Bill)';
  }
  if (tx.transactionNature === 'linked_borrow_lend' && tx.affectsAccountBalance === false) {
    return 'Catatan Non-Kas (Pinjam A → Teruskan B)';
  }
  if (tx.transactionNature === 'asset_purchase_credit') {
    return 'Perolehan Aset Non-Kas (Kredit)';
  }
  if (tx.transactionNature === 'asset_sale_proceeds' && tx.affectsAccountBalance === false) {
    return 'Penjualan Aset Non-Kas (Piutang)';
  }
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

export function getTransactionExpenseImpactLabel(
  tx: Transaction,
  categories: readonly Category[] = []
): string {
  if (tx.isVoided) return 'Tidak berdampak (Void)';
  if (
    tx.type === 'expense' &&
    !tx.excludeFromExpenseStats &&
    !matchesCategorySystemKey(tx.categoryId, categories, 'business_ops', 'cat-biz-ops') &&
    !matchesCategorySystemKey(tx.categoryId, categories, 'debt_payment', 'cat-debt')
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
    `Dana Titipan Aktif,${escapeCSV(snapshot.custodialFundsHeldTotal)}`,
    `DP Proyek Belum Diakui,${escapeCSV(snapshot.deferredProjectAdvancesTotal)}`,
    `Pendapatan Diakui Bulan Ini,${escapeCSV(snapshot.recognizedIncomeThisMonth)}`,
    `Penerimaan Kas Masuk Bulan Ini,${escapeCSV(snapshot.cashReceiptsThisMonth)}`,
    `Piutang Dihapusbuku,${escapeCSV(snapshot.writtenOffReceivableTotal)}`,
    `Total Nilai Aset Fisik Dimiliki,${escapeCSV(snapshot.physicalAssetsTotal)}`,
    `Laba/Rugi Pelepasan Aset Fisik,${escapeCSV(snapshot.assetSaleGainLossTotal)}`,
    `Total Nilai Aset Hilang (Riwayat),${escapeCSV(snapshot.assetHistoricalLossTotal)}`,
    `Kekayaan Bersih Pribadi,${escapeCSV(snapshot.totalPersonalWealthNet)}`,
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
        escapeCSV(getTransactionExpenseImpactLabel(tx, state.categories)),
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
