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
  FinanceState,
  FreelanceProject,
  GoalType,
  IncomeSourceType,
  ObligationDurationType,
  ObligationFrequency,
  ObligationKind,
  ObligationStatus,
  ProjectPayment,
  ProjectionAssumptions,
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

export function updateTransactionAction(
  state: FinanceState,
  id: string,
  updates: Partial<Pick<Transaction, 'amount' | 'categoryId' | 'accountId' | 'date' | 'description' | 'notes'>>
): FinanceState {
  const prevTx = state.transactions.find((t) => t.id === id);
  const next = {
    ...state,
    transactions: state.transactions.map((t) => {
      if (t.id !== id) return t;
      const categoryId = updates.categoryId ?? t.categoryId;
      const cat = state.categories.find((c) => c.id === categoryId);
      const isEssential =
        t.type === 'expense' &&
        (cat?.classification === 'essential' ||
          cat?.classification === 'obligation' ||
          cat?.classification === 'debt' ||
          cat?.classification === 'business');
      return {
        ...t,
        ...updates,
        amount: updates.amount !== undefined ? Math.round(updates.amount) : t.amount,
        isEssential,
        isDiscretionary: t.type === 'expense' && !isEssential,
      };
    }),
  };
  return appendChangeLog(next, {
    entityType: 'transaction',
    entityId: id,
    action: 'update',
    summary: `Ubah transaksi: ${prevTx?.description ?? id}`,
    beforeValue: prevTx ? formatIDR(prevTx.amount) : undefined,
    afterValue: updates.amount !== undefined ? formatIDR(updates.amount) : undefined,
  });
}

export function voidTransactionAction(
  state: FinanceState,
  id: string,
  reason: string = 'Dibatalkan pengguna'
): FinanceState {
  const target = state.transactions.find((t) => t.id === id);
  if (!target) throw new Error('Transaksi tidak ditemukan.');
  if (target.isVoided) return state;

  const next: FinanceState = {
    ...state,
    transactions: state.transactions.map((t) =>
      t.id === id
        ? {
            ...t,
            isVoided: true,
            voidedAt: new Date().toISOString(),
            voidReason: reason.trim() || 'Dibatalkan pengguna',
          }
        : t
    ),
  };
  return appendChangeLog(next, {
    entityType: 'transaction',
    entityId: id,
    action: 'void',
    summary: `Void transaksi: ${target.description} (${formatIDR(target.amount)})`,
    beforeValue: formatIDR(target.amount),
    afterValue: 'Void (Rp0 aktif)',
    note: reason.trim() || undefined,
  });
}

export function deleteTransactionAction(state: FinanceState, id: string): FinanceState {
  const target = state.transactions.find((t) => t.id === id);
  const next = {
    ...state,
    transactions: state.transactions.filter((t) => t.id !== id),
  };
  if (!target) return withSyncBump(next);
  return appendChangeLog(next, {
    entityType: 'transaction',
    entityId: id,
    action: 'delete',
    summary: `Hapus transaksi: ${target.description} (${formatIDR(target.amount)})`,
    beforeValue: `${target.date} · ${formatIDR(target.amount)}`,
  });
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
  if (!payment || payment.status === 'received') return state;
  const project = state.projects.find((p) => p.id === payment.projectId);

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
    creditor: string;
    description: string;
    amount: number;
    dueDate?: string;
    priority?: number;
  }
): FinanceState {
  if (input.amount <= 0) throw new Error('Nominal harus lebih dari Rp0.');
  const direction: DebtDirection = input.direction ?? 'payable';
  const debt: Debt = {
    id: generateId(),
    direction,
    creditor: input.creditor.trim(),
    description: input.description.trim(),
    initialAmount: Math.round(input.amount),
    remainingAmount: Math.round(input.amount),
    dueDate: input.dueDate ? input.dueDate : undefined,
    priority: input.priority ?? 1,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  return appendChangeLog(
    { ...state, debts: [...state.debts, debt] },
    {
      entityType: direction === 'receivable' ? 'receivable' : 'debt',
      entityId: debt.id,
      action: 'create',
      summary: `${direction === 'receivable' ? 'Catat piutang baru dari' : 'Catat utang baru ke'} ${debt.creditor}: ${formatIDR(debt.initialAmount)}`,
      afterValue: debt.dueDate ? `Jatuh tempo ${debt.dueDate}` : 'Tanpa jatuh tempo',
    }
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
  }
): FinanceState {
  const debt = state.debts.find((d) => d.id === input.debtId);
  if (!debt) throw new Error('Data utang tidak ditemukan.');
  if ((debt.direction ?? 'payable') === 'receivable') {
    throw new Error('Gunakan penerimaan piutang untuk catatan piutang.');
  }
  if (input.amount <= 0) throw new Error('Nominal pembayaran harus lebih dari Rp0.');
  const payAmount = Math.min(Math.round(input.amount), debt.remainingAmount);
  if (payAmount <= 0) throw new Error('Utang ini sudah lunas.');

  const res = addTransactionAction(state, {
    type: 'expense',
    amount: payAmount,
    categoryId: 'cat-debt',
    accountId: input.accountId,
    date: input.date,
    description: `Cicil/Bayar Utang: ${debt.creditor}`,
    notes: input.notes,
  });

  const newRemaining = Math.max(0, debt.remainingAmount - payAmount);

  return withSyncBump({
    ...res.state,
    debts: res.state.debts.map((d) =>
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
        accountId: input.accountId,
        transactionId: res.transaction.id,
        notes: input.notes?.trim() || undefined,
        createdAt: new Date().toISOString(),
      },
      ...res.state.debtPayments,
    ],
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
  }
): FinanceState {
  const item = state.debts.find((d) => d.id === input.debtId);
  if (!item) throw new Error('Data piutang tidak ditemukan.');
  if (item.direction !== 'receivable') throw new Error('Item ini bukan piutang.');
  if (input.amount <= 0) throw new Error('Nominal penerimaan harus lebih dari Rp0.');
  const collectAmount = Math.min(Math.round(input.amount), item.remainingAmount);
  if (collectAmount <= 0) throw new Error('Piutang ini sudah lunas diterima.');

  const res = addTransactionAction(state, {
    type: 'income',
    amount: collectAmount,
    categoryId: 'cat-income-other',
    accountId: input.accountId,
    date: input.date,
    description: `Terima Piutang: ${item.creditor}`,
    notes: input.notes,
    incomeSource: 'other',
  });

  const newRemaining = Math.max(0, item.remainingAmount - collectAmount);

  return withSyncBump({
    ...res.state,
    debts: res.state.debts.map((d) =>
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
        accountId: input.accountId,
        transactionId: res.transaction.id,
        notes: input.notes?.trim() || 'Penerimaan pelunasan piutang',
        createdAt: new Date().toISOString(),
      },
      ...res.state.debtPayments,
    ],
  });
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
    incomeSource: delta > 0 ? 'other' : undefined,
    isEssential: true,
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
  const usedInDebt = state.debtPayments.filter((d) => d.accountId === accountId).length;

  const totalRefs = usedInTx + usedInTransfer + usedInProjPay + usedInProjExp + usedInDebt;
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
