import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Calculator, ShieldAlert, X } from 'lucide-react';
import { FinanceSnapshot, simulateExpenseImpact } from '../engine/financeEngine';
import { addTransactionAction } from '../hooks/financeActions';
import { FinanceState } from '../types/finance';
import { formatIDR, todayISO } from '../utils/format';

interface DecisionSimulatorModalProps {
  isOpen: boolean;
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onClose: () => void;
  onCommit: (next: FinanceState) => void;
}

export const DecisionSimulatorModal: React.FC<DecisionSimulatorModalProps> = ({
  isOpen,
  state,
  snapshot,
  onClose,
  onCommit,
}) => {
  const expenseCategories = useMemo(
    () => state.categories.filter((c) => c.type === 'expense' && !c.isArchived),
    [state.categories]
  );
  const activeAccounts = useMemo(
    () => snapshot.activeAccounts.length > 0 ? snapshot.activeAccounts : snapshot.accounts,
    [snapshot.activeAccounts, snapshot.accounts]
  );

  const [amount, setAmount] = useState<string>('25000');
  const [categoryId, setCategoryId] = useState<string>('cat-hangout');
  const [accountId, setAccountId] = useState<string>(activeAccounts[0]?.id ?? 'acc-cash');
  const [description, setDescription] = useState<string>('');
  const [overrideReason, setOverrideReason] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const numericAmount = Math.max(0, Number(amount) || 0);

  const impact = useMemo(() => {
    return simulateExpenseImpact(
      state,
      {
        amount: numericAmount,
        categoryId,
        accountId,
        date: todayISO(),
      },
      snapshot
    );
  }, [state, snapshot, numericAmount, categoryId, accountId]);

  if (!isOpen) return null;

  const needsOverride =
    !impact.isEssential &&
    (impact.warningLevel === 'critical' || impact.warningLevel === 'recovery_alert');

  const handleConfirmRecord = () => {
    setError(null);
    if (numericAmount <= 0) {
      setError('Masukkan nominal simulasi lebih dari Rp0.');
      return;
    }
    try {
      const { state: next } = addTransactionAction(state, {
        type: 'expense',
        amount: numericAmount,
        categoryId,
        accountId,
        date: todayISO(),
        description: description.trim() || `Pengeluaran ${impact.categoryName}`,
        overrideReason: needsOverride ? overrideReason : undefined,
      });
      onCommit(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mencatat transaksi.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 sm:p-4 backdrop-blur-xs">
      <div className="w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl border border-slate-200 bg-white shadow-2xl max-h-[92vh] flex flex-col">
        <div className="sm:hidden w-10 h-1.5 bg-slate-300 rounded-full mx-auto mt-3" />

        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#E8F6FC] text-[#0976A6] flex items-center justify-center shrink-0">
              <Calculator className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                Simulasi Keputusan Keuangan
              </h3>
              <p className="text-xs text-slate-500">
                Uji dampak pengeluaran sebelum saldo benar-benar berkurang.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
            aria-label="Tutup simulasi"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Rencana Nominal (Rp)
              </label>
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-bold font-mono-num focus:border-[#0C8FC5] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Kategori</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
              >
                {expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Akun Sumber</label>
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
          </div>

          {/* Impact Summary Banner */}
          <div
            className={`rounded-xl border p-4 text-xs flex items-start gap-2.5 ${
              impact.warningLevel === 'recovery_alert' || impact.warningLevel === 'critical'
                ? 'border-red-200 bg-red-50 text-red-950'
                : impact.warningLevel === 'warning'
                ? 'border-amber-200 bg-amber-50 text-amber-950'
                : 'border-emerald-200 bg-emerald-50 text-emerald-950'
            }`}
          >
            {impact.warningLevel === 'normal' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
            ) : impact.warningLevel === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p className="font-bold">
                {impact.reasons.length > 0
                  ? 'Peringatan Dampak Simulasi'
                  : 'Pengeluaran Masih Dalam Batas Terkendali'}
              </p>
              {impact.reasons.length > 0 ? (
                <ul className="list-disc pl-4 space-y-0.5">
                  {impact.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : (
                <p>Tidak ditemukan pelanggaran batas anggaran dari rencana pengeluaran ini.</p>
              )}
            </div>
          </div>

          {/* Impact Matrix */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-slate-200 p-3.5 space-y-2">
              <p className="font-bold text-slate-900">Dampak Dana Aman &amp; Saldo Akun</p>
              <div className="flex justify-between">
                <span className="text-slate-600">Dana Aman (Safe-to-Spend)</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.safeToSpendBefore)} →{' '}
                  <span className={impact.safeToSpendAfter <= 0 ? 'text-red-700' : 'text-slate-900'}>
                    {formatIDR(impact.safeToSpendAfter)}
                  </span>
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Saldo {impact.accountName}</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.accountBalanceBefore)} →{' '}
                  <span className={impact.accountBalanceAfter < 0 ? 'text-red-700' : 'text-slate-900'}>
                    {formatIDR(impact.accountBalanceAfter)}
                  </span>
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Proyeksi Akhir Bulan</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.projectedEndOfMonthBefore)} →{' '}
                  <span className={impact.projectedEndOfMonthAfter < 0 ? 'text-red-700' : 'text-slate-900'}>
                    {formatIDR(impact.projectedEndOfMonthAfter)}
                  </span>
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3.5 space-y-2">
              <p className="font-bold text-slate-900">Dampak Sisa Anggaran</p>
              <div className="flex justify-between">
                <span className="text-slate-600">Sisa Harian</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.dailyRemainingBefore)} → {formatIDR(impact.dailyRemainingAfter)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Sisa Mingguan</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.weeklyRemainingBefore)} → {formatIDR(impact.weeklyRemainingAfter)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Sisa Bulanan</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(impact.monthlyRemainingBefore)} → {formatIDR(impact.monthlyRemainingAfter)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs">
            <p className="font-bold text-slate-900">Dampak Terhadap Kewajiban, Utang &amp; Target</p>
            <p className="text-slate-700">
              <strong>Kewajiban &amp; Tagihan:</strong> {impact.unfundedObligationsRisk}
            </p>
            <p className="text-slate-700">
              <strong>Pelunasan Utang:</strong> {impact.debtImpactNote}
            </p>
            <p className="text-slate-700">
              <strong>Dana Darurat:</strong> {impact.emergencyFundImpactNote}
            </p>
            <p className="text-slate-700">
              <strong>Target Tabungan:</strong> {impact.savingsGoalsImpactNote}
            </p>
          </div>

          {/* Optional Confirm to Record */}
          <div className="border-t border-slate-200 pt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Deskripsi (jika ingin langsung dicatat)"
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs focus:border-[#0C8FC5] focus:outline-none"
              />
              {needsOverride && (
                <input
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Alasan wajib min. 5 karakter untuk konfirmasi"
                  className="rounded-xl border border-red-300 px-3 py-2 text-xs focus:border-red-600 focus:outline-none"
                />
              )}
            </div>

            {error && (
              <p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500">
                Simulasi bersifat baca-saja dan tidak mengubah saldo sampai Anda mengonfirmasi transaksi.
              </p>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
                >
                  Tutup Simulasi
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRecord}
                  className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[40px]"
                >
                  Konfirmasi &amp; Catat Transaksi
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
