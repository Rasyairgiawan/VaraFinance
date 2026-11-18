import { computeAccountBalances, evaluateDisciplineForExpense } from '../engine/financeEngine';
import { DEFAULT_PROJECTION_ASSUMPTIONS, GENERAL_CATEGORY_PRESETS } from '../data/initialProfile';
import {
  Account,
  AccountTransfer,
  Category,
  CategoryClassification,
  ChangeEntityType,
  ChangeLogEntry,
  CustomReminder,
  Debt,
  DebtDirection,
  DebtPayment,
  DebtReceiptKind,
  FinanceState,
  FreelanceProject,
  GoalType,
  IncomeSourceType,
  NoSpendConfirmation,
  ObligationDurationType,
  ObligationFrequency,
  ObligationKind,
  ObligationLog,
  ObligationStatus,
  ProjectExpense,
  ProjectPayment,
  ProjectionAssumptions,
  ReceivableKind,
  RecurringObligation,
  ReminderSettings,
  SavingsGoal,
  Transaction,
  UserFinancialSettings,
} from '../types/finance';
import { addDaysISO, formatIDR, generateId, todayISO } from '../utils/format';

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
  | 'project_payment'
  | 'project_expense'
  | 'obligation_log'
  | 'reconciliation';

export interface TransactionLinkInfo {
  isLinked: boolean;
  linkType: TransactionLinkType;
  linkedDebt?: Debt;
  linkedDebtPayment?: DebtPayment;
  linkedProjectPayment?: ProjectPayment;
  linkedProjectExpense?: ProjectExpense;
  linkedObligationLog?: ObligationLog;
  canDirectVoid: boolean;
  canEditMetadataOnly: boolean;
  reason?: string;
}

export function getTransactionLinkInfo(
  state: FinanceState,
  txId: string
): TransactionLinkInfo {
  const tx = state.transactions.find((t) => t.id === txId);
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
          tx.transactionNature === 'loan_disbursement'))
  );
  if (linkedDebtByOrigin) {
    const hasActivePayments = state.debtPayments.some(
      (dp) => dp.debtId === linkedDebtByOrigin.id && !dp.isVoided
    );
    return {
      isLinked: true,
      linkType: 'debt_origin',
      linkedDebt: linkedDebtByOrigin,
      canDirectVoid: !hasActivePayments,
      canEditMetadataOnly: true,
      reason: hasActivePayments
        ? `Transaksi asal ${linkedDebtByOrigin.direction === 'receivable' ? 'piutang' : 'utang'} (${linkedDebtByOrigin.creditor}) sudah memiliki pembayaran aktif. Batalkan pembayaran terlebih dahulu sebelum membatalkan transaksi ini.`
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
  dates: string[]
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
        t.categoryId !== 'cat-biz-ops' &&
        t.categoryId !== 'cat-debt' &&
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
    [prevTx.date, nextDate]
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

  if (link.linkType === 'debt_origin' && link.linkedDebt) {
    const debt = link.linkedDebt;
    const hasActivePayments = state.debtPayments.some(
      (dp) => dp.debtId === debt.id && !dp.isVoided
    );
    if (hasActivePayments) {
      throw new Error(
        `Transaksi asal ${debt.direction === 'receivable' ? 'piutang' : 'utang'} (${debt.creditor}) masih memiliki pembayaran aktif. Batalkan pembayaran terkait terlebih dahulu sebelum membatalkan transaksi ini.`
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

    const nextNoSpend = reconcileNoSpendConfirmationsForDates(
      nextTransactions,
      state.noSpendConfirmations,
      [target.date]
    );

    return appendChangeLog(
      {
        ...state,
        transactions: nextTransactions,
        debts: nextDebts,
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

  if (
    link.linkType === 'debt_orphan' ||
    link.linkType === 'project_payment' ||
    link.linkType === 'project_expense' ||
    link.linkType === 'obligation_log'
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
    [target.date]
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
    [target.date]
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

export function addTransferAction(
  state: FinanceState,
  input: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    date: string;
    notes?: string;
  }
): FinanceState {
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

  const transfer: AccountTransfer = {
    id: generateId(),
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: Math.round(input.amount),
    date: input.date,
    notes: input.notes?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  return withSyncBump({
    ...state,
    transfers: [transfer, ...state.transfers],
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

  if (input.status === 'received') {
    const targetAccId = input.accountId || 'acc-business';
    const labelMap = {
      full: 'Pelunasan Penuh',
      dp: 'Uang Muka (DP)',
      installment: 'Cicilan Proyek',
      final: 'Pelunasan Akhir',
    };
    const res = addTransactionAction(nextState, {
      type: 'income',
      amount: input.amount,
      categoryId: 'cat-income-freelance',
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
    accountId: input.status === 'received' ? input.accountId || 'acc-business' : undefined,
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
      categoryId: 'cat-income-freelance',
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
    categoryId: projectRevenueAlreadyRecorded ? 'cat-income-other' : 'cat-income-freelance',
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
  }
): FinanceState {
  const project = state.projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error('Proyek tidak ditemukan.');
  if (input.amount <= 0) throw new Error('Nominal biaya proyek harus lebih dari Rp0.');

  const res = addTransactionAction(state, {
    type: 'expense',
    amount: input.amount,
    categoryId: 'cat-biz-ops',
    accountId: input.accountId,
    date: input.date,
    description: `Biaya Proyek (${project.projectName}): ${input.description}`,
    projectId: project.id,
  });

  return withSyncBump({
    ...res.state,
    projectExpenses: [
      {
        id: generateId(),
        projectId: project.id,
        description: input.description.trim(),
        amount: Math.round(input.amount),
        date: input.date,
        accountId: input.accountId,
        transactionId: res.transaction.id,
        createdAt: new Date().toISOString(),
      },
      ...res.state.projectExpenses,
    ],
  });
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
    if (input.receivableType === 'personal_loan') {
      if (!input.accountId) {
        throw new Error('Akun sumber dana wajib dipilih untuk pinjaman uang pribadi.');
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
          `Saldo akun "${sourceAcc.name}" (${formatIDR(sourceAcc.currentBalance)}) tidak mencukupi untuk memberikan pinjaman sebesar ${formatIDR(roundedAmount)}.`
        );
      }

      const loanTx: Transaction = {
        id: generateId(),
        type: 'expense',
        amount: roundedAmount,
        categoryId: 'cat-debt',
        accountId: sourceAcc.id,
        date: txDate,
        description: `Pinjaman Diberikan ke ${cleanCreditor}`,
        notes: cleanDesc || undefined,
        tags: ['piutang', 'pinjaman_pribadi'],
        debtId,
        transactionNature: 'loan_disbursement',
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
        categoryId: 'cat-income-other',
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

  const payAmount = Math.min(Math.round(input.amount), debt.remainingAmount);
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
    categoryId: 'cat-debt',
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

  const collectAmount = Math.min(Math.round(input.amount), item.remainingAmount);

  // Prevent double-counting project revenue or treating personal loan principal return as new income
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

  const isPersonalLoanReturn = item.receivableType === 'personal_loan';
  const projectRevenueAlreadyCounted =
    Boolean(item.revenueAlreadyRecorded) ||
    linkedProjectPayment?.status === 'received' ||
    Boolean(
      linkedProject &&
        linkedProject.contractValue > 0 &&
        linkedProjectReceivedTotal >= linkedProject.contractValue
    );
  const excludeFromIncomeStats = isPersonalLoanReturn || projectRevenueAlreadyCounted;

  const isProjectReceivable =
    item.receivableType === 'project_sales' || Boolean(item.projectId);
  const nowISO = new Date().toISOString();

  const tx: Transaction = {
    id: generateId(),
    type: 'income',
    amount: collectAmount,
    categoryId: isProjectReceivable && !excludeFromIncomeStats ? 'cat-income-freelance' : 'cat-income-other',
    accountId: targetAcc.id,
    date: input.date,
    description: `Terima Piutang: ${item.creditor}`,
    notes: input.notes?.trim() || undefined,
    tags: ['piutang', isProjectReceivable ? 'penagihan_proyek' : 'pengembalian_pinjaman'],
    incomeSource: isProjectReceivable ? 'freelance' : 'other',
    projectId: item.projectId,
    debtId: item.id,
    transactionNature: 'receivable_collection',
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
  }
): { state: FinanceState; obligation: RecurringObligation } {
  if (input.amount <= 0) throw new Error('Nominal kewajiban/tagihan harus lebih dari Rp0.');
  const cleanName = input.name.trim();
  const kind: ObligationKind = input.kind ?? 'obligation';

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
      | 'isArchived'
    >
  >
): FinanceState {
  const current = state.obligations.find((o) => o.id === obligationId);
  if (!current) throw new Error('Kewajiban tidak ditemukan.');

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
    categoryId: 'cat-college',
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
    categoryId: delta > 0 ? 'cat-income-other' : 'cat-other-exp',
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

  const totalRefs =
    usedInTx + usedInTransfer + usedInProjPay + usedInProjExp + usedInDebtPayments + usedInDebts;
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
    id: `cat-${generateId()}`,
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
  const additions: Category[] = GENERAL_CATEGORY_PRESETS.filter((p) => !existingIds.has(p.id)).map(
    (p) => ({ ...p, isSystem: false, isArchived: false })
  );
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
      if (c.id === 'cat-cig') return { ...c, weeklyLimit: nextSettings.cigaretteWeeklyLimit };
      if (c.id === 'cat-hangout') return { ...c, weeklyLimit: nextSettings.hangoutWeeklyLimit };
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
