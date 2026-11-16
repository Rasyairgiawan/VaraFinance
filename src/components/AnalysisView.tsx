import React, { useState } from 'react';
import {
  AlertOctagon,
  BarChart3,
  CreditCard,
  Download,
  Lightbulb,
  PiggyBank,
  Printer,
  ShieldCheck,
  SlidersHorizontal,
  TrendingDown,
} from 'lucide-react';
import { FinanceSnapshot } from '../engine/financeEngine';
import { updateProjectionAssumptionsAction } from '../hooks/financeActions';
import { FinanceState } from '../types/finance';
import { addDaysISO, formatDateID, formatIDR, startOfWeekISO } from '../utils/format';

interface AnalysisViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
}

export const AnalysisView: React.FC<AnalysisViewProps> = ({ state, snapshot, onCommit }) => {
  const [showAssumptions, setShowAssumptions] = useState(false);

  const validTransactions = state.transactions.filter((t) => !t.isVoided);

  const currWeekStart = startOfWeekISO(snapshot.nowISO);
  const weeks = [-3, -2, -1, 0].map((offset) => {
    const start = addDaysISO(currWeekStart, offset * 7);
    const end = addDaysISO(start, 6);
    const txs = validTransactions.filter((t) => t.date >= start && t.date <= end);
    const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expenses = txs.filter((t) => t.type === 'expense' && t.categoryId !== 'cat-biz-ops');
    const expenseTotal = expenses.reduce((s, t) => s + t.amount, 0);
    const cig = expenses.filter((t) => t.categoryId === 'cat-cig').reduce((s, t) => s + t.amount, 0);
    const hang = expenses
      .filter((t) => t.categoryId === 'cat-hangout')
      .reduce((s, t) => s + t.amount, 0);
    const snack = expenses
      .filter((t) => t.categoryId === 'cat-other-exp')
      .reduce((s, t) => s + t.amount, 0);
    const other = Math.max(0, expenseTotal - cig - hang - snack);
    return {
      label: offset === 0 ? 'Minggu Ini' : `M${offset}`,
      income,
      expenseTotal,
      cig,
      hang,
      snack,
      other,
    };
  });

  const maxWeekFlow = Math.max(100000, ...weeks.map((w) => Math.max(w.income, w.expenseTotal)));
  const maxWeekExp = Math.max(50000, ...weeks.map((w) => w.expenseTotal));

  const catBreakdown = snapshot.categoryBudgets
    .filter((c) => c.monthlySpent > 0)
    .sort((a, b) => b.monthlySpent - a.monthlySpent);
  const totalMonthlyCat = Math.max(1, catBreakdown.reduce((s, c) => s + c.monthlySpent, 0));

  const payableDebts = state.debts.filter((d) => (d.direction ?? 'payable') === 'payable');
  const totalInitialDebt = payableDebts.reduce((s, d) => s + d.initialAmount, 0);
  const totalPaidDebt = Math.max(0, totalInitialDebt - snapshot.outstandingDebtTotal);
  const debtProgressPct =
    totalInitialDebt > 0 ? Math.round((totalPaidDebt / totalInitialDebt) * 100) : 100;

  const emergencyPct =
    snapshot.emergencyTarget > 0
      ? Math.min(100, Math.round((snapshot.emergencySaved / snapshot.emergencyTarget) * 100))
      : 0;

  const formatDelta = (curr: number, prev: number) => {
    const diff = curr - prev;
    if (diff === 0) return 'Sama dengan periode sebelumnya';
    return `${diff > 0 ? '+' : ''}${formatIDR(diff)} dibanding sebelumnya`;
  };

  const handleExportCSV = () => {
    const escapeCSV = (val: string | number) => {
      const s = String(val ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const rows: string[] = [
      'RINGKASAN LAPORAN KEUANGAN KENDALIUANG',
      `Tanggal Laporan,${snapshot.nowISO}`,
      `Saldo Likuid Pribadi,${snapshot.liquidPersonalBalance}`,
      `Kas Bisnis Freelance,${snapshot.businessBalance}`,
      `Dana Dialokasikan,${snapshot.allocatedTotal}`,
      `Dana Aman Dibelanjakan,${snapshot.safeToSpend}`,
      `Kekurangan Pendanaan,${snapshot.fundingShortfall}`,
      `Utang Aktif,${snapshot.outstandingDebtTotal}`,
      `Piutang Aktif,${snapshot.outstandingReceivableTotal}`,
      '',
      'Tanggal,Tipe,Deskripsi,Kategori,Akun,Nominal,Status,Alasan Override',
    ];

    for (const tx of state.transactions) {
      const cat = state.categories.find((c) => c.id === tx.categoryId)?.name ?? '';
      const acc = state.accounts.find((a) => a.id === tx.accountId)?.name ?? '';
      rows.push(
        [
          tx.date,
          tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran',
          escapeCSV(tx.description),
          escapeCSV(cat),
          escapeCSV(acc),
          tx.amount,
          tx.isVoided ? 'Void' : 'Aktif',
          escapeCSV(tx.overrideReason ?? ''),
        ].join(',')
      );
    }

    const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kendaliuang-laporan-${snapshot.nowISO}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintPDF = () => {
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const pred = snapshot.monthlyPrediction;
  const assum = pred.assumptions;

  return (
    <div className="space-y-6">
      {/* Export Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 no-print">
        <div>
          <h2 className="font-display text-sm font-bold text-slate-900">
            Laporan Analisis, Arus Kas & Proyeksi Keuangan
          </h2>
          <p className="text-xs text-slate-500">
            Unduh rekap transaksi CSV atau cetak laporan PDF rapi langsung dari perangkat.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportCSV}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Download className="w-4 h-4" />
            <span>Ekspor CSV</span>
          </button>
          <button
            type="button"
            onClick={handlePrintPDF}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83]"
          >
            <Printer className="w-4 h-4" />
            <span>Cetak / Ekspor PDF</span>
          </button>
        </div>
      </div>

      {/* KPI Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Arus Kas Bersih Bulan Ini</p>
          <p
            className={`font-mono-num text-lg font-extrabold mt-1 ${
              pred.confirmedNetCashFlow >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {pred.confirmedNetCashFlow >= 0 ? '+' : ''}
            {formatIDR(pred.confirmedNetCashFlow)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Rasio Tabungan (Aktual)</p>
          <p className="font-mono-num text-lg font-extrabold text-[#0976A6] mt-1">
            {pred.savingsRatioPct !== null ? `${pred.savingsRatioPct}%` : 'Belum ada pemasukan'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Rasio Pengeluaran Konsumtif</p>
          <p className="font-mono-num text-lg font-extrabold text-slate-900 mt-1">
            {pred.discretionaryRatioPct !== null ? `${pred.discretionaryRatioPct}%` : 'Belum ada belanja'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Piutang Aktif (Belum Cair)</p>
          <p className="font-mono-num text-lg font-extrabold text-slate-900 mt-1">
            {formatIDR(snapshot.outstandingReceivableTotal)}
          </p>
        </div>
      </div>

      {/* Row 1: Discipline Score + Actual vs Estimate vs Projection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-[#0976A6]" />
              <h2 className="font-display text-sm font-bold text-slate-900">
                Skor Disiplin Finansial
              </h2>
            </div>
            {snapshot.disciplineScore !== null ? (
              <span className="font-mono-num text-2xl font-extrabold text-[#0976A6]">
                {snapshot.disciplineScore}
                <span className="text-xs font-normal text-slate-500">/100</span>
              </span>
            ) : (
              <span className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-900">
                Belum cukup data
              </span>
            )}
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            {snapshot.disciplineScoreReason}
          </p>

          <div className={`space-y-3 ${snapshot.disciplineScore === null ? 'opacity-50' : ''}`}>
            {snapshot.disciplineScoreBreakdown.map((item) => (
              <div key={item.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-600">{item.label}</span>
                  <span className="font-mono-num font-bold text-slate-900">
                    {snapshot.disciplineScore !== null ? `${item.score} / ${item.max}` : `-- / ${item.max}`}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#0C8FC5]"
                    style={{
                      width:
                        snapshot.disciplineScore !== null
                          ? `${Math.round((item.score / item.max) * 100)}%`
                          : '0%',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <TrendingDown className="w-5 h-5 text-slate-700" />
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900">
                  Pemisahan Data Aktual, Estimasi & Proyeksi Akhir Bulan
                </h2>
                <p className="text-xs text-slate-500">
                  Asumsi proyeksi transparan dan terpisah dari saldo aktual.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowAssumptions((v) => !v)}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 no-print"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{showAssumptions ? 'Tutup Asumsi' : 'Atur Asumsi Proyeksi'}</span>
            </button>
          </div>

          {showAssumptions && (
            <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-4 space-y-3 text-xs no-print">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Tambahan Pemasukan Diharapkan Bulan Ini (Rp)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={10000}
                    value={assum.expectedExtraIncome}
                    onChange={(e) =>
                      onCommit(
                        updateProjectionAssumptionsAction(state, {
                          expectedExtraIncome: Math.max(0, Number(e.target.value) || 0),
                        })
                      )
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Override Belanja Konsumtif/Hari (Kosong = Pakai Aktual)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={5000}
                    value={assum.dailyDiscretionaryOverride ?? ''}
                    placeholder={`Otomatis (${formatIDR(pred.avgDailyDiscretionaryRate)})`}
                    onChange={(e) => {
                      const raw = e.target.value;
                      onCommit(
                        updateProjectionAssumptionsAction(state, {
                          dailyDiscretionaryOverride: raw === '' ? null : Math.max(0, Number(raw) || 0),
                        })
                      );
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono-num"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-4 pt-1">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assum.includeObligationsInProjection}
                    onChange={(e) =>
                      onCommit(
                        updateProjectionAssumptionsAction(state, {
                          includeObligationsInProjection: e.target.checked,
                        })
                      )
                    }
                  />
                  <span>Hitung Kewajiban Aktif</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assum.includeScheduledExpenses}
                    onChange={(e) =>
                      onCommit(
                        updateProjectionAssumptionsAction(state, {
                          includeScheduledExpenses: e.target.checked,
                        })
                      )
                    }
                  />
                  <span>Hitung Pengeluaran Terjadwal</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assum.includeDebtInProjection}
                    onChange={(e) =>
                      onCommit(
                        updateProjectionAssumptionsAction(state, {
                          includeDebtInProjection: e.target.checked,
                        })
                      )
                    }
                  />
                  <span>Hitung Sisa Utang</span>
                </label>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-xl border border-slate-200 p-3.5 space-y-2">
              <p className="font-bold text-slate-900">1. Data Aktual</p>
              <div>
                <p className="text-slate-500">Pemasukan Diterima</p>
                <p className="font-mono-num font-bold text-emerald-700">
                  +{formatIDR(pred.confirmedIncomeThisMonth)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Pengeluaran Tercatat</p>
                <p className="font-mono-num font-bold text-slate-900">
                  -{formatIDR(pred.confirmedExpenseThisMonth)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Saldo Likuid Kini</p>
                <p className="font-mono-num font-extrabold text-slate-900">
                  {formatIDR(snapshot.liquidPersonalBalance)}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3.5 space-y-2">
              <p className="font-bold text-amber-950">2. Estimasi Beban</p>
              <div>
                <p className="text-slate-600">Laju Konsumtif / Hari</p>
                <p className="font-mono-num font-bold text-slate-900">
                  {formatIDR(pred.appliedDailyDiscretionaryRate)}
                </p>
              </div>
              <div>
                <p className="text-slate-600">Est. Sisa {pred.remainingDaysInMonth} Hari</p>
                <p className="font-mono-num font-bold text-red-700">
                  -{formatIDR(pred.estimatedRemainingDiscretionarySpend)}
                </p>
              </div>
              <div>
                <p className="text-slate-600">Kewajiban & Utang Terhitung</p>
                <p className="font-mono-num font-bold text-amber-800">
                  -{formatIDR(pred.estimatedUpcomingObligations + pred.estimatedUpcomingScheduledExpenses + pred.estimatedUpcomingDebt)}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-3.5 space-y-2">
              <p className="font-bold text-slate-900">3. Proyeksi Akhir Bulan</p>
              <div>
                <p className="text-slate-600">Est. Saldo Likuid</p>
                <p
                  className={`font-mono-num text-base font-extrabold ${
                    pred.estimatedEndOfMonthLiquidBalance < 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {formatIDR(pred.estimatedEndOfMonthLiquidBalance)}
                </p>
              </div>
              {pred.potentialShortfall > 0 && (
                <p className="text-[11px] font-semibold text-red-700 font-mono-num">
                  Potensi kekurangan: {formatIDR(pred.potentialShortfall)}
                </p>
              )}
              <div>
                <p className="text-slate-600">Piutang Freelance (Terpisah)</p>
                <p className="font-mono-num font-semibold text-[#0976A6]">
                  {formatIDR(pred.expectedFreelanceReceivables)}
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Row 2: Weekly & Monthly Comparisons + Debt & Emergency Progress */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-500">Perbandingan Mingguan</p>
          <div className="flex justify-between text-xs">
            <span>Pemasukan</span>
            <span className="font-mono-num font-bold text-emerald-700">
              {formatIDR(snapshot.weeklyComparison.currentIncome)}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span>Pengeluaran</span>
            <span className="font-mono-num font-bold text-slate-900">
              {formatIDR(snapshot.weeklyComparison.currentExpense)}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 pt-1">
            {formatDelta(
              snapshot.weeklyComparison.currentExpense,
              snapshot.weeklyComparison.previousExpense
            )}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-500">Perbandingan Bulanan</p>
          <div className="flex justify-between text-xs">
            <span>Pemasukan</span>
            <span className="font-mono-num font-bold text-emerald-700">
              {formatIDR(snapshot.monthlyComparison.currentIncome)}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span>Pengeluaran</span>
            <span className="font-mono-num font-bold text-slate-900">
              {formatIDR(snapshot.monthlyComparison.currentExpense)}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 pt-1">
            {formatDelta(
              snapshot.monthlyComparison.currentExpense,
              snapshot.monthlyComparison.previousExpense
            )}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700 inline-flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5 text-red-700" />
              Progres Pelunasan Utang
            </span>
            <span className="font-mono-num font-bold text-slate-900">{debtProgressPct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-emerald-600" style={{ width: `${debtProgressPct}%` }} />
          </div>
          <p className="text-[11px] text-slate-500 font-mono-num">
            Terbayar {formatIDR(totalPaidDebt)} · Sisa {formatIDR(snapshot.outstandingDebtTotal)}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700 inline-flex items-center gap-1.5">
              <PiggyBank className="w-3.5 h-3.5 text-emerald-700" />
              Progres Dana Darurat
            </span>
            <span className="font-mono-num font-bold text-slate-900">{emergencyPct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-[#0C8FC5]" style={{ width: `${emergencyPct}%` }} />
          </div>
          <p className="text-[11px] text-slate-500 font-mono-num">
            {formatIDR(snapshot.emergencySaved)} / {formatIDR(snapshot.emergencyTarget)}
          </p>
        </div>
      </div>

      {/* Row 3: Income vs Expense Chart + Category Trend Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-emerald-700" />
              <h2 className="font-display text-sm font-bold text-slate-900">
                Grafik Pemasukan vs Pengeluaran (4 Minggu)
              </h2>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 inline-block" /> Masuk
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-slate-800 inline-block" /> Keluar
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 items-end h-48 pt-6 border-b border-slate-200 pb-2">
            {weeks.map((w) => {
              const incH = Math.max(w.income > 0 ? 6 : 0, Math.round((w.income / maxWeekFlow) * 135));
              const expH = Math.max(
                w.expenseTotal > 0 ? 6 : 0,
                Math.round((w.expenseTotal / maxWeekFlow) * 135)
              );
              return (
                <div key={w.label} className="flex flex-col items-center justify-end h-full">
                  <div className="flex items-end gap-1.5 h-36">
                    <div
                      title={`Masuk: ${formatIDR(w.income)}`}
                      style={{ height: `${incH}px` }}
                      className="w-5 sm:w-6 rounded-t-md bg-emerald-600"
                    />
                    <div
                      title={`Keluar: ${formatIDR(w.expenseTotal)}`}
                      style={{ height: `${expH}px` }}
                      className="w-5 sm:w-6 rounded-t-md bg-slate-800"
                    />
                  </div>
                  <span className="text-xs font-semibold text-slate-700 mt-2">{w.label}</span>
                  <span className="text-[10px] font-mono-num text-slate-500">
                    +{formatIDR(w.income)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-slate-900">
              Tren Pengeluaran per Kategori (4 Minggu)
            </h2>
            <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-red-600 inline-block" /> Rokok
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" /> Nongkrong
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-indigo-500 inline-block" /> Jajan
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-[#0C8FC5] inline-block" /> Esensial
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 items-end h-48 pt-6 border-b border-slate-200 pb-2">
            {weeks.map((w) => {
              const cigH = Math.round((w.cig / maxWeekExp) * 135);
              const hangH = Math.round((w.hang / maxWeekExp) * 135);
              const snackH = Math.round((w.snack / maxWeekExp) * 135);
              const otherH = Math.round((w.other / maxWeekExp) * 135);
              return (
                <div key={w.label} className="flex flex-col items-center justify-end h-full">
                  <span className="text-[11px] font-mono-num font-semibold text-slate-700 mb-1.5">
                    {formatIDR(w.expenseTotal)}
                  </span>
                  <div className="w-10 sm:w-12 flex flex-col-reverse rounded-t-lg overflow-hidden bg-slate-100">
                    {w.other > 0 && <div style={{ height: `${otherH}px` }} className="bg-[#0C8FC5] w-full" />}
                    {w.snack > 0 && <div style={{ height: `${snackH}px` }} className="bg-indigo-500 w-full" />}
                    {w.hang > 0 && <div style={{ height: `${hangH}px` }} className="bg-amber-500 w-full" />}
                    {w.cig > 0 && <div style={{ height: `${cigH}px` }} className="bg-red-600 w-full" />}
                  </div>
                  <span className="text-xs font-semibold text-slate-600 mt-2">{w.label}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Row 4: Category Distribution & Excessive Spending Analysis */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <h2 className="font-display text-sm font-bold text-slate-900">
            Distribusi Pengeluaran Bulan Ini
          </h2>
          {catBreakdown.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              Belum ada pengeluaran bulan ini untuk dianalisis.
            </p>
          ) : (
            <div className="space-y-3">
              {catBreakdown.map((c) => {
                const pct = Math.round((c.monthlySpent / totalMonthlyCat) * 100);
                return (
                  <div key={c.categoryId} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-800">{c.categoryName}</span>
                      <span className="font-mono-num text-slate-600">
                        {formatIDR(c.monthlySpent)} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          c.categoryId === 'cat-cig'
                            ? 'bg-red-600'
                            : c.categoryId === 'cat-hangout'
                            ? 'bg-amber-500'
                            : c.categoryId === 'cat-other-exp'
                            ? 'bg-indigo-500'
                            : 'bg-[#0C8FC5]'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-5 h-5 text-red-700" />
            <h2 className="font-display text-sm font-bold text-slate-900">
              Analisis Pengeluaran Berlebihan ({snapshot.excessiveTransactions.length})
            </h2>
          </div>

          {snapshot.excessiveTransactions.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              Belum ada transaksi konsumtif yang melewati batas anggaran dengan konfirmasi darurat.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {snapshot.excessiveTransactions.map((tx) => {
                const cat = state.categories.find((c) => c.id === tx.categoryId)?.name;
                return (
                  <div key={tx.id} className="py-3 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">
                        {tx.description} ({cat})
                      </span>
                      <span className="font-mono-num font-bold text-red-700">
                        -{formatIDR(tx.amount)}
                      </span>
                    </div>
                    <p className="text-slate-600">
                      {formatDateID(tx.date)} · Alasan: &ldquo;{tx.overrideReason || '-'}&rdquo;
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Recommendations Engine */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <Lightbulb className="w-5 h-5 text-amber-600" />
          <h2 className="font-display text-sm font-bold text-slate-900">
            Rekomendasi Berbasis Data Keuangan Anda
          </h2>
        </div>

        {snapshot.recommendations.length === 0 ? (
          <p className="text-xs text-slate-600">
            Kondisi disiplin keuangan Anda saat ini berada pada jalur yang aman. Pertahankan pencatatan rutin.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {snapshot.recommendations.map((rec) => (
              <div key={rec.id} className="py-3.5 first:pt-0 last:pb-0 space-y-1">
                <p className="text-sm font-bold text-slate-900">{rec.title}</p>
                <p className="text-xs text-slate-700">{rec.message}</p>
                <p className="text-[11px] text-slate-500">Alasan: {rec.reason}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
