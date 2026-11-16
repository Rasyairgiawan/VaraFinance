import React, { useState } from 'react';
import {
  Archive,
  ArrowRightCircle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  History,
  Pencil,
  PiggyBank,
  Plus,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { FinanceSnapshot } from '../engine/financeEngine';
import {
  addDebtAction,
  addGoalAction,
  addObligationAction,
  archiveGoalAction,
  archiveObligationAction,
  collectReceivableAction,
  contributeToGoalAction,
  payObligationAction,
  reallocateCompletedObligationAction,
  repayDebtAction,
  reserveObligationAction,
  updateDebtAction,
  updateObligationAction,
} from '../hooks/financeActions';
import {
  Debt,
  DebtDirection,
  FinanceState,
  GoalType,
  ObligationDurationType,
  ObligationFrequency,
  ObligationKind,
  ObligationStatus,
  RecurringObligation,
} from '../types/finance';
import { formatDateID, formatIDR, todayISO } from '../utils/format';

interface DebtsAndGoalsViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
}

const STATUS_META: Record<ObligationStatus, { label: string; style: string }> = {
  active: { label: 'Aktif', style: 'text-emerald-800 bg-emerald-50 border-emerald-200' },
  paused: { label: 'Ditangguhkan', style: 'text-amber-800 bg-amber-50 border-amber-200' },
  completed: { label: 'Selesai', style: 'text-[#0976A6] bg-[#E8F6FC] border-[#B9E2F5]' },
  cancelled: { label: 'Dibatalkan', style: 'text-slate-600 bg-slate-100 border-slate-200' },
};

const DURATION_LABELS: Record<ObligationDurationType, string> = {
  temporary: 'Sementara',
  indefinite: 'Rutin Tanpa Batas',
  fixed_term: 'Rutin Berbatas Waktu',
  one_time: 'Sekali Bayar',
};

export const DebtsAndGoalsView: React.FC<DebtsAndGoalsViewProps> = ({
  state,
  snapshot,
  onCommit,
}) => {
  const [subTab, setSubTab] = useState<'debts' | 'goals'>('debts');

  // Debts & Receivables
  const [debtFilter, setDebtFilter] = useState<'all' | 'payable' | 'receivable'>('all');
  const [showNewDebt, setShowNewDebt] = useState(false);
  const [debtDirection, setDebtDirection] = useState<DebtDirection>('payable');
  const [creditor, setCreditor] = useState('');
  const [debtDesc, setDebtDesc] = useState('');
  const [debtAmount, setDebtAmount] = useState('');
  const [debtDueDate, setDebtDueDate] = useState('');

  const [repayDebtId, setRepayDebtId] = useState<string | null>(null);
  const [repayAmount, setRepayAmount] = useState('');
  const [repayAccId, setRepayAccId] = useState('acc-cash');
  const [editingDueId, setEditingDueId] = useState<string | null>(null);
  const [editDueVal, setEditDueVal] = useState('');
  const [debtHistoryId, setDebtHistoryId] = useState<string | null>(null);

  // Obligations & Scheduled Expenses
  const [obKindFilter, setObKindFilter] = useState<'all' | 'obligation' | 'scheduled_expense'>('all');
  const [showArchivedObs, setShowArchivedObs] = useState(false);
  const [showObForm, setShowObForm] = useState(false);
  const [editingObId, setEditingObId] = useState<string | null>(null);
  const [obKind, setObKind] = useState<ObligationKind>('obligation');
  const [obName, setObName] = useState('');
  const [obAmount, setObAmount] = useState('');
  const [obFreq, setObFreq] = useState<ObligationFrequency>('weekly');
  const [obDuration, setObDuration] = useState<ObligationDurationType>('temporary');
  const [obStart, setObStart] = useState(todayISO());
  const [obDue, setObDue] = useState(todayISO());
  const [obEnd, setObEnd] = useState('');
  const [obReminderEnabled, setObReminderEnabled] = useState(true);
  const [obReminderDays, setObReminderDays] = useState('3');
  const [obError, setObError] = useState<string | null>(null);

  const [obAction, setObAction] = useState<{ id: string; mode: 'reserve' | 'pay' | 'history' } | null>(
    null
  );
  const [obActionAmt, setObActionAmt] = useState('');
  const [obPayAccId, setObPayAccId] = useState('acc-cash');
  const [reallocGoalMap, setReallocGoalMap] = useState<Record<string, string>>({});

  // Goal forms
  const [showArchivedGoals, setShowArchivedGoals] = useState(false);
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [goalName, setGoalName] = useState('');
  const [goalType, setGoalType] = useState<GoalType>('personal');
  const [goalTarget, setGoalTarget] = useState('');
  const [goalMonthly, setGoalMonthly] = useState('');

  const [contribGoalId, setContribGoalId] = useState<string | null>(null);
  const [contribAmt, setContribAmt] = useState('');
  const [contribFromAcc, setContribFromAcc] = useState('acc-cash');
  const [contribToAcc, setContribToAcc] = useState('acc-savings');

  const handleAddDebt = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(debtAmount) || 0;
    if (!creditor.trim() || amt <= 0) return;
    onCommit(
      addDebtAction(state, {
        direction: debtDirection,
        creditor,
        description: debtDesc || (debtDirection === 'receivable' ? 'Piutang / pinjaman teman' : 'Utang pribadi'),
        amount: amt,
        dueDate: debtDueDate || undefined,
      })
    );
    setCreditor('');
    setDebtDesc('');
    setDebtAmount('');
    setDebtDueDate('');
    setShowNewDebt(false);
  };

  const handleSettleDebtOrReceivable = (e: React.FormEvent, item: Debt) => {
    e.preventDefault();
    const amt = Number(repayAmount) || 0;
    if (amt <= 0) return;
    if ((item.direction ?? 'payable') === 'receivable') {
      onCommit(
        collectReceivableAction(state, {
          debtId: item.id,
          amount: amt,
          accountId: repayAccId,
          date: todayISO(),
        })
      );
    } else {
      onCommit(
        repayDebtAction(state, {
          debtId: item.id,
          amount: amt,
          accountId: repayAccId,
          date: todayISO(),
        })
      );
    }
    setRepayDebtId(null);
    setRepayAmount('');
  };

  const handleSaveDebtDue = (e: React.FormEvent, debtId: string) => {
    e.preventDefault();
    onCommit(
      updateDebtAction(state, debtId, {
        dueDate: editDueVal ? editDueVal : null,
      })
    );
    setEditingDueId(null);
  };

  const openNewObForm = () => {
    setObError(null);
    setEditingObId(null);
    setObKind('obligation');
    setObName('');
    setObAmount('');
    setObFreq('weekly');
    setObDuration('temporary');
    setObStart(todayISO());
    setObDue(todayISO());
    setObEnd('');
    setObReminderEnabled(true);
    setObReminderDays('3');
    setShowObForm(true);
  };

  const openEditObForm = (ob: RecurringObligation) => {
    setObError(null);
    setEditingObId(ob.id);
    setObKind(ob.kind ?? 'obligation');
    setObName(ob.name);
    setObAmount(String(ob.amount));
    setObFreq(ob.frequency);
    setObDuration(ob.durationType);
    setObStart(ob.startDate);
    setObDue(ob.nextDueDate);
    setObEnd(ob.endDate ?? '');
    setObReminderEnabled(ob.reminderEnabled);
    setObReminderDays(String(ob.reminderDaysBefore));
    setShowObForm(true);
  };

  const handleSaveOb = (e: React.FormEvent) => {
    e.preventDefault();
    setObError(null);
    const amt = Number(obAmount) || 0;
    if (!obName.trim() || amt <= 0) {
      setObError('Nama dan nominal wajib diisi valid.');
      return;
    }

    try {
      if (editingObId) {
        onCommit(
          updateObligationAction(state, editingObId, {
            kind: obKind,
            name: obName,
            amount: amt,
            frequency: obFreq,
            durationType: obDuration,
            startDate: obStart,
            nextDueDate: obDue,
            endDate: obEnd || undefined,
            reminderEnabled: obReminderEnabled,
            reminderDaysBefore: Math.max(0, Number(obReminderDays) || 0),
          })
        );
      } else {
        const res = addObligationAction(state, {
          kind: obKind,
          name: obName,
          category: obKind === 'scheduled_expense' ? 'Pengeluaran Terjadwal' : 'Kewajiban Rutin',
          amount: amt,
          frequency: obFreq,
          durationType: obDuration,
          startDate: obStart,
          nextDueDate: obDue,
          endDate: obEnd || undefined,
          reminderEnabled: obReminderEnabled,
          reminderDaysBefore: Math.max(0, Number(obReminderDays) || 0),
        });
        onCommit(res.state);
      }
      setShowObForm(false);
      setEditingObId(null);
    } catch (err) {
      setObError(err instanceof Error ? err.message : 'Gagal menyimpan kewajiban.');
    }
  };

  const handleObActionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!obAction || obAction.mode === 'history') return;
    setObError(null);
    const amt = Number(obActionAmt) || 0;
    if (amt <= 0) return;

    try {
      if (obAction.mode === 'reserve') {
        onCommit(reserveObligationAction(state, obAction.id, amt, todayISO()));
      } else {
        onCommit(
          payObligationAction(state, {
            obligationId: obAction.id,
            amount: amt,
            accountId: obPayAccId,
            date: todayISO(),
          })
        );
      }
      setObAction(null);
      setObActionAmt('');
    } catch (err) {
      setObError(err instanceof Error ? err.message : 'Gagal memproses kewajiban.');
    }
  };

  const handleAddGoal = (e: React.FormEvent) => {
    e.preventDefault();
    const target = Number(goalTarget) || 0;
    if (!goalName.trim() || target <= 0) return;
    onCommit(
      addGoalAction(state, {
        name: goalName,
        goalType,
        targetAmount: target,
        monthlyTarget: Number(goalMonthly) || 0,
      })
    );
    setGoalName('');
    setGoalTarget('');
    setGoalMonthly('');
    setShowNewGoal(false);
  };

  const handleContribSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contribGoalId) return;
    const amt = Number(contribAmt) || 0;
    if (amt <= 0) return;
    onCommit(
      contributeToGoalAction(state, {
        goalId: contribGoalId,
        amount: amt,
        fromAccountId: contribFromAcc,
        toAccountId: contribToAcc || undefined,
        date: todayISO(),
      })
    );
    setContribGoalId(null);
    setContribAmt('');
  };

  const filteredDebts = state.debts.filter((d) => {
    const dir = d.direction ?? 'payable';
    if (debtFilter === 'payable') return dir === 'payable';
    if (debtFilter === 'receivable') return dir === 'receivable';
    return true;
  });

  const filteredObligations = state.obligations.filter((ob) => {
    if (!showArchivedObs && ob.isArchived) return false;
    const k = ob.kind ?? 'obligation';
    if (obKindFilter !== 'all' && k !== obKindFilter) return false;
    return true;
  });

  const visibleGoals = state.goals.filter((g) => (showArchivedGoals ? true : !g.isArchived));
  const personalActiveLiquid = snapshot.activeAccounts.filter((a) => !a.isBusiness);

  return (
    <div className="space-y-5">
      <div className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1">
        <button
          type="button"
          onClick={() => setSubTab('debts')}
          className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
            subTab === 'debts' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          Utang, Piutang & Kewajiban
        </button>
        <button
          type="button"
          onClick={() => setSubTab('goals')}
          className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
            subTab === 'goals' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          Tabungan & Target Finansial
        </button>
      </div>

      {subTab === 'debts' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* DEBTS & RECEIVABLES */}
          <section className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <CreditCard className="w-5 h-5 text-red-700" />
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">Utang & Piutang</h3>
                  <p className="text-xs text-slate-500">
                    Utang:{' '}
                    <strong className="font-mono-num text-red-700">
                      {formatIDR(snapshot.outstandingDebtTotal)}
                    </strong>{' '}
                    · Piutang:{' '}
                    <strong className="font-mono-num text-[#0976A6]">
                      {formatIDR(snapshot.outstandingReceivableTotal)}
                    </strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNewDebt((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah</span>
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs">
              {[
                { id: 'all', label: 'Semua' },
                { id: 'payable', label: 'Utang Saya' },
                { id: 'receivable', label: 'Piutang Orang Lain' },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setDebtFilter(f.id as typeof debtFilter)}
                  className={`flex-1 py-1.5 rounded-md font-semibold transition-colors ${
                    debtFilter === f.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {snapshot.outstandingReceivableTotal > 0 && (
              <p className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-2 text-[11px] text-[#075D83]">
                Piutang belum lunas tidak dihitung sebagai kas likuid atau Safe-to-Spend sampai dana benar-benar diterima.
              </p>
            )}

            {showNewDebt && (
              <form onSubmit={handleAddDebt} className="rounded-xl bg-slate-50 p-3.5 space-y-2.5">
                <select
                  value={debtDirection}
                  onChange={(e) => setDebtDirection(e.target.value as DebtDirection)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold"
                >
                  <option value="payable">Utang Saya (Wajib Dibayar)</option>
                  <option value="receivable">Piutang (Uang Dipinjamkan ke Orang Lain)</option>
                </select>
                <input
                  type="text"
                  required
                  value={creditor}
                  onChange={(e) => setCreditor(e.target.value)}
                  placeholder={
                    debtDirection === 'receivable'
                      ? 'Nama Peminjam'
                      : 'Nama Pemberi Pinjaman'
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    required
                    min={1}
                    value={debtAmount}
                    onChange={(e) => setDebtAmount(e.target.value)}
                    placeholder="Nominal (Rp)"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono-num"
                  />
                  <input
                    type="date"
                    value={debtDueDate}
                    onChange={(e) => setDebtDueDate(e.target.value)}
                    title="Tanggal jatuh tempo (opsional)"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  />
                </div>
                <p className="text-[11px] text-slate-500">
                  Tanggal jatuh tempo bersifat opsional (kosongkan jika belum ditetapkan).
                </p>
                <input
                  type="text"
                  value={debtDesc}
                  onChange={(e) => setDebtDesc(e.target.value)}
                  placeholder="Keterangan"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowNewDebt(false)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-[#0976A6] px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Simpan
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-slate-100">
              {filteredDebts.map((d) => {
                const isReceivable = d.direction === 'receivable';
                const paidPct = Math.round(
                  ((d.initialAmount - d.remainingAmount) / Math.max(1, d.initialAmount)) * 100
                );
                const payments = state.debtPayments.filter((p) => p.debtId === d.id);

                return (
                  <div key={d.id} className="py-3.5 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              isReceivable
                                ? 'bg-[#E8F6FC] text-[#0976A6]'
                                : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {isReceivable ? 'Piutang' : 'Utang'}
                          </span>
                          <p className="text-sm font-bold text-slate-900">
                            {d.creditor}
                            {d.status === 'paid' && (
                              <span className="ml-2 text-xs font-semibold text-emerald-700">(Lunas)</span>
                            )}
                          </p>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {d.description} ·{' '}
                          {d.dueDate ? `Jatuh tempo ${formatDateID(d.dueDate)}` : 'Tanpa jatuh tempo'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`font-mono-num text-sm font-extrabold ${
                            isReceivable ? 'text-[#0976A6]' : 'text-red-700'
                          }`}
                        >
                          {formatIDR(d.remainingAmount)}
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono-num">
                          dari {formatIDR(d.initialAmount)}
                        </p>
                      </div>
                    </div>

                    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-600"
                        style={{ width: `${paidPct}%` }}
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingDueId(editingDueId === d.id ? null : d.id);
                            setEditDueVal(d.dueDate ?? '');
                          }}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          Ubah Jatuh Tempo
                        </button>
                        <button
                          type="button"
                          onClick={() => setDebtHistoryId(debtHistoryId === d.id ? null : d.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600"
                        >
                          <History className="w-3 h-3" />
                          <span>({payments.length})</span>
                        </button>
                      </div>

                      {d.status === 'active' && (
                        <button
                          type="button"
                          onClick={() => {
                            setRepayDebtId(d.id);
                            setRepayAmount(String(d.remainingAmount));
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${
                            isReceivable
                              ? 'bg-[#0976A6] hover:bg-[#075D83]'
                              : 'bg-slate-900 hover:bg-slate-800'
                          }`}
                        >
                          {isReceivable ? 'Terima Pelunasan' : 'Cicil / Lunasi'}
                        </button>
                      )}
                    </div>

                    {editingDueId === d.id && (
                      <form
                        onSubmit={(e) => handleSaveDebtDue(e, d.id)}
                        className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex flex-wrap items-center gap-2 text-xs"
                      >
                        <input
                          type="date"
                          value={editDueVal}
                          onChange={(e) => setEditDueVal(e.target.value)}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
                        />
                        <button
                          type="submit"
                          className="rounded-lg bg-[#0976A6] px-2.5 py-1.5 font-semibold text-white"
                        >
                          Simpan
                        </button>
                        {d.dueDate && (
                          <button
                            type="button"
                            onClick={() => {
                              onCommit(updateDebtAction(state, d.id, { dueDate: null }));
                              setEditingDueId(null);
                            }}
                            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 font-semibold text-red-700"
                          >
                            Hapus Jatuh Tempo
                          </button>
                        )}
                      </form>
                    )}

                    {repayDebtId === d.id && (
                      <form
                        onSubmit={(e) => handleSettleDebtOrReceivable(e, d)}
                        className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2"
                      >
                        <p className="text-xs font-bold text-slate-900">
                          {isReceivable
                            ? 'Terima Pembayaran Piutang ke Akun'
                            : 'Catat Pembayaran / Cicilan Utang'}
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            type="number"
                            required
                            min={1}
                            max={d.remainingAmount}
                            value={repayAmount}
                            onChange={(e) => setRepayAmount(e.target.value)}
                            placeholder="Nominal"
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono-num"
                          />
                          <select
                            value={repayAccId}
                            onChange={(e) => setRepayAccId(e.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                          >
                            {personalActiveLiquid.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({formatIDR(a.currentBalance)})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setRepayDebtId(null)}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                          >
                            Batal
                          </button>
                          <button
                            type="submit"
                            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white"
                          >
                            {isReceivable ? 'Catat Penerimaan' : 'Catat Pembayaran'}
                          </button>
                        </div>
                      </form>
                    )}

                    {debtHistoryId === d.id && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1 text-xs">
                        <p className="font-bold text-slate-800">Riwayat Pelunasan</p>
                        {payments.length === 0 ? (
                          <p className="text-slate-500">Belum ada pembayaran tercatat.</p>
                        ) : (
                          payments.map((p) => (
                            <div key={p.id} className="flex justify-between py-1 border-b border-slate-200/70 last:border-0">
                              <span>{formatDateID(p.date)} {p.notes ? `· ${p.notes}` : ''}</span>
                              <span className="font-mono-num font-bold">{formatIDR(p.amount)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* LONG-TERM OBLIGATIONS & SCHEDULED EXPENSES */}
          <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <CalendarClock className="w-5 h-5 text-[#0976A6]" />
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">
                    Kewajiban & Pengeluaran Terjadwal
                  </h3>
                  <p className="text-xs text-slate-500">
                    Mendukung mingguan, bulanan, tahunan, sementara berbatas waktu, dan sekali bayar.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowArchivedObs((v) => !v)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600"
                >
                  {showArchivedObs ? 'Sembunyikan Arsip' : 'Arsip'}
                </button>
                <button
                  type="button"
                  onClick={openNewObForm}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#0976A6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#075D83]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Tambah</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs">
              {[
                { id: 'all', label: 'Semua' },
                { id: 'obligation', label: 'Kewajiban Rutin' },
                { id: 'scheduled_expense', label: 'Pengeluaran Terjadwal' },
              ].map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setObKindFilter(k.id as typeof obKindFilter)}
                  className={`flex-1 py-1.5 rounded-md font-semibold transition-colors ${
                    obKindFilter === k.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>

            {obError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700">
                {obError}
              </div>
            )}

            {showObForm && (
              <form
                onSubmit={handleSaveOb}
                className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
              >
                <h4 className="text-xs font-bold text-slate-900">
                  {editingObId ? 'Edit Kewajiban / Jadwal' : 'Tambah Kewajiban / Pengeluaran Terjadwal'}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Jenis</label>
                    <select
                      value={obKind}
                      onChange={(e) => setObKind(e.target.value as ObligationKind)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    >
                      <option value="obligation">Kewajiban / Iuran Wajib</option>
                      <option value="scheduled_expense">Pengeluaran Terjadwal (Tagihan/Langganan)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Nama</label>
                    <input
                      type="text"
                      required
                      value={obName}
                      onChange={(e) => setObName(e.target.value)}
                      placeholder="Mis. Kos / Internet / KKN"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Nominal per Periode</label>
                    <input
                      type="number"
                      required
                      min={1}
                      value={obAmount}
                      onChange={(e) => setObAmount(e.target.value)}
                      placeholder="Rp"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Frekuensi</label>
                    <select
                      value={obFreq}
                      onChange={(e) => setObFreq(e.target.value as ObligationFrequency)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    >
                      <option value="weekly">Mingguan</option>
                      <option value="monthly">Bulanan</option>
                      <option value="yearly">Tahunan</option>
                      <option value="once">Sekali Bayar</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Sifat Durasi</label>
                    <select
                      value={obDuration}
                      onChange={(e) => setObDuration(e.target.value as ObligationDurationType)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    >
                      <option value="temporary">Sementara</option>
                      <option value="fixed_term">Rutin Dengan Batas Waktu</option>
                      <option value="indefinite">Rutin Tanpa Batas Waktu</option>
                      <option value="one_time">Sekali Bayar</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Tanggal Mulai</label>
                    <input
                      type="date"
                      required
                      value={obStart}
                      onChange={(e) => setObStart(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Tanggal Jatuh Tempo</label>
                    <input
                      type="date"
                      required
                      value={obDue}
                      onChange={(e) => setObDue(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      Tanggal Berakhir (Opsional)
                    </label>
                    <input
                      type="date"
                      value={obEnd}
                      onChange={(e) => setObEnd(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    />
                  </div>
                  <div className="flex items-end gap-2 sm:col-span-2">
                    <label className="flex items-center gap-2 pb-2">
                      <input
                        type="checkbox"
                        checked={obReminderEnabled}
                        onChange={(e) => setObReminderEnabled(e.target.checked)}
                      />
                      <span>Pengingat H-</span>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      disabled={!obReminderEnabled}
                      value={obReminderDays}
                      onChange={(e) => setObReminderDays(e.target.value)}
                      className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-2 font-mono-num"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowObForm(false);
                      setEditingObId(null);
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-[#0976A6] px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    {editingObId ? 'Simpan Perubahan' : 'Simpan'}
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-slate-100">
              {filteredObligations.map((ob) => {
                const shortfall = ob.status === 'active' ? Math.max(0, ob.amount - ob.reservedAmount) : 0;
                const pct = Math.min(100, Math.round((ob.reservedAmount / ob.amount) * 100));
                const logs = state.obligationLogs.filter((l) => l.obligationId === ob.id);
                const statusMeta = STATUS_META[ob.status];
                const selectedGoalId =
                  reallocGoalMap[ob.id] ?? state.goals[0]?.id ?? '';
                const freqLabel =
                  ob.frequency === 'once'
                    ? 'Sekali'
                    : ob.frequency === 'weekly'
                    ? 'Mingguan'
                    : ob.frequency === 'yearly'
                    ? 'Tahunan'
                    : 'Bulanan';

                return (
                  <div key={ob.id} className="py-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-bold text-slate-900">{ob.name}</p>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                            {ob.kind === 'scheduled_expense' ? 'Terjadwal' : 'Kewajiban'}
                          </span>
                          <span
                            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusMeta.style}`}
                          >
                            {statusMeta.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {DURATION_LABELS[ob.durationType]} · {freqLabel} · Mulai {formatDateID(ob.startDate)}
                          {ob.endDate ? ` · Berakhir ${formatDateID(ob.endDate)}` : ''}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Jatuh tempo berikutnya: {formatDateID(ob.nextDueDate)}
                          {ob.reminderEnabled ? ` · Pengingat H-${ob.reminderDaysBefore}` : ' · Pengingat Nonaktif'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono-num text-sm font-extrabold text-slate-900">
                          {formatIDR(ob.amount)}
                        </p>
                        <p className="text-[11px] font-mono-num text-[#0976A6]">
                          Cadangan: {formatIDR(ob.reservedAmount)}
                        </p>
                      </div>
                    </div>

                    {ob.status === 'active' && (
                      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-[#0C8FC5]" style={{ width: `${pct}%` }} />
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span
                        className={
                          ob.status !== 'active'
                            ? 'text-slate-500 font-medium'
                            : shortfall > 0
                            ? 'text-amber-700 font-semibold'
                            : 'text-emerald-700 font-semibold'
                        }
                      >
                        {ob.status === 'completed'
                          ? 'Selesai — alokasi berikutnya dihentikan otomatis (riwayat tetap tersimpan).'
                          : ob.status === 'paused'
                          ? 'Ditangguhkan — tidak menyedot Dana Aman sementara.'
                          : ob.status === 'cancelled'
                          ? 'Dibatalkan — alokasi dihentikan.'
                          : shortfall > 0
                          ? `Perlu disisihkan: ${formatIDR(shortfall)}`
                          : 'Dana cadangan siap dibayar'}
                      </span>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {ob.status === 'active' && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setObAction({ id: ob.id, mode: 'reserve' });
                                setObActionAmt(
                                  String(shortfall > 0 ? Math.min(shortfall, 10000) : 10000)
                                );
                              }}
                              className="rounded-lg border border-[#B9E2F5] bg-[#E8F6FC] px-2.5 py-1 text-xs font-semibold text-[#0976A6]"
                            >
                              Sisihkan
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setObAction({ id: ob.id, mode: 'pay' });
                                setObActionAmt(String(ob.amount));
                              }}
                              className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              Bayar
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setObAction(
                              obAction?.id === ob.id && obAction.mode === 'history'
                                ? null
                                : { id: ob.id, mode: 'history' }
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700"
                        >
                          <History className="w-3.5 h-3.5" />
                          <span>({logs.length})</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditObForm(ob)}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-[#0976A6]"
                          aria-label={`Edit ${ob.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onCommit(archiveObligationAction(state, ob.id))}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-800"
                          title={ob.isArchived ? 'Aktifkan dari arsip' : 'Arsipkan'}
                        >
                          {ob.isArchived ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                        </button>
                        <select
                          aria-label={`Ubah status ${ob.name}`}
                          value={ob.status}
                          onChange={(e) =>
                            onCommit(
                              updateObligationAction(state, ob.id, {
                                status: e.target.value as ObligationStatus,
                              })
                            )
                          }
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
                        >
                          <option value="active">Aktif</option>
                          <option value="paused">Tangguhkan</option>
                          <option value="completed">Selesai</option>
                          <option value="cancelled">Batalkan</option>
                        </select>
                      </div>
                    </div>

                    {ob.status === 'completed' && !ob.reallocatedToGoalId && state.goals.length > 0 && (
                      <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                        <div className="flex items-start gap-2">
                          <ArrowRightCircle className="w-4 h-4 text-[#0976A6] shrink-0 mt-0.5" />
                          <div>
                            <p className="font-bold text-slate-900">
                              Alihkan Alokasi ke Tujuan Lain
                            </p>
                            <p className="text-[#075D83]">
                              Kewajiban ini telah selesai.{' '}
                              {ob.reservedAmount > 0
                                ? `Tersedia sisa cadangan ${formatIDR(ob.reservedAmount)} yang dapat dipindahkan ke target tabungan.`
                                : `Anda dapat mengalihkan porsi rutin ${formatIDR(ob.amount)} ke target tabungan atau Dana Darurat.`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <select
                            value={selectedGoalId}
                            onChange={(e) =>
                              setReallocGoalMap({ ...reallocGoalMap, [ob.id]: e.target.value })
                            }
                            className="rounded-lg border border-[#B9E2F5] bg-white px-2.5 py-1.5 text-xs"
                          >
                            {state.goals.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              onCommit(
                                reallocateCompletedObligationAction(state, {
                                  obligationId: ob.id,
                                  goalId: selectedGoalId,
                                  fromAccountId: 'acc-cash',
                                  toAccountId: 'acc-savings',
                                  date: todayISO(),
                                })
                              )
                            }
                            className="rounded-lg bg-[#0976A6] px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap"
                          >
                            Alihkan Sekarang
                          </button>
                        </div>
                      </div>
                    )}

                    {obAction?.id === ob.id && obAction.mode !== 'history' && (
                      <form
                        onSubmit={handleObActionSubmit}
                        className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-3 space-y-2"
                      >
                        <p className="text-xs font-bold text-slate-900">
                          {obAction.mode === 'reserve'
                            ? 'Sisihkan Dana dari Saldo Likuid (Mengunci dari Dana Aman)'
                            : 'Catat Pembayaran Aktual'}
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            type="number"
                            required
                            min={1}
                            value={obActionAmt}
                            onChange={(e) => setObActionAmt(e.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono-num"
                          />
                          {obAction.mode === 'pay' && (
                            <select
                              value={obPayAccId}
                              onChange={(e) => setObPayAccId(e.target.value)}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                            >
                              {personalActiveLiquid.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name} ({formatIDR(a.currentBalance)})
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setObAction(null)}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                          >
                            Batal
                          </button>
                          <button
                            type="submit"
                            className="rounded-lg bg-[#0976A6] px-3 py-1.5 text-xs font-semibold text-white"
                          >
                            Konfirmasi
                          </button>
                        </div>
                      </form>
                    )}

                    {obAction?.id === ob.id && obAction.mode === 'history' && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5 text-xs">
                        <p className="font-bold text-slate-800">Riwayat Pembayaran & Aktivitas</p>
                        {logs.length === 0 ? (
                          <p className="text-slate-500">Belum ada riwayat pembayaran/penyisihan.</p>
                        ) : (
                          logs.map((l) => (
                            <div
                              key={l.id}
                              className="flex items-center justify-between py-1 border-b border-slate-200/70 last:border-0"
                            >
                              <span className="text-slate-700">
                                {l.action === 'pay'
                                  ? 'Pembayaran'
                                  : l.action === 'reserve'
                                  ? 'Penyisihan'
                                  : l.action === 'reallocate'
                                  ? 'Pengalihan'
                                  : 'Ubah Status'}{' '}
                                · {formatDateID(l.date)} {l.notes ? `(${l.notes})` : ''}
                              </span>
                              <span className="font-mono-num font-bold text-slate-900">
                                {formatIDR(l.amount)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {subTab === 'goals' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-slate-500">Total Seluruh Target & Dana Darurat Terkumpul</p>
                <p className="font-display text-2xl font-extrabold font-mono-num text-slate-900">
                  {formatIDR(snapshot.totalSavingsSaved)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {snapshot.modeEvaluation.mode === 'recovery'
                    ? 'Saat Mode Pemulihan aktif, target investasi tetap boleh disimpan namun rekomendasi setoran investasi ditahan sampai utang, kewajiban, dan dana darurat awal aman.'
                    : 'Setoran ke akun Tabungan Terlindungi otomatis memisahkan dana agar tidak ikut terjajan.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowArchivedGoals((v) => !v)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                {showArchivedGoals ? 'Aktif Saja' : 'Tampilkan Arsip'}
              </button>
              <button
                type="button"
                onClick={() => setShowNewGoal((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[42px]"
              >
                <PiggyBank className="w-4 h-4" />
                <span>Target Baru</span>
              </button>
            </div>
          </div>

          {showNewGoal && (
            <form
              onSubmit={handleAddGoal}
              className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
            >
              <h3 className="font-display text-sm font-bold text-slate-900">Tambah Target Finansial</h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <input
                  type="text"
                  required
                  value={goalName}
                  onChange={(e) => setGoalName(e.target.value)}
                  placeholder="Nama Target"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <select
                  value={goalType}
                  onChange={(e) => setGoalType(e.target.value as GoalType)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="emergency">Dana Darurat</option>
                  <option value="personal">Tabungan Pribadi</option>
                  <option value="smartphone">Beli Perangkat / Aset</option>
                  <option value="business">Pengembangan Bisnis</option>
                  <option value="investment">Investasi</option>
                  <option value="buffer">Penyangga Kas</option>
                </select>
                <input
                  type="number"
                  required
                  min={1}
                  value={goalTarget}
                  onChange={(e) => setGoalTarget(e.target.value)}
                  placeholder="Target Nominal (Rp)"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
                />
                <input
                  type="number"
                  min={0}
                  value={goalMonthly}
                  onChange={(e) => setGoalMonthly(e.target.value)}
                  placeholder="Target / Bulan (Rp)"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewGoal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white"
                >
                  Simpan Target
                </button>
              </div>
            </form>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visibleGoals.map((g) => {
              const pct = Math.min(100, Math.round((g.currentAmount / Math.max(1, g.targetAmount)) * 100));
              const investPausedNote =
                g.goalType === 'investment' && snapshot.modeEvaluation.mode === 'recovery';

              return (
                <div
                  key={g.id}
                  className={`rounded-2xl border bg-white p-5 space-y-3 ${
                    g.isArchived ? 'border-slate-200 opacity-75' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold text-slate-500">
                        Prioritas #{g.priority} ·{' '}
                        {g.goalType === 'emergency'
                          ? 'Dana Darurat Terpisah'
                          : g.goalType === 'investment'
                          ? 'Target Investasi'
                          : 'Target Finansial'}
                      </p>
                      <h4 className="font-display text-base font-bold text-slate-900 mt-0.5">
                        {g.name}
                      </h4>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono-num text-sm font-bold text-[#0976A6]">{pct}%</span>
                      <button
                        type="button"
                        onClick={() => onCommit(archiveGoalAction(state, g.id))}
                        className="p-1 rounded border border-slate-200 text-slate-400 hover:text-slate-700"
                        title={g.isArchived ? 'Aktifkan kembali' : 'Arsipkan target'}
                      >
                        {g.isArchived ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {investPausedNote && (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                      Target investasi tetap tersimpan, namun rekomendasi setoran investasi ditahan selama Mode Pemulihan agar utang & kewajiban lunas dahulu.
                    </p>
                  )}

                  <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-600 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono-num text-slate-700">
                      <strong className="text-slate-900">{formatIDR(g.currentAmount)}</strong> /{' '}
                      {formatIDR(g.targetAmount)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setContribGoalId(g.id);
                        setContribAmt('25000');
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Setor Dana</span>
                    </button>
                  </div>

                  {contribGoalId === g.id && (
                    <form
                      onSubmit={handleContribSubmit}
                      className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 space-y-2.5"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          type="number"
                          required
                          min={1}
                          value={contribAmt}
                          onChange={(e) => setContribAmt(e.target.value)}
                          placeholder="Nominal"
                          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono-num"
                        />
                        <select
                          value={contribFromAcc}
                          onChange={(e) => setContribFromAcc(e.target.value)}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs"
                        >
                          {snapshot.activeAccounts
                            .filter((a) => !a.isProtected)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                Dari: {a.name}
                              </option>
                            ))}
                        </select>
                        <select
                          value={contribToAcc}
                          onChange={(e) => setContribToAcc(e.target.value)}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs"
                        >
                          <option value="acc-savings">Pindah ke Tabungan Terlindungi</option>
                          <option value="acc-invest">Pindah ke Akun Investasi</option>
                          <option value="">Kunci Virtual di Dompet/Bank</option>
                        </select>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setContribGoalId(null)}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                        >
                          Batal
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          Simpan Setoran
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
