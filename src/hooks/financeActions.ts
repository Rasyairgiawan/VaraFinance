import { computeAccountBalances, evaluateDisciplineForExpense } from '../engine/financeEngine';
import {
  DEFAULT_PROJECTION_ASSUMPTIONS,
  GENERAL_CATEGORY_PRESETS,
  SYSTEM_CATEGORY_KEY_MAP,
} from '../data/initialProfile';
import {
  Account,
  AccountTransfer,
  AssetCategory,
  AssetCondition,
  AssetConditionLogEntry,
  AssetLossRecord,
  AssetPaymentMethod,
  AssetRecoveryRecord,
  Category,
  CategoryClassification,
  ChangeEntityType,
  ChangeLogEntry,
  CustodialFund,
  CustodialReturnEntry,
  CustomReminder,
  Debt,
  DebtDirection,
  DebtPayment,
  DebtReceiptKind,
  DebtWriteOffEntry,
  FinanceState,
  FreelanceProject,
  FundAllocation,
  GoalType,
  IncomeSourceType,
  NoSpendConfirmation,
  ObligationDurationType,
  ObligationFrequency,
  ObligationKind,
  ObligationLog,
  ObligationStatus,
  PhysicalAsset,
  PhysicalItemLoan,
  ProjectAdvance,
  ProjectAdvanceRecognition,
  ProjectAdvanceRefund,
  ProjectExpense,
  ProjectExpenseKind,
  ProjectPayment,
  ProjectionAssumptions,
  ReceivableKind,
  RecurringObligation,
  ReminderSettings,
  SavingsGoal,
  SplitBill,
  SplitBillParticipant,
  Transaction,
  TransferAllocationMovement,
  UserFinancialSettings,
} from '../types/finance';
import { addDaysISO, formatIDR, generateId, todayISO } from '../utils/format';
import {
  matchesCategorySystemKey,
  resolveSystemAccountId,
  resolveSystemCategoryId,
} from '../utils/systemEntityResolver';

function withSyncBump(state: FinanceState): FinanceState {
  const prev = state.syncMeta;
  return {
    ...state,
    syncMeta: {
      lastModifiedAt: new Date().toISOString(),
      deviceId: prev?.deviceId ?? 'local-device',
      version: (prev?.version ?? 1) + 1,
    },
  };
}

export function appendChangeLog(
  state: FinanceState,
  entry: {
    entityType: ChangeEntityType;
    entityId: string;
    action: ChangeLogEntry['action'];
    summary: string;
    beforeValue?: string;
    afterValue?: string;
    note?: string;
  }
): FinanceState {
  const log: ChangeLogEntry = {
    id: generateId(),
    ...entry,
    timestamp: new Date().toISOString(),
  };
  return withSyncBump({
    ...state,
    changeLogs: [log, ...(state.changeLogs ?? [])].slice(0, 300),
  });
}

export async function hashPinSHA256(pin: string): Promise<string> {
  const trimmed = pin.trim();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(`kendaliuang:${trimmed}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback deterministic hash only if SubtleCrypto is unavailable in test/legacy env
  let h = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fallback-${(h >>> 0).toString(16)}`;
}

export function addTransactionAction(
  state: FinanceState,
  input: {
    type: 'income' | 'expense';
    amount: number;
    categoryId: string;
    accountId: string;
    date: string;
    description: string;
    notes?: string;
    tags?: string[];
    incomeSource?: IncomeSourceType;
    projectId?: string;
    overrideReason?: string;
  }
): { state: FinanceState; transaction: Transaction } {
  if (input.amount <= 0 || !Number.isFinite(input.amount)) {
    throw new Error('Nominal transaksi harus lebih dari Rp0.');
  }

  const acc = state.accounts.find((a) => a.id === input.accountId);
  if (acc && (acc.status === 'closed' || acc.status === 'archived')) {
    throw new Error(`Akun "${acc.name}" berstatus ${acc.status === 'closed' ? 'ditutup' : 'diarsipkan'} dan tidak menerima transaksi baru.`);
  }

  const cat = state.categories.find((c) => c.id === input.categoryId);
  const isEssential =
    input.type === 'expense' &&
    (cat?.classification === 'essential' ||
      cat?.classification === 'obligation' ||
      cat?.classification === 'debt' ||
      cat?.classification === 'business');
  const isDiscretionary = input.type === 'expense' && !isEssential;

  let exceededBudget = false;
  if (input.type === 'expense') {
    const check = evaluateDisciplineForExpense(state, {
      amount: input.amount,
      categoryId: input.categoryId,
      accountId: input.accountId,
      date: input.date,
    });
    if (check.requiresConfirmation && (!input.overrideReason || input.overrideReason.trim().length < 5)) {
      throw new Error('Transaksi melebihi batas aman: alasan tertulis wajib diisi minimal 5 karakter.');
    }
    exceededBudget = check.requiresConfirmation;
  }

  const tx: Transaction = {
    id: generateId(),
    type: input.type,
    amount: Math.round(input.amount),
    categoryId: input.categoryId,
    accountId: input.accountId,
    date: input.date,
    description: input.description.trim() || cat?.name || 'Transaksi',
    notes: input.notes?.trim() || undefined,
    tags: input.tags ?? [],
    incomeSource: input.incomeSource,
    projectId: input.projectId,
    isEssential,
    isDiscretionary,
    exceededBudget,
    overrideReason: input.overrideReason?.trim() || undefined,
    isVoided: false,
    createdAt: new Date().toISOString(),
  };

  const nextConfirmations = isDiscretionary
    ? (state.noSpendConfirmations ?? []).map((c) =>
        c.date === input.date ? { ...c, status: 'revoked' as const } : c
      )
    : state.noSpendConfirmations ?? [];

  return {
    state: withSyncBump({
      ...state,
      transactions: [tx, ...state.transactions],
      noSpendConfirmations: nextConfirmations,
    }),
    transaction: tx,
  };
}

export type TransactionLinkType =
  | 'none'
  | 'debt_origin'
  | 'debt_payment'
  | 'debt_orphan'
  | 'linked_borrow_lend'
  | 'split_bill_payment'
  | 'split_bill_personal_share'
  | 'project_payment'
  | 'project_expense'
  | 'obligation_log'
  | 'custodial_receipt'
  | 'custodial_return'
  | 'project_advance_receipt'
  | 'project_advance_recognition'
  | 'project_advance_refund'
  | 'receivable_write_off'
  | 'asset_purchase'
  | 'asset_sale'
  | 'reconciliation';

export interface TransactionLinkInfo {
  isLinked: boolean;
  linkType: TransactionLinkType;
  linkedDebt?: Debt;
  linkedDebtPayment?: DebtPayment;
  linkedSplitBill?: SplitBill;
  linkedProjectPayment?: ProjectPayment;
  linkedProjectExpense?: ProjectExpense;
  linkedObligationLog?: ObligationLog;
  linkedCustodialFund?: CustodialFund;
  linkedProjectAdvance?: ProjectAdvance;
  linkedAsset?: PhysicalAsset;
  hasActiveChildren?: boolean;
  canDirectVoid: boolean;
  canEditMetadataOnly: boolean;
  reason?: string;
}

export function getTransactionLinkInfo(
  state: FinanceState,
  txId: string
): TransactionLinkInfo {
  const tx = state.transactions.find((t) => t.id === txId);
  const hasActiveChildren = state.transactions.some(
    (t) => t.parentTransactionId === txId && !t.isVoided
  );

  // Custodial fund relations
  const custodialReceiptFund = (state.custodialFunds ?? []).find(
    (cf) => cf.receiptTransactionId === txId
  );
  if (custodialReceiptFund) {
    const hasActiveReturns =
      hasActiveChildren || custodialReceiptFund.returns.some((r) => !r.isVoided);
    return {
      isLinked: true,
      linkType: 'custodial_receipt',
      linkedCustodialFund: custodialReceiptFund,
      hasActiveChildren: hasActiveReturns,
      canDirectVoid: !hasActiveReturns,
      canEditMetadataOnly: true,
      reason: hasActiveReturns
        ? `Dana titipan (${custodialReceiptFund.counterparty}) masih memiliki pengembalian aktif. Batalkan pengembalian terkait terlebih dahulu sebelum membatalkan penerimaan titipan.`
        : `Transaksi ini terhubung langsung dengan dana titipan (${custodialReceiptFund.counterparty}). Nominal, akun, dan kategori dikunci; gunakan Void untuk membatalkan catatan titipan secara atomik.`,
    };
  }

  for (const cf of state.custodialFunds ?? []) {
    const ret = cf.returns.find((r) => r.transactionId === txId);
    if (ret) {
      return {
        isLinked: true,
        linkType: 'custodial_return',
        linkedCustodialFund: cf,
        canDirectVoid: true,
        canEditMetadataOnly: true,
        reason: `Transaksi ini merupakan pengembalian dana titipan (${cf.counterparty}). Nominal, akun, dan kategori dikunci; gunakan Void untuk memulihkan saldo dana titipan.`,
      };
    }
  }

  // Project Advance (DP Proyek) relations
  const advanceReceipt = (state.projectAdvances ?? []).find(
    (pa) => pa.receiptTransactionId === txId
  );
  if (advanceReceipt) {
    const hasActiveChildOps =
      hasActiveChildren ||
      advanceReceipt.recognitions.some((r) => !r.isVoided) ||
      advanceReceipt.refunds.some((r) => !r.isVoided);
    return {
      isLinked: true,
      linkType: 'project_advance_receipt',
      linkedProjectAdvance: advanceReceipt,
      hasActiveChildren: hasActiveChildOps,
      canDirectVoid: !hasActiveChildOps,
      canEditMetadataOnly: true,
      reason: hasActiveChildOps
        ? `DP proyek (${advanceReceipt.clientName}) masih memiliki pengakuan pendapatan atau pengembalian aktif. Batalkan transaksi anak terlebih dahulu sebelum membatalkan DP induk.`
        : `Transaksi ini merupakan penerimaan DP proyek (${advanceReceipt.clientName}). Nominal, akun, dan kategori dikunci.`,
    };
  }

  for (const pa of state.projectAdvances ?? []) {
    if (pa.recognitions.some((r) => r.transactionId === txId)) {
      return {
        isLinked: true,
        linkType: 'project_advance_recognition',
        linkedProjectAdvance: pa,
        canDirectVoid: true,
        canEditMetadataOnly: true,
        reason: `Transaksi non-kas pengakuan pendapatan DP proyek (${pa.clientName}). Gunakan Void untuk mengembalikan sisa DP belum diakui.`,
      };
    }
    if (pa.refunds.some((r) => r.transactionId === txId)) {
      return {
        isLinked: true,
        linkType: 'project_advance_refund',
        linkedProjectAdvance: pa,
        canDirectVoid: true,
        canEditMetadataOnly: true,
        reason: `Transaksi pengembalian DP proyek (${pa.clientName}). Gunakan Void untuk memulihkan kewajiban DP dan kas.`,
      };
    }
  }

  // Split Bill relations
  const splitBillPayment = (state.splitBills ?? []).find(
    (sb) => sb.paymentTransactionId === txId || (tx?.splitBillId && sb.id === tx.splitBillId && tx.transactionNature === 'split_bill_payment')
  );
  if (splitBillPayment) {
    const participantDebtIds = new Set(splitBillPayment.participants.map((p) => p.debtId));
    const hasActiveParticipantPayments = state.debtPayments.some(
      (dp) => participantDebtIds.has(dp.debtId) && !dp.isVoided
    );
    const hasWrittenOffParticipant = state.debts.some(
      (d) => participantDebtIds.has(d.id) && d.status === 'written_off'
    );
    const hasExternalChildTx = state.transactions.some(
      (t) =>
        t.parentTransactionId === txId &&
        !t.isVoided &&
        t.id !== splitBillPayment.personalShareTransactionId
    );
    const hasBlockingChildren =
      hasActiveParticipantPayments || hasWrittenOffParticipant || hasExternalChildTx;
    return {
      isLinked: true,
      linkType: 'split_bill_payment',
      linkedSplitBill: splitBillPayment,
      hasActiveChildren: hasBlockingChildren,
      canDirectVoid: !hasBlockingChildren,
      canEditMetadataOnly: true,
      reason: hasBlockingChildren
        ? `Split Bill "${splitBillPayment.title}" sudah memiliki pembayaran/write-off peserta aktif. Batalkan pelunasan atau pulihkan piutang peserta terlebih dahulu.`
        : `Transaksi ini merupakan pembayaran induk Split Bill "${splitBillPayment.title}". Nominal, akun, dan kategori dikunci; gunakan Void untuk membatalkan Split Bill dan seluruh piutang peserta secara atomik.`,
    };
  }

  const splitBillPersonal = (state.splitBills ?? []).find(
    (sb) => sb.personalShareTransactionId === txId || (tx?.splitBillId && sb.id === tx.splitBillId && tx.transactionNature === 'split_bill_personal_share')
  );
  if (splitBillPersonal) {
    return {
      isLinked: true,
      linkType: 'split_bill_personal_share',
      linkedSplitBill: splitBillPersonal,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason: `Porsi pribadi Split Bill "${splitBillPersonal.title}" terhubung dengan transaksi pembayaran induknya. Lakukan Void pada transaksi induk Split Bill untuk membatalkan.`,
    };
  }

  if (tx?.transactionNature === 'linked_borrow_lend') {
    const linkedPair = state.debts.filter((d) => d.transactionId === txId);
    const hasActivePairPayments =
      hasActiveChildren ||
      linkedPair.some(
        (d) =>
          state.debtPayments.some((dp) => dp.debtId === d.id && !dp.isVoided) ||
          d.status === 'written_off'
      );
    return {
      isLinked: true,
      linkType: 'linked_borrow_lend',
      linkedDebt: linkedPair[0],
      hasActiveChildren: hasActivePairPayments,
      canDirectVoid: !hasActivePairPayments,
      canEditMetadataOnly: true,
      reason: hasActivePairPayments
        ? 'Transaksi Pinjam-A Teruskan-ke-B sudah memiliki pembayaran aktif atau status write-off. Batalkan pembayaran terlebih dahulu.'
        : 'Transaksi terhubung langsung dengan pasangan Utang A & Piutang B. Gunakan Void untuk membatalkan keduanya secara atomik.',
    };
  }

  if (tx?.transactionNature === 'receivable_write_off') {
    const parentDebt = tx.debtId
      ? state.debts.find((d) => d.id === tx.debtId)
      : undefined;
    return {
      isLinked: true,
      linkType: 'receivable_write_off',
      linkedDebt: parentDebt,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi penghapusbukuan piutang tidak dapat di-void langsung. Gunakan fitur Pemulihan Piutang agar histori write-off tetap utuh.',
    };
  }

  // Physical Asset purchase / sale relations
  const assetBySale = (state.physicalAssets ?? []).find(
    (a) =>
      a.disposal?.saleTransactionId === txId ||
      (tx?.assetId === a.id && tx?.transactionNature === 'asset_sale_proceeds')
  );
  if (assetBySale) {
    const linkedSaleReceivable = assetBySale.disposal?.receivableId
      ? state.debts.find((d) => d.id === assetBySale.disposal?.receivableId)
      : undefined;
    const hasSaleCollections = Boolean(
      linkedSaleReceivable &&
        (linkedSaleReceivable.status === 'written_off' ||
          state.debtPayments.some((dp) => dp.debtId === linkedSaleReceivable.id && !dp.isVoided))
    );
    return {
      isLinked: true,
      linkType: 'asset_sale',
      linkedAsset: assetBySale,
      linkedDebt: linkedSaleReceivable,
      hasActiveChildren: hasSaleCollections,
      canDirectVoid: !hasSaleCollections,
      canEditMetadataOnly: true,
      reason: hasSaleCollections
        ? `Penjualan aset "${assetBySale.name}" sudah memiliki pembayaran piutang aktif atau status write-off. Batalkan pembayaran terlebih dahulu.`
        : `Transaksi penjualan aset "${assetBySale.name}" terhubung langsung dengan pelepasan aset fisik. Gunakan Void untuk memulihkan status kepemilikan aset.`,
    };
  }

  const assetByPurchase = (state.physicalAssets ?? []).find(
    (a) =>
      a.purchaseTransactionId === txId ||
      a.downPaymentTransactionId === txId ||
      (tx?.assetId === a.id &&
        (tx.transactionNature === 'asset_purchase_cash' ||
          tx.transactionNature === 'asset_purchase_credit' ||
          tx.transactionNature === 'asset_purchase_down_payment'))
  );
  if (assetByPurchase) {
    const linkedPurchaseDebt = assetByPurchase.purchaseDebtId
      ? state.debts.find((d) => d.id === assetByPurchase.purchaseDebtId)
      : undefined;
    const hasDebtActivity = Boolean(
      linkedPurchaseDebt &&
        state.debtPayments.some((dp) => dp.debtId === linkedPurchaseDebt.id && !dp.isVoided)
    );
    const hasAssetLifecycleChildren =
      assetByPurchase.status === 'sold' ||
      assetByPurchase.status === 'lost' ||
      assetByPurchase.status === 'lent' ||
      (assetByPurchase.lossHistory ?? []).length > 0 ||
      (assetByPurchase.recoveryHistory ?? []).length > 0 ||
      (state.physicalItemLoans ?? []).some(
        (l) => !l.isVoided && l.assetId === assetByPurchase.id && l.status === 'active'
      ) ||
      hasDebtActivity;
    return {
      isLinked: true,
      linkType: 'asset_purchase',
      linkedAsset: assetByPurchase,
      linkedDebt: linkedPurchaseDebt,
      hasActiveChildren: hasAssetLifecycleChildren,
      canDirectVoid: !hasAssetLifecycleChildren,
      canEditMetadataOnly: true,
      reason: hasAssetLifecycleChildren
        ? `Perolehan aset "${assetByPurchase.name}" memiliki cicilan utang, riwayat kehilangan, penjualan, atau peminjaman aktif. Selesaikan/batalkan turunan terkait terlebih dahulu.`
        : `Transaksi ini merupakan perolehan aset fisik "${assetByPurchase.name}". Gunakan Void untuk membatalkan catatan aset dan transaksi terkait secara atomik.`,
    };
  }

  const linkedDebtPayment = state.debtPayments.find((dp) => dp.transactionId === txId);
  if (linkedDebtPayment) {
    const parentDebt = state.debts.find((d) => d.id === linkedDebtPayment.debtId);
    const label = parentDebt?.direction === 'receivable' ? 'penerimaan piutang' : 'pembayaran utang';
    return {
      isLinked: true,
      linkType: 'debt_payment',
      linkedDebt: parentDebt,
      linkedDebtPayment,
      canDirectVoid: true,
      canEditMetadataOnly: true,
      reason: `Transaksi ini terhubung dengan ${label} (${parentDebt?.creditor ?? linkedDebtPayment.debtId}). Nominal, akun, dan kategori dikunci; gunakan Void untuk membatalkan pembayaran dan memulihkan saldo utang/piutang.`,
    };
  }

  const linkedDebtByOrigin = state.debts.find(
    (d) =>
      d.transactionId === txId ||
      (tx?.debtId &&
        d.id === tx.debtId &&
        (tx.transactionNature === 'debt_receipt' ||
          tx.transactionNature === 'debt_direct_expense' ||
          tx.transactionNature === 'loan_disbursement' ||
          tx.transactionNature === 'friend_advance' ||
          tx.transactionNature === 'project_reimbursement_advance'))
  );
  if (linkedDebtByOrigin) {
    const hasActivePayments =
      hasActiveChildren ||
      linkedDebtByOrigin.status === 'written_off' ||
      state.debtPayments.some((dp) => dp.debtId === linkedDebtByOrigin.id && !dp.isVoided);
    return {
      isLinked: true,
      linkType: 'debt_origin',
      linkedDebt: linkedDebtByOrigin,
      hasActiveChildren: hasActivePayments,
      canDirectVoid: !hasActivePayments,
      canEditMetadataOnly: true,
      reason: hasActivePayments
        ? `Transaksi asal ${linkedDebtByOrigin.direction === 'receivable' ? 'piutang' : 'utang'} (${linkedDebtByOrigin.creditor}) sudah memiliki pembayaran aktif atau status write-off. Batalkan pembayaran terlebih dahulu sebelum membatalkan transaksi ini.`
        : `Transaksi ini terhubung langsung dengan catatan ${linkedDebtByOrigin.direction === 'receivable' ? 'piutang' : 'utang'} (${linkedDebtByOrigin.creditor}). Nominal, akun, dan kategori dikunci; gunakan Void untuk membatalkan transaksi dan catatan terkait secara atomik.`,
    };
  }

  if (tx?.debtId) {
    const parentDebt = state.debts.find((d) => d.id === tx.debtId);
    return {
      isLinked: true,
      linkType: 'debt_orphan',
      linkedDebt: parentDebt,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi ini memiliki referensi utang/piutang tanpa entri DebtPayment yang utuh dan tidak dapat diubah atau di-void langsung.',
    };
  }

  const linkedProjectPayment = state.projectPayments.find((pp) => pp.transactionId === txId);
  if (linkedProjectPayment) {
    return {
      isLinked: true,
      linkType: 'project_payment',
      linkedProjectPayment,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi ini terhubung dengan penerimaan proyek (ProjectPayment). Nominal, akun, dan kategori dikunci serta tidak dapat dihapus/di-void langsung agar ringkasan proyek tetap konsisten.',
    };
  }

  const linkedProjectExpense = state.projectExpenses.find((pe) => pe.transactionId === txId);
  if (linkedProjectExpense) {
    return {
      isLinked: true,
      linkType: 'project_expense',
      linkedProjectExpense,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi ini terhubung dengan biaya operasional proyek (ProjectExpense). Nominal, akun, dan kategori dikunci serta tidak dapat dihapus/di-void langsung.',
    };
  }

  const linkedObligationLog = state.obligationLogs.find((ol) => ol.transactionId === txId);
  if (linkedObligationLog) {
    return {
      isLinked: true,
      linkType: 'obligation_log',
      linkedObligationLog,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi ini terhubung dengan pembayaran kewajiban rutin (ObligationLog). Nominal, akun, dan kategori dikunci serta tidak dapat dihapus/di-void langsung karena memengaruhi jadwal jatuh tempo dan cadangan kewajiban.',
    };
  }

  if (tx?.transactionNature === 'reconciliation' || tx?.tags?.includes('rekonsiliasi')) {
    return {
      isLinked: true,
      linkType: 'reconciliation',
      canDirectVoid: true,
      canEditMetadataOnly: true,
      reason:
        'Transaksi rekonsiliasi saldo tidak boleh diubah nominal, akun, atau kategorinya secara langsung.',
    };
  }

  if (hasActiveChildren) {
    return {
      isLinked: true,
      linkType: 'none',
      hasActiveChildren: true,
      canDirectVoid: false,
      canEditMetadataOnly: true,
      reason:
        'Transaksi induk ini masih memiliki transaksi anak aktif. Batalkan transaksi anak terlebih dahulu sebelum mengubah atau membatalkan transaksi ini.',
    };
  }

  return {
    isLinked: false,
    linkType: 'none',
    canDirectVoid: true,
    canEditMetadataOnly: false,
  };
}

function reconcileNoSpendConfirmationsForDates(
  transactions: Transaction[],
  prevConfirmations: NoSpendConfirmation[] | undefined,
  dates: string[],
  categories: readonly Category[] = []
): NoSpendConfirmation[] {
  const uniqueDates = Array.from(new Set(dates.filter(Boolean)));
  if (uniqueDates.length === 0) return prevConfirmations ?? [];

  const next = [...(prevConfirmations ?? [])];
  for (const date of uniqueDates) {
    const hasDiscretionaryOnDate = transactions.some(
      (t) =>
        !t.isVoided &&
        t.type === 'expense' &&
        !t.excludeFromExpenseStats &&
        !matchesCategorySystemKey(t.categoryId, categories, 'business_ops', 'cat-biz-ops') &&
        !matchesCategorySystemKey(t.categoryId, categories, 'debt_payment', 'cat-debt') &&
        t.isDiscretionary &&
        t.date === date
    );

    const idx = next.findIndex((c) => c.date === date);
    if (idx === -1) continue;

    if (hasDiscretionaryOnDate && next[idx].status === 'confirmed') {
      next[idx] = { ...next[idx], status: 'revoked' as const };
    } else if (!hasDiscretionaryOnDate && next[idx].status === 'revoked') {
      next[idx] = { ...next[idx], status: 'confirmed' as const };
    }
  }

  return next;
}

export function updateTransactionAction(
  state: FinanceState,
  id: string,
  updates: Partial<Pick<Transaction, 'amount' | 'categoryId' | 'accountId' | 'date' | 'description' | 'notes'>>
): FinanceState {
  const prevTx = state.transactions.find((t) => t.id === id);
  if (!prevTx) {
    throw new Error('Transaksi tidak ditemukan.');
  }
  if (prevTx.isVoided) {
    throw new Error('Transaksi yang sudah di-void tidak dapat diubah.');
  }

  const link = getTransactionLinkInfo(state, id);
  if (link.isLinked) {
    const amountChanged =
      updates.amount !== undefined && Math.round(updates.amount) !== prevTx.amount;
    const accountChanged =
      updates.accountId !== undefined && updates.accountId !== prevTx.accountId;
    const categoryChanged =
      updates.categoryId !== undefined && updates.categoryId !== prevTx.categoryId;
    const dateChanged =
      updates.date !== undefined && updates.date !== prevTx.date;

    if (amountChanged || accountChanged || categoryChanged || dateChanged) {
      throw new Error(
        link.reason ??
          'Transaksi terikat relasi tidak dapat diubah nominal, akun, kategori, atau tanggalnya secara langsung. Gunakan mekanisme Void lalu catat ulang.'
      );
    }
  }

  if (updates.amount !== undefined) {
    if (!Number.isFinite(updates.amount) || updates.amount <= 0 || Math.round(updates.amount) <= 0) {
      throw new Error('Nominal transaksi harus lebih dari Rp0.');
    }
  }

  const nextAmount = updates.amount !== undefined ? Math.round(updates.amount) : prevTx.amount;
  const nextAccountId = updates.accountId ?? prevTx.accountId;
  const nextCategoryId = updates.categoryId ?? prevTx.categoryId;
  const nextDate = updates.date ?? prevTx.date;

  if (prevTx.affectsAccountBalance !== false) {
    const targetAcc = state.accounts.find((a) => a.id === nextAccountId);
    if (!targetAcc) {
      throw new Error('Akun transaksi tidak ditemukan.');
    }
    if ((targetAcc.status ?? 'active') !== 'active') {
      throw new Error(
        `Akun "${targetAcc.name}" berstatus ${targetAcc.status === 'closed' ? 'ditutup' : 'diarsipkan'} dan tidak dapat digunakan.`
      );
    }
  }

  const cat = state.categories.find((c) => c.id === nextCategoryId);
  if (!cat) {
    throw new Error('Kategori transaksi tidak ditemukan.');
  }
  if (cat.type !== prevTx.type) {
    throw new Error(`Kategori "${cat.name}" tidak sesuai dengan jenis transaksi ini.`);
  }

  const isReconciliation =
    prevTx.transactionNature === 'reconciliation' || prevTx.tags?.includes('rekonsiliasi');
  const isEssential = isReconciliation
    ? false
    : prevTx.type === 'expense' &&
      (cat.classification === 'essential' ||
        cat.classification === 'obligation' ||
        cat.classification === 'debt' ||
        cat.classification === 'business');
  const isDiscretionary = isReconciliation ? false : prevTx.type === 'expense' && !isEssential;

  let exceededBudget = prevTx.exceededBudget;
  if (prevTx.type === 'expense') {
    if (isDiscretionary && !prevTx.excludeFromExpenseStats) {
      const stateWithoutTx: FinanceState = {
        ...state,
        transactions: state.transactions.filter((t) => t.id !== id),
      };
      const check = evaluateDisciplineForExpense(stateWithoutTx, {
        amount: nextAmount,
        categoryId: nextCategoryId,
        accountId: nextAccountId,
        date: nextDate,
      });
      exceededBudget = check.requiresConfirmation;
    } else {
      exceededBudget = false;
    }
  }

  const nextTransactions = state.transactions.map((t) => {
    if (t.id !== id) return t;
    return {
      ...t,
      ...updates,
      amount: nextAmount,
      accountId: nextAccountId,
      categoryId: nextCategoryId,
      date: nextDate,
      description:
        updates.description !== undefined
          ? updates.description.trim() || cat.name
          : t.description,
      notes: updates.notes !== undefined ? updates.notes.trim() || undefined : t.notes,
      isEssential,
      isDiscretionary,
      exceededBudget,
    };
  });

  const nextNoSpend = reconcileNoSpendConfirmationsForDates(
    nextTransactions,
    state.noSpendConfirmations,
    [prevTx.date, nextDate],
    state.categories
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: 'transaction',
      entityId: id,
      action: 'update',
      summary: `Ubah transaksi: ${prevTx.description}`,
      beforeValue: formatIDR(prevTx.amount),
      afterValue: updates.amount !== undefined ? formatIDR(nextAmount) : undefined,
    }
  );
}

export function voidTransactionAction(
  state: FinanceState,
  id: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const target = state.transactions.find((t) => t.id === id);
  if (!target) throw new Error('Transaksi tidak ditemukan.');
  if (target.isVoided) return state;

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const link = getTransactionLinkInfo(state, id);

  if (link.linkType === 'debt_payment' && link.linkedDebtPayment) {
    return voidDebtPaymentAction(state, link.linkedDebtPayment.id, cleanReason);
  }

  if (link.linkType === 'split_bill_payment' && link.linkedSplitBill) {
    return voidSplitBillAction(state, link.linkedSplitBill.id, cleanReason);
  }

  if (link.linkType === 'split_bill_personal_share') {
    throw new Error(
      link.reason ?? 'Porsi pribadi Split Bill hanya dapat dibatalkan melalui transaksi induk Split Bill.'
    );
  }

  if (link.linkType === 'linked_borrow_lend') {
    const pairedDebts = state.debts.filter((d) => d.transactionId === id);
    const hasActivePairPayments = pairedDebts.some(
      (d) =>
        d.status === 'written_off' ||
        state.debtPayments.some((dp) => dp.debtId === d.id && !dp.isVoided)
    );
    if (hasActivePairPayments) {
      throw new Error(
        link.reason ??
          'Transaksi Pinjam-A Teruskan-ke-B sudah memiliki pembayaran aktif atau status write-off. Batalkan pembayaran terlebih dahulu.'
      );
    }

    const pairedDebtIds = new Set(pairedDebts.map((d) => d.id));
    const nextTransactions = state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );
    const nextDebts = state.debts.map((d) =>
      pairedDebtIds.has(d.id)
        ? {
            ...d,
            remainingAmount: 0,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
          }
        : d
    );
    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        debts: nextDebts,
      },
      {
        entityType: 'transaction',
        entityId: id,
        action: 'void',
        summary: `Void transaksi Pinjam A → Teruskan ke B: ${formatIDR(target.amount)}`,
        beforeValue: formatIDR(target.amount),
        afterValue: 'Void (Rp0 aktif)',
        note: cleanReason,
      }
    );
  }

  if (link.linkType === 'debt_origin' && link.linkedDebt) {
    const debt = link.linkedDebt;
    const hasActivePayments =
      debt.status === 'written_off' ||
      state.debtPayments.some((dp) => dp.debtId === debt.id && !dp.isVoided);
    if (hasActivePayments) {
      throw new Error(
        `Transaksi asal ${debt.direction === 'receivable' ? 'piutang' : 'utang'} (${debt.creditor}) masih memiliki pembayaran aktif atau status write-off. Batalkan pembayaran terkait terlebih dahulu sebelum membatalkan transaksi ini.`
      );
    }

    const nextTransactions = state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );

    const nextDebts = state.debts.map((d) =>
      d.id === debt.id
        ? {
            ...d,
            remainingAmount: 0,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
          }
        : d
    );

    const nextProjectExpenses = debt.projectExpenseId
      ? state.projectExpenses.map((pe) =>
          pe.id === debt.projectExpenseId || pe.transactionId === id
            ? {
                ...pe,
                isVoided: true,
                voidedAt: nowISO,
                voidReason: cleanReason,
              }
            : pe
        )
      : state.projectExpenses;

    const nextNoSpend = reconcileNoSpendConfirmationsForDates(
      nextTransactions,
      state.noSpendConfirmations,
      [target.date],
      state.categories
    );

    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        debts: nextDebts,
        projectExpenses: nextProjectExpenses,
        noSpendConfirmations: nextNoSpend,
      },
      {
        entityType: debt.direction === 'receivable' ? 'receivable' : 'debt',
        entityId: debt.id,
        action: 'void',
        summary: `Void transaksi & ${debt.direction === 'receivable' ? 'piutang' : 'utang'} (${debt.creditor}): ${formatIDR(target.amount)}`,
        beforeValue: formatIDR(debt.remainingAmount),
        afterValue: 'Void (Rp0 aktif)',
        note: cleanReason,
      }
    );
  }

  if (link.linkType === 'custodial_return' && link.linkedCustodialFund) {
    const ret = link.linkedCustodialFund.returns.find((r) => r.transactionId === id);
    if (ret) {
      return voidCustodialReturnAction(state, link.linkedCustodialFund.id, ret.id, cleanReason);
    }
  }

  if (link.linkType === 'custodial_receipt' && link.linkedCustodialFund) {
    const fund = link.linkedCustodialFund;
    const hasActiveReturns =
      fund.returns.some((r) => !r.isVoided) ||
      state.transactions.some((t) => t.parentTransactionId === id && !t.isVoided);
    if (hasActiveReturns) {
      throw new Error(
        `Transaksi penerimaan dana titipan (${fund.counterparty}) masih memiliki pengembalian aktif. Batalkan pengembalian terkait terlebih dahulu.`
      );
    }

    const nextTransactions = state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );
    const nextCustodials = (state.custodialFunds ?? []).map((cf) =>
      cf.id === fund.id
        ? {
            ...cf,
            remainingAmount: 0,
            fundAllocations: [],
            status: 'voided' as const,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
          }
        : cf
    );

    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        custodialFunds: nextCustodials,
      },
      {
        entityType: 'custodial',
        entityId: fund.id,
        action: 'void',
        summary: `Void penerimaan dana titipan (${fund.counterparty}): ${formatIDR(fund.initialAmount)}`,
        beforeValue: formatIDR(fund.remainingAmount),
        afterValue: 'Void (Rp0)',
        note: cleanReason,
      }
    );
  }

  if (link.linkType === 'project_advance_recognition' && link.linkedProjectAdvance) {
    const rec = link.linkedProjectAdvance.recognitions.find((r) => r.transactionId === id);
    if (rec) {
      return voidProjectAdvanceRecognitionAction(
        state,
        link.linkedProjectAdvance.id,
        rec.id,
        cleanReason
      );
    }
  }

  if (link.linkType === 'project_advance_refund' && link.linkedProjectAdvance) {
    const ref = link.linkedProjectAdvance.refunds.find((r) => r.transactionId === id);
    if (ref) {
      return voidProjectAdvanceRefundAction(
        state,
        link.linkedProjectAdvance.id,
        ref.id,
        cleanReason
      );
    }
  }

  if (link.linkType === 'project_advance_receipt' && link.linkedProjectAdvance) {
    const adv = link.linkedProjectAdvance;
    const hasActiveChildren =
      adv.recognitions.some((r) => !r.isVoided) ||
      adv.refunds.some((r) => !r.isVoided) ||
      state.transactions.some((t) => t.parentTransactionId === id && !t.isVoided);
    if (hasActiveChildren) {
      throw new Error(
        `Transaksi DP proyek (${adv.clientName}) masih memiliki pengakuan pendapatan atau pengembalian aktif. Batalkan transaksi anak terlebih dahulu.`
      );
    }

    const nextTransactions = state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );
    const nextAdvances = (state.projectAdvances ?? []).map((pa) =>
      pa.id === adv.id
        ? {
            ...pa,
            remainingAmount: 0,
            fundAllocations: [],
            status: 'voided' as const,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
          }
        : pa
    );

    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        projectAdvances: nextAdvances,
      },
      {
        entityType: 'project_advance',
        entityId: adv.id,
        action: 'void',
        summary: `Void penerimaan DP proyek (${adv.clientName}): ${formatIDR(adv.initialAmount)}`,
        beforeValue: formatIDR(adv.remainingAmount),
        afterValue: 'Void (Rp0)',
        note: cleanReason,
      }
    );
  }

  if (link.linkType === 'asset_sale' && link.linkedAsset) {
    const asset = link.linkedAsset;
    const saleRecId = asset.disposal?.receivableId;
    if (link.hasActiveChildren) {
      throw new Error(
        link.reason ??
          `Penjualan aset "${asset.name}" sudah memiliki pembayaran piutang aktif. Batalkan pembayaran terkait terlebih dahulu.`
      );
    }
    const nextTransactions = state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );
    const nextDebts = saleRecId
      ? state.debts.map((d) =>
          d.id === saleRecId
            ? {
                ...d,
                remainingAmount: 0,
                isVoided: true,
                voidedAt: nowISO,
                voidReason: cleanReason,
              }
            : d
        )
      : state.debts;
    const nextAssets = (state.physicalAssets ?? []).map((a) =>
      a.id === asset.id
        ? {
            ...a,
            status: 'active' as const,
            disposal: undefined,
            updatedAt: nowISO,
          }
        : a
    );
    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        debts: nextDebts,
        physicalAssets: nextAssets,
      },
      {
        entityType: 'physical_asset',
        entityId: asset.id,
        action: 'void',
        summary: `Void penjualan aset "${asset.name}": ${formatIDR(target.amount)}`,
        beforeValue: 'Terjual',
        afterValue: 'Aktif Dimiliki',
        note: cleanReason,
      }
    );
  }

  if (link.linkType === 'asset_purchase' && link.linkedAsset) {
    const asset = link.linkedAsset;
    if (link.hasActiveChildren) {
      throw new Error(
        link.reason ??
          `Perolehan aset "${asset.name}" memiliki cicilan utang atau riwayat turunan aktif sehingga tidak dapat di-void langsung.`
      );
    }
    const txIdsToVoid = new Set(
      [id, asset.purchaseTransactionId, asset.downPaymentTransactionId].filter(
        (v): v is string => Boolean(v)
      )
    );
    const nextTransactions = state.transactions.map((t) =>
      txIdsToVoid.has(t.id)
        ? {
            ...t,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            exceededBudget: false,
          }
        : t
    );
    const nextDebts = asset.purchaseDebtId
      ? state.debts.map((d) =>
          d.id === asset.purchaseDebtId
            ? {
                ...d,
                remainingAmount: 0,
                isVoided: true,
                voidedAt: nowISO,
                voidReason: cleanReason,
              }
            : d
        )
      : state.debts;
    const nextAssets = (state.physicalAssets ?? []).map((a) =>
      a.id === asset.id
        ? {
            ...a,
            status: 'voided' as const,
            isVoided: true,
            voidedAt: nowISO,
            voidReason: cleanReason,
            updatedAt: nowISO,
          }
        : a
    );
    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        debts: nextDebts,
        physicalAssets: nextAssets,
      },
      {
        entityType: 'physical_asset',
        entityId: asset.id,
        action: 'void',
        summary: `Void perolehan aset "${asset.name}": ${formatIDR(asset.acquisitionValue)}`,
        beforeValue: formatIDR(asset.acquisitionValue),
        afterValue: 'Void (Rp0 aktif)',
        note: cleanReason,
      }
    );
  }

  if (
    link.hasActiveChildren ||
    link.linkType === 'debt_orphan' ||
    link.linkType === 'project_payment' ||
    link.linkType === 'project_expense' ||
    link.linkType === 'obligation_log' ||
    link.linkType === 'receivable_write_off'
  ) {
    throw new Error(
      link.reason ??
        'Transaksi terikat relasi ini tidak dapat di-void langsung dari buku transaksi.'
    );
  }

  const nextTransactions = state.transactions.map((t) =>
    t.id === id
      ? {
          ...t,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
          exceededBudget: false,
        }
      : t
  );

  const nextNoSpend = reconcileNoSpendConfirmationsForDates(
    nextTransactions,
    state.noSpendConfirmations,
    [target.date],
    state.categories
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: 'transaction',
      entityId: id,
      action: 'void',
      summary: `Void transaksi: ${target.description} (${formatIDR(target.amount)})`,
      beforeValue: formatIDR(target.amount),
      afterValue: 'Void (Rp0 aktif)',
      note: cleanReason,
    }
  );
}

export function deleteTransactionAction(state: FinanceState, id: string): FinanceState {
  const target = state.transactions.find((t) => t.id === id);
  if (!target) return state;

  const hasChildTx = state.transactions.some((t) => t.parentTransactionId === id);
  if (hasChildTx) {
    throw new Error(
      `Transaksi induk "${target.description}" masih memiliki transaksi anak (pengembalian/pengakuan/pembayaran) dan tidak boleh dihapus.`
    );
  }

  const link = getTransactionLinkInfo(state, id);
  if (link.isLinked) {
    throw new Error(
      `Transaksi "${target.description}" terhubung dengan entitas lain (${link.linkType}) dan tidak boleh dihapus permanen. Gunakan mekanisme Void jika ingin membatalkan transaksi secara aman.`
    );
  }

  const nextTransactions = state.transactions.filter((t) => t.id !== id);
  const nextNoSpend = reconcileNoSpendConfirmationsForDates(
    nextTransactions,
    state.noSpendConfirmations,
    [target.date],
    state.categories
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: 'transaction',
      entityId: id,
      action: 'delete',
      summary: `Hapus transaksi: ${target.description} (${formatIDR(target.amount)})`,
      beforeValue: `${target.date} · ${formatIDR(target.amount)}`,
    }
  );
}

function getNormalizedAllocations(item: {
  remainingAmount: number;
  holdingAccountId: string;
  fundAllocations?: FundAllocation[];
}): FundAllocation[] {
  if (item.remainingAmount <= 0) return [];
  const raw =
    Array.isArray(item.fundAllocations) && item.fundAllocations.length > 0
      ? item.fundAllocations.filter((a) => a.amount > 0)
      : [{ accountId: item.holdingAccountId, amount: item.remainingAmount }];
  return raw.length > 0
    ? raw.map((a) => ({ accountId: a.accountId, amount: Math.round(a.amount) }))
    : [{ accountId: item.holdingAccountId, amount: item.remainingAmount }];
}

function getAllocatedAmountInAccount(
  item: { remainingAmount: number; holdingAccountId: string; fundAllocations?: FundAllocation[] },
  accountId: string
): number {
  return getNormalizedAllocations(item)
    .filter((a) => a.accountId === accountId)
    .reduce((sum, a) => sum + a.amount, 0);
}

function shiftAllocationBetweenAccounts(
  allocations: FundAllocation[],
  fromAccountId: string,
  toAccountId: string,
  moveAmount: number
): FundAllocation[] {
  if (moveAmount <= 0) return allocations;
  let remainingToDeduct = moveAmount;
  const nextMap = new Map<string, number>();

  for (const alloc of allocations) {
    if (alloc.amount <= 0) continue;
    let amt = alloc.amount;
    if (alloc.accountId === fromAccountId && remainingToDeduct > 0) {
      const deduct = Math.min(amt, remainingToDeduct);
      amt -= deduct;
      remainingToDeduct -= deduct;
    }
    if (amt > 0) {
      nextMap.set(alloc.accountId, (nextMap.get(alloc.accountId) ?? 0) + amt);
    }
  }

  nextMap.set(toAccountId, (nextMap.get(toAccountId) ?? 0) + moveAmount);
  return Array.from(nextMap.entries()).map(([accountId, amount]) => ({ accountId, amount }));
}

function adjustAllocationInAccount(
  allocations: FundAllocation[],
  accountId: string,
  delta: number
): FundAllocation[] {
  const nextMap = new Map<string, number>();
  for (const alloc of allocations) {
    if (alloc.amount > 0) {
      nextMap.set(alloc.accountId, (nextMap.get(alloc.accountId) ?? 0) + alloc.amount);
    }
  }
  const updated = Math.max(0, (nextMap.get(accountId) ?? 0) + delta);
  if (updated > 0) {
    nextMap.set(accountId, updated);
  } else {
    nextMap.delete(accountId);
  }
  return Array.from(nextMap.entries()).map(([accId, amount]) => ({ accountId: accId, amount }));
}

export function addTransferAction(
  state: FinanceState,
  input: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    date: string;
    notes?: string;
    idempotencyKey?: string;
    restrictedAllocations?: TransferAllocationMovement[];
    carryRestrictedAllocations?: boolean;
  }
): FinanceState {
  if (input.idempotencyKey) {
    const existing = state.transfers.find((t) => t.idempotencyKey === input.idempotencyKey);
    if (existing) return state;
  }

  if (input.fromAccountId === input.toAccountId) {
    throw new Error('Akun asal dan akun tujuan transfer harus berbeda.');
  }
  if (input.amount <= 0 || !Number.isFinite(input.amount)) {
    throw new Error('Nominal transfer harus lebih dari Rp0.');
  }

  const fromAcc = state.accounts.find((a) => a.id === input.fromAccountId);
  const toAcc = state.accounts.find((a) => a.id === input.toAccountId);
  if (fromAcc?.status === 'closed' || toAcc?.status === 'closed') {
    throw new Error('Transfer tidak dapat melibatkan akun yang sudah ditutup.');
  }

  const roundedAmount = Math.round(input.amount);
  const balances = computeAccountBalances(state);
  const fromBalanceBefore =
    balances.find((a) => a.id === input.fromAccountId)?.currentBalance ?? 0;

  let nextCustodials = [...(state.custodialFunds ?? [])];
  let nextAdvances = [...(state.projectAdvances ?? [])];
  const recordedMovements: TransferAllocationMovement[] = [];
  let movedRestrictedTotal = 0;

  // 1. Apply explicit restricted allocation movements if specified
  if (input.restrictedAllocations && input.restrictedAllocations.length > 0) {
    const requestedSum = input.restrictedAllocations.reduce((s, r) => s + Math.round(r.amount), 0);
    if (requestedSum > roundedAmount) {
      throw new Error(
        'Total alokasi dana terikat yang dipindahkan tidak boleh melebihi nominal transfer.'
      );
    }

    for (const move of input.restrictedAllocations) {
      const moveAmt = Math.round(move.amount);
      if (moveAmt <= 0) continue;

      if (move.fundType === 'custodial') {
        const idx = nextCustodials.findIndex(
          (cf) => cf.id === move.fundId && !cf.isVoided && cf.status === 'active'
        );
        if (idx === -1) {
          throw new Error('Dana titipan yang akan dipindahkan alokasinya tidak ditemukan.');
        }
        const fund = nextCustodials[idx];
        const availableInFrom = getAllocatedAmountInAccount(fund, input.fromAccountId);
        if (moveAmt > availableInFrom) {
          throw new Error(
            `Alokasi dana titipan (${fund.counterparty}) di akun asal hanya ${formatIDR(availableInFrom)}.`
          );
        }
        nextCustodials[idx] = {
          ...fund,
          fundAllocations: shiftAllocationBetweenAccounts(
            getNormalizedAllocations(fund),
            input.fromAccountId,
            input.toAccountId,
            moveAmt
          ),
        };
        movedRestrictedTotal += moveAmt;
        recordedMovements.push({ fundType: 'custodial', fundId: fund.id, amount: moveAmt });
      } else {
        const idx = nextAdvances.findIndex(
          (pa) => pa.id === move.fundId && !pa.isVoided && pa.status === 'active'
        );
        if (idx === -1) {
          throw new Error('DP proyek yang akan dipindahkan alokasinya tidak ditemukan.');
        }
        const adv = nextAdvances[idx];
        const availableInFrom = getAllocatedAmountInAccount(adv, input.fromAccountId);
        if (moveAmt > availableInFrom) {
          throw new Error(
            `Alokasi DP proyek (${adv.clientName}) di akun asal hanya ${formatIDR(availableInFrom)}.`
          );
        }
        nextAdvances[idx] = {
          ...adv,
          fundAllocations: shiftAllocationBetweenAccounts(
            getNormalizedAllocations(adv),
            input.fromAccountId,
            input.toAccountId,
            moveAmt
          ),
        };
        movedRestrictedTotal += moveAmt;
        recordedMovements.push({ fundType: 'project_advance', fundId: adv.id, amount: moveAmt });
      }
    }
  }

  // 2. Check remaining restricted funds in fromAccountId vs post-transfer cash balance
  const remainingRestrictedInFrom =
    nextCustodials
      .filter((cf) => !cf.isVoided && cf.status === 'active' && cf.remainingAmount > 0)
      .reduce((s, cf) => s + getAllocatedAmountInAccount(cf, input.fromAccountId), 0) +
    nextAdvances
      .filter((pa) => !pa.isVoided && pa.status === 'active' && pa.remainingAmount > 0)
      .reduce((s, pa) => s + getAllocatedAmountInAccount(pa, input.fromAccountId), 0);

  const fromBalanceAfter = fromBalanceBefore - roundedAmount;
  const remainingTransferCapacity = Math.max(0, roundedAmount - movedRestrictedTotal);

  let autoMoveTarget = 0;
  if (input.carryRestrictedAllocations === true) {
    autoMoveTarget = Math.min(remainingRestrictedInFrom, remainingTransferCapacity);
  } else if (fromBalanceAfter < remainingRestrictedInFrom) {
    if (input.carryRestrictedAllocations === false) {
      throw new Error(
        `Transfer sebesar ${formatIDR(roundedAmount)} akan memakai dana terikat (titipan / DP proyek) sebesar ${formatIDR(remainingRestrictedInFrom)} di akun asal.`
      );
    }
    const shortfall = remainingRestrictedInFrom - Math.max(0, fromBalanceAfter);
    autoMoveTarget = Math.min(shortfall, remainingRestrictedInFrom, remainingTransferCapacity);
  }

  if (autoMoveTarget > 0) {
    let remainingToShift = autoMoveTarget;

    nextCustodials = nextCustodials.map((cf) => {
      if (remainingToShift <= 0 || cf.isVoided || cf.status !== 'active' || cf.remainingAmount <= 0) {
        return cf;
      }
      const inFrom = getAllocatedAmountInAccount(cf, input.fromAccountId);
      if (inFrom <= 0) return cf;
      const shiftAmt = Math.min(inFrom, remainingToShift);
      remainingToShift -= shiftAmt;
      recordedMovements.push({ fundType: 'custodial', fundId: cf.id, amount: shiftAmt });
      return {
        ...cf,
        fundAllocations: shiftAllocationBetweenAccounts(
          getNormalizedAllocations(cf),
          input.fromAccountId,
          input.toAccountId,
          shiftAmt
        ),
      };
    });

    nextAdvances = nextAdvances.map((pa) => {
      if (remainingToShift <= 0 || pa.isVoided || pa.status !== 'active' || pa.remainingAmount <= 0) {
        return pa;
      }
      const inFrom = getAllocatedAmountInAccount(pa, input.fromAccountId);
      if (inFrom <= 0) return pa;
      const shiftAmt = Math.min(inFrom, remainingToShift);
      remainingToShift -= shiftAmt;
      recordedMovements.push({ fundType: 'project_advance', fundId: pa.id, amount: shiftAmt });
      return {
        ...pa,
        fundAllocations: shiftAllocationBetweenAccounts(
          getNormalizedAllocations(pa),
          input.fromAccountId,
          input.toAccountId,
          shiftAmt
        ),
      };
    });
  }

  const transfer: AccountTransfer = {
    id: generateId(),
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: roundedAmount,
    date: input.date,
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    restrictedMovements: recordedMovements.length > 0 ? recordedMovements : undefined,
    createdAt: new Date().toISOString(),
  };

  return withSyncBump({
    ...state,
    transfers: [transfer, ...state.transfers],
    ...(state.custodialFunds !== undefined || nextCustodials.length > 0
      ? { custodialFunds: nextCustodials }
      : {}),
    ...(state.projectAdvances !== undefined || nextAdvances.length > 0
      ? { projectAdvances: nextAdvances }
      : {}),
  });
}

export function createProjectAction(
  state: FinanceState,
  input: {
    clientName: string;
    projectName: string;
    contractValue: number;
    paymentScheme: 'full' | 'dp_final' | 'milestone' | 'custom';
    businessSharePct: number;
    notes?: string;
  }
): { state: FinanceState; project: FreelanceProject } {
  const project: FreelanceProject = {
    id: generateId(),
    clientName: input.clientName.trim(),
    projectName: input.projectName.trim(),
    contractValue: Math.round(input.contractValue),
    paymentScheme: input.paymentScheme,
    status: 'active',
    businessSharePct: input.businessSharePct,
    personalSharePct: 100 - input.businessSharePct,
    notes: input.notes?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  return {
    state: withSyncBump({
      ...state,
      projects: [project, ...state.projects],
    }),
    project,
  };
}

export function archiveProjectAction(state: FinanceState, projectId: string): FinanceState {
  const proj = state.projects.find((p) => p.id === projectId);
  if (!proj) return state;
  return withSyncBump({
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, isArchived: !p.isArchived } : p)),
  });
}

export function addProjectPaymentAction(
  state: FinanceState,
  input: {
    projectId: string;
    paymentType: 'full' | 'dp' | 'installment' | 'final';
    amount: number;
    status: 'expected' | 'received';
    date: string;
    accountId?: string;
    notes?: string;
  }
): FinanceState {
  const project = state.projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error('Proyek tidak ditemukan.');
  if (input.amount <= 0) throw new Error('Nominal pembayaran harus lebih dari Rp0.');

  let transactionId: string | undefined;
  let nextState = state;

  const defaultBusinessAccId = resolveSystemAccountId(
    state.accounts,
    'business',
    'acc-business',
    undefined,
    { activeOnly: true }
  );

  if (input.status === 'received') {
    const targetAccId = input.accountId || defaultBusinessAccId;
    const labelMap = {
      full: 'Pelunasan Penuh',
      dp: 'Uang Muka (DP)',
      installment: 'Cicilan Proyek',
      final: 'Pelunasan Akhir',
    };
    const res = addTransactionAction(nextState, {
      type: 'income',
      amount: input.amount,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'income_freelance',
        'cat-income-freelance',
        'income'
      ),
      accountId: targetAccId,
      date: input.date,
      description: `${labelMap[input.paymentType]} — ${project.projectName}`,
      notes: input.notes,
      incomeSource: 'freelance',
      projectId: project.id,
    });
    nextState = res.state;
    transactionId = res.transaction.id;
  }

  const payment: ProjectPayment = {
    id: generateId(),
    projectId: project.id,
    paymentType: input.paymentType,
    amount: Math.round(input.amount),
    status: input.status,
    expectedDate: input.status === 'expected' ? input.date : undefined,
    receivedDate: input.status === 'received' ? input.date : undefined,
    accountId: input.status === 'received' ? input.accountId || defaultBusinessAccId : undefined,
    transactionId,
    notes: input.notes?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  return withSyncBump({
    ...nextState,
    projectPayments: [payment, ...nextState.projectPayments],
  });
}

export function markProjectPaymentReceivedAction(
  state: FinanceState,
  paymentId: string,
  accountId: string,
  receivedDate: string = todayISO()
): FinanceState {
  const payment = state.projectPayments.find((p) => p.id === paymentId);
  if (!payment || payment.isVoided || payment.status === 'received') return state;
  const project = state.projects.find((p) => p.id === payment.projectId);

  const linkedReceivables = state.debts.filter(
    (d) =>
      !d.isVoided &&
      d.status === 'active' &&
      d.direction === 'receivable' &&
      d.remainingAmount > 0 &&
      d.projectPaymentId === paymentId
  );

  if (linkedReceivables.length === 0) {
    const res = addTransactionAction(state, {
      type: 'income',
      amount: payment.amount,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'income_freelance',
        'cat-income-freelance',
        'income'
      ),
      accountId,
      date: receivedDate,
      description: `Pembayaran Proyek — ${project?.projectName ?? 'Freelance'}`,
      notes: payment.notes,
      incomeSource: 'freelance',
      projectId: payment.projectId,
    });

    return withSyncBump({
      ...res.state,
      projectPayments: res.state.projectPayments.map((p) =>
        p.id === paymentId
          ? { ...p, status: 'received', receivedDate, accountId, transactionId: res.transaction.id }
          : p
      ),
    });
  }

  const primaryReceivable = linkedReceivables[0];
  const projectRevenueAlreadyRecorded = linkedReceivables.some((d) =>
    Boolean(d.revenueAlreadyRecorded)
  );

  const res = addTransactionAction(state, {
    type: 'income',
    amount: payment.amount,
    categoryId: projectRevenueAlreadyRecorded
      ? resolveSystemCategoryId(state.categories, 'income_other', 'cat-income-other', 'income')
      : resolveSystemCategoryId(
          state.categories,
          'income_freelance',
          'cat-income-freelance',
          'income'
        ),
    accountId,
    date: receivedDate,
    description: `Pembayaran Proyek — ${project?.projectName ?? 'Freelance'}`,
    notes: payment.notes,
    tags: ['piutang', 'penagihan_proyek'],
    incomeSource: 'freelance',
    projectId: payment.projectId,
  });

  const enrichedTx: Transaction = {
    ...res.transaction,
    debtId: primaryReceivable.id,
    transactionNature: 'receivable_collection',
    affectsAccountBalance: true,
    excludeFromIncomeStats: projectRevenueAlreadyRecorded,
  };

  let remainingPaymentBudget = payment.amount;
  const nowISO = new Date().toISOString();
  const createdDebtPayments: DebtPayment[] = [];
  const settledUpdates: Array<{
    debtId: string;
    creditor: string;
    applied: number;
    beforeRemaining: number;
    afterRemaining: number;
  }> = [];

  const updatedDebts = res.state.debts.map((d) => {
    if (
      d.isVoided ||
      d.status !== 'active' ||
      d.direction !== 'receivable' ||
      d.remainingAmount <= 0 ||
      d.projectPaymentId !== paymentId ||
      remainingPaymentBudget <= 0
    ) {
      return d;
    }

    const applied = Math.min(remainingPaymentBudget, d.remainingAmount);
    remainingPaymentBudget -= applied;
    const nextRemaining = Math.max(0, d.remainingAmount - applied);

    createdDebtPayments.push({
      id: generateId(),
      debtId: d.id,
      amount: applied,
      date: receivedDate,
      accountId,
      transactionId: enrichedTx.id,
      notes:
        payment.notes ||
        `Pelunasan piutang dari pembayaran proyek (${project?.projectName ?? 'Freelance'})`,
      createdAt: nowISO,
    });

    settledUpdates.push({
      debtId: d.id,
      creditor: d.creditor,
      applied,
      beforeRemaining: d.remainingAmount,
      afterRemaining: nextRemaining,
    });

    return {
      ...d,
      remainingAmount: nextRemaining,
      status: nextRemaining === 0 ? ('paid' as const) : ('active' as const),
    };
  });

  let nextState: FinanceState = {
    ...res.state,
    transactions: res.state.transactions.map((t) => (t.id === enrichedTx.id ? enrichedTx : t)),
    projectPayments: res.state.projectPayments.map((p) =>
      p.id === paymentId
        ? { ...p, status: 'received', receivedDate, accountId, transactionId: enrichedTx.id }
        : p
    ),
    debts: updatedDebts,
    debtPayments: [...createdDebtPayments, ...res.state.debtPayments],
  };

  for (const upd of settledUpdates) {
    nextState = appendChangeLog(nextState, {
      entityType: 'receivable',
      entityId: upd.debtId,
      action: 'update',
      summary: `Pelunasan otomatis piutang proyek (${upd.creditor}): ${formatIDR(upd.applied)}`,
      beforeValue: formatIDR(upd.beforeRemaining),
      afterValue: formatIDR(upd.afterRemaining),
    });
  }

  return nextState;
}

export function addProjectExpenseAction(
  state: FinanceState,
  input: {
    projectId: string;
    description: string;
    amount: number;
    date: string;
    accountId: string;
    expenseKind?: ProjectExpenseKind;
    creditor?: string;
    dueDate?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const project = state.projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error('Proyek tidak ditemukan.');
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal biaya proyek harus lebih dari Rp0.');
  }

  const expenseKind: ProjectExpenseKind = input.expenseKind ?? 'project_cost';
  const roundedAmount = Math.round(input.amount);

  if (expenseKind === 'project_cost') {
    const res = addTransactionAction(state, {
      type: 'expense',
      amount: roundedAmount,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'business_ops',
        'cat-biz-ops',
        'expense'
      ),
      accountId: input.accountId,
      date: input.date,
      description: `Biaya Proyek (${project.projectName}): ${input.description}`,
      notes: input.notes,
      projectId: project.id,
    });

    return withSyncBump({
      ...res.state,
      projectExpenses: [
        {
          id: generateId(),
          projectId: project.id,
          expenseKind: 'project_cost',
          description: input.description.trim(),
          amount: roundedAmount,
          date: input.date,
          accountId: input.accountId,
          transactionId: res.transaction.id,
          createdAt: new Date().toISOString(),
        },
        ...res.state.projectExpenses,
      ],
    });
  }

  if (input.idempotencyKey) {
    const alreadyRecorded = state.debts.some((d) => d.idempotencyKey === input.idempotencyKey);
    if (alreadyRecorded) return state;
  }

  const balances = computeAccountBalances(state);
  const sourceAcc = balances.find((a) => a.id === input.accountId);
  if (!sourceAcc) throw new Error('Akun sumber dana tidak ditemukan.');
  if ((sourceAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
  }
  if (sourceAcc.currentBalance < roundedAmount) {
    throw new Error(
      `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk talangan proyek sebesar ${formatIDR(roundedAmount)}.`
    );
  }

  const nowISO = new Date().toISOString();
  const expenseId = generateId();
  const debtId = generateId();
  const txId = generateId();
  const ledgerGroupId = generateId();
  const clientLabel = input.creditor?.trim() || project.clientName;
  const cleanDesc = input.description.trim() || 'Biaya reimbursement proyek';

  const tx: Transaction = {
    id: txId,
    type: 'expense',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(state.categories, 'debt_payment', 'cat-debt', 'expense'),
    accountId: sourceAcc.id,
    date: input.date,
    description:
      expenseKind === 'pass_through'
        ? `Biaya Diteruskan (${project.projectName}): ${cleanDesc}`
        : `Talangan Proyek (${project.projectName}): ${cleanDesc}`,
    notes: input.notes?.trim() || `Menunggu penggantian dari ${clientLabel}`,
    tags: ['proyek', 'reimbursement', expenseKind],
    projectId: project.id,
    debtId,
    ledgerGroupId,
    transactionNature: 'project_reimbursement_advance',
    affectsAccountBalance: true,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const receivable: Debt = {
    id: debtId,
    direction: 'receivable',
    receivableType: 'project_reimbursement',
    reimbursementKind: expenseKind,
    accountId: sourceAcc.id,
    transactionId: txId,
    projectId: project.id,
    projectExpenseId: expenseId,
    revenueAlreadyRecorded: true,
    date: input.date,
    idempotencyKey: input.idempotencyKey,
    creditor: clientLabel,
    description: `${expenseKind === 'pass_through' ? 'Pass-Through' : 'Reimbursement'}: ${cleanDesc} (${project.projectName})`,
    initialAmount: roundedAmount,
    remainingAmount: roundedAmount,
    dueDate: input.dueDate || undefined,
    priority: 1,
    status: 'active',
    createdAt: nowISO,
  };

  const projExp: ProjectExpense = {
    id: expenseId,
    projectId: project.id,
    expenseKind,
    linkedReceivableId: debtId,
    description: cleanDesc,
    amount: roundedAmount,
    date: input.date,
    accountId: sourceAcc.id,
    transactionId: txId,
    createdAt: nowISO,
  };

  return appendChangeLog(
    {
      ...state,
      transactions: [tx, ...state.transactions],
      debts: [...state.debts, receivable],
      projectExpenses: [projExp, ...state.projectExpenses],
    },
    {
      entityType: 'receivable',
      entityId: debtId,
      action: 'create',
      summary: `Catat ${expenseKind === 'pass_through' ? 'biaya pass-through' : 'talangan reimbursement'} proyek (${project.projectName}): ${formatIDR(roundedAmount)}`,
      afterValue: `Tagihan ke ${clientLabel}`,
    }
  );
}

export function distributeProjectPersonalShareAction(
  state: FinanceState,
  input: {
    projectId: string;
    amount: number;
    fromAccountId: string;
    toAccountId: string;
    date: string;
  }
): FinanceState {
  const project = state.projects.find((p) => p.id === input.projectId);
  return addTransferAction(state, {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: input.amount,
    date: input.date,
    notes: `Distribusi profit pribadi proyek: ${project?.projectName ?? ''}`,
  });
}

export function addDebtAction(
  state: FinanceState,
  input: {
    direction?: DebtDirection;
    receivableType?: ReceivableKind;
    debtReceiptType?: DebtReceiptKind;
    accountId?: string;
    expenseCategoryId?: string;
    projectId?: string;
    projectPaymentId?: string;
    revenueAlreadyRecorded?: boolean;
    creditor: string;
    description: string;
    amount: number;
    date?: string;
    dueDate?: string;
    priority?: number;
    idempotencyKey?: string;
  }
): FinanceState {
  if (input.idempotencyKey) {
    const alreadyRecorded = state.debts.some((d) => d.idempotencyKey === input.idempotencyKey);
    if (alreadyRecorded) {
      return state;
    }
  }

  if (!input.creditor || !input.creditor.trim()) {
    throw new Error('Nama pihak terkait wajib diisi.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal harus lebih dari Rp0.');
  }

  const direction: DebtDirection = input.direction ?? 'payable';
  const roundedAmount = Math.round(input.amount);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const debtId = generateId();
  const cleanCreditor = input.creditor.trim();
  const cleanDesc = input.description.trim();

  let nextTransactions = state.transactions;
  let nextNoSpend = state.noSpendConfirmations ?? [];
  let linkedTransactionId: string | undefined;
  let resolvedAccountId: string | undefined;
  let resolvedExpenseCategoryId: string | undefined;
  let resolvedRevenueAlreadyRecorded = input.revenueAlreadyRecorded;

  if (direction === 'receivable') {
    if (input.receivableType === 'personal_loan' || input.receivableType === 'friend_advance') {
      const isFriendAdvance = input.receivableType === 'friend_advance';
      if (!input.accountId) {
        throw new Error(
          isFriendAdvance
            ? 'Akun sumber dana wajib dipilih untuk talangan teman.'
            : 'Akun sumber dana wajib dipilih untuk pinjaman uang pribadi.'
        );
      }
      const balances = computeAccountBalances(state);
      const sourceAcc = balances.find((a) => a.id === input.accountId);
      if (!sourceAcc) {
        throw new Error('Akun sumber dana tidak ditemukan.');
      }
      if ((sourceAcc.status ?? 'active') !== 'active') {
        throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
      }
      if (sourceAcc.currentBalance < roundedAmount) {
        throw new Error(
          `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk ${isFriendAdvance ? 'talangan' : 'memberikan pinjaman'} sebesar ${formatIDR(roundedAmount)}.`
        );
      }

      const loanTx: Transaction = {
        id: generateId(),
        type: 'expense',
        amount: roundedAmount,
        categoryId: resolveSystemCategoryId(
          state.categories,
          'debt_payment',
          'cat-debt',
          'expense'
        ),
        accountId: sourceAcc.id,
        date: txDate,
        description: isFriendAdvance
          ? cleanDesc
            ? `Talangan Teman (${cleanCreditor}): ${cleanDesc}`
            : `Talangan Kebutuhan ${cleanCreditor}`
          : `Pinjaman Diberikan ke ${cleanCreditor}`,
        notes: cleanDesc || undefined,
        tags: isFriendAdvance ? ['piutang', 'talangan_teman'] : ['piutang', 'pinjaman_pribadi'],
        debtId,
        transactionNature: isFriendAdvance ? 'friend_advance' : 'loan_disbursement',
        affectsAccountBalance: true,
        excludeFromExpenseStats: true,
        isEssential: false,
        isDiscretionary: false,
        exceededBudget: false,
        isVoided: false,
        createdAt: nowISO,
      };
      nextTransactions = [loanTx, ...nextTransactions];
      linkedTransactionId = loanTx.id;
      resolvedAccountId = sourceAcc.id;
    } else if (input.receivableType === 'project_sales') {
      if (input.projectId) {
        const proj = state.projects.find((p) => p.id === input.projectId);
        if (!proj) {
          throw new Error('Proyek terkait tidak ditemukan.');
        }
        if (resolvedRevenueAlreadyRecorded === undefined) {
          const projReceived = state.projectPayments
            .filter((p) => p.projectId === proj.id && p.status === 'received' && !p.isVoided)
            .reduce((sum, p) => sum + p.amount, 0);
          if (projReceived >= proj.contractValue && proj.contractValue > 0) {
            resolvedRevenueAlreadyRecorded = true;
          }
        }
      }
    }
  } else {
    if (input.debtReceiptType === 'cash_received') {
      if (!input.accountId) {
        throw new Error('Akun penerima dana wajib dipilih.');
      }
      const targetAcc = state.accounts.find((a) => a.id === input.accountId);
      if (!targetAcc) {
        throw new Error('Akun penerima dana tidak ditemukan.');
      }
      if ((targetAcc.status ?? 'active') !== 'active') {
        throw new Error(`Akun "${targetAcc.name}" tidak aktif dan tidak dapat menerima dana.`);
      }

      const receiptTx: Transaction = {
        id: generateId(),
        type: 'income',
        amount: roundedAmount,
        categoryId: resolveSystemCategoryId(
          state.categories,
          'income_other',
          'cat-income-other',
          'income'
        ),
        accountId: targetAcc.id,
        date: txDate,
        description: `Pinjaman Diterima dari ${cleanCreditor}`,
        notes: cleanDesc || undefined,
        tags: ['utang', 'dana_diterima'],
        incomeSource: 'other',
        debtId,
        transactionNature: 'debt_receipt',
        affectsAccountBalance: true,
        excludeFromIncomeStats: true,
        isEssential: false,
        isDiscretionary: false,
        exceededBudget: false,
        isVoided: false,
        createdAt: nowISO,
      };
      nextTransactions = [receiptTx, ...nextTransactions];
      linkedTransactionId = receiptTx.id;
      resolvedAccountId = targetAcc.id;
    } else if (input.debtReceiptType === 'direct_expense') {
      if (!input.expenseCategoryId) {
        throw new Error('Kategori pengeluaran wajib dipilih.');
      }
      const cat = state.categories.find(
        (c) => c.id === input.expenseCategoryId && c.type === 'expense'
      );
      if (!cat) {
        throw new Error('Kategori pengeluaran tidak ditemukan.');
      }
      const nominalAcc =
        state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness) ??
        state.accounts[0];
      if (!nominalAcc) {
        throw new Error('Tidak ada akun referensi pada sistem.');
      }

      const isEssential =
        cat.classification === 'essential' ||
        cat.classification === 'obligation' ||
        cat.classification === 'debt' ||
        cat.classification === 'business';
      const isDiscretionary = !isEssential;

      const directExpenseTx: Transaction = {
        id: generateId(),
        type: 'expense',
        amount: roundedAmount,
        categoryId: cat.id,
        accountId: nominalAcc.id,
        date: txDate,
        description: cleanDesc || `${cat.name} (Dibayar ${cleanCreditor})`,
        notes: `Dibayar langsung oleh ${cleanCreditor} (utang non-kas)`,
        tags: ['utang', 'bayar_langsung'],
        debtId,
        transactionNature: 'debt_direct_expense',
        affectsAccountBalance: false,
        excludeFromExpenseStats: false,
        isEssential,
        isDiscretionary,
        exceededBudget: false,
        isVoided: false,
        createdAt: nowISO,
      };
      nextTransactions = [directExpenseTx, ...nextTransactions];
      if (isDiscretionary) {
        nextNoSpend = nextNoSpend.map((c) =>
          c.date === txDate ? { ...c, status: 'revoked' as const } : c
        );
      }
      linkedTransactionId = directExpenseTx.id;
      resolvedExpenseCategoryId = cat.id;
    }
  }

  const debt: Debt = {
    id: debtId,
    direction,
    receivableType: direction === 'receivable' ? input.receivableType : undefined,
    debtReceiptType: direction === 'payable' ? input.debtReceiptType : undefined,
    accountId: resolvedAccountId,
    expenseCategoryId: resolvedExpenseCategoryId,
    transactionId: linkedTransactionId,
    projectId: direction === 'receivable' ? input.projectId || undefined : undefined,
    projectPaymentId: direction === 'receivable' ? input.projectPaymentId || undefined : undefined,
    revenueAlreadyRecorded:
      direction === 'receivable' && input.receivableType === 'project_sales'
        ? Boolean(resolvedRevenueAlreadyRecorded)
        : undefined,
    date: txDate,
    idempotencyKey: input.idempotencyKey,
    creditor: cleanCreditor,
    description:
      cleanDesc ||
      (direction === 'receivable'
        ? input.receivableType === 'project_sales'
          ? 'Tagihan proyek / penjualan'
          : input.receivableType === 'friend_advance'
          ? 'Talangan kebutuhan teman'
          : input.receivableType === 'split_bill'
          ? 'Bagian split bill'
          : input.receivableType === 'project_reimbursement'
          ? 'Penggantian biaya proyek'
          : 'Pinjaman uang pribadi'
        : input.debtReceiptType === 'direct_expense'
        ? 'Pengeluaran dibayarkan langsung pihak lain'
        : 'Pinjaman dana masuk ke akun'),
    initialAmount: roundedAmount,
    remainingAmount: roundedAmount,
    dueDate: input.dueDate ? input.dueDate : undefined,
    priority: input.priority ?? 1,
    status: 'active',
    createdAt: nowISO,
  };

  return appendChangeLog(
    {
      ...state,
      debts: [...state.debts, debt],
      transactions: nextTransactions,
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: direction === 'receivable' ? 'receivable' : 'debt',
      entityId: debt.id,
      action: 'create',
      summary: `${direction === 'receivable' ? 'Catat piutang baru dari' : 'Catat utang baru ke'} ${debt.creditor}: ${formatIDR(debt.initialAmount)}`,
      afterValue: debt.dueDate ? `Jatuh tempo ${debt.dueDate}` : 'Tanpa jatuh tempo',
    }
  );
}

export function findDefaultActiveDebt(
  debts: Debt[],
  direction: DebtDirection = 'payable'
): Debt | undefined {
  return debts.find(
    (d) =>
      !d.isVoided &&
      d.status === 'active' &&
      d.remainingAmount > 0 &&
      (d.direction ?? 'payable') === direction
  );
}

export function updateDebtAction(
  state: FinanceState,
  debtId: string,
  updates: {
    creditor?: string;
    description?: string;
    dueDate?: string | null;
    priority?: number;
  }
): FinanceState {
  const existing = state.debts.find((d) => d.id === debtId);
  if (!existing) throw new Error('Catatan utang/piutang tidak ditemukan.');
  if (existing.isVoided) {
    throw new Error('Catatan utang/piutang yang sudah dibatalkan (void) tidak dapat diedit.');
  }

  const nextDue = updates.dueDate === null || updates.dueDate === '' ? undefined : updates.dueDate ?? existing.dueDate;

  const next: FinanceState = {
    ...state,
    debts: state.debts.map((d) =>
      d.id === debtId
        ? {
            ...d,
            creditor: updates.creditor?.trim() || d.creditor,
            description: updates.description !== undefined ? updates.description.trim() : d.description,
            dueDate: nextDue,
            priority: updates.priority ?? d.priority,
          }
        : d
    ),
  };

  return appendChangeLog(next, {
    entityType: existing.direction === 'receivable' ? 'receivable' : 'debt',
    entityId: debtId,
    action: 'update',
    summary: `Perbarui ${existing.direction === 'receivable' ? 'piutang' : 'utang'} (${existing.creditor})`,
    beforeValue: existing.dueDate ?? 'Tanpa jatuh tempo',
    afterValue: nextDue ?? 'Tanpa jatuh tempo',
  });
}

export function repayDebtAction(
  state: FinanceState,
  input: {
    debtId: string;
    amount: number;
    accountId: string;
    date: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  if (input.idempotencyKey) {
    const alreadyRecorded = state.debtPayments.some(
      (dp) => dp.idempotencyKey === input.idempotencyKey
    );
    if (alreadyRecorded) {
      return state;
    }
  }

  const debt = state.debts.find((d) => d.id === input.debtId);
  if (!debt) throw new Error('Data utang tidak ditemukan.');
  if (debt.isVoided) throw new Error('Catatan utang ini sudah dibatalkan (void).');
  if ((debt.direction ?? 'payable') === 'receivable') {
    throw new Error('Gunakan penerimaan piutang untuk catatan piutang.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal pembayaran harus lebih dari Rp0.');
  }
  if (debt.status === 'paid' || debt.remainingAmount <= 0) {
    throw new Error('Utang ini sudah lunas.');
  }

  const requestedAmount = Math.round(input.amount);
  if (requestedAmount > debt.remainingAmount) {
    throw new Error(
      `Nominal pembayaran (${formatIDR(requestedAmount)}) melebihi sisa utang (${formatIDR(debt.remainingAmount)}).`
    );
  }
  const payAmount = requestedAmount;
  const balances = computeAccountBalances(state);
  const sourceAcc = balances.find((a) => a.id === input.accountId);
  if (!sourceAcc) {
    throw new Error('Akun pembayaran utang tidak ditemukan.');
  }
  if ((sourceAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
  }
  if (sourceAcc.currentBalance < payAmount) {
    throw new Error(
      `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk membayar utang sebesar ${formatIDR(payAmount)}.`
    );
  }

  const nowISO = new Date().toISOString();
  const tx: Transaction = {
    id: generateId(),
    type: 'expense',
    amount: payAmount,
    categoryId: resolveSystemCategoryId(state.categories, 'debt_payment', 'cat-debt', 'expense'),
    accountId: sourceAcc.id,
    date: input.date,
    description: `Cicil/Bayar Utang: ${debt.creditor}`,
    notes: input.notes?.trim() || undefined,
    tags: ['utang', 'pelunasan'],
    debtId: debt.id,
    transactionNature: 'debt_repayment',
    affectsAccountBalance: true,
    excludeFromExpenseStats: true,
    isEssential: true,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const newRemaining = Math.max(0, debt.remainingAmount - payAmount);

  const nextState: FinanceState = {
    ...state,
    transactions: [tx, ...state.transactions],
    debts: state.debts.map((d) =>
      d.id === debt.id
        ? { ...d, remainingAmount: newRemaining, status: newRemaining === 0 ? 'paid' : 'active' }
        : d
    ),
    debtPayments: [
      {
        id: generateId(),
        debtId: debt.id,
        amount: payAmount,
        date: input.date,
        accountId: sourceAcc.id,
        transactionId: tx.id,
        notes: input.notes?.trim() || undefined,
        idempotencyKey: input.idempotencyKey,
        createdAt: nowISO,
      },
      ...state.debtPayments,
    ],
  };

  return appendChangeLog(nextState, {
    entityType: 'debt',
    entityId: debt.id,
    action: 'update',
    summary: `Bayar utang ke ${debt.creditor}: ${formatIDR(payAmount)}`,
    beforeValue: formatIDR(debt.remainingAmount),
    afterValue: formatIDR(newRemaining),
  });
}

export function collectReceivableAction(
  state: FinanceState,
  input: {
    debtId: string;
    amount: number;
    accountId: string;
    date: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  if (input.idempotencyKey) {
    const alreadyRecorded = state.debtPayments.some(
      (dp) => dp.idempotencyKey === input.idempotencyKey
    );
    if (alreadyRecorded) {
      return state;
    }
  }

  const item = state.debts.find((d) => d.id === input.debtId);
  if (!item) throw new Error('Data piutang tidak ditemukan.');
  if (item.isVoided) throw new Error('Catatan piutang ini sudah dibatalkan (void).');
  if (item.direction !== 'receivable') throw new Error('Item ini bukan piutang.');
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal penerimaan harus lebih dari Rp0.');
  }
  if (item.status === 'paid' || item.remainingAmount <= 0) {
    throw new Error('Piutang ini sudah lunas diterima.');
  }

  const targetAcc = state.accounts.find((a) => a.id === input.accountId);
  if (!targetAcc) {
    throw new Error('Akun penerima pembayaran piutang tidak ditemukan.');
  }
  if ((targetAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${targetAcc.name}" tidak aktif dan tidak dapat menerima dana.`);
  }

  const requestedAmount = Math.round(input.amount);
  if (requestedAmount > item.remainingAmount) {
    throw new Error(
      `Nominal penerimaan (${formatIDR(requestedAmount)}) melebihi sisa piutang (${formatIDR(item.remainingAmount)}).`
    );
  }
  const collectAmount = requestedAmount;

  // Prevent double-counting project revenue or treating personal loan / split bill / friend advance / reimbursement return as new income
  const linkedProjectPayment = item.projectPaymentId
    ? state.projectPayments.find((p) => p.id === item.projectPaymentId && !p.isVoided)
    : undefined;
  const linkedProject = item.projectId
    ? state.projects.find((p) => p.id === item.projectId)
    : undefined;
  const linkedProjectReceivedTotal = linkedProject
    ? state.projectPayments
        .filter((p) => p.projectId === linkedProject.id && p.status === 'received' && !p.isVoided)
        .reduce((sum, p) => sum + p.amount, 0)
    : 0;

  const isNonIncomeReturn =
    item.receivableType === 'personal_loan' ||
    item.receivableType === 'split_bill' ||
    item.receivableType === 'friend_advance' ||
    item.receivableType === 'project_reimbursement' ||
    item.receivableType === 'asset_sale' ||
    item.receivableType === 'asset_loss_compensation';
  const projectRevenueAlreadyCounted =
    Boolean(item.revenueAlreadyRecorded) ||
    linkedProjectPayment?.status === 'received' ||
    Boolean(
      linkedProject &&
        linkedProject.contractValue > 0 &&
        linkedProjectReceivedTotal >= linkedProject.contractValue
    );
  const excludeFromIncomeStats = isNonIncomeReturn || projectRevenueAlreadyCounted;

  const isProjectSalesReceivable =
    item.receivableType === 'project_sales' ||
    (Boolean(item.projectId) && item.receivableType !== 'project_reimbursement');
  const isReimbursement = item.receivableType === 'project_reimbursement';
  const isAssetSale = item.receivableType === 'asset_sale';
  const isAssetCompensation = item.receivableType === 'asset_loss_compensation';
  const nowISO = new Date().toISOString();

  const tx: Transaction = {
    id: generateId(),
    type: 'income',
    amount: collectAmount,
    categoryId:
      isProjectSalesReceivable && !excludeFromIncomeStats
        ? resolveSystemCategoryId(
            state.categories,
            'income_freelance',
            'cat-income-freelance',
            'income'
          )
        : resolveSystemCategoryId(state.categories, 'income_other', 'cat-income-other', 'income'),
    accountId: targetAcc.id,
    date: input.date,
    description: isReimbursement
      ? `Penggantian Biaya Proyek: ${item.creditor}`
      : isAssetSale
      ? `Terima Cicilan/Pelunasan Penjualan Aset: ${item.creditor}`
      : isAssetCompensation
      ? `Terima Ganti Rugi Aset Hilang: ${item.creditor}`
      : `Terima Piutang: ${item.creditor}`,
    notes: input.notes?.trim() || undefined,
    tags: [
      'piutang',
      isReimbursement
        ? 'reimbursement_proyek'
        : isAssetSale
        ? 'penjualan_aset'
        : isAssetCompensation
        ? 'ganti_rugi_aset'
        : item.receivableType === 'split_bill'
        ? 'split_bill'
        : item.receivableType === 'friend_advance'
        ? 'talangan_teman'
        : isProjectSalesReceivable
        ? 'penagihan_proyek'
        : 'pengembalian_pinjaman',
    ],
    incomeSource: isProjectSalesReceivable ? 'freelance' : 'other',
    projectId: item.projectId,
    debtId: item.id,
    splitBillId: item.splitBillId,
    assetId: item.assetId,
    physicalLoanId: item.physicalLoanId,
    transactionNature: isReimbursement ? 'reimbursement_collection' : 'receivable_collection',
    affectsAccountBalance: true,
    excludeFromIncomeStats,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const newRemaining = Math.max(0, item.remainingAmount - collectAmount);

  // Synchronize linked ProjectPayment across both full and partial receivable collections
  let nextProjectPayments = state.projectPayments;
  if (linkedProjectPayment && linkedProjectPayment.status === 'expected') {
    if (newRemaining === 0) {
      nextProjectPayments = state.projectPayments.map((pp) =>
        pp.id === linkedProjectPayment.id
          ? {
              ...pp,
              amount: collectAmount,
              status: 'received' as const,
              receivedDate: input.date,
              accountId: targetAcc.id,
              transactionId: tx.id,
            }
          : pp
      );
    } else {
      const nextExpectedAmount = Math.max(0, linkedProjectPayment.amount - collectAmount);
      const installmentPayment: ProjectPayment = {
        id: generateId(),
        projectId: linkedProjectPayment.projectId,
        paymentType: 'installment',
        amount: collectAmount,
        status: 'received',
        expectedDate: linkedProjectPayment.expectedDate,
        receivedDate: input.date,
        accountId: targetAcc.id,
        transactionId: tx.id,
        notes: input.notes?.trim() || `Cicilan piutang proyek (${item.creditor})`,
        isVoided: false,
        createdAt: nowISO,
      };
      nextProjectPayments = [
        installmentPayment,
        ...state.projectPayments.map((pp) =>
          pp.id === linkedProjectPayment.id
            ? {
                ...pp,
                amount: nextExpectedAmount,
              }
            : pp
        ),
      ];
    }
  }

  const nextState: FinanceState = {
    ...state,
    transactions: [tx, ...state.transactions],
    projectPayments: nextProjectPayments,
    debts: state.debts.map((d) =>
      d.id === item.id
        ? { ...d, remainingAmount: newRemaining, status: newRemaining === 0 ? 'paid' : 'active' }
        : d
    ),
    debtPayments: [
      {
        id: generateId(),
        debtId: item.id,
        amount: collectAmount,
        date: input.date,
        accountId: targetAcc.id,
        transactionId: tx.id,
        notes: input.notes?.trim() || 'Penerimaan pelunasan piutang',
        idempotencyKey: input.idempotencyKey,
        createdAt: nowISO,
      },
      ...state.debtPayments,
    ],
  };

  return appendChangeLog(nextState, {
    entityType: 'receivable',
    entityId: item.id,
    action: 'update',
    summary: `Terima piutang dari ${item.creditor}: ${formatIDR(collectAmount)}`,
    beforeValue: formatIDR(item.remainingAmount),
    afterValue: formatIDR(newRemaining),
  });
}

export function voidDebtPaymentAction(
  state: FinanceState,
  debtPaymentId: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const dp = state.debtPayments.find((p) => p.id === debtPaymentId);
  if (!dp) {
    throw new Error('Catatan pembayaran utang/piutang tidak ditemukan.');
  }
  if (dp.isVoided) {
    return state;
  }

  const parentDebt = state.debts.find((d) => d.id === dp.debtId);
  if (!parentDebt) {
    throw new Error('Data utang/piutang induk untuk pembayaran ini tidak ditemukan.');
  }
  if (parentDebt.isVoided) {
    throw new Error('Catatan utang/piutang induk sudah dalam status void.');
  }

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const restoredRemaining = Math.min(
    parentDebt.initialAmount,
    parentDebt.remainingAmount + dp.amount
  );
  const restoredStatus: Debt['status'] = restoredRemaining > 0 ? 'active' : 'paid';

  const nextDebtPayments = state.debtPayments.map((p) =>
    p.id === dp.id
      ? {
          ...p,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
        }
      : p
  );

  const nextTransactions = dp.transactionId
    ? state.transactions.map((t) =>
        t.id === dp.transactionId && !t.isVoided
          ? {
              ...t,
              isVoided: true,
              voidedAt: nowISO,
              voidReason: cleanReason,
              exceededBudget: false,
            }
          : t
      )
    : state.transactions;

  const nextDebts = state.debts.map((d) =>
    d.id === parentDebt.id
      ? {
          ...d,
          remainingAmount: restoredRemaining,
          status: restoredStatus,
        }
      : d
  );

  let nextProjectPayments = state.projectPayments;
  if (dp.transactionId) {
    const rootPpId = parentDebt.projectPaymentId;
    const rootPp = rootPpId
      ? state.projectPayments.find((pp) => pp.id === rootPpId && !pp.isVoided)
      : undefined;

    const rootHeldByActiveDebtPayment = Boolean(
      rootPp &&
        rootPp.status === 'received' &&
        rootPp.transactionId &&
        rootPp.transactionId !== dp.transactionId &&
        state.debtPayments.some(
          (otherDp) =>
            otherDp.debtId === parentDebt.id &&
            otherDp.id !== dp.id &&
            !otherDp.isVoided &&
            otherDp.transactionId === rootPp.transactionId
        )
    );

    const preservedActiveReceiptFromRoot: ProjectPayment | null =
      rootHeldByActiveDebtPayment && rootPp
        ? {
            id: generateId(),
            projectId: rootPp.projectId,
            paymentType: rootPp.paymentType === 'full' ? 'installment' : rootPp.paymentType,
            amount: rootPp.amount,
            status: 'received',
            expectedDate: rootPp.expectedDate,
            receivedDate: rootPp.receivedDate,
            accountId: rootPp.accountId,
            transactionId: rootPp.transactionId,
            notes: rootPp.notes,
            isVoided: false,
            createdAt: rootPp.createdAt,
          }
        : null;

    nextProjectPayments = state.projectPayments.map((pp) => {
      if (rootPpId && pp.id === rootPpId) {
        if (pp.transactionId === dp.transactionId) {
          return {
            ...pp,
            status: 'expected' as const,
            amount: restoredRemaining,
            receivedDate: undefined,
            accountId: undefined,
            transactionId: undefined,
          };
        }
        if (pp.status === 'expected') {
          return {
            ...pp,
            amount: restoredRemaining,
          };
        }
        if (preservedActiveReceiptFromRoot) {
          return {
            ...pp,
            status: 'expected' as const,
            amount: restoredRemaining,
            receivedDate: undefined,
            accountId: undefined,
            transactionId: undefined,
          };
        }
        return pp;
      }

      if (pp.transactionId === dp.transactionId && !pp.isVoided) {
        return {
          ...pp,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
        };
      }

      return pp;
    });

    if (preservedActiveReceiptFromRoot) {
      nextProjectPayments = [preservedActiveReceiptFromRoot, ...nextProjectPayments];
    }
  }

  const isReceivable = parentDebt.direction === 'receivable';
  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      debts: nextDebts,
      debtPayments: nextDebtPayments,
      projectPayments: nextProjectPayments,
    },
    {
      entityType: isReceivable ? 'receivable' : 'debt',
      entityId: parentDebt.id,
      action: 'void',
      summary: `Batalkan (void) ${isReceivable ? 'penerimaan piutang' : 'pembayaran utang'} ${parentDebt.creditor}: ${formatIDR(dp.amount)}`,
      beforeValue: formatIDR(parentDebt.remainingAmount),
      afterValue: formatIDR(restoredRemaining),
      note: cleanReason,
    }
  );
}

export function addObligationAction(
  state: FinanceState,
  input: {
    kind?: ObligationKind;
    name: string;
    category: string;
    amount: number;
    frequency: ObligationFrequency;
    durationType?: ObligationDurationType;
    startDate?: string;
    nextDueDate: string;
    endDate?: string;
    reminderEnabled?: boolean;
    reminderDaysBefore?: number;
    linkedDebtId?: string;
  }
): { state: FinanceState; obligation: RecurringObligation } {
  if (input.amount <= 0) throw new Error('Nominal kewajiban/tagihan harus lebih dari Rp0.');
  const cleanName = input.name.trim();
  const kind: ObligationKind = input.kind ?? 'obligation';

  if (input.linkedDebtId) {
    const linked = state.debts.find((d) => d.id === input.linkedDebtId && !d.isVoided);
    if (!linked) {
      throw new Error('Utang terkait (linkedDebtId) tidak ditemukan atau sudah void.');
    }
  }

  const duplicate = state.obligations.find(
    (o) =>
      o.status === 'active' &&
      !o.isArchived &&
      (o.kind ?? 'obligation') === kind &&
      o.name.trim().toLowerCase() === cleanName.toLowerCase() &&
      o.frequency === input.frequency
  );
  if (duplicate) {
    throw new Error(
      `Definisi aktif "${cleanName}" (${input.frequency}) sudah ada. Gunakan satu definisi berulang yang sama dan catat tiap periode lewat Riwayat Pembayaran.`
    );
  }

  const start = input.startDate || input.nextDueDate;
  if (input.endDate && input.endDate < start) {
    throw new Error('Tanggal berakhir tidak boleh lebih awal dari tanggal mulai.');
  }
  const durationType: ObligationDurationType =
    input.durationType ??
    (input.frequency === 'once' ? 'one_time' : input.endDate ? 'fixed_term' : 'indefinite');

  const ob: RecurringObligation = {
    id: generateId(),
    kind,
    name: cleanName,
    category: input.category,
    amount: Math.round(input.amount),
    frequency: input.frequency,
    durationType,
    startDate: start,
    nextDueDate: input.nextDueDate,
    endDate: input.endDate || undefined,
    status: 'active',
    reservedAmount: 0,
    reminderEnabled: input.reminderEnabled ?? true,
    reminderDaysBefore: input.reminderDaysBefore ?? 3,
    linkedDebtId: input.linkedDebtId || undefined,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  const nextState = appendChangeLog(
    { ...state, obligations: [...state.obligations, ob] },
    {
      entityType: kind === 'scheduled_expense' ? 'scheduled_expense' : 'obligation',
      entityId: ob.id,
      action: 'create',
      summary: `Tambah ${kind === 'scheduled_expense' ? 'pengeluaran terjadwal' : 'kewajiban'}: ${ob.name} (${formatIDR(ob.amount)})`,
      afterValue: `${ob.frequency} · mulai ${ob.startDate}${ob.endDate ? ` s.d. ${ob.endDate}` : ''}`,
    }
  );
  return {
    state: nextState,
    obligation: ob,
  };
}

export function updateObligationAction(
  state: FinanceState,
  obligationId: string,
  updates: Partial<
    Pick<
      RecurringObligation,
      | 'kind'
      | 'name'
      | 'category'
      | 'amount'
      | 'frequency'
      | 'durationType'
      | 'startDate'
      | 'nextDueDate'
      | 'endDate'
      | 'status'
      | 'reminderEnabled'
      | 'reminderDaysBefore'
      | 'linkedDebtId'
      | 'isArchived'
    >
  >
): FinanceState {
  const current = state.obligations.find((o) => o.id === obligationId);
  if (!current) throw new Error('Kewajiban tidak ditemukan.');

  if (updates.linkedDebtId) {
    const linked = state.debts.find((d) => d.id === updates.linkedDebtId && !d.isVoided);
    if (!linked) {
      throw new Error('Utang terkait (linkedDebtId) tidak ditemukan atau sudah void.');
    }
  }

  const nextStatus: ObligationStatus = updates.status ?? current.status;
  const nextEnd = updates.endDate !== undefined ? updates.endDate : current.endDate;
  const nextStart = updates.startDate ?? current.startDate;
  if (nextEnd && nextEnd < nextStart) {
    throw new Error('Tanggal berakhir tidak boleh lebih awal dari tanggal mulai.');
  }

  const logs =
    updates.status && updates.status !== current.status
      ? [
          {
            id: generateId(),
            obligationId,
            action: 'status_change' as const,
            amount: current.amount,
            date: todayISO(),
            notes: `Status diubah menjadi ${updates.status}`,
            createdAt: new Date().toISOString(),
          },
          ...state.obligationLogs,
        ]
      : state.obligationLogs;

  const updated = {
    ...state,
    obligations: state.obligations.map((o) =>
      o.id === obligationId
        ? {
            ...o,
            ...updates,
            amount: updates.amount !== undefined ? Math.round(updates.amount) : o.amount,
            status: nextStatus,
            isActive: nextStatus === 'active',
          }
        : o
    ),
    obligationLogs: logs,
  };

  return appendChangeLog(updated, {
    entityType: (updates.kind ?? current.kind) === 'scheduled_expense' ? 'scheduled_expense' : 'obligation',
    entityId: obligationId,
    action: updates.isArchived ? 'archive' : 'update',
    summary: `Perbarui ${(updates.kind ?? current.kind) === 'scheduled_expense' ? 'pengeluaran terjadwal' : 'kewajiban'}: ${updates.name ?? current.name}`,
    beforeValue: `${formatIDR(current.amount)} (${current.status})`,
    afterValue: `${formatIDR(updates.amount ?? current.amount)} (${nextStatus})`,
  });
}

export function archiveObligationAction(state: FinanceState, obligationId: string): FinanceState {
  const current = state.obligations.find((o) => o.id === obligationId);
  if (!current) return state;
  return updateObligationAction(state, obligationId, {
    isArchived: !current.isArchived,
    status: !current.isArchived && current.status === 'active' ? 'paused' : current.status,
  });
}

export function syncExpiredObligationsAction(
  state: FinanceState,
  referenceISO: string = todayISO()
): FinanceState {
  let changed = false;
  const nextObs = state.obligations.map((ob) => {
    if (ob.status === 'active' && ob.endDate && referenceISO > ob.endDate) {
      changed = true;
      return { ...ob, status: 'completed' as const, isActive: false };
    }
    return ob;
  });
  return changed ? { ...state, obligations: nextObs } : state;
}

export function reserveObligationAction(
  state: FinanceState,
  obligationId: string,
  amount: number,
  date: string = todayISO()
): FinanceState {
  const ob = state.obligations.find((o) => o.id === obligationId);
  if (!ob) throw new Error('Kewajiban tidak ditemukan.');
  if (ob.status !== 'active') {
    throw new Error('Kewajiban tidak berstatus aktif sehingga alokasi dihentikan.');
  }
  if (ob.endDate && date > ob.endDate) {
    throw new Error('Kewajiban ini sudah melewati tanggal berakhir.');
  }
  if (amount <= 0) throw new Error('Nominal penyisihan harus lebih dari Rp0.');
  return withSyncBump({
    ...state,
    obligations: state.obligations.map((o) =>
      o.id === obligationId ? { ...o, reservedAmount: o.reservedAmount + Math.round(amount) } : o
    ),
    obligationLogs: [
      {
        id: generateId(),
        obligationId,
        action: 'reserve',
        amount: Math.round(amount),
        date,
        notes: 'Sisihkan dana cadangan kewajiban',
        createdAt: new Date().toISOString(),
      },
      ...state.obligationLogs,
    ],
  });
}

export function payObligationAction(
  state: FinanceState,
  input: {
    obligationId: string;
    amount: number;
    accountId: string;
    date: string;
    notes?: string;
  }
): FinanceState {
  const ob = state.obligations.find((o) => o.id === input.obligationId);
  if (!ob) throw new Error('Kewajiban tidak ditemukan.');
  if (ob.status === 'completed' || ob.status === 'cancelled') {
    throw new Error('Kewajiban yang sudah selesai atau dibatalkan tidak menerima pembayaran baru.');
  }
  if (input.amount <= 0) throw new Error('Nominal pembayaran harus lebih dari Rp0.');

  const res = addTransactionAction(state, {
    type: 'expense',
    amount: input.amount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'college_obligation',
      'cat-college',
      'expense'
    ),
    accountId: input.accountId,
    date: input.date,
    description: `Bayar ${ob.kind === 'scheduled_expense' ? 'Tagihan' : 'Kewajiban'}: ${ob.name}`,
    notes: input.notes,
  });

  const nextDue =
    ob.frequency === 'once'
      ? ob.nextDueDate
      : ob.frequency === 'weekly'
      ? addDaysISO(ob.nextDueDate, 7)
      : ob.frequency === 'yearly'
      ? addDaysISO(ob.nextDueDate, 365)
      : addDaysISO(ob.nextDueDate, 30);

  const shouldComplete =
    ob.frequency === 'once' || Boolean(ob.endDate && nextDue > ob.endDate);

  const nextStatus: ObligationStatus = shouldComplete ? 'completed' : ob.status;
  const remainingReserved = Math.max(0, ob.reservedAmount - Math.round(input.amount));

  return withSyncBump({
    ...res.state,
    obligations: res.state.obligations.map((o) =>
      o.id === ob.id
        ? {
            ...o,
            reservedAmount: remainingReserved,
            nextDueDate: nextDue,
            status: nextStatus,
            isActive: nextStatus === 'active',
          }
        : o
    ),
    obligationLogs: [
      {
        id: generateId(),
        obligationId: ob.id,
        action: 'pay',
        amount: Math.round(input.amount),
        date: input.date,
        accountId: input.accountId,
        transactionId: res.transaction.id,
        notes: input.notes,
        createdAt: new Date().toISOString(),
      },
      ...res.state.obligationLogs,
    ],
  });
}

export function reallocateCompletedObligationAction(
  state: FinanceState,
  input: {
    obligationId: string;
    goalId: string;
    fromAccountId?: string;
    toAccountId?: string;
    date?: string;
  }
): FinanceState {
  const ob = state.obligations.find((o) => o.id === input.obligationId);
  const goal = state.goals.find((g) => g.id === input.goalId);
  if (!ob || !goal) throw new Error('Kewajiban atau target tujuan tidak ditemukan.');

  const date = input.date || todayISO();
  let nextState = state;
  const leftover = ob.reservedAmount;

  if (leftover > 0 && input.fromAccountId) {
    nextState = contributeToGoalAction(nextState, {
      goalId: goal.id,
      amount: leftover,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      date,
      notes: `Pengalihan sisa cadangan kewajiban selesai: ${ob.name}`,
    });
  }

  return withSyncBump({
    ...nextState,
    obligations: nextState.obligations.map((o) =>
      o.id === ob.id
        ? {
            ...o,
            reservedAmount: 0,
            reallocatedToGoalId: goal.id,
            status: 'completed',
            isActive: false,
          }
        : o
    ),
    obligationLogs: [
      {
        id: generateId(),
        obligationId: ob.id,
        action: 'reallocate',
        amount: leftover > 0 ? leftover : ob.amount,
        date,
        notes: `Alokasi dialihkan ke target: ${goal.name}`,
        createdAt: new Date().toISOString(),
      },
      ...nextState.obligationLogs,
    ],
  });
}

export function contributeToGoalAction(
  state: FinanceState,
  input: {
    goalId: string;
    amount: number;
    fromAccountId: string;
    toAccountId?: string;
    date: string;
    notes?: string;
  }
): FinanceState {
  const goal = state.goals.find((g) => g.id === input.goalId);
  if (!goal) throw new Error('Target tabungan tidak ditemukan.');
  if (input.amount <= 0) throw new Error('Nominal setoran tabungan harus lebih dari Rp0.');

  const rounded = Math.round(input.amount);
  let nextState = state;
  let transferId: string | undefined;
  let virtualDelta = 0;

  if (input.toAccountId && input.toAccountId !== input.fromAccountId) {
    const transfer: AccountTransfer = {
      id: generateId(),
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: rounded,
      date: input.date,
      notes: `Setoran Target: ${goal.name}`,
      createdAt: new Date().toISOString(),
    };
    transferId = transfer.id;
    nextState = { ...nextState, transfers: [transfer, ...nextState.transfers] };
  } else {
    virtualDelta = rounded;
  }

  return withSyncBump({
    ...nextState,
    goals: nextState.goals.map((g) =>
      g.id === goal.id
        ? {
            ...g,
            currentAmount: g.currentAmount + rounded,
            virtualReservedInLiquid: g.virtualReservedInLiquid + virtualDelta,
          }
        : g
    ),
    goalContributions: [
      {
        id: generateId(),
        goalId: goal.id,
        amount: rounded,
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        transferId,
        notes: input.notes,
        createdAt: new Date().toISOString(),
      },
      ...nextState.goalContributions,
    ],
  });
}

export function addGoalAction(
  state: FinanceState,
  input: {
    name: string;
    goalType: GoalType;
    targetAmount: number;
    monthlyTarget: number;
    targetDate?: string;
    priority?: number;
  }
): FinanceState {
  if (input.targetAmount <= 0) throw new Error('Target nominal harus lebih dari Rp0.');
  const goal: SavingsGoal = {
    id: generateId(),
    name: input.name.trim(),
    goalType: input.goalType,
    targetAmount: Math.round(input.targetAmount),
    currentAmount: 0,
    virtualReservedInLiquid: 0,
    targetDate: input.targetDate || undefined,
    priority: input.priority ?? state.goals.length + 1,
    monthlyTarget: Math.round(input.monthlyTarget),
    isProtected: true,
    createdAt: new Date().toISOString(),
  };
  return appendChangeLog(
    { ...state, goals: [...state.goals, goal] },
    {
      entityType: 'goal',
      entityId: goal.id,
      action: 'create',
      summary: `Buat target baru: ${goal.name} (${formatIDR(goal.targetAmount)})`,
      afterValue: formatIDR(goal.targetAmount),
    }
  );
}

export function archiveGoalAction(state: FinanceState, goalId: string): FinanceState {
  const g = state.goals.find((x) => x.id === goalId);
  if (!g) return state;
  const next = {
    ...state,
    goals: state.goals.map((x) => (x.id === goalId ? { ...x, isArchived: !x.isArchived } : x)),
  };
  return appendChangeLog(next, {
    entityType: 'goal',
    entityId: goalId,
    action: 'archive',
    summary: `${g.isArchived ? 'Aktifkan kembali' : 'Arsipkan'} target: ${g.name}`,
  });
}

export function addAccountAction(
  state: FinanceState,
  input: {
    name: string;
    accountType: Account['accountType'];
    openingBalance: number;
    isBusiness: boolean;
  }
): FinanceState {
  if (!input.name.trim()) throw new Error('Nama akun wajib diisi.');
  if (input.openingBalance < 0) throw new Error('Saldo awal tidak boleh negatif.');
  const acc: Account = {
    id: generateId(),
    name: input.name.trim(),
    accountType: input.accountType,
    openingBalance: Math.round(input.openingBalance),
    isBusiness: input.isBusiness,
    isProtected: input.accountType === 'savings' || input.accountType === 'investment' || input.isBusiness,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  return appendChangeLog(
    { ...state, accounts: [...state.accounts, acc] },
    {
      entityType: 'account',
      entityId: acc.id,
      action: 'create',
      summary: `Tambah akun baru: ${acc.name}`,
      afterValue: `Saldo awal ${formatIDR(acc.openingBalance)}`,
    }
  );
}

export function editAccountAction(
  state: FinanceState,
  accountId: string,
  updates: {
    name: string;
    accountType: Account['accountType'];
    openingBalance: number;
    isBusiness: boolean;
  }
): FinanceState {
  if (!updates.name.trim()) throw new Error('Nama akun wajib diisi.');
  if (updates.openingBalance < 0) throw new Error('Saldo awal tidak boleh negatif.');
  const prev = state.accounts.find((a) => a.id === accountId);
  const next = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === accountId
        ? {
            ...a,
            name: updates.name.trim(),
            accountType: updates.accountType,
            openingBalance: Math.round(updates.openingBalance),
            isBusiness: updates.isBusiness,
            isProtected:
              updates.accountType === 'savings' ||
              updates.accountType === 'investment' ||
              updates.isBusiness,
          }
        : a
    ),
  };
  return appendChangeLog(next, {
    entityType: 'account',
    entityId: accountId,
    action: 'update',
    summary: `Edit akun: ${updates.name.trim()}`,
    beforeValue: prev ? `${prev.name} (awal ${formatIDR(prev.openingBalance)})` : undefined,
    afterValue: `${updates.name.trim()} (awal ${formatIDR(updates.openingBalance)})`,
  });
}

export function archiveAccountAction(state: FinanceState, accountId: string): FinanceState {
  const activeCount = state.accounts.filter((a) => (a.status ?? 'active') === 'active').length;
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error('Akun tidak ditemukan.');
  if ((acc.status ?? 'active') === 'active' && activeCount <= 1) {
    throw new Error('Minimal harus tersisa satu akun aktif.');
  }

  const nextStatus = (acc.status ?? 'active') === 'archived' ? 'active' : 'archived';
  const next = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === accountId
        ? {
            ...a,
            status: nextStatus as Account['status'],
            archivedAt: nextStatus === 'archived' ? new Date().toISOString() : undefined,
          }
        : a
    ),
  };
  return appendChangeLog(next, {
    entityType: 'account',
    entityId: accountId,
    action: nextStatus === 'archived' ? 'archive' : 'reopen',
    summary: `${nextStatus === 'archived' ? 'Arsipkan' : 'Aktifkan kembali'} akun: ${acc.name}`,
  });
}

export function closeAccountAction(state: FinanceState, accountId: string): FinanceState {
  const activeCount = state.accounts.filter((a) => (a.status ?? 'active') === 'active').length;
  const balances = computeAccountBalances(state);
  const acc = balances.find((a) => a.id === accountId);
  if (!acc) throw new Error('Akun tidak ditemukan.');
  if ((acc.status ?? 'active') === 'active' && activeCount <= 1) {
    throw new Error('Minimal harus tersisa satu akun aktif.');
  }
  if (Math.abs(acc.currentBalance) > 0) {
    throw new Error(
      `Saldo akun "${acc.name}" masih ${formatIDR(acc.currentBalance)}. Transfer atau rekonsiliasi saldo ke Rp0 sebelum menutup akun.`
    );
  }

  const next = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === accountId
        ? {
            ...a,
            status: 'closed' as const,
            closedAt: new Date().toISOString(),
          }
        : a
    ),
  };
  return appendChangeLog(next, {
    entityType: 'account',
    entityId: accountId,
    action: 'close',
    summary: `Tutup akun secara permanen: ${acc.name}`,
  });
}

export function reopenAccountAction(state: FinanceState, accountId: string): FinanceState {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error('Akun tidak ditemukan.');
  const next = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === accountId
        ? { ...a, status: 'active' as const, archivedAt: undefined, closedAt: undefined }
        : a
    ),
  };
  return appendChangeLog(next, {
    entityType: 'account',
    entityId: accountId,
    action: 'reopen',
    summary: `Buka kembali akun: ${acc.name}`,
  });
}

export function reconcileAccountAction(
  state: FinanceState,
  input: {
    accountId: string;
    actualBalance: number;
    date?: string;
    note?: string;
  }
): FinanceState {
  if (!Number.isFinite(input.actualBalance) || input.actualBalance < 0) {
    throw new Error('Saldo aktual tidak valid atau negatif.');
  }
  const balances = computeAccountBalances(state);
  const acc = balances.find((a) => a.id === input.accountId);
  if (!acc) throw new Error('Akun tidak ditemukan.');

  const target = Math.round(input.actualBalance);
  const delta = target - acc.currentBalance;
  if (delta === 0) return state;

  const date = input.date || todayISO();
  const tx: Transaction = {
    id: generateId(),
    type: delta > 0 ? 'income' : 'expense',
    amount: Math.abs(delta),
    categoryId:
      delta > 0
        ? resolveSystemCategoryId(state.categories, 'income_other', 'cat-income-other', 'income')
        : resolveSystemCategoryId(state.categories, 'other_expense', 'cat-other-exp', 'expense'),
    accountId: acc.id,
    date,
    description: `Rekonsiliasi Saldo: ${acc.name}`,
    notes: input.note?.trim() || `Penyesuaian saldo aktual dari ${formatIDR(acc.currentBalance)} ke ${formatIDR(target)}`,
    tags: ['rekonsiliasi'],
    incomeSource: undefined,
    transactionNature: 'reconciliation',
    affectsAccountBalance: true,
    excludeFromIncomeStats: true,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: new Date().toISOString(),
  };

  return appendChangeLog(
    { ...state, transactions: [tx, ...state.transactions] },
    {
      entityType: 'account',
      entityId: acc.id,
      action: 'reconcile',
      summary: `Rekonsiliasi saldo ${acc.name}: ${formatIDR(acc.currentBalance)} -> ${formatIDR(target)}`,
      beforeValue: formatIDR(acc.currentBalance),
      afterValue: formatIDR(target),
      note: input.note?.trim() || undefined,
    }
  );
}

export function deleteAccountAction(state: FinanceState, accountId: string): FinanceState {
  if (state.accounts.length <= 1) {
    throw new Error('Minimal harus tersisa satu akun aktif di dalam sistem.');
  }
  const usedInTx = state.transactions.filter((t) => t.accountId === accountId).length;
  const usedInTransfer = state.transfers.filter(
    (t) => t.fromAccountId === accountId || t.toAccountId === accountId
  ).length;
  const usedInProjPay = state.projectPayments.filter((p) => p.accountId === accountId).length;
  const usedInProjExp = state.projectExpenses.filter((e) => e.accountId === accountId).length;
  const usedInDebtPayments = state.debtPayments.filter((d) => d.accountId === accountId).length;
  const usedInDebts = state.debts.filter((d) => d.accountId === accountId).length;
  const usedInCustodial = (state.custodialFunds ?? []).filter(
    (cf) =>
      cf.holdingAccountId === accountId ||
      cf.fundAllocations.some((a) => a.accountId === accountId) ||
      cf.returns.some((r) => r.accountId === accountId)
  ).length;
  const usedInAdvances = (state.projectAdvances ?? []).filter(
    (pa) =>
      pa.holdingAccountId === accountId ||
      pa.fundAllocations.some((a) => a.accountId === accountId) ||
      pa.refunds.some((r) => r.accountId === accountId)
  ).length;

  const totalRefs =
    usedInTx +
    usedInTransfer +
    usedInProjPay +
    usedInProjExp +
    usedInDebtPayments +
    usedInDebts +
    usedInCustodial +
    usedInAdvances;
  if (totalRefs > 0) {
    throw new Error(
      `Akun tidak dapat dihapus karena masih terhubung dengan ${totalRefs} catatan transaksi/transfer. Gunakan fitur Arsipkan atau Tutup Akun agar riwayat tetap terjaga.`
    );
  }

  return appendChangeLog(
    { ...state, accounts: state.accounts.filter((a) => a.id !== accountId) },
    {
      entityType: 'account',
      entityId: accountId,
      action: 'delete',
      summary: `Hapus akun kosong (${accountId})`,
    }
  );
}

export function addCategoryAction(
  state: FinanceState,
  input: {
    name: string;
    type: 'income' | 'expense';
    classification: CategoryClassification;
    weeklyLimit?: number;
    monthlyLimit?: number;
  }
): FinanceState {
  const cleanName = input.name.trim();
  if (!cleanName) throw new Error('Nama kategori wajib diisi.');
  const exists = state.categories.find(
    (c) => c.type === input.type && c.name.trim().toLowerCase() === cleanName.toLowerCase()
  );
  if (exists) {
    throw new Error(`Kategori "${cleanName}" sudah ada.`);
  }
  const cat: Category = {
    id: generateId(),
    name: cleanName,
    type: input.type,
    classification: input.type === 'income' ? 'income' : input.classification,
    weeklyLimit: Math.max(0, Math.round(input.weeklyLimit ?? 0)),
    monthlyLimit: Math.max(0, Math.round(input.monthlyLimit ?? 0)),
    isSystem: false,
    isArchived: false,
  };
  return appendChangeLog(
    { ...state, categories: [...state.categories, cat] },
    {
      entityType: 'category',
      entityId: cat.id,
      action: 'create',
      summary: `Tambah kategori ${cat.type === 'income' ? 'pemasukan' : 'pengeluaran'}: ${cat.name}`,
    }
  );
}

export function editCategoryAction(
  state: FinanceState,
  categoryId: string,
  updates: { name?: string; weeklyLimit?: number; monthlyLimit?: number; classification?: CategoryClassification }
): FinanceState {
  const prev = state.categories.find((c) => c.id === categoryId);
  if (!prev) throw new Error('Kategori tidak ditemukan.');

  const next = {
    ...state,
    categories: state.categories.map((c) =>
      c.id === categoryId
        ? {
            ...c,
            name: updates.name?.trim() || c.name,
            weeklyLimit: updates.weeklyLimit !== undefined ? Math.max(0, Math.round(updates.weeklyLimit)) : c.weeklyLimit,
            monthlyLimit: updates.monthlyLimit !== undefined ? Math.max(0, Math.round(updates.monthlyLimit)) : c.monthlyLimit,
            classification: c.isSystem ? c.classification : updates.classification ?? c.classification,
          }
        : c
    ),
  };
  return appendChangeLog(next, {
    entityType: 'category',
    entityId: categoryId,
    action: 'update',
    summary: `Perbarui kategori: ${updates.name?.trim() || prev.name}`,
    beforeValue: `Batas minggu ${formatIDR(prev.weeklyLimit)}`,
    afterValue: `Batas minggu ${formatIDR(updates.weeklyLimit ?? prev.weeklyLimit)}`,
  });
}

export function archiveCategoryAction(state: FinanceState, categoryId: string): FinanceState {
  const cat = state.categories.find((c) => c.id === categoryId);
  if (!cat) return state;
  const next = {
    ...state,
    categories: state.categories.map((c) =>
      c.id === categoryId ? { ...c, isArchived: !c.isArchived } : c
    ),
  };
  return appendChangeLog(next, {
    entityType: 'category',
    entityId: categoryId,
    action: cat.isArchived ? 'reopen' : 'archive',
    summary: `${cat.isArchived ? 'Aktifkan kembali' : 'Arsipkan'} kategori: ${cat.name}`,
  });
}

export function installGeneralPresetCategoriesAction(state: FinanceState): FinanceState {
  const existingIds = new Set(state.categories.map((c) => c.id));
  const existingSystemKeys = new Set(
    state.categories
      .map((c) => c.systemKey ?? SYSTEM_CATEGORY_KEY_MAP[c.id])
      .filter((k): k is string => Boolean(k))
  );
  const existingTypeNames = new Set(
    state.categories.map((c) => `${c.type}:${c.name.trim().toLowerCase()}`)
  );
  const additions: Category[] = GENERAL_CATEGORY_PRESETS.filter(
    (p) =>
      !existingIds.has(p.id) &&
      !(p.systemKey && existingSystemKeys.has(p.systemKey)) &&
      !existingTypeNames.has(`${p.type}:${p.name.trim().toLowerCase()}`)
  ).map((p) => ({ ...p, id: generateId(), isSystem: false, isArchived: false }));
  if (additions.length === 0) return state;
  return appendChangeLog(
    { ...state, categories: [...state.categories, ...additions] },
    {
      entityType: 'category',
      entityId: 'presets',
      action: 'create',
      summary: `Tambahkan ${additions.length} kategori umum jangka panjang (gaji, kos/sewa, tagihan, pajak, dll.)`,
    }
  );
}

export function confirmNoSpendDayAction(
  state: FinanceState,
  date: string,
  note?: string,
  referenceISO: string = todayISO()
): FinanceState {
  if (date > referenceISO) {
    throw new Error(
      `Tanggal mendatang (${date}) tidak boleh dikonfirmasi sebagai Hari Tanpa Jajan.`
    );
  }

  const hasDiscretionaryOnDate = state.transactions.some(
    (t) => !t.isVoided && t.type === 'expense' && t.date === date && t.isDiscretionary
  );
  if (hasDiscretionaryOnDate) {
    throw new Error(
      'Tidak dapat mengonfirmasi Hari Tanpa Jajan karena sudah terdapat pengeluaran konsumtif pada tanggal tersebut.'
    );
  }

  const existing = state.noSpendConfirmations ?? [];
  const filtered = existing.filter((c) => c.date !== date);
  return withSyncBump({
    ...state,
    noSpendConfirmations: [
      ...filtered,
      {
        date,
        status: 'confirmed',
        note: note?.trim() || undefined,
        confirmedAt: new Date().toISOString(),
      },
    ],
  });
}

export function revokeNoSpendDayAction(state: FinanceState, date: string): FinanceState {
  return withSyncBump({
    ...state,
    noSpendConfirmations: (state.noSpendConfirmations ?? []).filter((c) => c.date !== date),
  });
}

export function updateReminderSettingsAction(
  state: FinanceState,
  partial: Partial<ReminderSettings>
): FinanceState {
  return withSyncBump({
    ...state,
    settings: {
      ...state.settings,
      reminderSettings: {
        ...state.settings.reminderSettings,
        ...partial,
      },
    },
  });
}

export function snoozeReminderAction(
  state: FinanceState,
  reminderId: string,
  days: number = 1,
  referenceISO: string = todayISO()
): FinanceState {
  const prevStates = state.settings.reminderSettings.reminderStates ?? {};
  return updateReminderSettingsAction(state, {
    reminderStates: {
      ...prevStates,
      [reminderId]: {
        status: 'snoozed',
        snoozedUntil: addDaysISO(referenceISO, Math.max(1, days)),
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

export function completeReminderAction(state: FinanceState, reminderId: string): FinanceState {
  const prevStates = state.settings.reminderSettings.reminderStates ?? {};
  return updateReminderSettingsAction(state, {
    reminderStates: {
      ...prevStates,
      [reminderId]: {
        status: 'completed',
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

export function disableReminderAction(state: FinanceState, reminderId: string): FinanceState {
  const prevStates = state.settings.reminderSettings.reminderStates ?? {};
  return updateReminderSettingsAction(state, {
    reminderStates: {
      ...prevStates,
      [reminderId]: {
        status: 'disabled',
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

export function resetReminderStateAction(state: FinanceState, reminderId: string): FinanceState {
  const prevStates = { ...(state.settings.reminderSettings.reminderStates ?? {}) };
  delete prevStates[reminderId];
  return updateReminderSettingsAction(state, { reminderStates: prevStates });
}

export function addCustomReminderAction(
  state: FinanceState,
  input: { title: string; date: string; note?: string }
): FinanceState {
  if (!input.title.trim()) throw new Error('Judul pengingat wajib diisi.');
  const rem: CustomReminder = {
    id: generateId(),
    title: input.title.trim(),
    date: input.date,
    note: input.note?.trim() || undefined,
    enabled: true,
  };
  return updateReminderSettingsAction(state, {
    customReminders: [...(state.settings.reminderSettings.customReminders ?? []), rem],
  });
}

export function toggleCustomReminderAction(state: FinanceState, id: string): FinanceState {
  const list = state.settings.reminderSettings.customReminders ?? [];
  return updateReminderSettingsAction(state, {
    customReminders: list.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
  });
}

export function deleteCustomReminderAction(state: FinanceState, id: string): FinanceState {
  const list = state.settings.reminderSettings.customReminders ?? [];
  return updateReminderSettingsAction(state, {
    customReminders: list.filter((r) => r.id !== id),
  });
}

export function updateProjectionAssumptionsAction(
  state: FinanceState,
  partial: Partial<ProjectionAssumptions>
): FinanceState {
  return withSyncBump({
    ...state,
    projectionAssumptions: {
      ...DEFAULT_PROJECTION_ASSUMPTIONS,
      ...(state.projectionAssumptions ?? {}),
      ...partial,
    },
  });
}

export function updateSettingsAction(
  state: FinanceState,
  partial: Partial<UserFinancialSettings>
): FinanceState {
  const nextSettings = { ...state.settings, ...partial };
  let nextState: FinanceState = {
    ...state,
    settings: nextSettings,
    categories: state.categories.map((c) => {
      const sysKey = c.systemKey ?? SYSTEM_CATEGORY_KEY_MAP[c.id];
      if (sysKey === 'cigarette') return { ...c, weeklyLimit: nextSettings.cigaretteWeeklyLimit };
      if (sysKey === 'hangout') return { ...c, weeklyLimit: nextSettings.hangoutWeeklyLimit };
      return c;
    }),
    goals: state.goals.map((g) => {
      if (g.goalType === 'emergency') return { ...g, targetAmount: nextSettings.emergencyFundTarget };
      return g;
    }),
  };

  // Record audit history for budget / allocation rule edits without mutating historical transactions
  const budgetChanged =
    partial.dailyBudgetLimit !== undefined ||
    partial.weeklyBudgetLimit !== undefined ||
    partial.monthlyBudgetLimit !== undefined ||
    partial.cigaretteWeeklyLimit !== undefined ||
    partial.hangoutWeeklyLimit !== undefined;

  if (budgetChanged) {
    nextState = appendChangeLog(nextState, {
      entityType: 'budget',
      entityId: 'settings-budget',
      action: 'update',
      summary: 'Perubahan batas anggaran (tidak mengubah riwayat transaksi lama)',
      beforeValue: `Harian ${formatIDR(state.settings.dailyBudgetLimit)} / Rokok ${formatIDR(state.settings.cigaretteWeeklyLimit)}`,
      afterValue: `Harian ${formatIDR(nextSettings.dailyBudgetLimit)} / Rokok ${formatIDR(nextSettings.cigaretteWeeklyLimit)}`,
    });
  } else if (
    partial.allowanceAllocationRules !== undefined ||
    partial.freelanceAllocationRules !== undefined
  ) {
    nextState = appendChangeLog(nextState, {
      entityType: 'allocation',
      entityId: 'settings-allocation',
      action: 'update',
      summary: 'Perubahan aturan persentase alokasi pemasukan',
    });
  } else {
    nextState = withSyncBump(nextState);
  }

  return nextState;
}

// ============================================================================
// PHASE 2.4: CUSTODIAL FUNDS, DEFERRED PROJECT ADVANCES & RECEIVABLE WRITE-OFF
// ============================================================================

export function receiveCustodialFundAction(
  state: FinanceState,
  input: {
    counterparty: string;
    description?: string;
    amount: number;
    accountId: string;
    date?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; custodialFund: CustodialFund; transaction: Transaction } {
  if (input.idempotencyKey) {
    const existing = (state.custodialFunds ?? []).find(
      (cf) => cf.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      const existingTx = state.transactions.find((t) => t.id === existing.receiptTransactionId)!;
      return { state, custodialFund: existing, transaction: existingTx };
    }
  }

  const cleanCounterparty = input.counterparty?.trim();
  if (!cleanCounterparty) {
    throw new Error('Nama penitip / pihak terkait wajib diisi.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal dana titipan harus lebih dari Rp0.');
  }

  const targetAcc = state.accounts.find((a) => a.id === input.accountId);
  if (!targetAcc) {
    throw new Error('Akun penerima dana titipan tidak ditemukan.');
  }
  if ((targetAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${targetAcc.name}" tidak aktif dan tidak dapat menerima dana titipan.`);
  }

  const roundedAmount = Math.round(input.amount);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const fundId = generateId();
  const txId = generateId();
  const ledgerGroupId = generateId();
  const cleanDesc = input.description?.trim() || `Dana titipan dari ${cleanCounterparty}`;

  const receiptTx: Transaction = {
    id: txId,
    type: 'income',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'income_other',
      'cat-income-other',
      'income'
    ),
    accountId: targetAcc.id,
    date: txDate,
    description: `Terima Titipan: ${cleanCounterparty}`,
    notes: input.notes?.trim() || cleanDesc,
    tags: ['dana_titipan', 'masuk'],
    incomeSource: 'other',
    custodialFundId: fundId,
    ledgerGroupId,
    transactionNature: 'custodial_receipt',
    affectsAccountBalance: true,
    excludeFromIncomeStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const custodialFund: CustodialFund = {
    id: fundId,
    counterparty: cleanCounterparty,
    description: cleanDesc,
    initialAmount: roundedAmount,
    remainingAmount: roundedAmount,
    receivedDate: txDate,
    holdingAccountId: targetAcc.id,
    fundAllocations: [{ accountId: targetAcc.id, amount: roundedAmount }],
    receiptTransactionId: txId,
    ledgerGroupId,
    status: 'active',
    returns: [],
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: [receiptTx, ...state.transactions],
      custodialFunds: [custodialFund, ...(state.custodialFunds ?? [])],
    },
    {
      entityType: 'custodial',
      entityId: fundId,
      action: 'create',
      summary: `Terima dana titipan dari ${cleanCounterparty}: ${formatIDR(roundedAmount)}`,
      afterValue: `${targetAcc.name} · ${formatIDR(roundedAmount)}`,
    }
  );

  return { state: nextState, custodialFund, transaction: receiptTx };
}

export function returnCustodialFundAction(
  state: FinanceState,
  input: {
    custodialFundId: string;
    amount: number;
    accountId: string;
    date?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const funds = state.custodialFunds ?? [];
  const fund = funds.find((cf) => cf.id === input.custodialFundId);
  if (!fund) {
    throw new Error('Catatan dana titipan tidak ditemukan.');
  }
  if (fund.isVoided || fund.status === 'voided') {
    throw new Error('Dana titipan ini sudah dibatalkan (void).');
  }
  if (input.idempotencyKey && fund.returns.some((r) => r.idempotencyKey === input.idempotencyKey)) {
    return state;
  }
  if (fund.status === 'returned' || fund.remainingAmount <= 0) {
    throw new Error('Seluruh dana titipan ini sudah dikembalikan.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal pengembalian titipan harus lebih dari Rp0.');
  }

  const roundedAmount = Math.round(input.amount);
  if (roundedAmount > fund.remainingAmount) {
    throw new Error(
      `Nominal pengembalian (${formatIDR(roundedAmount)}) melebihi sisa dana titipan yang tersedia (${formatIDR(fund.remainingAmount)}).`
    );
  }

  const balances = computeAccountBalances(state);
  const sourceAcc = balances.find((a) => a.id === input.accountId);
  if (!sourceAcc) {
    throw new Error('Akun pengembalian dana tidak ditemukan.');
  }
  if ((sourceAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
  }

  const allocatedInAcc = getAllocatedAmountInAccount(fund, sourceAcc.id);
  if (roundedAmount > allocatedInAcc) {
    throw new Error(
      `Alokasi dana titipan pada akun "${sourceAcc.name}" hanya ${formatIDR(allocatedInAcc)}. Pindahkan alokasi via Transfer terlebih dahulu atau pilih akun yang menyimpan titipan.`
    );
  }
  if (sourceAcc.currentBalance < roundedAmount) {
    throw new Error(
      `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk mengembalikan titipan sebesar ${formatIDR(roundedAmount)}.`
    );
  }

  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const returnId = generateId();
  const txId = generateId();

  const returnTx: Transaction = {
    id: txId,
    type: 'expense',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'other_expense',
      'cat-other-exp',
      'expense'
    ),
    accountId: sourceAcc.id,
    date: txDate,
    description: `Kembalikan Titipan ke ${fund.counterparty}`,
    notes: input.notes?.trim() || fund.description,
    tags: ['dana_titipan', 'pengembalian'],
    custodialFundId: fund.id,
    ledgerGroupId: fund.ledgerGroupId,
    parentTransactionId: fund.receiptTransactionId,
    transactionNature: 'custodial_return',
    affectsAccountBalance: true,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const returnEntry: CustodialReturnEntry = {
    id: returnId,
    amount: roundedAmount,
    date: txDate,
    accountId: sourceAcc.id,
    transactionId: txId,
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextRemaining = Math.max(0, fund.remainingAmount - roundedAmount);
  const nextAllocations = adjustAllocationInAccount(
    getNormalizedAllocations(fund),
    sourceAcc.id,
    -roundedAmount
  );

  return appendChangeLog(
    {
      ...state,
      transactions: [returnTx, ...state.transactions],
      custodialFunds: funds.map((cf) =>
        cf.id === fund.id
          ? {
              ...cf,
              remainingAmount: nextRemaining,
              fundAllocations: nextAllocations,
              status: nextRemaining === 0 ? ('returned' as const) : ('active' as const),
              returns: [returnEntry, ...cf.returns],
            }
          : cf
      ),
    },
    {
      entityType: 'custodial',
      entityId: fund.id,
      action: 'update',
      summary: `Kembalikan dana titipan ke ${fund.counterparty}: ${formatIDR(roundedAmount)}`,
      beforeValue: formatIDR(fund.remainingAmount),
      afterValue: formatIDR(nextRemaining),
    }
  );
}

export function voidCustodialReturnAction(
  state: FinanceState,
  custodialFundId: string,
  returnId: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const funds = state.custodialFunds ?? [];
  const fund = funds.find((cf) => cf.id === custodialFundId);
  if (!fund) throw new Error('Catatan dana titipan tidak ditemukan.');
  if (fund.isVoided || fund.status === 'voided') {
    throw new Error('Dana titipan induk sudah dalam status void.');
  }
  const entry = fund.returns.find((r) => r.id === returnId);
  if (!entry) throw new Error('Catatan pengembalian dana titipan tidak ditemukan.');
  if (entry.isVoided) return state;

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const restoredRemaining = Math.min(fund.initialAmount, fund.remainingAmount + entry.amount);
  const nextAllocations = adjustAllocationInAccount(
    getNormalizedAllocations(fund),
    entry.accountId,
    entry.amount
  );

  const nextTransactions = state.transactions.map((t) =>
    t.id === entry.transactionId && !t.isVoided
      ? {
          ...t,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
          exceededBudget: false,
        }
      : t
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      custodialFunds: funds.map((cf) =>
        cf.id === fund.id
          ? {
              ...cf,
              remainingAmount: restoredRemaining,
              fundAllocations: nextAllocations,
              status: restoredRemaining > 0 ? ('active' as const) : ('returned' as const),
              returns: cf.returns.map((r) =>
                r.id === returnId
                  ? { ...r, isVoided: true, voidedAt: nowISO, voidReason: cleanReason }
                  : r
              ),
            }
          : cf
      ),
    },
    {
      entityType: 'custodial',
      entityId: fund.id,
      action: 'void',
      summary: `Batalkan (void) pengembalian titipan ${fund.counterparty}: ${formatIDR(entry.amount)}`,
      beforeValue: formatIDR(fund.remainingAmount),
      afterValue: formatIDR(restoredRemaining),
      note: cleanReason,
    }
  );
}

export function receiveProjectAdvanceAction(
  state: FinanceState,
  input: {
    projectId: string;
    amount: number;
    accountId: string;
    date?: string;
    description?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; projectAdvance: ProjectAdvance; transaction: Transaction } {
  if (input.idempotencyKey) {
    const existing = (state.projectAdvances ?? []).find(
      (pa) => pa.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      const existingTx = state.transactions.find((t) => t.id === existing.receiptTransactionId)!;
      return { state, projectAdvance: existing, transaction: existingTx };
    }
  }

  const project = state.projects.find((p) => p.id === input.projectId);
  if (!project) {
    throw new Error('Proyek tidak ditemukan.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal DP proyek harus lebih dari Rp0.');
  }

  const targetAcc = state.accounts.find((a) => a.id === input.accountId);
  if (!targetAcc) {
    throw new Error('Akun penerima DP proyek tidak ditemukan.');
  }
  if ((targetAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${targetAcc.name}" tidak aktif dan tidak dapat menerima DP.`);
  }

  const roundedAmount = Math.round(input.amount);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const advanceId = generateId();
  const txId = generateId();
  const ledgerGroupId = generateId();
  const cleanDesc = input.description?.trim() || `DP Proyek ${project.projectName}`;

  const receiptTx: Transaction = {
    id: txId,
    type: 'income',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'income_other',
      'cat-income-other',
      'income'
    ),
    accountId: targetAcc.id,
    date: txDate,
    description: `Terima DP Proyek — ${project.projectName}`,
    notes: input.notes?.trim() || cleanDesc,
    tags: ['dp_proyek', 'ditangguhkan'],
    incomeSource: 'freelance',
    projectId: project.id,
    projectAdvanceId: advanceId,
    ledgerGroupId,
    transactionNature: 'project_advance_receipt',
    affectsAccountBalance: true,
    excludeFromIncomeStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const projectAdvance: ProjectAdvance = {
    id: advanceId,
    projectId: project.id,
    clientName: project.clientName,
    description: cleanDesc,
    initialAmount: roundedAmount,
    recognizedAmount: 0,
    refundedAmount: 0,
    remainingAmount: roundedAmount,
    receivedDate: txDate,
    holdingAccountId: targetAcc.id,
    fundAllocations: [{ accountId: targetAcc.id, amount: roundedAmount }],
    receiptTransactionId: txId,
    ledgerGroupId,
    status: 'active',
    recognitions: [],
    refunds: [],
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: [receiptTx, ...state.transactions],
      projectAdvances: [projectAdvance, ...(state.projectAdvances ?? [])],
    },
    {
      entityType: 'project_advance',
      entityId: advanceId,
      action: 'create',
      summary: `Terima DP proyek ${project.projectName} (${project.clientName}): ${formatIDR(roundedAmount)}`,
      afterValue: `${targetAcc.name} · Ditangguhkan ${formatIDR(roundedAmount)}`,
    }
  );

  return { state: nextState, projectAdvance, transaction: receiptTx };
}

export function recognizeProjectAdvanceAction(
  state: FinanceState,
  input: {
    projectAdvanceId: string;
    amount: number;
    date?: string;
    accountId?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const advances = state.projectAdvances ?? [];
  const advance = advances.find((pa) => pa.id === input.projectAdvanceId);
  if (!advance) {
    throw new Error('Catatan DP proyek tidak ditemukan.');
  }
  if (advance.isVoided || advance.status === 'voided') {
    throw new Error('DP proyek ini sudah dibatalkan (void).');
  }
  if (
    input.idempotencyKey &&
    advance.recognitions.some((r) => r.idempotencyKey === input.idempotencyKey)
  ) {
    return state;
  }
  if (advance.status === 'settled' || advance.remainingAmount <= 0) {
    throw new Error('Seluruh saldo DP proyek ini sudah diakui atau dikembalikan.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal pengakuan pendapatan DP harus lebih dari Rp0.');
  }

  const roundedAmount = Math.round(input.amount);
  if (roundedAmount > advance.remainingAmount) {
    throw new Error(
      `Nominal pengakuan (${formatIDR(roundedAmount)}) melebihi sisa DP belum diakui (${formatIDR(advance.remainingAmount)}).`
    );
  }

  const currentAllocations = getNormalizedAllocations(advance);
  const allocationDeltas: FundAllocation[] = [];
  let remainingToRecognize = roundedAmount;

  // Prefer specified accountId first if present, then remaining allocations in order
  const orderedAccountIds = [
    ...(input.accountId ? [input.accountId] : []),
    advance.holdingAccountId,
    ...currentAllocations.map((a) => a.accountId),
  ].filter((accId, idx, arr) => arr.indexOf(accId) === idx);

  let nextAllocations = [...currentAllocations];
  for (const accId of orderedAccountIds) {
    if (remainingToRecognize <= 0) break;
    const avail = nextAllocations
      .filter((a) => a.accountId === accId)
      .reduce((s, a) => s + a.amount, 0);
    if (avail <= 0) continue;
    const deduct = Math.min(avail, remainingToRecognize);
    remainingToRecognize -= deduct;
    nextAllocations = adjustAllocationInAccount(nextAllocations, accId, -deduct);
    allocationDeltas.push({ accountId: accId, amount: deduct });
  }

  const project = state.projects.find((p) => p.id === advance.projectId);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const recognitionId = generateId();
  const txId = generateId();
  const refAccountId =
    allocationDeltas[0]?.accountId ?? input.accountId ?? advance.holdingAccountId;

  const recognitionTx: Transaction = {
    id: txId,
    type: 'income',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'income_freelance',
      'cat-income-freelance',
      'income'
    ),
    accountId: refAccountId,
    date: txDate,
    description: `Pengakuan Pendapatan DP — ${project?.projectName ?? advance.clientName}`,
    notes:
      input.notes?.trim() ||
      `Pengakuan bertahap DP proyek (${formatIDR(roundedAmount)} dari sisa ${formatIDR(advance.remainingAmount)})`,
    tags: ['dp_proyek', 'pengakuan_pendapatan'],
    incomeSource: 'freelance',
    projectId: advance.projectId,
    projectAdvanceId: advance.id,
    ledgerGroupId: advance.ledgerGroupId,
    parentTransactionId: advance.receiptTransactionId,
    transactionNature: 'project_advance_recognition',
    affectsAccountBalance: false,
    excludeFromIncomeStats: false,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const recognitionEntry: ProjectAdvanceRecognition = {
    id: recognitionId,
    amount: roundedAmount,
    date: txDate,
    transactionId: txId,
    allocationDeltas,
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextRecognized = advance.recognizedAmount + roundedAmount;
  const nextRemaining = Math.max(0, advance.remainingAmount - roundedAmount);

  return appendChangeLog(
    {
      ...state,
      transactions: [recognitionTx, ...state.transactions],
      projectAdvances: advances.map((pa) =>
        pa.id === advance.id
          ? {
              ...pa,
              recognizedAmount: nextRecognized,
              remainingAmount: nextRemaining,
              fundAllocations: nextAllocations,
              status: nextRemaining === 0 ? ('settled' as const) : ('active' as const),
              recognitions: [recognitionEntry, ...pa.recognitions],
            }
          : pa
      ),
    },
    {
      entityType: 'project_advance',
      entityId: advance.id,
      action: 'update',
      summary: `Akui pendapatan DP proyek (${project?.projectName ?? advance.clientName}): ${formatIDR(roundedAmount)}`,
      beforeValue: `Sisa DP ${formatIDR(advance.remainingAmount)}`,
      afterValue: `Diakui ${formatIDR(nextRecognized)} · Sisa DP ${formatIDR(nextRemaining)}`,
    }
  );
}

export function refundProjectAdvanceAction(
  state: FinanceState,
  input: {
    projectAdvanceId: string;
    amount: number;
    accountId: string;
    date?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const advances = state.projectAdvances ?? [];
  const advance = advances.find((pa) => pa.id === input.projectAdvanceId);
  if (!advance) {
    throw new Error('Catatan DP proyek tidak ditemukan.');
  }
  if (advance.isVoided || advance.status === 'voided') {
    throw new Error('DP proyek ini sudah dibatalkan (void).');
  }
  if (
    input.idempotencyKey &&
    advance.refunds.some((r) => r.idempotencyKey === input.idempotencyKey)
  ) {
    return state;
  }
  if (advance.status === 'settled' || advance.remainingAmount <= 0) {
    throw new Error('Seluruh saldo DP proyek ini sudah diakui atau dikembalikan.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal pengembalian DP harus lebih dari Rp0.');
  }

  const roundedAmount = Math.round(input.amount);
  if (roundedAmount > advance.remainingAmount) {
    throw new Error(
      `Nominal pengembalian DP (${formatIDR(roundedAmount)}) melebihi sisa DP belum diakui (${formatIDR(advance.remainingAmount)}).`
    );
  }

  const balances = computeAccountBalances(state);
  const sourceAcc = balances.find((a) => a.id === input.accountId);
  if (!sourceAcc) {
    throw new Error('Akun sumber pengembalian DP tidak ditemukan.');
  }
  if ((sourceAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
  }

  const allocatedInAcc = getAllocatedAmountInAccount(advance, sourceAcc.id);
  if (roundedAmount > allocatedInAcc) {
    throw new Error(
      `Alokasi DP proyek pada akun "${sourceAcc.name}" hanya ${formatIDR(allocatedInAcc)}. Pindahkan alokasi via Transfer terlebih dahulu atau pilih akun yang menyimpan DP.`
    );
  }
  if (sourceAcc.currentBalance < roundedAmount) {
    throw new Error(
      `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk mengembalikan DP sebesar ${formatIDR(roundedAmount)}.`
    );
  }

  const project = state.projects.find((p) => p.id === advance.projectId);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const refundId = generateId();
  const txId = generateId();

  const refundTx: Transaction = {
    id: txId,
    type: 'expense',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'other_expense',
      'cat-other-exp',
      'expense'
    ),
    accountId: sourceAcc.id,
    date: txDate,
    description: `Pengembalian DP Proyek — ${project?.projectName ?? advance.clientName}`,
    notes: input.notes?.trim() || `Pengembalian DP kepada ${advance.clientName}`,
    tags: ['dp_proyek', 'pengembalian_dp'],
    projectId: advance.projectId,
    projectAdvanceId: advance.id,
    ledgerGroupId: advance.ledgerGroupId,
    parentTransactionId: advance.receiptTransactionId,
    transactionNature: 'project_advance_refund',
    affectsAccountBalance: true,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const refundEntry: ProjectAdvanceRefund = {
    id: refundId,
    amount: roundedAmount,
    date: txDate,
    accountId: sourceAcc.id,
    transactionId: txId,
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextRefunded = advance.refundedAmount + roundedAmount;
  const nextRemaining = Math.max(0, advance.remainingAmount - roundedAmount);
  const nextAllocations = adjustAllocationInAccount(
    getNormalizedAllocations(advance),
    sourceAcc.id,
    -roundedAmount
  );

  return appendChangeLog(
    {
      ...state,
      transactions: [refundTx, ...state.transactions],
      projectAdvances: advances.map((pa) =>
        pa.id === advance.id
          ? {
              ...pa,
              refundedAmount: nextRefunded,
              remainingAmount: nextRemaining,
              fundAllocations: nextAllocations,
              status: nextRemaining === 0 ? ('settled' as const) : ('active' as const),
              refunds: [refundEntry, ...pa.refunds],
            }
          : pa
      ),
    },
    {
      entityType: 'project_advance',
      entityId: advance.id,
      action: 'update',
      summary: `Kembalikan DP proyek (${project?.projectName ?? advance.clientName}): ${formatIDR(roundedAmount)}`,
      beforeValue: formatIDR(advance.remainingAmount),
      afterValue: formatIDR(nextRemaining),
    }
  );
}

export function voidProjectAdvanceRecognitionAction(
  state: FinanceState,
  projectAdvanceId: string,
  recognitionId: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const advances = state.projectAdvances ?? [];
  const advance = advances.find((pa) => pa.id === projectAdvanceId);
  if (!advance) throw new Error('Catatan DP proyek tidak ditemukan.');
  if (advance.isVoided || advance.status === 'voided') {
    throw new Error('DP proyek induk sudah berstatus void.');
  }
  const entry = advance.recognitions.find((r) => r.id === recognitionId);
  if (!entry) throw new Error('Catatan pengakuan DP tidak ditemukan.');
  if (entry.isVoided) return state;

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const nextRecognized = Math.max(0, advance.recognizedAmount - entry.amount);
  const restoredRemaining = Math.min(
    advance.initialAmount - nextRecognized - advance.refundedAmount,
    advance.remainingAmount + entry.amount
  );

  let nextAllocations = getNormalizedAllocations(advance);
  const deltas =
    entry.allocationDeltas && entry.allocationDeltas.length > 0
      ? entry.allocationDeltas
      : [{ accountId: advance.holdingAccountId, amount: entry.amount }];
  for (const d of deltas) {
    nextAllocations = adjustAllocationInAccount(nextAllocations, d.accountId, d.amount);
  }

  const nextTransactions = state.transactions.map((t) =>
    t.id === entry.transactionId && !t.isVoided
      ? { ...t, isVoided: true, voidedAt: nowISO, voidReason: cleanReason, exceededBudget: false }
      : t
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      projectAdvances: advances.map((pa) =>
        pa.id === advance.id
          ? {
              ...pa,
              recognizedAmount: nextRecognized,
              remainingAmount: restoredRemaining,
              fundAllocations: nextAllocations,
              status: restoredRemaining > 0 ? ('active' as const) : ('settled' as const),
              recognitions: pa.recognitions.map((r) =>
                r.id === recognitionId
                  ? { ...r, isVoided: true, voidedAt: nowISO, voidReason: cleanReason }
                  : r
              ),
            }
          : pa
      ),
    },
    {
      entityType: 'project_advance',
      entityId: advance.id,
      action: 'void',
      summary: `Batalkan (void) pengakuan DP ${advance.clientName}: ${formatIDR(entry.amount)}`,
      beforeValue: formatIDR(advance.remainingAmount),
      afterValue: formatIDR(restoredRemaining),
      note: cleanReason,
    }
  );
}

export function voidProjectAdvanceRefundAction(
  state: FinanceState,
  projectAdvanceId: string,
  refundId: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const advances = state.projectAdvances ?? [];
  const advance = advances.find((pa) => pa.id === projectAdvanceId);
  if (!advance) throw new Error('Catatan DP proyek tidak ditemukan.');
  if (advance.isVoided || advance.status === 'voided') {
    throw new Error('DP proyek induk sudah berstatus void.');
  }
  const entry = advance.refunds.find((r) => r.id === refundId);
  if (!entry) throw new Error('Catatan pengembalian DP tidak ditemukan.');
  if (entry.isVoided) return state;

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const nextRefunded = Math.max(0, advance.refundedAmount - entry.amount);
  const restoredRemaining = Math.min(
    advance.initialAmount - advance.recognizedAmount - nextRefunded,
    advance.remainingAmount + entry.amount
  );
  const nextAllocations = adjustAllocationInAccount(
    getNormalizedAllocations(advance),
    entry.accountId,
    entry.amount
  );

  const nextTransactions = state.transactions.map((t) =>
    t.id === entry.transactionId && !t.isVoided
      ? { ...t, isVoided: true, voidedAt: nowISO, voidReason: cleanReason, exceededBudget: false }
      : t
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      projectAdvances: advances.map((pa) =>
        pa.id === advance.id
          ? {
              ...pa,
              refundedAmount: nextRefunded,
              remainingAmount: restoredRemaining,
              fundAllocations: nextAllocations,
              status: restoredRemaining > 0 ? ('active' as const) : ('settled' as const),
              refunds: pa.refunds.map((r) =>
                r.id === refundId
                  ? { ...r, isVoided: true, voidedAt: nowISO, voidReason: cleanReason }
                  : r
              ),
            }
          : pa
      ),
    },
    {
      entityType: 'project_advance',
      entityId: advance.id,
      action: 'void',
      summary: `Batalkan (void) pengembalian DP ${advance.clientName}: ${formatIDR(entry.amount)}`,
      beforeValue: formatIDR(advance.remainingAmount),
      afterValue: formatIDR(restoredRemaining),
      note: cleanReason,
    }
  );
}

export function writeOffReceivableAction(
  state: FinanceState,
  input: {
    debtId: string;
    date?: string;
    reason?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const item = state.debts.find((d) => d.id === input.debtId);
  if (!item) {
    throw new Error('Data piutang tidak ditemukan.');
  }
  if (item.isVoided) {
    throw new Error('Catatan piutang yang sudah void tidak dapat di-write-off.');
  }
  if (item.direction !== 'receivable') {
    throw new Error('Write-off hanya berlaku untuk piutang (bukan utang).');
  }
  if (
    input.idempotencyKey &&
    (item.writeOffHistory ?? []).some((w) => w.idempotencyKey === input.idempotencyKey)
  ) {
    return state;
  }
  if (item.status === 'written_off') {
    throw new Error('Piutang ini sudah berstatus written_off.');
  }
  if (item.status === 'paid' || item.remainingAmount <= 0) {
    throw new Error('Piutang yang sudah lunas tidak dapat di-write-off.');
  }

  const writeOffAmount = item.remainingAmount;
  const revenueWasRecorded = Boolean(item.revenueAlreadyRecorded);
  const txDate = input.date || todayISO();
  const cleanReason = input.reason?.trim() || 'Piutang dinyatakan tidak tertagih';
  const nowISO = new Date().toISOString();

  let nextTransactions = state.transactions;
  let writeOffTxId: string | undefined;

  // Record a non-cash write-off loss record ONLY when revenue was already recognized.
  // Never invent a fake income/expense loss for unrecognized receivables (personal loan / cash-basis).
  if (revenueWasRecorded) {
    const refAcc =
      state.accounts.find((a) => a.id === item.accountId) ??
      state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness) ??
      state.accounts[0];
    const originTx = item.transactionId
      ? state.transactions.find((t) => t.id === item.transactionId)
      : undefined;
    const ledgerGroupId = originTx?.ledgerGroupId ?? generateId();
    writeOffTxId = generateId();

    const writeOffTx: Transaction = {
      id: writeOffTxId,
      type: 'expense',
      amount: writeOffAmount,
      categoryId: item.projectId
        ? resolveSystemCategoryId(state.categories, 'business_ops', 'cat-biz-ops', 'expense')
        : resolveSystemCategoryId(state.categories, 'other_expense', 'cat-other-exp', 'expense'),
      accountId: refAcc?.id ?? resolveSystemAccountId(state.accounts, 'cash', 'acc-cash'),
      date: txDate,
      description: `Penghapusbukuan Piutang (${item.creditor})`,
      notes: `${cleanReason} (Non-kas; pendapatan sebelumnya telah diakui)`,
      tags: ['piutang', 'write_off'],
      projectId: item.projectId,
      debtId: item.id,
      ledgerGroupId,
      parentTransactionId: item.transactionId,
      transactionNature: 'receivable_write_off',
      affectsAccountBalance: false,
      excludeFromExpenseStats: true,
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: nowISO,
    };
    nextTransactions = [writeOffTx, ...nextTransactions];
  }

  const historyEntry: DebtWriteOffEntry = {
    id: generateId(),
    action: 'write_off',
    amount: writeOffAmount,
    date: txDate,
    revenueAlreadyRecorded: revenueWasRecorded,
    transactionId: writeOffTxId,
    reason: cleanReason,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      debts: state.debts.map((d) =>
        d.id === item.id
          ? {
              ...d,
              status: 'written_off' as const,
              remainingAmount: 0,
              writtenOffAmount: writeOffAmount,
              writtenOffAt: nowISO,
              writeOffReason: cleanReason,
              writeOffHistory: [historyEntry, ...(d.writeOffHistory ?? [])],
            }
          : d
      ),
    },
    {
      entityType: 'receivable',
      entityId: item.id,
      action: 'update',
      summary: `Write-off piutang (${item.creditor}): ${formatIDR(writeOffAmount)}${revenueWasRecorded ? ' [pendapatan sudah diakui]' : ' [non-pendapatan / belum diakui]'}`,
      beforeValue: formatIDR(writeOffAmount),
      afterValue: 'written_off',
      note: cleanReason,
    }
  );
}

export function recoverReceivableAction(
  state: FinanceState,
  input: {
    debtId: string;
    date?: string;
    reason?: string;
    collectAmount?: number;
    accountId?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  const item = state.debts.find((d) => d.id === input.debtId);
  if (!item) {
    throw new Error('Data piutang tidak ditemukan.');
  }
  if (item.isVoided) {
    throw new Error('Catatan piutang yang sudah void tidak dapat dipulihkan.');
  }
  if (item.direction !== 'receivable') {
    throw new Error('Pemulihan write-off hanya berlaku untuk piutang.');
  }
  if (
    input.idempotencyKey &&
    (item.writeOffHistory ?? []).some((w) => w.idempotencyKey === input.idempotencyKey)
  ) {
    return state;
  }
  if (item.status !== 'written_off') {
    throw new Error('Piutang ini tidak sedang dalam status written_off.');
  }

  const restoredAmount = item.writtenOffAmount ?? 0;
  if (restoredAmount <= 0) {
    throw new Error('Nominal piutang yang di-write-off tidak valid.');
  }

  const txDate = input.date || todayISO();
  const cleanReason = input.reason?.trim() || 'Piutang dipulihkan untuk ditagih kembali';
  const nowISO = new Date().toISOString();

  // Preserve write-off transactions as voided historical records rather than deleting them
  const nextTransactions = state.transactions.map((t) =>
    t.debtId === item.id && t.transactionNature === 'receivable_write_off' && !t.isVoided
      ? {
          ...t,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: `Dipulihkan: ${cleanReason}`,
        }
      : t
  );

  const recoveryEntry: DebtWriteOffEntry = {
    id: generateId(),
    action: 'recover',
    amount: restoredAmount,
    date: txDate,
    revenueAlreadyRecorded: Boolean(item.revenueAlreadyRecorded),
    reason: cleanReason,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  let nextState = appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      debts: state.debts.map((d) =>
        d.id === item.id
          ? {
              ...d,
              status: 'active' as const,
              remainingAmount: restoredAmount,
              writtenOffAmount: 0,
              writeOffHistory: [recoveryEntry, ...(d.writeOffHistory ?? [])],
            }
          : d
      ),
    },
    {
      entityType: 'receivable',
      entityId: item.id,
      action: 'reopen',
      summary: `Pulihkan piutang write-off (${item.creditor}): ${formatIDR(restoredAmount)}`,
      beforeValue: 'written_off',
      afterValue: `active (${formatIDR(restoredAmount)})`,
      note: cleanReason,
    }
  );

  if (input.collectAmount && input.collectAmount > 0) {
    const fallbackAcc =
      input.accountId ||
      item.accountId ||
      nextState.accounts.find((a) => (a.status ?? 'active') === 'active')?.id ||
      resolveSystemAccountId(nextState.accounts, 'cash', 'acc-cash');
    nextState = collectReceivableAction(nextState, {
      debtId: item.id,
      amount: input.collectAmount,
      accountId: fallbackAcc,
      date: txDate,
      notes: cleanReason,
    });
  }

  return nextState;
}

// ============================================================================
// PHASE 2.5 ACTIONS: Split Bill, Friend Advance & Linked Borrow-Lend
// ============================================================================

export function createSplitBillAction(
  state: FinanceState,
  input: {
    title: string;
    totalAmount: number;
    categoryId: string;
    accountId: string;
    date?: string;
    splitMode: 'equal' | 'manual';
    userShareAmount?: number;
    participants: Array<{
      name: string;
      shareAmount?: number;
      dueDate?: string;
    }>;
    notes?: string;
    overrideReason?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; splitBill: SplitBill; paymentTransaction: Transaction } {
  if (input.idempotencyKey) {
    const existing = (state.splitBills ?? []).find(
      (sb) => sb.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      const existingTx = state.transactions.find((t) => t.id === existing.paymentTransactionId)!;
      return { state, splitBill: existing, paymentTransaction: existingTx };
    }
  }

  const cleanTitle = input.title.trim();
  if (!cleanTitle) {
    throw new Error('Judul tagihan Split Bill wajib diisi.');
  }
  if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
    throw new Error('Total tagihan Split Bill harus lebih dari Rp0.');
  }
  const roundedTotal = Math.round(input.totalAmount);

  if (!Array.isArray(input.participants) || input.participants.length === 0) {
    throw new Error('Tambahkan minimal 1 peserta untuk membagi tagihan.');
  }
  for (const p of input.participants) {
    if (!p.name || !p.name.trim()) {
      throw new Error('Nama setiap peserta Split Bill wajib diisi.');
    }
  }

  const balances = computeAccountBalances(state);
  const sourceAcc = balances.find((a) => a.id === input.accountId);
  if (!sourceAcc) {
    throw new Error('Akun pembayaran Split Bill tidak ditemukan.');
  }
  if ((sourceAcc.status ?? 'active') !== 'active') {
    throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
  }
  if (sourceAcc.currentBalance < roundedTotal) {
    throw new Error(
      `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk membayar total tagihan ${formatIDR(roundedTotal)}.`
    );
  }

  const cat = state.categories.find((c) => c.id === input.categoryId && c.type === 'expense');
  if (!cat) {
    throw new Error('Kategori pengeluaran Split Bill tidak valid.');
  }

  let resolvedUserShare = 0;
  let resolvedParticipants: Array<{ name: string; shareAmount: number; dueDate?: string }> = [];

  if (input.splitMode === 'equal') {
    const hasExplicitUserShare =
      input.userShareAmount !== undefined && Number.isFinite(input.userShareAmount);
    if (hasExplicitUserShare) {
      resolvedUserShare = Math.round(input.userShareAmount!);
      if (resolvedUserShare < 0 || resolvedUserShare >= roundedTotal) {
        throw new Error('Porsi pengguna tidak valid untuk pembagian merata.');
      }
      const distributable = roundedTotal - resolvedUserShare;
      const count = input.participants.length;
      const base = Math.floor(distributable / count);
      let remainder = distributable - base * count;
      resolvedParticipants = input.participants.map((p) => {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        return {
          name: p.name.trim(),
          shareAmount: base + extra,
          dueDate: p.dueDate || undefined,
        };
      });
    } else {
      const headCount = 1 + input.participants.length;
      const base = Math.floor(roundedTotal / headCount);
      const remainder = roundedTotal - base * headCount;
      resolvedUserShare = base + remainder;
      resolvedParticipants = input.participants.map((p) => ({
        name: p.name.trim(),
        shareAmount: base,
        dueDate: p.dueDate || undefined,
      }));
    }
  } else {
    resolvedUserShare =
      input.userShareAmount !== undefined && Number.isFinite(input.userShareAmount)
        ? Math.round(input.userShareAmount)
        : 0;
    if (resolvedUserShare < 0) {
      throw new Error('Porsi pribadi pengguna tidak boleh negatif.');
    }
    resolvedParticipants = input.participants.map((p) => ({
      name: p.name.trim(),
      shareAmount: Math.round(p.shareAmount ?? 0),
      dueDate: p.dueDate || undefined,
    }));
  }

  if (resolvedParticipants.some((p) => p.shareAmount <= 0)) {
    throw new Error('Setiap peserta Split Bill harus memiliki bagian lebih dari Rp0.');
  }

  const participantsSum = resolvedParticipants.reduce((s, p) => s + p.shareAmount, 0);
  if (resolvedUserShare + participantsSum !== roundedTotal) {
    throw new Error(
      `Total pembagian (${formatIDR(resolvedUserShare + participantsSum)}) harus sama persis dengan total tagihan (${formatIDR(roundedTotal)}).`
    );
  }

  const txDate = input.date || todayISO();
  const isEssential =
    cat.classification === 'essential' ||
    cat.classification === 'obligation' ||
    cat.classification === 'debt' ||
    cat.classification === 'business';
  const isDiscretionary = !isEssential;

  let exceededBudget = false;
  if (resolvedUserShare > 0) {
    const check = evaluateDisciplineForExpense(state, {
      amount: resolvedUserShare,
      categoryId: cat.id,
      accountId: sourceAcc.id,
      date: txDate,
    });
    if (
      check.requiresConfirmation &&
      (!input.overrideReason || input.overrideReason.trim().length < 5)
    ) {
      throw new Error(
        'Porsi pribadi Split Bill melebihi batas aman: alasan tertulis wajib diisi minimal 5 karakter.'
      );
    }
    exceededBudget = check.requiresConfirmation;
  }

  const nowISO = new Date().toISOString();
  const splitBillId = generateId();
  const paymentTxId = generateId();
  const ledgerGroupId = generateId();

  const paymentTx: Transaction = {
    id: paymentTxId,
    type: 'expense',
    amount: roundedTotal,
    categoryId: cat.id,
    accountId: sourceAcc.id,
    date: txDate,
    description: `Split Bill: ${cleanTitle}`,
    notes:
      input.notes?.trim() ||
      `Total ${formatIDR(roundedTotal)} · Porsi pribadi ${formatIDR(resolvedUserShare)} · Talangan ${formatIDR(participantsSum)}`,
    tags: ['split_bill', 'pembayaran_total'],
    splitBillId,
    ledgerGroupId,
    transactionNature: 'split_bill_payment',
    affectsAccountBalance: true,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  let personalShareTx: Transaction | undefined;
  if (resolvedUserShare > 0) {
    personalShareTx = {
      id: generateId(),
      type: 'expense',
      amount: resolvedUserShare,
      categoryId: cat.id,
      accountId: sourceAcc.id,
      date: txDate,
      description: `Porsi Pribadi Split Bill: ${cleanTitle}`,
      notes: input.notes?.trim() || `Bagian pribadi dari total tagihan ${formatIDR(roundedTotal)}`,
      tags: ['split_bill', 'porsi_pribadi'],
      splitBillId,
      ledgerGroupId,
      parentTransactionId: paymentTxId,
      transactionNature: 'split_bill_personal_share',
      affectsAccountBalance: false,
      excludeFromExpenseStats: false,
      isEssential,
      isDiscretionary,
      exceededBudget,
      overrideReason: input.overrideReason?.trim() || undefined,
      isVoided: false,
      createdAt: nowISO,
    };
  }

  const createdReceivables: Debt[] = [];
  const participantRecords: SplitBillParticipant[] = resolvedParticipants.map((p) => {
    const debtId = generateId();
    createdReceivables.push({
      id: debtId,
      direction: 'receivable',
      receivableType: 'split_bill',
      accountId: sourceAcc.id,
      transactionId: paymentTxId,
      splitBillId,
      revenueAlreadyRecorded: true,
      date: txDate,
      creditor: p.name,
      description: `Split Bill: ${cleanTitle}`,
      initialAmount: p.shareAmount,
      remainingAmount: p.shareAmount,
      dueDate: p.dueDate,
      priority: 1,
      status: 'active',
      createdAt: nowISO,
    });
    return {
      id: generateId(),
      name: p.name,
      shareAmount: p.shareAmount,
      debtId,
    };
  });

  const splitBill: SplitBill = {
    id: splitBillId,
    title: cleanTitle,
    date: txDate,
    categoryId: cat.id,
    accountId: sourceAcc.id,
    totalAmount: roundedTotal,
    userShareAmount: resolvedUserShare,
    splitMode: input.splitMode,
    participants: participantRecords,
    paymentTransactionId: paymentTxId,
    personalShareTransactionId: personalShareTx?.id,
    ledgerGroupId,
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowISO,
  };

  const nextTransactions = personalShareTx
    ? [personalShareTx, paymentTx, ...state.transactions]
    : [paymentTx, ...state.transactions];

  const nextNoSpend = reconcileNoSpendConfirmationsForDates(
    nextTransactions,
    state.noSpendConfirmations,
    [txDate],
    state.categories
  );

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      debts: [...state.debts, ...createdReceivables],
      splitBills: [splitBill, ...(state.splitBills ?? [])],
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: 'split_bill',
      entityId: splitBillId,
      action: 'create',
      summary: `Catat Split Bill "${cleanTitle}": Total ${formatIDR(roundedTotal)} (Pribadi ${formatIDR(resolvedUserShare)}, ${participantRecords.length} peserta)`,
      afterValue: `${sourceAcc.name} · Piutang ${formatIDR(participantsSum)}`,
    }
  );

  return { state: nextState, splitBill, paymentTransaction: paymentTx };
}

export function voidSplitBillAction(
  state: FinanceState,
  splitBillId: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const splitBills = state.splitBills ?? [];
  const sb = splitBills.find((s) => s.id === splitBillId);
  if (!sb) {
    throw new Error('Catatan Split Bill tidak ditemukan.');
  }
  if (sb.isVoided) {
    return state;
  }

  const participantDebtIds = new Set(sb.participants.map((p) => p.debtId));
  const hasActivePayments = state.debtPayments.some(
    (dp) => participantDebtIds.has(dp.debtId) && !dp.isVoided
  );
  if (hasActivePayments) {
    throw new Error(
      `Split Bill "${sb.title}" masih memiliki pembayaran piutang peserta aktif. Batalkan pelunasan peserta terlebih dahulu sebelum membatalkan Split Bill.`
    );
  }
  const hasWrittenOff = state.debts.some(
    (d) => participantDebtIds.has(d.id) && d.status === 'written_off'
  );
  if (hasWrittenOff) {
    throw new Error(
      `Split Bill "${sb.title}" memiliki piutang peserta berstatus write-off. Pulihkan piutang tersebut terlebih dahulu sebelum melakukan void.`
    );
  }

  const cleanReason = reason.trim() || 'Dibatalkan pengguna';
  const nowISO = new Date().toISOString();
  const txIdsToVoid = new Set(
    [sb.paymentTransactionId, sb.personalShareTransactionId].filter(
      (x): x is string => Boolean(x)
    )
  );

  const nextTransactions = state.transactions.map((t) =>
    txIdsToVoid.has(t.id) && !t.isVoided
      ? {
          ...t,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
          exceededBudget: false,
        }
      : t
  );

  const nextDebts = state.debts.map((d) =>
    participantDebtIds.has(d.id)
      ? {
          ...d,
          remainingAmount: 0,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
        }
      : d
  );

  const nextSplitBills = splitBills.map((item) =>
    item.id === sb.id
      ? {
          ...item,
          isVoided: true,
          voidedAt: nowISO,
          voidReason: cleanReason,
        }
      : item
  );

  const nextNoSpend = reconcileNoSpendConfirmationsForDates(
    nextTransactions,
    state.noSpendConfirmations,
    [sb.date],
    state.categories
  );

  return appendChangeLog(
    {
      ...state,
      transactions: nextTransactions,
      debts: nextDebts,
      splitBills: nextSplitBills,
      noSpendConfirmations: nextNoSpend,
    },
    {
      entityType: 'split_bill',
      entityId: sb.id,
      action: 'void',
      summary: `Void Split Bill "${sb.title}": ${formatIDR(sb.totalAmount)}`,
      beforeValue: formatIDR(sb.totalAmount),
      afterValue: 'Void (Rp0 aktif)',
      note: cleanReason,
    }
  );
}

export function createFriendAdvanceAction(
  state: FinanceState,
  input: {
    friendName: string;
    amount: number;
    accountId: string;
    date?: string;
    dueDate?: string;
    description?: string;
    idempotencyKey?: string;
  }
): FinanceState {
  return addDebtAction(state, {
    direction: 'receivable',
    receivableType: 'friend_advance',
    accountId: input.accountId,
    creditor: input.friendName,
    description: input.description || `Talangan kebutuhan ${input.friendName.trim()}`,
    amount: input.amount,
    date: input.date,
    dueDate: input.dueDate,
    idempotencyKey: input.idempotencyKey,
  });
}

export function createLinkedBorrowLendAction(
  state: FinanceState,
  input: {
    lenderName: string;
    borrowerName: string;
    amount: number;
    date?: string;
    dueDatePayable?: string;
    dueDateReceivable?: string;
    description?: string;
    mode?: 'direct_passthrough' | 'via_account';
    receiveAccountId?: string;
    disburseAccountId?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; payableDebt: Debt; receivableDebt: Debt } {
  if (input.idempotencyKey) {
    const existingPayable = state.debts.find(
      (d) =>
        d.idempotencyKey === input.idempotencyKey &&
        (d.direction ?? 'payable') === 'payable' &&
        d.linkedDebtId
    );
    if (existingPayable) {
      const existingReceivable = state.debts.find((d) => d.id === existingPayable.linkedDebtId)!;
      return { state, payableDebt: existingPayable, receivableDebt: existingReceivable };
    }
  }

  const cleanLender = input.lenderName.trim();
  const cleanBorrower = input.borrowerName.trim();
  if (!cleanLender || !cleanBorrower) {
    throw new Error('Nama pemberi pinjaman (A) dan penerima pinjaman (B) wajib diisi.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal pinjaman A → B harus lebih dari Rp0.');
  }

  const roundedAmount = Math.round(input.amount);
  const txDate = input.date || todayISO();
  const nowISO = new Date().toISOString();
  const mode = input.mode ?? 'direct_passthrough';
  const payableId = generateId();
  const receivableId = generateId();
  const ledgerGroupId = generateId();
  const descNote = input.description?.trim() || `Pinjam dari ${cleanLender} diteruskan ke ${cleanBorrower}`;

  if (mode === 'via_account') {
    const receiveAccId =
      input.receiveAccountId ??
      state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness)?.id ??
      state.accounts[0]?.id;
    const disburseAccId = input.disburseAccountId ?? receiveAccId;

    const balances = computeAccountBalances(state);
    const receiveAcc = balances.find((a) => a.id === receiveAccId);
    const disburseAcc = balances.find((a) => a.id === disburseAccId);

    if (!receiveAcc || (receiveAcc.status ?? 'active') !== 'active') {
      throw new Error('Akun penerima dana pinjaman (A) tidak ditemukan atau tidak aktif.');
    }
    if (!disburseAcc || (disburseAcc.status ?? 'active') !== 'active') {
      throw new Error('Akun penyalur dana ke peminjam (B) tidak ditemukan atau tidak aktif.');
    }

    const availableForDisburse =
      receiveAcc.id === disburseAcc.id
        ? disburseAcc.currentBalance + roundedAmount
        : disburseAcc.currentBalance;
    if (availableForDisburse < roundedAmount) {
      throw new Error(
        `Saldo akun "${disburseAcc.name}" (${formatIDR(availableForDisburse)}) tidak mencukupi untuk meneruskan pinjaman sebesar ${formatIDR(roundedAmount)}.`
      );
    }

    const receiptTxId = generateId();
    const disburseTxId = generateId();

    const receiptTx: Transaction = {
      id: receiptTxId,
      type: 'income',
      amount: roundedAmount,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'income_other',
        'cat-income-other',
        'income'
      ),
      accountId: receiveAcc.id,
      date: txDate,
      description: `Pinjaman Diterima dari ${cleanLender} (untuk ${cleanBorrower})`,
      notes: descNote,
      tags: ['utang', 'dana_diterima', 'pinjam_teruskan'],
      incomeSource: 'other',
      debtId: payableId,
      ledgerGroupId,
      transactionNature: 'debt_receipt',
      affectsAccountBalance: true,
      excludeFromIncomeStats: true,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: nowISO,
    };

    const disburseTx: Transaction = {
      id: disburseTxId,
      type: 'expense',
      amount: roundedAmount,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'debt_payment',
        'cat-debt',
        'expense'
      ),
      accountId: disburseAcc.id,
      date: txDate,
      description: `Pinjaman Diteruskan ke ${cleanBorrower} (sumber: ${cleanLender})`,
      notes: descNote,
      tags: ['piutang', 'pinjaman_pribadi', 'pinjam_teruskan'],
      debtId: receivableId,
      ledgerGroupId,
      parentTransactionId: receiptTxId,
      transactionNature: 'loan_disbursement',
      affectsAccountBalance: true,
      excludeFromExpenseStats: true,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: nowISO,
    };

    const payableDebt: Debt = {
      id: payableId,
      direction: 'payable',
      debtReceiptType: 'cash_received',
      accountId: receiveAcc.id,
      transactionId: receiptTxId,
      linkedDebtId: receivableId,
      date: txDate,
      idempotencyKey: input.idempotencyKey,
      creditor: cleanLender,
      description: descNote,
      initialAmount: roundedAmount,
      remainingAmount: roundedAmount,
      dueDate: input.dueDatePayable || undefined,
      priority: 1,
      status: 'active',
      createdAt: nowISO,
    };

    const receivableDebt: Debt = {
      id: receivableId,
      direction: 'receivable',
      receivableType: 'personal_loan',
      accountId: disburseAcc.id,
      transactionId: disburseTxId,
      linkedDebtId: payableId,
      revenueAlreadyRecorded: false,
      date: txDate,
      creditor: cleanBorrower,
      description: descNote,
      initialAmount: roundedAmount,
      remainingAmount: roundedAmount,
      dueDate: input.dueDateReceivable || undefined,
      priority: 1,
      status: 'active',
      createdAt: nowISO,
    };

    const nextState = appendChangeLog(
      {
        ...state,
        transactions: [disburseTx, receiptTx, ...state.transactions],
        debts: [...state.debts, payableDebt, receivableDebt],
      },
      {
        entityType: 'debt',
        entityId: payableId,
        action: 'create',
        summary: `Catat pinjaman dari ${cleanLender} diteruskan ke ${cleanBorrower}: ${formatIDR(roundedAmount)}`,
        afterValue: `Utang ${cleanLender} ↔ Piutang ${cleanBorrower}`,
      }
    );

    return { state: nextState, payableDebt, receivableDebt };
  }

  // direct_passthrough (A -> B via user, net kas = 0)
  const refAcc =
    state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness) ??
    state.accounts[0];
  if (!refAcc) {
    throw new Error('Tidak ada akun referensi pada sistem.');
  }

  const txId = generateId();
  const passthroughTx: Transaction = {
    id: txId,
    type: 'expense',
    amount: roundedAmount,
    categoryId: resolveSystemCategoryId(state.categories, 'debt_payment', 'cat-debt', 'expense'),
    accountId: refAcc.id,
    date: txDate,
    description: `Teruskan Pinjaman: ${cleanLender} → ${cleanBorrower}`,
    notes: `${descNote} (Non-kas; kas bersih tidak berubah)`,
    tags: ['utang', 'piutang', 'pinjam_teruskan'],
    debtId: payableId,
    ledgerGroupId,
    transactionNature: 'linked_borrow_lend',
    affectsAccountBalance: false,
    excludeFromExpenseStats: true,
    excludeFromIncomeStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const payableDebt: Debt = {
    id: payableId,
    direction: 'payable',
    debtReceiptType: 'cash_received',
    transactionId: txId,
    linkedDebtId: receivableId,
    date: txDate,
    idempotencyKey: input.idempotencyKey,
    creditor: cleanLender,
    description: descNote,
    initialAmount: roundedAmount,
    remainingAmount: roundedAmount,
    dueDate: input.dueDatePayable || undefined,
    priority: 1,
    status: 'active',
    createdAt: nowISO,
  };

  const receivableDebt: Debt = {
    id: receivableId,
    direction: 'receivable',
    receivableType: 'personal_loan',
    transactionId: txId,
    linkedDebtId: payableId,
    revenueAlreadyRecorded: false,
    date: txDate,
    creditor: cleanBorrower,
    description: descNote,
    initialAmount: roundedAmount,
    remainingAmount: roundedAmount,
    dueDate: input.dueDateReceivable || undefined,
    priority: 1,
    status: 'active',
    createdAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: [passthroughTx, ...state.transactions],
      debts: [...state.debts, payableDebt, receivableDebt],
    },
    {
      entityType: 'debt',
      entityId: payableId,
      action: 'create',
      summary: `Catat pinjaman diteruskan (${cleanLender} → ${cleanBorrower}): ${formatIDR(roundedAmount)}`,
      afterValue: `Utang ${cleanLender} ↔ Piutang ${cleanBorrower} (Kas bersih Rp0)`,
    }
  );

  return { state: nextState, payableDebt, receivableDebt };
}

// =============================================================================
// PHASE 2.6: ASSET MANAGEMENT & PHYSICAL ITEM LENDING
// =============================================================================

export function purchaseAssetAction(
  state: FinanceState,
  input: {
    name: string;
    category: AssetCategory;
    acquisitionDate: string;
    acquisitionValue: number;
    condition: AssetCondition;
    paymentMethod: AssetPaymentMethod;
    accountId?: string;
    downPaymentAmount?: number;
    creditor?: string;
    dueDate?: string;
    brandOrModel?: string;
    serialNumber?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): {
  state: FinanceState;
  asset: PhysicalAsset;
  debt?: Debt;
  transaction: Transaction;
} {
  if (input.idempotencyKey) {
    const existing = (state.physicalAssets ?? []).find(
      (a) => a.idempotencyKey === input.idempotencyKey && !a.isVoided
    );
    if (existing) {
      const existingDebt = existing.purchaseDebtId
        ? state.debts.find((d) => d.id === existing.purchaseDebtId)
        : undefined;
      const existingTx =
        state.transactions.find(
          (t) =>
            t.id === (existing.downPaymentTransactionId ?? existing.purchaseTransactionId)
        ) ?? state.transactions[0];
      return { state, asset: existing, debt: existingDebt, transaction: existingTx };
    }
  }

  const cleanName = input.name.trim();
  if (!cleanName) {
    throw new Error('Nama aset fisik wajib diisi.');
  }
  if (!Number.isFinite(input.acquisitionValue) || input.acquisitionValue <= 0) {
    throw new Error('Nilai perolehan aset harus lebih dari Rp0.');
  }

  const totalValue = Math.round(input.acquisitionValue);
  const txDate = input.acquisitionDate || todayISO();
  const nowISO = new Date().toISOString();
  const assetId = generateId();
  const ledgerGroupId = generateId();

  const initialCondLog: AssetConditionLogEntry = {
    id: generateId(),
    date: txDate,
    condition: input.condition,
    note:
      input.paymentMethod === 'cash'
        ? 'Perolehan aset fisik secara tunai'
        : input.paymentMethod === 'credit_with_down_payment'
        ? 'Perolehan aset fisik secara kredit dengan uang muka'
        : 'Perolehan aset fisik secara kredit penuh',
    createdAt: nowISO,
  };

  if (input.paymentMethod === 'cash') {
    const balances = computeAccountBalances(state);
    const sourceAcc = balances.find((a) => a.id === input.accountId);
    if (!sourceAcc) {
      throw new Error('Akun pembayaran pembelian aset tidak ditemukan.');
    }
    if ((sourceAcc.status ?? 'active') !== 'active') {
      throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
    }
    if (sourceAcc.currentBalance < totalValue) {
      throw new Error(
        `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk membeli aset senilai ${formatIDR(totalValue)}.`
      );
    }

    const txId = generateId();
    const tx: Transaction = {
      id: txId,
      type: 'expense',
      amount: totalValue,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'other_expense',
        'cat-other-exp',
        'expense'
      ),
      accountId: sourceAcc.id,
      date: txDate,
      description: `Beli Aset: ${cleanName}`,
      notes: input.notes?.trim() || 'Pembelian aset fisik (bukan pengeluaran konsumsi)',
      tags: ['aset_fisik', 'beli_aset_tunai'],
      assetId,
      ledgerGroupId,
      transactionNature: 'asset_purchase_cash',
      affectsAccountBalance: true,
      excludeFromExpenseStats: true,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: nowISO,
    };

    const asset: PhysicalAsset = {
      id: assetId,
      name: cleanName,
      category: input.category,
      acquisitionDate: txDate,
      acquisitionValue: totalValue,
      condition: input.condition,
      status: 'active',
      paymentMethod: 'cash',
      accountId: sourceAcc.id,
      purchaseTransactionId: txId,
      ledgerGroupId,
      brandOrModel: input.brandOrModel?.trim() || undefined,
      serialNumber: input.serialNumber?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      conditionHistory: [initialCondLog],
      lossHistory: [],
      recoveryHistory: [],
      idempotencyKey: input.idempotencyKey,
      isVoided: false,
      createdAt: nowISO,
    };

    const nextState = appendChangeLog(
      {
        ...state,
        transactions: [tx, ...state.transactions],
        physicalAssets: [asset, ...(state.physicalAssets ?? [])],
      },
      {
        entityType: 'physical_asset',
        entityId: asset.id,
        action: 'create',
        summary: `Beli aset tunai: ${asset.name} (${formatIDR(asset.acquisitionValue)})`,
        afterValue: `Nilai Aset +${formatIDR(asset.acquisitionValue)} · Kas -${formatIDR(totalValue)}`,
      }
    );

    return { state: nextState, asset, transaction: tx };
  }

  // Credit or Credit with Down Payment
  const cleanCreditor = input.creditor?.trim() || '';
  if (!cleanCreditor) {
    throw new Error('Nama pihak pemberi kredit / penjual cicilan wajib diisi.');
  }

  const dpAmount = Math.round(input.downPaymentAmount ?? 0);
  if (input.paymentMethod === 'credit_with_down_payment') {
    if (!Number.isFinite(dpAmount) || dpAmount <= 0 || dpAmount >= totalValue) {
      throw new Error(
        'Nominal uang muka (DP) harus lebih dari Rp0 dan lebih kecil dari nilai total aset.'
      );
    }
  } else if (dpAmount !== 0) {
    throw new Error('Pembelian kredit penuh tidak boleh memiliki nominal uang muka.');
  }

  const remainingDebtAmount = totalValue - dpAmount;
  const debtId = generateId();
  const txId = generateId();

  let txAccountId: string;
  if (dpAmount > 0) {
    const balances = computeAccountBalances(state);
    const sourceAcc = balances.find((a) => a.id === input.accountId);
    if (!sourceAcc) {
      throw new Error('Akun pembayaran uang muka (DP) aset tidak ditemukan.');
    }
    if ((sourceAcc.status ?? 'active') !== 'active') {
      throw new Error(`Akun "${sourceAcc.name}" tidak aktif dan tidak dapat digunakan.`);
    }
    if (sourceAcc.currentBalance < dpAmount) {
      throw new Error(
        `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk uang muka sebesar ${formatIDR(dpAmount)}.`
      );
    }
    txAccountId = sourceAcc.id;
  } else {
    const refAcc =
      state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness) ??
      state.accounts[0];
    if (!refAcc) {
      throw new Error('Tidak ada akun referensi pada sistem.');
    }
    txAccountId = refAcc.id;
  }

  const tx: Transaction = {
    id: txId,
    type: 'expense',
    amount: dpAmount > 0 ? dpAmount : totalValue,
    categoryId: resolveSystemCategoryId(state.categories, 'debt_payment', 'cat-debt', 'expense'),
    accountId: txAccountId,
    date: txDate,
    description:
      dpAmount > 0 ? `Uang Muka Aset: ${cleanName}` : `Beli Aset Kredit: ${cleanName}`,
    notes:
      dpAmount > 0
        ? `Uang muka pembelian ${cleanName}; sisa kredit ${formatIDR(remainingDebtAmount)} ke ${cleanCreditor}`
        : `Pembelian aset secara kredit penuh ke ${cleanCreditor} (non-kas)`,
    tags: ['aset_fisik', dpAmount > 0 ? 'dp_aset' : 'kredit_aset'],
    assetId,
    debtId,
    ledgerGroupId,
    transactionNature: dpAmount > 0 ? 'asset_purchase_down_payment' : 'asset_purchase_credit',
    affectsAccountBalance: dpAmount > 0,
    excludeFromExpenseStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const debt: Debt = {
    id: debtId,
    direction: 'payable',
    debtReceiptType: 'direct_expense',
    accountId: dpAmount > 0 ? txAccountId : undefined,
    transactionId: txId,
    assetId,
    date: txDate,
    creditor: cleanCreditor,
    description: `Cicilan pembelian aset: ${cleanName}`,
    initialAmount: remainingDebtAmount,
    remainingAmount: remainingDebtAmount,
    dueDate: input.dueDate || undefined,
    priority: 1,
    status: 'active',
    createdAt: nowISO,
  };

  const asset: PhysicalAsset = {
    id: assetId,
    name: cleanName,
    category: input.category,
    acquisitionDate: txDate,
    acquisitionValue: totalValue,
    condition: input.condition,
    status: 'active',
    paymentMethod: input.paymentMethod,
    accountId: dpAmount > 0 ? txAccountId : undefined,
    downPaymentAmount: dpAmount > 0 ? dpAmount : undefined,
    purchaseTransactionId: dpAmount === 0 ? txId : undefined,
    downPaymentTransactionId: dpAmount > 0 ? txId : undefined,
    purchaseDebtId: debtId,
    ledgerGroupId,
    brandOrModel: input.brandOrModel?.trim() || undefined,
    serialNumber: input.serialNumber?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    conditionHistory: [initialCondLog],
    lossHistory: [],
    recoveryHistory: [],
    idempotencyKey: input.idempotencyKey,
    isVoided: false,
    createdAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: [tx, ...state.transactions],
      debts: [...state.debts, debt],
      physicalAssets: [asset, ...(state.physicalAssets ?? [])],
    },
    {
      entityType: 'physical_asset',
      entityId: asset.id,
      action: 'create',
      summary: `Beli aset kredit: ${asset.name} (${formatIDR(asset.acquisitionValue)})`,
      afterValue:
        dpAmount > 0
          ? `DP ${formatIDR(dpAmount)} · Utang ${formatIDR(remainingDebtAmount)}`
          : `Kredit penuh · Utang ${formatIDR(remainingDebtAmount)}`,
    }
  );

  return { state: nextState, asset, debt, transaction: tx };
}

export function purchaseAssetCashAction(
  state: FinanceState,
  input: {
    name: string;
    category: AssetCategory;
    acquisitionDate: string;
    acquisitionValue: number;
    condition: AssetCondition;
    accountId: string;
    brandOrModel?: string;
    serialNumber?: string;
    notes?: string;
    idempotencyKey?: string;
  }
) {
  return purchaseAssetAction(state, { ...input, paymentMethod: 'cash' });
}

export function purchaseAssetCreditAction(
  state: FinanceState,
  input: {
    name: string;
    category: AssetCategory;
    acquisitionDate: string;
    acquisitionValue: number;
    condition: AssetCondition;
    creditor: string;
    downPaymentAmount?: number;
    accountId?: string;
    dueDate?: string;
    brandOrModel?: string;
    serialNumber?: string;
    notes?: string;
    idempotencyKey?: string;
  }
) {
  const dp = Math.round(input.downPaymentAmount ?? 0);
  return purchaseAssetAction(state, {
    ...input,
    paymentMethod: dp > 0 ? 'credit_with_down_payment' : 'credit',
  });
}

export function updateAssetConditionAction(
  state: FinanceState,
  input: {
    assetId: string;
    condition: AssetCondition;
    date?: string;
    note?: string;
  }
): FinanceState {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided || asset.status === 'voided') {
    throw new Error('Aset fisik tidak ditemukan atau sudah dibatalkan (void).');
  }

  const nowISO = new Date().toISOString();
  const entry: AssetConditionLogEntry = {
    id: generateId(),
    date: input.date || todayISO(),
    previousCondition: asset.condition,
    condition: input.condition,
    note: input.note?.trim() || 'Pembaruan kondisi fisik aset',
    createdAt: nowISO,
  };

  const nextAssets = (state.physicalAssets ?? []).map((a) =>
    a.id === asset.id
      ? {
          ...a,
          condition: input.condition,
          conditionHistory: [entry, ...(a.conditionHistory ?? [])],
          updatedAt: nowISO,
        }
      : a
  );

  return appendChangeLog(
    { ...state, physicalAssets: nextAssets },
    {
      entityType: 'physical_asset',
      entityId: asset.id,
      action: 'update',
      summary: `Perbarui kondisi aset "${asset.name}": ${asset.condition} → ${input.condition}`,
      beforeValue: asset.condition,
      afterValue: input.condition,
    }
  );
}

export function sellAssetAction(
  state: FinanceState,
  input: {
    assetId: string;
    salePrice: number;
    soldDate: string;
    proceedsMode: 'cash' | 'receivable';
    accountId?: string;
    buyerName?: string;
    dueDate?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): {
  state: FinanceState;
  asset: PhysicalAsset;
  transaction: Transaction;
  receivable?: Debt;
} {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided || asset.status === 'voided') {
    throw new Error('Aset fisik tidak ditemukan atau sudah dibatalkan (void).');
  }
  if (asset.status === 'sold') {
    throw new Error(`Aset "${asset.name}" sudah tercatat terjual.`);
  }
  if (asset.status === 'lost') {
    throw new Error(`Aset "${asset.name}" berstatus hilang dan tidak dapat dijual.`);
  }
  if (asset.status === 'lent') {
    throw new Error(
      `Aset "${asset.name}" sedang dipinjamkan. Catat pengembalian terlebih dahulu sebelum menjual aset.`
    );
  }
  if (!Number.isFinite(input.salePrice) || input.salePrice <= 0) {
    throw new Error('Harga jual aset harus lebih dari Rp0.');
  }

  const roundedSale = Math.round(input.salePrice);
  const soldDate = input.soldDate || todayISO();
  const gainOrLoss = roundedSale - asset.acquisitionValue;
  const nowISO = new Date().toISOString();
  const txId = generateId();

  if (input.proceedsMode === 'cash') {
    const targetAcc = state.accounts.find((a) => a.id === input.accountId);
    if (!targetAcc) {
      throw new Error('Akun penerima hasil penjualan aset tidak ditemukan.');
    }
    if ((targetAcc.status ?? 'active') !== 'active') {
      throw new Error(`Akun "${targetAcc.name}" tidak aktif dan tidak dapat menerima dana.`);
    }

    const tx: Transaction = {
      id: txId,
      type: 'income',
      amount: roundedSale,
      categoryId: resolveSystemCategoryId(
        state.categories,
        'income_other',
        'cat-income-other',
        'income'
      ),
      accountId: targetAcc.id,
      date: soldDate,
      description: `Jual Aset: ${asset.name}`,
      notes: input.notes?.trim() || `Hasil penjualan aset fisik (Laba/Rugi: ${gainOrLoss >= 0 ? '+' : ''}${formatIDR(gainOrLoss)})`,
      tags: ['aset_fisik', 'jual_aset'],
      incomeSource: 'other',
      assetId: asset.id,
      ledgerGroupId: asset.ledgerGroupId,
      transactionNature: 'asset_sale_proceeds',
      affectsAccountBalance: true,
      excludeFromIncomeStats: true,
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      isVoided: false,
      createdAt: nowISO,
    };

    const updatedAsset: PhysicalAsset = {
      ...asset,
      status: 'sold',
      disposal: {
        disposalType: 'sold',
        soldDate,
        salePrice: roundedSale,
        acquisitionValueAtDisposal: asset.acquisitionValue,
        gainOrLoss,
        proceedsMode: 'cash',
        buyerName: input.buyerName?.trim() || undefined,
        saleAccountId: targetAcc.id,
        saleTransactionId: txId,
        notes: input.notes?.trim() || undefined,
        createdAt: nowISO,
      },
      updatedAt: nowISO,
    };

    const nextState = appendChangeLog(
      {
        ...state,
        transactions: [tx, ...state.transactions],
        physicalAssets: (state.physicalAssets ?? []).map((a) =>
          a.id === asset.id ? updatedAsset : a
        ),
      },
      {
        entityType: 'physical_asset',
        entityId: asset.id,
        action: 'close',
        summary: `Jual aset tunai "${asset.name}": ${formatIDR(roundedSale)} (${gainOrLoss >= 0 ? 'Laba' : 'Rugi'} ${formatIDR(Math.abs(gainOrLoss))})`,
        beforeValue: formatIDR(asset.acquisitionValue),
        afterValue: `Terjual ${formatIDR(roundedSale)}`,
      }
    );

    return { state: nextState, asset: updatedAsset, transaction: tx };
  }

  // Proceeds as Receivable (jual kredit / dibayar menyusul)
  const cleanBuyer = input.buyerName?.trim() || '';
  if (!cleanBuyer) {
    throw new Error('Nama pembeli wajib diisi jika penjualan aset dicatat sebagai piutang.');
  }

  const refAcc =
    state.accounts.find((a) => (a.status ?? 'active') === 'active' && !a.isBusiness) ??
    state.accounts[0];
  if (!refAcc) {
    throw new Error('Tidak ada akun referensi pada sistem.');
  }

  const receivableId = generateId();
  const tx: Transaction = {
    id: txId,
    type: 'income',
    amount: roundedSale,
    categoryId: resolveSystemCategoryId(
      state.categories,
      'income_other',
      'cat-income-other',
      'income'
    ),
    accountId: refAcc.id,
    date: soldDate,
    description: `Jual Aset (Piutang ke ${cleanBuyer}): ${asset.name}`,
    notes: input.notes?.trim() || `Piutang penjualan aset (non-kas; Laba/Rugi: ${gainOrLoss >= 0 ? '+' : ''}${formatIDR(gainOrLoss)})`,
    tags: ['aset_fisik', 'jual_aset', 'piutang_aset'],
    incomeSource: 'other',
    assetId: asset.id,
    debtId: receivableId,
    ledgerGroupId: asset.ledgerGroupId,
    transactionNature: 'asset_sale_proceeds',
    affectsAccountBalance: false,
    excludeFromIncomeStats: true,
    isEssential: false,
    isDiscretionary: false,
    exceededBudget: false,
    isVoided: false,
    createdAt: nowISO,
  };

  const receivable: Debt = {
    id: receivableId,
    direction: 'receivable',
    receivableType: 'asset_sale',
    transactionId: txId,
    assetId: asset.id,
    revenueAlreadyRecorded: false,
    date: soldDate,
    idempotencyKey: input.idempotencyKey,
    creditor: cleanBuyer,
    description: `Piutang penjualan aset: ${asset.name}`,
    initialAmount: roundedSale,
    remainingAmount: roundedSale,
    dueDate: input.dueDate || undefined,
    priority: 1,
    status: 'active',
    createdAt: nowISO,
  };

  const updatedAsset: PhysicalAsset = {
    ...asset,
    status: 'sold',
    disposal: {
      disposalType: 'sold',
      soldDate,
      salePrice: roundedSale,
      acquisitionValueAtDisposal: asset.acquisitionValue,
      gainOrLoss,
      proceedsMode: 'receivable',
      buyerName: cleanBuyer,
      saleTransactionId: txId,
      receivableId,
      notes: input.notes?.trim() || undefined,
      createdAt: nowISO,
    },
    updatedAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      transactions: [tx, ...state.transactions],
      debts: [...state.debts, receivable],
      physicalAssets: (state.physicalAssets ?? []).map((a) =>
        a.id === asset.id ? updatedAsset : a
      ),
    },
    {
      entityType: 'physical_asset',
      entityId: asset.id,
      action: 'close',
      summary: `Jual aset (piutang ${cleanBuyer}) "${asset.name}": ${formatIDR(roundedSale)}`,
      beforeValue: formatIDR(asset.acquisitionValue),
      afterValue: `Piutang ${formatIDR(roundedSale)}`,
    }
  );

  return { state: nextState, asset: updatedAsset, transaction: tx, receivable };
}

export function reportAssetLostAction(
  state: FinanceState,
  input: {
    assetId: string;
    lostDate: string;
    reason: string;
    requireCompensation?: boolean;
    liableParty?: string;
    compensationAmount?: number;
    compensationDueDate?: string;
    notes?: string;
    idempotencyKey?: string;
  }
): {
  state: FinanceState;
  asset: PhysicalAsset;
  lossRecord: AssetLossRecord;
  compensationDebt?: Debt;
} {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided || asset.status === 'voided') {
    throw new Error('Aset fisik tidak ditemukan atau sudah dibatalkan (void).');
  }
  if (asset.status === 'sold') {
    throw new Error(`Aset "${asset.name}" sudah berstatus terjual.`);
  }
  if (asset.status === 'lost') {
    throw new Error(`Aset "${asset.name}" sudah tercatat hilang.`);
  }

  const cleanReason = input.reason.trim();
  if (!cleanReason) {
    throw new Error('Alasan atau kronologi kehilangan aset wajib diisi.');
  }

  const activeLoan = (state.physicalItemLoans ?? []).find(
    (l) => !l.isVoided && l.direction === 'lent' && l.assetId === asset.id && l.status === 'active'
  );

  const lostDate = input.lostDate || todayISO();
  const nowISO = new Date().toISOString();
  const lossId = generateId();

  let compensationDebt: Debt | undefined;
  let compDebtId: string | undefined;
  let roundedComp: number | undefined;
  const resolvedLiableParty = input.liableParty?.trim() || activeLoan?.counterpartyName;

  if (input.requireCompensation) {
    const compAmount = Math.round(input.compensationAmount ?? 0);
    if (!Number.isFinite(compAmount) || compAmount <= 0) {
      throw new Error('Nominal piutang ganti rugi harus lebih dari Rp0.');
    }
    if (!resolvedLiableParty) {
      throw new Error('Nama pihak penanggung ganti rugi wajib diisi.');
    }
    compDebtId = generateId();
    roundedComp = compAmount;
    compensationDebt = {
      id: compDebtId,
      direction: 'receivable',
      receivableType: 'asset_loss_compensation',
      assetId: asset.id,
      physicalLoanId: activeLoan?.id,
      revenueAlreadyRecorded: false,
      date: lostDate,
      idempotencyKey: input.idempotencyKey,
      creditor: resolvedLiableParty,
      description: `Ganti rugi kehilangan aset: ${asset.name}`,
      initialAmount: roundedComp,
      remainingAmount: roundedComp,
      dueDate: input.compensationDueDate || undefined,
      priority: 1,
      status: 'active',
      createdAt: nowISO,
    };
  }

  const lossRecord: AssetLossRecord = {
    id: lossId,
    lostDate,
    reason: cleanReason,
    lossAmount: asset.acquisitionValue,
    loanId: activeLoan?.id,
    liableParty: resolvedLiableParty || undefined,
    compensationAmount: roundedComp,
    compensationDebtId: compDebtId,
    notes: input.notes?.trim() || undefined,
    createdAt: nowISO,
  };

  const updatedAsset: PhysicalAsset = {
    ...asset,
    status: 'lost',
    lossHistory: [lossRecord, ...(asset.lossHistory ?? [])],
    updatedAt: nowISO,
  };

  const nextLoans = activeLoan
    ? (state.physicalItemLoans ?? []).map((l) =>
        l.id === activeLoan.id
          ? {
              ...l,
              status: 'lost' as const,
              lossRecordId: lossId,
              compensationDebtId: compDebtId,
              updatedAt: nowISO,
            }
          : l
      )
    : state.physicalItemLoans;

  const nextState = appendChangeLog(
    {
      ...state,
      physicalAssets: (state.physicalAssets ?? []).map((a) =>
        a.id === asset.id ? updatedAsset : a
      ),
      ...(nextLoans !== undefined ? { physicalItemLoans: nextLoans } : {}),
      debts: compensationDebt ? [...state.debts, compensationDebt] : state.debts,
    },
    {
      entityType: 'physical_asset',
      entityId: asset.id,
      action: 'update',
      summary: `Catat aset hilang "${asset.name}" (${formatIDR(asset.acquisitionValue)})`,
      beforeValue: asset.status,
      afterValue: compensationDebt
        ? `Hilang · Ganti rugi ${formatIDR(compensationDebt.initialAmount)}`
        : 'Hilang (Tanpa ganti rugi)',
      note: cleanReason,
    }
  );

  return { state: nextState, asset: updatedAsset, lossRecord, compensationDebt };
}

export function recoverLostAssetAction(
  state: FinanceState,
  input: {
    assetId: string;
    recoveredDate: string;
    condition: AssetCondition;
    cancelUnpaidCompensation?: boolean;
    cancelReason?: string;
    notes?: string;
  }
): {
  state: FinanceState;
  asset: PhysicalAsset;
  recoveryRecord: AssetRecoveryRecord;
} {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided || asset.status === 'voided') {
    throw new Error('Aset fisik tidak ditemukan atau sudah dibatalkan (void).');
  }
  if (asset.status !== 'lost') {
    throw new Error(`Hanya aset berstatus hilang yang dapat dipulihkan (status saat ini: ${asset.status}).`);
  }

  const recoveredDate = input.recoveredDate || todayISO();
  const nowISO = new Date().toISOString();
  const latestLoss = (asset.lossHistory ?? [])[0];
  let nextDebts = state.debts;
  let nextLossHistory = asset.lossHistory ?? [];
  let compCancelled = false;

  if (input.cancelUnpaidCompensation && latestLoss?.compensationDebtId) {
    const compDebt = state.debts.find((d) => d.id === latestLoss.compensationDebtId);
    if (compDebt && !compDebt.isVoided) {
      const hasCollected = state.debtPayments.some(
        (dp) => dp.debtId === compDebt.id && !dp.isVoided
      );
      if (hasCollected) {
        throw new Error(
          'Piutang ganti rugi sudah memiliki penerimaan pembayaran aktif. Batalkan penerimaan pembayaran terlebih dahulu sebelum membatalkan piutang ganti rugi.'
        );
      }
      const cancelNote = input.cancelReason?.trim() || 'Aset ditemukan kembali; ganti rugi dibatalkan';
      nextDebts = state.debts.map((d) =>
        d.id === compDebt.id
          ? {
              ...d,
              remainingAmount: 0,
              isVoided: true,
              voidedAt: nowISO,
              voidReason: cancelNote,
            }
          : d
      );
      nextLossHistory = nextLossHistory.map((lr) =>
        lr.id === latestLoss.id
          ? {
              ...lr,
              compensationCancelled: true,
              compensationCancelledAt: nowISO,
              compensationCancelReason: cancelNote,
            }
          : lr
      );
      compCancelled = true;
    }
  }

  const recoveryRecord: AssetRecoveryRecord = {
    id: generateId(),
    recoveredDate,
    condition: input.condition,
    lossRecordId: latestLoss?.id,
    compensationCancelled: compCancelled,
    notes: input.notes?.trim() || undefined,
    createdAt: nowISO,
  };

  const condEntry: AssetConditionLogEntry = {
    id: generateId(),
    date: recoveredDate,
    previousCondition: asset.condition,
    condition: input.condition,
    note: `Aset ditemukan kembali (${input.notes?.trim() || 'Status kembali aktif dimiliki'})`,
    createdAt: nowISO,
  };

  const updatedAsset: PhysicalAsset = {
    ...asset,
    status: 'active',
    condition: input.condition,
    conditionHistory: [condEntry, ...(asset.conditionHistory ?? [])],
    lossHistory: nextLossHistory,
    recoveryHistory: [recoveryRecord, ...(asset.recoveryHistory ?? [])],
    updatedAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      debts: nextDebts,
      physicalAssets: (state.physicalAssets ?? []).map((a) =>
        a.id === asset.id ? updatedAsset : a
      ),
    },
    {
      entityType: 'physical_asset',
      entityId: asset.id,
      action: 'reopen',
      summary: `Pulihkan aset ditemukan kembali: "${asset.name}"`,
      beforeValue: 'Hilang',
      afterValue: compCancelled ? 'Aktif · Ganti rugi dibatalkan' : 'Aktif Dimiliki',
      note: input.notes?.trim() || undefined,
    }
  );

  return { state: nextState, asset: updatedAsset, recoveryRecord };
}

export function cancelAssetCompensationAction(
  state: FinanceState,
  input: {
    assetId: string;
    lossRecordId?: string;
    reason?: string;
  }
): FinanceState {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided) {
    throw new Error('Aset fisik tidak ditemukan.');
  }
  const targetLoss = input.lossRecordId
    ? (asset.lossHistory ?? []).find((l) => l.id === input.lossRecordId)
    : (asset.lossHistory ?? []).find((l) => Boolean(l.compensationDebtId) && !l.compensationCancelled);

  if (!targetLoss || !targetLoss.compensationDebtId) {
    throw new Error('Tidak ada piutang ganti rugi yang dapat dibatalkan pada aset ini.');
  }

  const compDebt = state.debts.find((d) => d.id === targetLoss.compensationDebtId);
  if (!compDebt || compDebt.isVoided) {
    return state;
  }

  const hasCollected = state.debtPayments.some(
    (dp) => dp.debtId === compDebt.id && !dp.isVoided
  );
  if (hasCollected) {
    throw new Error(
      'Piutang ganti rugi sudah memiliki penerimaan pembayaran. Batalkan penerimaan pembayaran terlebih dahulu.'
    );
  }

  const nowISO = new Date().toISOString();
  const cleanReason = input.reason?.trim() || 'Piutang ganti rugi aset dibatalkan';

  return appendChangeLog(
    {
      ...state,
      debts: state.debts.map((d) =>
        d.id === compDebt.id
          ? {
              ...d,
              remainingAmount: 0,
              isVoided: true,
              voidedAt: nowISO,
              voidReason: cleanReason,
            }
          : d
      ),
      physicalAssets: (state.physicalAssets ?? []).map((a) =>
        a.id === asset.id
          ? {
              ...a,
              lossHistory: (a.lossHistory ?? []).map((lr) =>
                lr.id === targetLoss.id
                  ? {
                      ...lr,
                      compensationCancelled: true,
                      compensationCancelledAt: nowISO,
                      compensationCancelReason: cleanReason,
                    }
                  : lr
              ),
              updatedAt: nowISO,
            }
          : a
      ),
    },
    {
      entityType: 'receivable',
      entityId: compDebt.id,
      action: 'void',
      summary: `Batalkan piutang ganti rugi aset "${asset.name}" (${formatIDR(compDebt.initialAmount)})`,
      beforeValue: formatIDR(compDebt.remainingAmount),
      afterValue: 'Dibatalkan (Rp0)',
      note: cleanReason,
    }
  );
}

export function borrowPhysicalItemAction(
  state: FinanceState,
  input: {
    itemName: string;
    category?: AssetCategory;
    ownerName: string;
    loanDate: string;
    expectedReturnDate?: string;
    conditionReceived: AssetCondition;
    notes?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; loan: PhysicalItemLoan } {
  if (input.idempotencyKey) {
    const existing = (state.physicalItemLoans ?? []).find(
      (l) => l.idempotencyKey === input.idempotencyKey && !l.isVoided
    );
    if (existing) return { state, loan: existing };
  }

  const cleanItem = input.itemName.trim();
  const cleanOwner = input.ownerName.trim();
  if (!cleanItem || !cleanOwner) {
    throw new Error('Nama barang dan nama pemilik barang wajib diisi.');
  }
  const loanDate = input.loanDate || todayISO();
  if (input.expectedReturnDate && input.expectedReturnDate < loanDate) {
    throw new Error('Tanggal rencana pengembalian tidak boleh lebih awal dari tanggal pinjam.');
  }

  const nowISO = new Date().toISOString();
  const loan: PhysicalItemLoan = {
    id: generateId(),
    direction: 'borrowed',
    itemName: cleanItem,
    category: input.category ?? 'other',
    counterpartyName: cleanOwner,
    loanDate,
    expectedReturnDate: input.expectedReturnDate || undefined,
    conditionGivenOrReceived: input.conditionReceived,
    status: 'active',
    conditionHistory: [
      {
        id: generateId(),
        date: loanDate,
        condition: input.conditionReceived,
        note: `Barang diterima dipinjam dari ${cleanOwner} (bukan aset pengguna)`,
        createdAt: nowISO,
      },
    ],
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    isVoided: false,
    createdAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      physicalItemLoans: [loan, ...(state.physicalItemLoans ?? [])],
    },
    {
      entityType: 'physical_loan',
      entityId: loan.id,
      action: 'create',
      summary: `Pinjam barang milik ${cleanOwner}: ${cleanItem}`,
      afterValue: `Non-Aset · Status Aktif Dipinjam`,
    }
  );

  return { state: nextState, loan };
}

export function lendPhysicalAssetAction(
  state: FinanceState,
  input: {
    assetId: string;
    borrowerName: string;
    loanDate: string;
    expectedReturnDate?: string;
    conditionGiven?: AssetCondition;
    notes?: string;
    idempotencyKey?: string;
  }
): { state: FinanceState; loan: PhysicalItemLoan; asset: PhysicalAsset } {
  const asset = (state.physicalAssets ?? []).find((a) => a.id === input.assetId);
  if (!asset || asset.isVoided || asset.status === 'voided') {
    throw new Error('Aset fisik milik pengguna tidak ditemukan.');
  }
  if (asset.status === 'lent') {
    throw new Error(`Aset "${asset.name}" saat ini sudah berstatus dipinjamkan.`);
  }
  if (asset.status === 'sold' || asset.status === 'lost') {
    throw new Error(
      `Aset "${asset.name}" berstatus ${asset.status === 'sold' ? 'terjual' : 'hilang'} dan tidak dapat dipinjamkan.`
    );
  }

  if (input.idempotencyKey) {
    const existing = (state.physicalItemLoans ?? []).find(
      (l) => l.idempotencyKey === input.idempotencyKey && !l.isVoided
    );
    if (existing) return { state, loan: existing, asset };
  }

  const cleanBorrower = input.borrowerName.trim();
  if (!cleanBorrower) {
    throw new Error('Nama peminjam barang wajib diisi.');
  }
  const loanDate = input.loanDate || todayISO();
  if (input.expectedReturnDate && input.expectedReturnDate < loanDate) {
    throw new Error('Tanggal rencana kembali tidak boleh lebih awal dari tanggal dipinjamkan.');
  }

  const nowISO = new Date().toISOString();
  const condGiven = input.conditionGiven ?? asset.condition;
  const loan: PhysicalItemLoan = {
    id: generateId(),
    direction: 'lent',
    assetId: asset.id,
    itemName: asset.name,
    category: asset.category,
    counterpartyName: cleanBorrower,
    loanDate,
    expectedReturnDate: input.expectedReturnDate || undefined,
    conditionGivenOrReceived: condGiven,
    status: 'active',
    conditionHistory: [
      {
        id: generateId(),
        date: loanDate,
        condition: condGiven,
        note: `Aset dipinjamkan ke ${cleanBorrower}`,
        createdAt: nowISO,
      },
    ],
    notes: input.notes?.trim() || undefined,
    idempotencyKey: input.idempotencyKey,
    isVoided: false,
    createdAt: nowISO,
  };

  const updatedAsset: PhysicalAsset = {
    ...asset,
    status: 'lent',
    condition: condGiven,
    conditionHistory: [
      {
        id: generateId(),
        date: loanDate,
        previousCondition: asset.condition,
        condition: condGiven,
        note: `Dipinjamkan ke ${cleanBorrower} (tetap milik pengguna)`,
        createdAt: nowISO,
      },
      ...(asset.conditionHistory ?? []),
    ],
    updatedAt: nowISO,
  };

  const nextState = appendChangeLog(
    {
      ...state,
      physicalAssets: (state.physicalAssets ?? []).map((a) =>
        a.id === asset.id ? updatedAsset : a
      ),
      physicalItemLoans: [loan, ...(state.physicalItemLoans ?? [])],
    },
    {
      entityType: 'physical_loan',
      entityId: loan.id,
      action: 'create',
      summary: `Pinjamkan aset "${asset.name}" ke ${cleanBorrower}`,
      afterValue: 'Dipinjamkan (tetap dihitung sebagai aset)',
    }
  );

  return { state: nextState, loan, asset: updatedAsset };
}

export function returnPhysicalItemAction(
  state: FinanceState,
  input: {
    loanId: string;
    returnedDate: string;
    conditionReturned: AssetCondition;
    notes?: string;
  }
): FinanceState {
  const loan = (state.physicalItemLoans ?? []).find((l) => l.id === input.loanId);
  if (!loan || loan.isVoided) {
    throw new Error('Catatan peminjaman barang tidak ditemukan.');
  }
  if (loan.status === 'returned') {
    throw new Error('Barang ini sudah tercatat dikembalikan.');
  }
  if (loan.status === 'lost') {
    throw new Error('Peminjaman ini berstatus hilang; gunakan alur pemulihan aset jika ditemukan.');
  }

  const returnedDate = input.returnedDate || todayISO();
  if (returnedDate < loan.loanDate) {
    throw new Error('Tanggal pengembalian tidak boleh lebih awal dari tanggal peminjaman.');
  }

  const nowISO = new Date().toISOString();
  const loanCondEntry: AssetConditionLogEntry = {
    id: generateId(),
    date: returnedDate,
    previousCondition: loan.conditionGivenOrReceived,
    condition: input.conditionReturned,
    note: input.notes?.trim() || 'Barang dikembalikan',
    createdAt: nowISO,
  };

  const nextLoans = (state.physicalItemLoans ?? []).map((l) =>
    l.id === loan.id
      ? {
          ...l,
          status: 'returned' as const,
          returnedDate,
          conditionReturned: input.conditionReturned,
          conditionHistory: [loanCondEntry, ...(l.conditionHistory ?? [])],
          updatedAt: nowISO,
        }
      : l
  );

  const nextAssets =
    loan.direction === 'lent' && loan.assetId
      ? (state.physicalAssets ?? []).map((a) =>
          a.id === loan.assetId
            ? {
                ...a,
                status: 'active' as const,
                condition: input.conditionReturned,
                conditionHistory: [
                  {
                    id: generateId(),
                    date: returnedDate,
                    previousCondition: a.condition,
                    condition: input.conditionReturned,
                    note: `Dikembalikan oleh ${loan.counterpartyName}${input.notes?.trim() ? ` (${input.notes.trim()})` : ''}`,
                    createdAt: nowISO,
                  },
                  ...(a.conditionHistory ?? []),
                ],
                updatedAt: nowISO,
              }
            : a
        )
      : state.physicalAssets;

  return appendChangeLog(
    {
      ...state,
      ...(nextAssets !== undefined ? { physicalAssets: nextAssets } : {}),
      physicalItemLoans: nextLoans,
    },
    {
      entityType: 'physical_loan',
      entityId: loan.id,
      action: 'close',
      summary: `${loan.direction === 'lent' ? 'Terima kembali aset dipinjamkan' : 'Kembalikan barang pinjaman'}: ${loan.itemName}`,
      beforeValue: `Aktif (${loan.conditionGivenOrReceived})`,
      afterValue: `Dikembalikan (${input.conditionReturned})`,
    }
  );
}

