import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Calculator,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Cigarette,
  Clock,
  Coffee,
  CreditCard,
  EyeOff,
  GraduationCap,
  Info,
  Plus,
  ShieldAlert,
  Utensils,
  Wallet,
} from 'lucide-react';
import { buildCalendarEventsForMonth } from '../engine/calendarEvents';
import { FinanceSnapshot } from '../engine/financeEngine';
import {
  completeReminderAction,
  confirmNoSpendDayAction,
  disableReminderAction,
  snoozeReminderAction,
} from '../hooks/financeActions';
import { FinanceState, Transaction } from '../types/finance';
import { formatDateID, formatIDR } from '../utils/format';
import { QuickPreset } from './QuickTransactionModal';

interface DashboardViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onQuickAction: (preset: QuickPreset) => void;
  onOpenSimulator: () => void;
  onEditTransaction: (tx: Transaction) => void;
  onNavigate: (tab: string) => void;
  onCommit: (next: FinanceState) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  state,
  snapshot,
  onQuickAction,
  onOpenSimulator,
  onEditTransaction,
  onNavigate,
  onCommit,
}) => {
  const [showModeReasons, setShowModeReasons] = useState(false);

  const modeStyles = {
    recovery: {
      container: 'border-red-200 bg-red-50 text-red-950',
      labelColor: 'text-red-800',
      icon: <ShieldAlert className="w-5 h-5 text-red-700 shrink-0" />,
    },
    stabilization: {
      container: 'border-amber-200 bg-amber-50 text-amber-950',
      labelColor: 'text-amber-800',
      icon: <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0" />,
    },
    saving: {
      container: 'border-[#B9E2F5] bg-[#E8F6FC] text-slate-950',
      labelColor: 'text-[#0976A6]',
      icon: <Info className="w-5 h-5 text-[#0976A6] shrink-0" />,
    },
    growth: {
      container: 'border-emerald-200 bg-emerald-50 text-emerald-950',
      labelColor: 'text-emerald-800',
      icon: <ArrowUpRight className="w-5 h-5 text-emerald-700 shrink-0" />,
    },
  }[snapshot.modeEvaluation.mode];

  const quickActions: { id: QuickPreset; label: string; sub: string; icon: React.ReactNode; tone: string }[] = [
    {
      id: 'allowance',
      label: 'Catat Pemasukan',
      sub: 'Uang masuk aktual',
      icon: <Wallet className="w-4 h-4 text-[#0976A6]" />,
      tone: 'border-[#B9E2F5] bg-[#E8F6FC]/70 hover:bg-[#E8F6FC]',
    },
    {
      id: 'cigarette',
      label: 'Beli Rokok',
      sub: `Sisa ${formatIDR(Math.max(0, snapshot.cigaretteAnalysis.weeklyLimit - snapshot.cigaretteAnalysis.weeklySpent))}`,
      icon: <Cigarette className="w-4 h-4 text-red-700" />,
      tone: 'border-slate-200 bg-white hover:bg-slate-50',
    },
    {
      id: 'hangout',
      label: 'Nongkrong',
      sub: `Sisa ${formatIDR(Math.max(0, snapshot.hangoutAnalysis.weeklyLimit - snapshot.hangoutAnalysis.weeklySpent))}`,
      icon: <Coffee className="w-4 h-4 text-amber-700" />,
      tone: 'border-slate-200 bg-white hover:bg-slate-50',
    },
    {
      id: 'food',
      label: 'Makan',
      sub: 'Kebutuhan pokok',
      icon: <Utensils className="w-4 h-4 text-emerald-700" />,
      tone: 'border-slate-200 bg-white hover:bg-slate-50',
    },
    {
      id: 'kkn',
      label: 'Bayar Kewajiban',
      sub: `Kurang ${formatIDR(snapshot.unfundedObligations + snapshot.unfundedScheduledExpenses)}`,
      icon: <GraduationCap className="w-4 h-4 text-[#0976A6]" />,
      tone: 'border-slate-200 bg-white hover:bg-slate-50',
    },
    {
      id: 'debt',
      label: 'Bayar Utang',
      sub: `Sisa ${formatIDR(snapshot.outstandingDebtTotal)}`,
      icon: <CreditCard className="w-4 h-4 text-slate-700" />,
      tone: 'border-slate-200 bg-white hover:bg-slate-50',
    },
  ];

  const recentTx = state.transactions.filter((t) => !t.isVoided).slice(0, 5);
  const currMonth = snapshot.nowISO.slice(0, 7);
  const calMap = buildCalendarEventsForMonth(state, currMonth);
  const weekDaysSlice = snapshot.noSpendStats.daysStatus.slice(-7);
  const activeGoalsCount = state.goals.filter((g) => !g.isArchived).length;

  return (
    <div className="space-y-6">
      {/* Top Hero Row: Total Saldo Seluruh Akun + Safe-to-Spend + Automatic Mode */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 flex flex-col justify-between">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-slate-500">
                  Dana Aman Dibelanjakan (Safe-to-Spend)
                </p>
                <p className="mt-1 font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900 font-mono-num">
                  {formatIDR(snapshot.safeToSpend)}
                </p>
                {snapshot.fundingShortfall > 0 && (
                  <p className="mt-1 text-xs font-semibold text-red-700 font-mono-num">
                    Kekurangan pendanaan komitmen: {formatIDR(snapshot.fundingShortfall)}
                  </p>
                )}
              </div>
              <div className="sm:text-right shrink-0">
                <p className="text-xs font-medium text-slate-500">Total Saldo Seluruh Akun</p>
                <p className="mt-1 text-xl font-extrabold text-slate-900 font-mono-num">
                  {formatIDR(snapshot.totalNetAssets)}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500 font-mono-num">
                  Kas Likuid Pribadi: {formatIDR(snapshot.liquidPersonalBalance)}
                </p>
                {snapshot.outstandingReceivableTotal > 0 && (
                  <p className="mt-0.5 text-[11px] text-[#0976A6] font-mono-num">
                    Piutang belum cair (bukan kas): {formatIDR(snapshot.outstandingReceivableTotal)}
                  </p>
                )}
              </div>
            </div>

            {/* Rincian Saldo per Jenis Akun */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] text-slate-500">Tunai</p>
                <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                  {formatIDR(snapshot.accountBreakdown.cash)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] text-slate-500">Bank Pribadi</p>
                <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                  {formatIDR(snapshot.accountBreakdown.bankPersonal)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] text-slate-500">E-Wallet</p>
                <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                  {formatIDR(snapshot.accountBreakdown.ewallet)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] text-slate-500">Tabungan &amp; Inv.</p>
                <p className="font-mono-num font-bold text-emerald-700 mt-0.5">
                  {formatIDR(snapshot.accountBreakdown.savings + snapshot.accountBreakdown.investment)}
                </p>
              </div>
              <div className="rounded-xl bg-[#E8F6FC] px-3 py-2 col-span-2 sm:col-span-1">
                <p className="text-[11px] text-[#0976A6]">Kas Bisnis</p>
                <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                  {formatIDR(snapshot.accountBreakdown.business)}
                </p>
              </div>
            </div>

            {/* Transparent Safe-to-Spend Calculation Ledger */}
            <div className="mt-4 border-t border-slate-100 pt-3.5 space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Saldo Aktual Likuid Pribadi</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatIDR(snapshot.liquidPersonalBalance)}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>(-) Dana Sudah Dialokasikan (Kewajiban &amp; Tabungan Virtual)</span>
                <span className="font-mono-num font-semibold text-[#0976A6]">
                  -{formatIDR(snapshot.allocatedTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>(-) Kewajiban/Tagihan Belum Terdanai &amp; Sisa Utang</span>
                <span className="font-mono-num font-semibold text-red-700">
                  -{formatIDR(snapshot.unfundedObligations + snapshot.unfundedScheduledExpenses + snapshot.outstandingDebtTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>(-) Kebutuhan Pokok Direncanakan</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  -{formatIDR(snapshot.essentialReserve)}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Automatic Financial Mode Card */}
        <section className={`lg:col-span-5 rounded-2xl border p-5 sm:p-6 flex flex-col justify-between ${modeStyles.container}`}>
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {modeStyles.icon}
                <div>
                  <p className="text-xs font-medium opacity-80">Evaluasi Otomatis Sistem</p>
                  <h2 className={`font-display text-xl font-bold ${modeStyles.labelColor}`}>
                    {snapshot.modeEvaluation.label}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowModeReasons((v) => !v)}
                className="text-xs font-semibold underline underline-offset-4 hover:opacity-80 min-h-[36px] px-2"
              >
                {showModeReasons ? 'Sembunyikan' : 'Lihat Alasan'}
              </button>
            </div>

            <p className="mt-3 text-sm leading-relaxed">
              {snapshot.modeEvaluation.shortDesc}
            </p>

            {showModeReasons ? (
              <div className="mt-4 border-t border-black/10 pt-3 space-y-2 text-xs">
                <p className="font-bold">Alasan Penentuan Mode:</p>
                <ul className="list-disc pl-4 space-y-1">
                  {snapshot.modeEvaluation.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="mt-4 border-t border-black/10 pt-3 space-y-1.5 text-xs">
                <p className="font-bold">Aturan Perilaku Aktif:</p>
                <ul className="list-disc pl-4 space-y-1">
                  {snapshot.modeEvaluation.behavioralRules.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-black/10 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>Skor Disiplin Finansial</span>
            <button
              type="button"
              onClick={() => onNavigate('analysis')}
              className="font-mono-num font-bold underline underline-offset-4"
            >
              {snapshot.disciplineScore !== null
                ? `${snapshot.disciplineScore}/100 · Lihat Analisis`
                : 'Belum cukup data · Lihat Syarat'}
            </button>
          </div>
        </section>
      </div>

      {/* Quick Actions (1-Tap) */}
      <section aria-label="Aksi Cepat">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="font-display text-sm font-bold text-slate-900">Aksi Cepat Harian</h2>
          <div className="flex flex-wrap items-center gap-2.5">
            {snapshot.noSpendStats.todayStatus.status === 'unconfirmed' &&
              !snapshot.noSpendStats.todayStatus.hasDiscretionary && (
                <button
                  type="button"
                  onClick={() =>
                    onCommit(confirmNoSpendDayAction(state, snapshot.nowISO, 'Konfirmasi dari Beranda'))
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Konfirmasi Hari Tanpa Jajan</span>
                </button>
              )}
            <button
              type="button"
              onClick={onOpenSimulator}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-1.5 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9]"
            >
              <Calculator className="w-3.5 h-3.5" />
              <span>Simulasi Dampak</span>
            </button>
            <button
              type="button"
              onClick={() => onQuickAction(null)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#0976A6] hover:underline"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Catat Kustom</span>
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {quickActions.map((qa) => (
            <button
              key={qa.id}
              type="button"
              onClick={() => onQuickAction(qa.id)}
              className={`flex flex-col items-start justify-between rounded-xl border p-3.5 text-left transition-colors min-h-[76px] ${qa.tone}`}
            >
              <div className="flex items-center justify-between w-full">{qa.icon}</div>
              <div className="mt-2 w-full">
                <p className="text-xs font-bold text-slate-900 truncate">{qa.label}</p>
                <p className="text-[11px] text-slate-500 font-mono-num truncate">{qa.sub}</p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Active Reminders + Warnings */}
      {(snapshot.upcomingReminders.length > 0 || snapshot.recommendations.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {snapshot.recommendations.length > 0 && (
            <section
              className={`${
                snapshot.upcomingReminders.length > 0 ? 'lg:col-span-7' : 'lg:col-span-12'
              } rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100`}
            >
              <div className="px-5 py-3.5 flex items-center justify-between">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  Peringatan &amp; Prioritas Keuangan ({snapshot.recommendations.length})
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('analysis')}
                  className="text-xs font-semibold text-[#0976A6] hover:underline"
                >
                  Semua Rekomendasi
                </button>
              </div>
              {snapshot.recommendations.slice(0, 3).map((rec) => (
                <div
                  key={rec.id}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-3">
                    {rec.severity === 'critical' || rec.severity === 'recovery_alert' ? (
                      <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    ) : rec.severity === 'warning' ? (
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-4 h-4 text-[#0976A6] shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="text-xs font-bold text-slate-900">{rec.title}</p>
                      <p className="text-xs text-slate-600 mt-0.5">{rec.message}</p>
                    </div>
                  </div>
                  {rec.actionLabel && rec.targetTab && (
                    <button
                      type="button"
                      onClick={() => onNavigate(rec.targetTab!)}
                      className="self-start sm:self-center shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      {rec.actionLabel}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {snapshot.upcomingReminders.length > 0 && (
            <section
              className={`${
                snapshot.recommendations.length > 0 ? 'lg:col-span-5' : 'lg:col-span-12'
              } rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100`}
            >
              <div className="px-5 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#0976A6]" />
                  <h2 className="font-display text-sm font-bold text-slate-900">
                    Pengingat Aktif ({snapshot.upcomingReminders.length})
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('calendar')}
                  className="text-xs font-semibold text-[#0976A6] hover:underline"
                >
                  Atur Semua
                </button>
              </div>
              {snapshot.upcomingReminders.slice(0, 4).map((rem) => (
                <div key={rem.id} className="px-5 py-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{rem.title}</p>
                      <p className="text-slate-500">
                        {rem.daysRemaining === 0
                          ? 'Hari ini'
                          : rem.daysRemaining < 0
                          ? `Terlewat ${Math.abs(rem.daysRemaining)} hari`
                          : `${rem.daysRemaining} hari lagi`}{' '}
                        · {formatDateID(rem.dueDate)}
                      </p>
                    </div>
                    {rem.amount !== undefined && (
                      <span className="font-mono-num font-bold text-slate-900 shrink-0">
                        {formatIDR(rem.amount)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onCommit(snoozeReminderAction(state, rem.id, 1, snapshot.nowISO))}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                      title="Tunda 1 hari"
                    >
                      <Clock className="w-3 h-3" />
                      <span>Tunda 1h</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onCommit(completeReminderAction(state, rem.id))}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                      title="Tandai selesai"
                    >
                      <Check className="w-3 h-3" />
                      <span>Selesai</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onCommit(disableReminderAction(state, rem.id))}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
                      title="Nonaktifkan pengingat ini"
                    >
                      <EyeOff className="w-3 h-3" />
                      <span>Matikan</span>
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {/* Middle Row: Remaining Budgets + Savings/Emergency + Mini Calendar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-slate-900">
              Sisa Anggaran Harian, Mingguan &amp; Bulanan
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('budgets')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#0976A6] hover:underline"
            >
              <span>Kelola</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3.5">
            {[snapshot.dailyBudget, snapshot.weeklyBudget, snapshot.monthlyBudget].map((b) => {
              const barColor =
                b.level === 'critical' || b.level === 'recovery_alert'
                  ? 'bg-red-600'
                  : b.level === 'warning'
                  ? 'bg-amber-500'
                  : 'bg-[#0C8FC5]';
              return (
                <div key={b.period} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-800">{b.label}</span>
                    <span className="font-mono-num font-bold text-slate-900">
                      Sisa {formatIDR(b.remaining)}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${Math.min(100, b.utilizationPct)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono-num">
                    <span>Terpakai: {formatIDR(b.discretionarySpent)}</span>
                    <span>Batas: {formatIDR(b.limit)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Savings & Emergency Summary */}
        <section className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-slate-900">
              Ringkasan Target Tabungan &amp; Dana Darurat
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('obligations')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#0976A6] hover:underline"
            >
              <span>Detail</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <div className="rounded-xl bg-emerald-50 p-3">
              <p className="text-emerald-900 font-medium">Dana Darurat</p>
              <p className="font-mono-num text-sm font-extrabold text-emerald-950 mt-0.5">
                {formatIDR(snapshot.emergencySaved)}
              </p>
              <p className="text-[11px] text-emerald-800 font-mono-num">
                Target {formatIDR(snapshot.emergencyTarget)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="text-slate-600 font-medium">Total Semua Target</p>
              <p className="font-mono-num text-sm font-extrabold text-slate-900 mt-0.5">
                {formatIDR(snapshot.totalSavingsSaved)}
              </p>
              <p className="text-[11px] text-slate-500 font-mono-num">
                {activeGoalsCount} target aktif
              </p>
            </div>
          </div>

          <div className="space-y-2.5 pt-1">
            {state.goals
              .filter((g) => !g.isArchived)
              .slice(0, 3)
              .map((g) => {
                const pct = Math.min(100, Math.round((g.currentAmount / Math.max(1, g.targetAmount)) * 100));
                return (
                  <div key={g.id} className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="font-semibold text-slate-800 truncate pr-2">{g.name}</span>
                      <span className="font-mono-num text-slate-600 shrink-0">{pct}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
          </div>
        </section>

        {/* Compact Financial Activity Calendar */}
        <section className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#0976A6]" />
              <h2 className="font-display text-sm font-bold text-slate-900">
                Kalender Ringkas Aktivitas
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('calendar')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#0976A6] hover:underline"
            >
              <span>Kalender Penuh</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1.5">
            {weekDaysSlice.map((d) => {
              const evs = calMap.get(d.date) ?? [];
              const hasInc = evs.some((e) => e.type === 'income');
              const hasExp = evs.some((e) => e.type === 'expense');
              const hasDue = evs.some(
                (e) =>
                  e.type === 'debt_due' ||
                  e.type === 'receivable_due' ||
                  e.type === 'obligation_due' ||
                  e.type === 'scheduled_expense_due'
              );
              const isToday = d.date === snapshot.nowISO;
              return (
                <button
                  key={d.date}
                  type="button"
                  onClick={() => onNavigate('calendar')}
                  className={`rounded-xl border p-2 text-center transition-colors ${
                    isToday
                      ? 'border-[#0C8FC5] bg-[#E8F6FC]'
                      : 'border-slate-200 bg-slate-50/70 hover:bg-slate-100'
                  }`}
                >
                  <p className="font-mono-num text-xs font-bold text-slate-900">{d.date.slice(8, 10)}</p>
                  <div className="mt-1.5 flex items-center justify-center gap-0.5 min-h-[6px]">
                    {hasInc && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />}
                    {hasExp && <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />}
                    {hasDue && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-600" /> Pemasukan
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-slate-700" /> Pengeluaran
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> Jatuh Tempo
            </span>
          </div>

          <div className="border-t border-slate-100 pt-3 flex items-center justify-between text-xs">
            <span className="text-slate-600">Hari Tanpa Jajan ({snapshot.noSpendStats.periodLabel.split(';')[0]}):</span>
            <span className="font-mono-num font-bold text-slate-900 shrink-0 ml-2">
              {snapshot.noSpendStats.weeklyNoSpendDays}/{snapshot.noSpendStats.weeklyTotalDaysElapsed} minggu ini
            </span>
          </div>
        </section>
      </div>

      {/* Recent Transactions */}
      <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-display text-sm font-bold text-slate-900">Transaksi Terbaru</h2>
          <button
            type="button"
            onClick={() => onNavigate('transactions')}
            className="text-xs font-semibold text-[#0976A6] hover:underline"
          >
            Lihat Semua
          </button>
        </div>

        {recentTx.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm font-semibold text-slate-700">Belum ada transaksi tercatat</p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Pemasukan dan pengeluaran hanya dihitung setelah benar-benar tercatat. Gunakan tombol Aksi Cepat atau tombol Catat untuk memulai.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentTx.map((tx) => {
              const cat = state.categories.find((c) => c.id === tx.categoryId);
              const acc = state.accounts.find((a) => a.id === tx.accountId);
              return (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => onEditTransaction(tx)}
                  className="w-full px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-slate-50 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{tx.description}</p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      <span>{cat?.name ?? 'Kategori'}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{acc?.name ?? 'Akun'}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatDateID(tx.date)}</span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className={`text-sm font-bold font-mono-num ${
                        tx.type === 'income' ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {tx.type === 'income' ? '+' : '-'}
                      {formatIDR(tx.amount)}
                    </p>
                    {tx.exceededBudget && (
                      <p className="text-[11px] font-medium text-red-600">Melewati batas</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
