import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Calculator, CheckCircle2, Lock, ShieldAlert, X } from 'lucide-react';
import {
  computeAllocationBreakdown,
  evaluateDisciplineForExpense,
  FinanceSnapshot,
  simulateExpenseImpact,
} from '../engine/financeEngine';
import {
  addTransactionAction,
  addTransferAction,
  createFriendAdvanceAction,
  createSplitBillAction,
  findDefaultActiveDebt,
  getTransactionLinkInfo,
  payObligationAction,
  repayDebtAction,
  updateTransactionAction,
} from '../hooks/financeActions';
import { FinanceState, IncomeSourceType, Transaction } from '../types/finance';
import { formatIDR, todayISO } from '../utils/format';

export type QuickPreset =
  | 'allowance'
  | 'cigarette'
  | 'hangout'
  | 'food'
  | 'kkn'
  | 'debt'
  | 'transfer'
  | null;

interface QuickTransactionModalProps {
  isOpen: boolean;
  preset: QuickPreset;
  editingTx?: Transaction | null;
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onClose: () => void;
  onCommit: (next: FinanceState) => void;
}

export const QuickTransactionModal: React.FC<QuickTransactionModalProps> = ({
  isOpen,
  preset,
  editingTx,
  state,
  snapshot,
  onClose,
  onCommit,
}) => {
  const activeAccounts = useMemo(
    () => (snapshot.activeAccounts.length > 0 ? snapshot.activeAccounts : snapshot.accounts),
    [snapshot.activeAccounts, snapshot.accounts]
  );

  const [tab, setTab] = useState<'expense' | 'income' | 'transfer'>('expense');
  const [expenseMode, setExpenseMode] = useState<'standard' | 'split_bill' | 'friend_advance'>('standard');
  const [splitMode, setSplitMode] = useState<'equal' | 'manual'>('equal');
  const [userShareInput, setUserShareInput] = useState<string>('');
  const [splitParticipants, setSplitParticipants] = useState<
    Array<{ id: string; name: string; shareAmount: string }>
  >([{ id: 'p1', name: '', shareAmount: '' }]);
  const [friendName, setFriendName] = useState<string>('');
  const [friendDueDate, setFriendDueDate] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('cat-cig');
  const [accountId, setAccountId] = useState<string>(activeAccounts[0]?.id ?? 'acc-cash');
  const [toAccountId, setToAccountId] = useState<string>(activeAccounts[1]?.id ?? 'acc-ewallet');
  const [incomeSource, setIncomeSource] = useState<IncomeSourceType>('daily_allowance');
  const [date, setDate] = useState<string>(todayISO());
  const [description, setDescription] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [overrideReason, setOverrideReason] = useState<string>('');
  const [overrideConfirmed, setOverrideConfirmed] = useState<boolean>(false);
  const [showGate, setShowGate] = useState<boolean>(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setDuplicateWarning(null);
    setOverrideReason('');
    setOverrideConfirmed(false);
    setShowGate(false);
    setExpenseMode('standard');
    setSplitMode('equal');
    setUserShareInput('');
    setSplitParticipants([{ id: 'p1', name: '', shareAmount: '' }]);
    setFriendName('');
    setFriendDueDate('');

    const defaultAcc = activeAccounts[0]?.id ?? 'acc-cash';
    const secondAcc = activeAccounts.find((a) => a.id !== defaultAcc)?.id ?? defaultAcc;

    if (editingTx) {
      setTab(editingTx.type);
      setAmount(String(editingTx.amount));
      setCategoryId(editingTx.categoryId);
      setAccountId(editingTx.accountId);
      setIncomeSource(editingTx.incomeSource ?? 'other');
      setDate(editingTx.date);
      setDescription(editingTx.description);
      setNotes(editingTx.notes ?? '');
      return;
    }

    setDate(todayISO());
    setNotes('');
    if (preset === 'allowance') {
      setTab('income');
      setCategoryId('cat-income-allowance');
      setAccountId(defaultAcc);
      setIncomeSource('daily_allowance');
      setAmount('25000');
      setDescription('Pemasukan aktual diterima');
    } else if (preset === 'cigarette') {
      setTab('expense');
      setCategoryId('cat-cig');
      setAccountId(defaultAcc);
      setAmount('22000');
      setDescription('Beli rokok 1 bungkus');
    } else if (preset === 'hangout') {
      setTab('expense');
      setCategoryId('cat-hangout');
      setAccountId(defaultAcc);
      setAmount('30000');
      setDescription('Nongkrong / ngopi');
    } else if (preset === 'food') {
      setTab('expense');
      setCategoryId('cat-food');
      setAccountId(defaultAcc);
      setAmount('15000');
      setDescription('Makan di luar');
    } else if (preset === 'kkn') {
      setTab('expense');
      setCategoryId('cat-college');
      setAccountId(defaultAcc);
      const firstActiveOb = state.obligations.find((o) => o.status === 'active' && !o.isArchived);
      setAmount(firstActiveOb ? String(firstActiveOb.amount) : '30000');
      setDescription(firstActiveOb ? `Bayar ${firstActiveOb.name}` : 'Bayar kewajiban rutin');
    } else if (preset === 'debt') {
      setTab('expense');
      setCategoryId('cat-debt');
      setAccountId(defaultAcc);
      const firstDebt = findDefaultActiveDebt(state.debts, 'payable');
      setAmount(firstDebt ? String(firstDebt.remainingAmount) : '27000');
      setDescription(firstDebt ? `Bayar utang ke ${firstDebt.creditor}` : 'Bayar utang');
    } else if (preset === 'transfer') {
      setTab('transfer');
      setAccountId(defaultAcc);
      setToAccountId(secondAcc);
      setAmount('');
      setDescription('Transfer antar akun');
    } else {
      setTab('expense');
      setCategoryId('cat-food');
      setAccountId(defaultAcc);
      setToAccountId(secondAcc);
      setAmount('');
      setDescription('');
    }
  }, [isOpen, preset, editingTx, state.debts, state.obligations, activeAccounts]);

  const numericAmount = Number(amount) || 0;

  const splitComputation = useMemo(() => {
    const total = Math.round(numericAmount);
    const count = Math.max(1, splitParticipants.length);
    if (splitMode === 'equal') {
      const headCount = 1 + count;
      const base = total > 0 ? Math.floor(total / headCount) : 0;
      const remainder = total > 0 ? total - base * headCount : 0;
      return {
        userShare: base + remainder,
        participantShares: splitParticipants.map(() => base),
        isMatched: total > 0,
      };
    }
    const userShare = Math.max(0, Math.round(Number(userShareInput) || 0));
    const participantShares = splitParticipants.map((p) =>
      Math.max(0, Math.round(Number(p.shareAmount) || 0))
    );
    const sum = userShare + participantShares.reduce((s, v) => s + v, 0);
    return {
      userShare,
      participantShares,
      isMatched: total > 0 && sum === total,
    };
  }, [numericAmount, splitMode, userShareInput, splitParticipants]);

  const effectiveExpenseForStats = useMemo(() => {
    if (tab !== 'expense' || editingTx) return 0;
    if (expenseMode === 'friend_advance') return 0;
    if (expenseMode === 'split_bill') return splitComputation.userShare;
    return numericAmount;
  }, [tab, editingTx, expenseMode, splitComputation.userShare, numericAmount]);

  const disciplineCheck = useMemo(() => {
    if (tab !== 'expense' || effectiveExpenseForStats <= 0 || editingTx) return null;
    return evaluateDisciplineForExpense(
      state,
      { amount: effectiveExpenseForStats, categoryId, accountId, date },
      snapshot
    );
  }, [tab, effectiveExpenseForStats, categoryId, accountId, date, state, snapshot, editingTx]);

  const liveSimulation = useMemo(() => {
    if (tab !== 'expense' || effectiveExpenseForStats <= 0 || editingTx) return null;
    return simulateExpenseImpact(
      state,
      { amount: effectiveExpenseForStats, categoryId, accountId, date },
      snapshot
    );
  }, [tab, effectiveExpenseForStats, categoryId, accountId, date, state, snapshot, editingTx]);

  const allocationPreview = useMemo(() => {
    if (tab !== 'income' || numericAmount <= 0) return [];
    const rules =
      incomeSource === 'freelance' || incomeSource === 'business'
        ? state.settings.freelanceAllocationRules
        : state.settings.allowanceAllocationRules;
    return computeAllocationBreakdown(numericAmount, rules, incomeSource);
  }, [tab, numericAmount, incomeSource, state.settings]);

  const editingLinkInfo = useMemo(
    () => (editingTx ? getTransactionLinkInfo(state, editingTx.id) : null),
    [editingTx, state]
  );
  const isEditingLocked = Boolean(editingTx && editingLinkInfo?.isLinked);
  const isNonCashEditing = Boolean(editingTx && editingTx.affectsAccountBalance === false);

  if (!isOpen) return null;

  const expenseCategories = state.categories.filter(
    (c) => c.type === 'expense' && (!c.isArchived || c.id === categoryId)
  );
  const incomeCategories = state.categories.filter(
    (c) => c.type === 'income' && (!c.isArchived || c.id === categoryId)
  );

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (numericAmount <= 0) {
      setError('Masukkan nominal yang valid lebih dari Rp0.');
      return;
    }

    try {
      if (editingTx) {
        const next = updateTransactionAction(state, editingTx.id, {
          amount: numericAmount,
          categoryId,
          accountId,
          date,
          description,
          notes,
        });
        onCommit(next);
        onClose();
        return;
      }

      if (tab === 'transfer') {
        if (accountId === toAccountId) {
          setError('Akun asal dan tujuan tidak boleh sama.');
          return;
        }
        const recentDupTransfer = state.transfers.some(
          (tr) =>
            tr.fromAccountId === accountId &&
            tr.toAccountId === toAccountId &&
            tr.amount === Math.round(numericAmount) &&
            tr.date === date &&
            Date.now() - new Date(tr.createdAt).getTime() < 15000
        );
        if (recentDupTransfer && !duplicateWarning) {
          setDuplicateWarning(
            'Terdeteksi transfer identik baru saja dicatat dalam 15 detik terakhir. Klik "Simpan Transaksi" sekali lagi jika Anda yakin ingin mencatat ulang.'
          );
          return;
        }
        const next = addTransferAction(state, {
          fromAccountId: accountId,
          toAccountId,
          amount: numericAmount,
          date,
          notes: description || notes,
        });
        onCommit(next);
        onClose();
        return;
      }

      const recentDupTx = state.transactions.some(
        (tx) =>
          !tx.isVoided &&
          tx.type === tab &&
          tx.amount === Math.round(numericAmount) &&
          tx.categoryId === categoryId &&
          tx.accountId === accountId &&
          tx.date === date &&
          Date.now() - new Date(tx.createdAt).getTime() < 15000
      );
      if (recentDupTx && !duplicateWarning) {
        setDuplicateWarning(
          'Transaksi identik (nominal, kategori, akun, dan tanggal yang sama) baru saja dicatat dalam 15 detik terakhir. Klik simpan sekali lagi hanya jika transaksi memang terjadi dua kali.'
        );
        return;
      }

      if (tab === 'expense' && preset === 'debt') {
        const activeDebt = findDefaultActiveDebt(state.debts, 'payable');
        if (activeDebt && categoryId === 'cat-debt') {
          const next = repayDebtAction(state, {
            debtId: activeDebt.id,
            amount: numericAmount,
            accountId,
            date,
            notes,
          });
          onCommit(next);
          onClose();
          return;
        }
      }

      if (tab === 'expense' && preset === 'kkn') {
        const kkn = state.obligations.find(
          (o) => o.status === 'active' && !o.isArchived && (!o.endDate || date <= o.endDate)
        );
        if (kkn && categoryId === 'cat-college') {
          const next = payObligationAction(state, {
            obligationId: kkn.id,
            amount: numericAmount,
            accountId,
            date,
            notes,
          });
          onCommit(next);
          onClose();
          return;
        }
      }

      if (tab === 'expense' && preset !== 'debt' && preset !== 'kkn' && expenseMode === 'friend_advance') {
        if (!friendName.trim()) {
          setError('Nama teman yang ditalangi wajib diisi.');
          return;
        }
        const next = createFriendAdvanceAction(state, {
          friendName: friendName.trim(),
          amount: numericAmount,
          accountId,
          date,
          dueDate: friendDueDate || undefined,
          description: description.trim() || undefined,
        });
        onCommit(next);
        onClose();
        return;
      }

      if (tab === 'expense' && preset !== 'debt' && preset !== 'kkn' && expenseMode === 'split_bill') {
        if (disciplineCheck?.requiresConfirmation && !showGate) {
          setShowGate(true);
          return;
        }
        if (disciplineCheck?.requiresConfirmation) {
          if (overrideReason.trim().length < 5) {
            setError('Tuliskan alasan jujur minimal 5 karakter sebelum melanjutkan.');
            return;
          }
          if (!overrideConfirmed) {
            setError('Centang konfirmasi kesadaran dampak finansial terlebih dahulu.');
            return;
          }
        }
        const { state: next } = createSplitBillAction(state, {
          title: description.trim() || 'Patungan Split Bill',
          totalAmount: numericAmount,
          categoryId,
          accountId,
          date,
          splitMode,
          userShareAmount: splitMode === 'manual' ? Math.round(Number(userShareInput) || 0) : undefined,
          participants: splitParticipants.map((p) => ({
            name: p.name,
            shareAmount: splitMode === 'manual' ? Math.round(Number(p.shareAmount) || 0) : undefined,
          })),
          notes,
          overrideReason: showGate ? overrideReason : undefined,
        });
        onCommit(next);
        onClose();
        return;
      }

      if (tab === 'expense' && disciplineCheck?.requiresConfirmation && !showGate) {
        setShowGate(true);
        return;
      }

      if (tab === 'expense' && disciplineCheck?.requiresConfirmation) {
        if (overrideReason.trim().length < 5) {
          setError('Tuliskan alasan jujur minimal 5 karakter sebelum melanjutkan.');
          return;
        }
        if (!overrideConfirmed) {
          setError('Centang konfirmasi kesadaran dampak finansial terlebih dahulu.');
          return;
        }
      }

      const { state: next } = addTransactionAction(state, {
        type: tab,
        amount: numericAmount,
        categoryId,
        accountId,
        date,
        description,
        notes,
        incomeSource: tab === 'income' ? incomeSource : undefined,
        overrideReason: showGate ? overrideReason : undefined,
      });

      onCommit(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan transaksi.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 sm:p-4 backdrop-blur-xs">
      <div className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl border border-slate-200 bg-white shadow-2xl max-h-[92vh] flex flex-col">
        <div className="sm:hidden w-10 h-1.5 bg-slate-300 rounded-full mx-auto mt-3" />

        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="font-display text-base font-bold text-slate-900">
            {editingTx ? 'Edit Transaksi' : 'Catat Aktivitas Keuangan'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
            aria-label="Tutup modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="overflow-y-auto p-6 space-y-4">
          {!editingTx && (
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
              {[
                { id: 'expense', label: 'Pengeluaran' },
                { id: 'income', label: 'Pemasukan' },
                { id: 'transfer', label: 'Transfer Akun' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    const nextTab = t.id as 'expense' | 'income' | 'transfer';
                    setTab(nextTab);
                    setShowGate(false);
                    setExpenseMode('standard');
                    if (nextTab === 'expense') setCategoryId('cat-food');
                    if (nextTab === 'income') setCategoryId('cat-income-allowance');
                  }}
                  className={`py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    tab === t.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {!editingTx && tab === 'expense' && preset !== 'debt' && preset !== 'kkn' && (
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {[
                { id: 'standard', label: 'Pribadi' },
                { id: 'split_bill', label: 'Split Bill' },
                { id: 'friend_advance', label: 'Talangan Teman' },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setExpenseMode(m.id as 'standard' | 'split_bill' | 'friend_advance');
                    setShowGate(false);
                    setError(null);
                  }}
                  className={`py-1.5 px-2 text-[11px] font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    expenseMode === m.id
                      ? 'bg-[#0976A6] text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {isEditingLocked && editingLinkInfo && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold">Transaksi Terikat Relasi (Nominal, Akun, Kategori &amp; Tanggal Dikunci)</p>
                <p>{editingLinkInfo.reason}</p>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {tab === 'expense' && expenseMode === 'split_bill'
                ? 'Total Tagihan Split Bill (Dibayar Penuh)'
                : tab === 'expense' && expenseMode === 'friend_advance'
                ? 'Nominal Talangan Teman (Rupiah)'
                : 'Nominal (Rupiah)'}
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">
                Rp
              </span>
              <input
                type="number"
                min={1}
                required
                disabled={isEditingLocked}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setShowGate(false);
                }}
                placeholder="0"
                className="w-full rounded-xl border border-slate-300 pl-10 pr-4 py-3 text-lg font-bold font-mono-num text-slate-900 focus:border-[#0C8FC5] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
              />
            </div>
            {tab === 'expense' && !isEditingLocked && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[10000, 15000, 20000, 25000, 30000, 50000].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => {
                      setAmount(String(val));
                      setShowGate(false);
                    }}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-mono-num font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {formatIDR(val)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab !== 'transfer' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {!(tab === 'expense' && !editingTx && expenseMode === 'friend_advance') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Kategori
                  </label>
                  <select
                    value={categoryId}
                    disabled={isEditingLocked}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setShowGate(false);
                    }}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
                  >
                    {(tab === 'expense' ? expenseCategories : incomeCategories).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className={tab === 'expense' && !editingTx && expenseMode === 'friend_advance' ? 'sm:col-span-2' : ''}>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {isNonCashEditing
                    ? 'Sumber Pencatatan'
                    : tab === 'income'
                    ? 'Masuk ke Akun'
                    : 'Sumber Akun'}
                </label>
                {isNonCashEditing ? (
                  <input
                    type="text"
                    disabled
                    value="Non-Kas (Utang)"
                    className="w-full rounded-xl border border-slate-300 bg-slate-100 px-3 py-2.5 text-sm text-slate-600"
                  />
                ) : (
                  <select
                    value={accountId}
                    disabled={isEditingLocked}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
                  >
                    {activeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatIDR(a.currentBalance)})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Dari Akun
                </label>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
                >
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({formatIDR(a.currentBalance)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Ke Akun Tujuan
                </label>
                <select
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
                >
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({formatIDR(a.currentBalance)})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {tab === 'income' && !editingTx && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Jenis Sumber Pemasukan
              </label>
              <select
                value={incomeSource}
                onChange={(e) => setIncomeSource(e.target.value as IncomeSourceType)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
              >
                <option value="daily_allowance">Uang Saku / Tunjangan Harian</option>
                <option value="salary">Gaji Bulanan / Penghasilan Tetap</option>
                <option value="freelance">Profit Bersih Freelance</option>
                <option value="business">Pendapatan Bisnis</option>
                <option value="passive">Pendapatan Pasif</option>
                <option value="other">Pemasukan Lainnya</option>
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Tanggal Aktual
              </label>
              <input
                type="date"
                value={date}
                disabled={isEditingLocked}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Deskripsi Singkat
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={tab === 'transfer' ? 'Contoh: Top up e-wallet' : 'Contoh: Beli makan siang'}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Catatan Tambahan (Opsional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Detail tempat, keperluan, dll."
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
            />
          </div>

          {!editingTx && tab === 'expense' && expenseMode === 'friend_advance' && (
            <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-3.5 space-y-2.5">
              <p className="text-xs font-bold text-slate-900">Detail Talangan Kebutuhan Teman</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Nama Teman <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={friendName}
                    onChange={(e) => setFriendName(e.target.value)}
                    placeholder="Contoh: Bima"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Jatuh Tempo (Opsional)
                  </label>
                  <input
                    type="date"
                    value={friendDueDate}
                    onChange={(e) => setFriendDueDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  />
                </div>
              </div>
              <p className="text-[11px] text-[#075D83]">
                Saldo akun sumber langsung berkurang dan tercatat sebagai <strong>Piutang Talangan Teman</strong> — tidak masuk statistik pengeluaran konsumsi atau membatalkan No-Spend Day.
              </p>
            </div>
          )}

          {!editingTx && tab === 'expense' && expenseMode === 'split_bill' && (
            <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-900">Pembagian Split Bill</p>
                <div className="inline-flex rounded-lg bg-white border border-slate-200 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSplitMode('equal')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      splitMode === 'equal' ? 'bg-[#0976A6] text-white' : 'text-slate-600'
                    }`}
                  >
                    Bagi Rata
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitMode('manual')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      splitMode === 'manual' ? 'bg-[#0976A6] text-white' : 'text-slate-600'
                    }`}
                  >
                    Nominal Manual
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-white border border-slate-200 px-3 py-2 text-xs">
                <span className="font-semibold text-slate-700">Porsi Pribadi Anda:</span>
                {splitMode === 'equal' ? (
                  <span className="font-mono-num font-bold text-slate-900">
                    {formatIDR(splitComputation.userShare)}
                  </span>
                ) : (
                  <input
                    type="number"
                    min={0}
                    value={userShareInput}
                    onChange={(e) => setUserShareInput(e.target.value)}
                    placeholder="Nominal porsi Anda"
                    className="w-36 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-mono-num text-right"
                  />
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700">
                    Peserta Lain (Menjadi Piutang):
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSplitParticipants((prev) => [
                        ...prev,
                        { id: `p${Date.now()}`, name: '', shareAmount: '' },
                      ])
                    }
                    className="text-[11px] font-semibold text-[#0976A6] hover:underline"
                  >
                    + Tambah Peserta
                  </button>
                </div>
                {splitParticipants.map((part, idx) => (
                  <div key={part.id} className="flex items-center gap-2">
                    <input
                      type="text"
                      required
                      value={part.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSplitParticipants((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, name: val } : item))
                        );
                      }}
                      placeholder={`Nama teman ${idx + 1}`}
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    />
                    {splitMode === 'equal' ? (
                      <span className="w-28 text-right font-mono-num text-xs font-semibold text-slate-700">
                        {formatIDR(splitComputation.participantShares[idx] ?? 0)}
                      </span>
                    ) : (
                      <input
                        type="number"
                        min={1}
                        required
                        value={part.shareAmount}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSplitParticipants((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, shareAmount: val } : item))
                          );
                        }}
                        placeholder="Porsi (Rp)"
                        className="w-28 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono-num"
                      />
                    )}
                    {splitParticipants.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setSplitParticipants((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-red-600 hover:bg-red-50"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {numericAmount > 0 && (
                <p
                  className={`text-[11px] font-semibold ${
                    splitComputation.isMatched ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {splitComputation.isMatched
                    ? `Total pembagian cocok (${formatIDR(numericAmount)}). Hanya porsi Anda (${formatIDR(splitComputation.userShare)}) yang masuk pengeluaran pribadi.`
                    : 'Jumlah porsi Anda + semua peserta harus sama persis dengan total tagihan.'}
                </p>
              )}
            </div>
          )}

          {/* Transfer Info */}
          {tab === 'transfer' && (
            <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] p-3 text-xs text-slate-900 flex items-start gap-2.5">
              <ArrowLeftRight className="w-4 h-4 text-[#0976A6] shrink-0 mt-0.5" />
              <span>
                Transfer antar akun hanya memindahkan saldo dan <strong>tidak dihitung sebagai pemasukan atau pengeluaran</strong>. Total aset Anda tetap sama.
              </span>
            </div>
          )}

          {/* Income Allocation Guide Preview */}
          {tab === 'income' && allocationPreview.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
              <p className="text-xs font-bold text-slate-900">
                Rencana Alokasi Otomatis Sesuai Aturan Anda:
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {allocationPreview.map((item) => (
                  <div key={item.key} className="flex items-center justify-between">
                    <span className="text-slate-600 truncate pr-2">
                      {item.label} ({item.percentage}%)
                    </span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatIDR(item.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Live Read-Only Impact Preview for Expenses */}
          {tab === 'expense' && liveSimulation && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Calculator className="w-3.5 h-3.5 text-[#0976A6]" />
                <span>Simulasi Dampak Sebelum Konfirmasi:</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono-num text-slate-600 pt-0.5">
                <span>
                  Dana Aman: {formatIDR(liveSimulation.safeToSpendBefore)} →{' '}
                  <strong className={liveSimulation.safeToSpendAfter <= 0 ? 'text-red-700' : 'text-slate-900'}>
                    {formatIDR(liveSimulation.safeToSpendAfter)}
                  </strong>
                </span>
                <span>
                  Sisa Mingguan: {formatIDR(liveSimulation.weeklyRemainingBefore)} →{' '}
                  <strong className="text-slate-900">{formatIDR(liveSimulation.weeklyRemainingAfter)}</strong>
                </span>
              </div>
            </div>
          )}

          {/* Essential Bypass / Warning Indicator */}
          {tab === 'expense' && disciplineCheck && !showGate && (
            <div
              className={`rounded-xl border p-3 text-xs flex items-start gap-2.5 ${
                disciplineCheck.level === 'warning'
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : disciplineCheck.level === 'critical' || disciplineCheck.level === 'recovery_alert'
                  ? 'border-red-200 bg-red-50 text-red-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900'
              }`}
            >
              {disciplineCheck.level === 'normal' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <div>
                <p className="font-semibold">{disciplineCheck.title}</p>
                <p className="mt-0.5">{disciplineCheck.message}</p>
              </div>
            </div>
          )}

          {/* Discipline Confirmation Gate */}
          {showGate && disciplineCheck && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                <div className="text-xs text-red-950 space-y-1">
                  <p className="font-bold text-sm">{disciplineCheck.title}</p>
                  <p>{disciplineCheck.message}</p>
                  <ul className="list-disc pl-4 space-y-0.5 pt-1">
                    {disciplineCheck.impactDetails.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-red-900 mb-1">
                  Alasan Wajib Sebelum Tetap Mencatat (min. 5 karakter)
                </label>
                <input
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Contoh: Keperluan mendesak bersama tim proyek"
                  className="w-full rounded-xl border border-red-300 bg-white px-3 py-2 text-sm focus:border-red-600 focus:outline-none"
                />
              </div>

              <label className="flex items-start gap-2.5 text-xs text-red-950 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideConfirmed}
                  onChange={(e) => setOverrideConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-red-300 text-red-700"
                />
                <span>
                  Saya sadar pengeluaran ini melewati batas aman dan mengurangi dana untuk utang / kewajiban / tabungan saya.
                </span>
              </label>
            </div>
          )}

          {duplicateWarning && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900">
              {duplicateWarning}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 min-h-[44px]"
            >
              Batal
            </button>
            <button
              type="submit"
              className={`rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-colors min-h-[44px] ${
                showGate ? 'bg-red-700 hover:bg-red-800' : 'bg-[#0976A6] hover:bg-[#075D83]'
              }`}
            >
              {showGate
                ? 'Konfirmasi & Tetap Catat'
                : editingTx
                ? 'Simpan Perubahan'
                : 'Simpan Transaksi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
