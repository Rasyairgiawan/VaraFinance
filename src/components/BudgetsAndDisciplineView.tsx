import React, { useState } from 'react';
import {
  Archive,
  Calculator,
  CalendarCheck2,
  CheckCircle2,
  Cigarette,
  ClipboardList,
  Coffee,
  Flame,
  FolderPlus,
  RotateCcw,
  Save,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';
import { FinanceSnapshot } from '../engine/financeEngine';
import {
  addCategoryAction,
  archiveCategoryAction,
  confirmNoSpendDayAction,
  editCategoryAction,
  installGeneralPresetCategoriesAction,
  revokeNoSpendDayAction,
  updateSettingsAction,
} from '../hooks/financeActions';
import { CategoryClassification, FinanceState } from '../types/finance';
import { formatDateID, formatIDR } from '../utils/format';

interface BudgetsAndDisciplineViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
  onOpenSimulator?: () => void;
}

export const BudgetsAndDisciplineView: React.FC<BudgetsAndDisciplineViewProps> = ({
  state,
  snapshot,
  onCommit,
  onOpenSimulator,
}) => {
  const [cigLimit, setCigLimit] = useState(String(state.settings.cigaretteWeeklyLimit));
  const [hangLimit, setHangLimit] = useState(String(state.settings.hangoutWeeklyLimit));
  const [dailyLimit, setDailyLimit] = useState(String(state.settings.dailyBudgetLimit));
  const [weeklyLimit, setWeeklyLimit] = useState(String(state.settings.weeklyBudgetLimit));
  const [monthlyLimit, setMonthlyLimit] = useState(String(state.settings.monthlyBudgetLimit));
  const [savedToast, setSavedToast] = useState(false);

  const [noSpendDate, setNoSpendDate] = useState(snapshot.nowISO);
  const [noSpendNote, setNoSpendNote] = useState('');
  const [noSpendError, setNoSpendError] = useState<string | null>(null);

  // Category Management
  const [showNewCat, setShowNewCat] = useState(false);
  const [catName, setCatName] = useState('');
  const [catType, setCatType] = useState<'expense' | 'income'>('expense');
  const [catClass, setCatClass] = useState<CategoryClassification>('essential');
  const [catWeekly, setCatWeekly] = useState('0');
  const [catError, setCatError] = useState<string | null>(null);
  const [showArchivedCats, setShowArchivedCats] = useState(false);

  const handleSaveLimits = (e: React.FormEvent) => {
    e.preventDefault();
    const next = updateSettingsAction(state, {
      cigaretteWeeklyLimit: Math.max(0, Number(cigLimit) || 0),
      hangoutWeeklyLimit: Math.max(0, Number(hangLimit) || 0),
      dailyBudgetLimit: Math.max(0, Number(dailyLimit) || 0),
      weeklyBudgetLimit: Math.max(0, Number(weeklyLimit) || 0),
      monthlyBudgetLimit: Math.max(0, Number(monthlyLimit) || 0),
    });
    onCommit(next);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2500);
  };

  const handleConfirmNoSpend = (date: string) => {
    setNoSpendError(null);
    try {
      onCommit(
        confirmNoSpendDayAction(
          state,
          date,
          noSpendNote || 'Dikonfirmasi manual bebas jajan',
          snapshot.nowISO
        )
      );
      setNoSpendNote('');
    } catch (err) {
      setNoSpendError(err instanceof Error ? err.message : 'Gagal mengonfirmasi Hari Tanpa Jajan.');
    }
  };

  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    setCatError(null);
    try {
      onCommit(
        addCategoryAction(state, {
          name: catName,
          type: catType,
          classification: catType === 'income' ? 'income' : catClass,
          weeklyLimit: Number(catWeekly) || 0,
        })
      );
      setCatName('');
      setCatWeekly('0');
      setShowNewCat(false);
    } catch (err) {
      setCatError(err instanceof Error ? err.message : 'Gagal menambahkan kategori.');
    }
  };

  const selectedDayInfo = snapshot.noSpendStats.daysStatus.find((d) => d.date === noSpendDate);
  const budgetAuditLogs = (state.changeLogs ?? []).filter(
    (l) => l.entityType === 'budget' || l.entityType === 'allocation' || l.entityType === 'category'
  );
  const visibleCats = state.categories.filter((c) => (showArchivedCats ? true : !c.isArchived));

  return (
    <div className="space-y-6">
      {/* Multi-period budgets */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-sm font-bold text-slate-900">
            Ringkasan Batas Anggaran Multi-Periode
          </h2>
          {onOpenSimulator && (
            <button
              type="button"
              onClick={onOpenSimulator}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-1.5 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9]"
            >
              <Calculator className="w-3.5 h-3.5" />
              <span>Simulasi Dampak Pengeluaran</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[snapshot.dailyBudget, snapshot.weeklyBudget, snapshot.monthlyBudget].map((b) => {
            const barColor =
              b.level === 'critical' || b.level === 'recovery_alert'
                ? 'bg-red-600'
                : b.level === 'warning'
                ? 'bg-amber-500'
                : 'bg-[#0C8FC5]';

            return (
              <div key={b.period} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-bold text-slate-900">{b.label}</h3>
                  <span className="text-xs font-semibold text-slate-500 font-mono-num">
                    {b.utilizationPct}%
                  </span>
                </div>
                <p className="font-mono-num text-2xl font-extrabold text-slate-900">
                  {formatIDR(b.discretionarySpent)}
                  <span className="text-xs font-normal text-slate-500"> / {formatIDR(b.limit)}</span>
                </p>
                <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${barColor}`}
                    style={{ width: `${Math.min(100, b.utilizationPct)}%` }}
                  />
                </div>
                <div className="text-xs text-slate-600 space-y-1 pt-1">
                  <div className="flex justify-between">
                    <span>Batas Dinamis Aman:</span>
                    <span className="font-mono-num font-semibold text-[#0976A6]">
                      {formatIDR(b.dynamicSafeLimit)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Belanja Esensial (Terpisah):</span>
                    <span className="font-mono-num font-semibold">{formatIDR(b.essentialSpent)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Consumptive Behavior Evaluation (Cigarettes, Hangouts, Snacks) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-sm font-bold text-slate-900">
            Evaluasi Perilaku Konsumtif Aktual (Rokok, Nongkrong & Jajan)
          </h2>
          <span className="text-xs text-slate-600">
            Porsi belanja konsumtif bulan ini:{' '}
            <strong className="font-mono-num text-slate-900">{snapshot.discretionarySharePct}%</strong> dari total pengeluaran
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-50 text-red-700">
                  <Cigarette className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">Rokok</h3>
                  <p className="text-[11px] text-slate-500">
                    {snapshot.cigaretteAnalysis.purchaseCountThisMonth}x transaksi bulan ini
                  </p>
                </div>
              </div>
              <span
                className={`text-xs font-bold ${
                  snapshot.cigaretteAnalysis.level === 'critical' ||
                  snapshot.cigaretteAnalysis.level === 'recovery_alert'
                    ? 'text-red-700'
                    : snapshot.cigaretteAnalysis.level === 'warning'
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {snapshot.cigaretteAnalysis.level === 'normal'
                  ? 'Terkendali'
                  : snapshot.cigaretteAnalysis.level === 'warning'
                  ? 'Mendekati Batas'
                  : 'Melebihi Batas'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Minggu Ini / Batas</span>
                <span className="font-mono-num font-bold text-slate-900">
                  {formatIDR(snapshot.cigaretteAnalysis.weeklySpent)} /{' '}
                  {formatIDR(snapshot.cigaretteAnalysis.weeklyLimit)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Total Bulan Ini</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(snapshot.cigaretteAnalysis.monthlySpent)}
                </span>
              </div>
              <div className="rounded-xl bg-emerald-50 p-2.5 text-[11px] text-emerald-900">
                Hemat 50%:{' '}
                <strong className="font-mono-num">
                  {formatIDR(snapshot.cigaretteAnalysis.potentialMonthlySavings50Pct)}/bln
                </strong>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                  <Coffee className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">Nongkrong</h3>
                  <p className="text-[11px] text-slate-500">
                    {snapshot.hangoutAnalysis.frequencyThisMonth}x sesi bulan ini
                  </p>
                </div>
              </div>
              <span
                className={`text-xs font-bold ${
                  snapshot.hangoutAnalysis.level === 'critical' ||
                  snapshot.hangoutAnalysis.level === 'recovery_alert'
                    ? 'text-red-700'
                    : snapshot.hangoutAnalysis.level === 'warning'
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {snapshot.hangoutAnalysis.level === 'normal' ? 'Terkendali' : 'Waspada'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Minggu Ini / Batas</span>
                <span className="font-mono-num font-bold text-slate-900">
                  {formatIDR(snapshot.hangoutAnalysis.weeklySpent)} /{' '}
                  {formatIDR(snapshot.hangoutAnalysis.weeklyLimit)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Total Bulan Ini</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(snapshot.hangoutAnalysis.monthlySpent)}
                </span>
              </div>
              <div className="rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-700">
                Rata-rata per nongkrong:{' '}
                <strong className="font-mono-num">
                  {formatIDR(snapshot.hangoutAnalysis.avgPerSession)}
                </strong>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#E8F6FC] text-[#0976A6]">
                  <ShoppingBag className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">Jajan & Lainnya</h3>
                  <p className="text-[11px] text-slate-500">
                    {snapshot.snackAnalysis.frequencyThisMonth}x transaksi bulan ini
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Minggu Ini vs Lalu</span>
                <span className="font-mono-num font-bold text-slate-900">
                  {formatIDR(snapshot.snackAnalysis.weeklySpent)} /{' '}
                  {formatIDR(snapshot.snackAnalysis.prevWeekSpent)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Total Bulan Ini</span>
                <span className="font-mono-num font-bold">
                  {formatIDR(snapshot.snackAnalysis.monthlySpent)}
                </span>
              </div>
              <div className="rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-700">
                Rata-rata per jajan:{' '}
                <strong className="font-mono-num">
                  {formatIDR(snapshot.snackAnalysis.avgPerPurchase)}
                </strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Manual No-Spend Day Tracker */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <CalendarCheck2 className="w-5 h-5 text-[#0976A6]" />
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Hari Tanpa Jajan (No-Spend Day) — Konfirmasi Manual Wajib
              </h3>
              <p className="text-xs text-slate-500">
                Periode berjalan: <strong>{snapshot.noSpendStats.periodLabel}</strong> · Tidak otomatis terhitung hanya karena 0 transaksi.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono-num font-bold text-slate-900">
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <Flame className="w-4 h-4" />
              Minggu: {snapshot.noSpendStats.weeklyNoSpendDays}/{snapshot.noSpendStats.weeklyTotalDaysElapsed}
            </span>
            <span>·</span>
            <span>
              Bulan: {snapshot.noSpendStats.monthlyNoSpendDays}/{snapshot.noSpendStats.monthlyTotalDaysElapsed} sah
            </span>
            <span className="text-slate-400">
              ({snapshot.noSpendStats.invalidatedDaysCount} jajan, {snapshot.noSpendStats.unconfirmedDaysCount} belum)
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
            <div className="sm:col-span-3">
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Pilih Tanggal (Maks. Hari Ini)
              </label>
              <input
                type="date"
                max={snapshot.nowISO}
                value={noSpendDate}
                onChange={(e) => {
                  setNoSpendDate(e.target.value);
                  setNoSpendError(null);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              />
            </div>
            <div className="sm:col-span-5">
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Catatan Refleksi (Opsional)
              </label>
              <input
                type="text"
                value={noSpendNote}
                onChange={(e) => setNoSpendNote(e.target.value)}
                placeholder="Misal: Bawa bekal, tidak jajan di luar"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              />
            </div>
            <div className="sm:col-span-4 flex items-end gap-2 pt-4 sm:pt-5">
              {selectedDayInfo?.status === 'confirmed' ? (
                <button
                  type="button"
                  onClick={() => onCommit(revokeNoSpendDayAction(state, noSpendDate))}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Batalkan Konfirmasi</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleConfirmNoSpend(noSpendDate)}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Konfirmasi Bebas Jajan</span>
                </button>
              )}
            </div>
          </div>

          {selectedDayInfo ? (
            <p className="text-xs text-slate-600">
              Status tanggal <strong>{formatDateID(noSpendDate)}</strong>:{' '}
              {selectedDayInfo.status === 'confirmed' ? (
                <span className="font-semibold text-emerald-700">
                  Terkonfirmasi Sah (Bebas Jajan)
                </span>
              ) : selectedDayInfo.status === 'invalidated' ? (
                <span className="font-semibold text-red-700">
                  Tidak Sah — terdapat pengeluaran konsumtif {formatIDR(selectedDayInfo.discretionaryTotal)}
                </span>
              ) : (
                <span className="font-semibold text-slate-700">
                  Belum Dikonfirmasi (tidak otomatis dihitung)
                </span>
              )}
            </p>
          ) : (
            noSpendDate > snapshot.nowISO && (
              <p className="text-xs font-semibold text-red-700">
                Tanggal mendatang ({formatDateID(noSpendDate)}) tidak dapat dikonfirmasi sebagai Hari Tanpa Jajan.
              </p>
            )
          )}

          {noSpendError && (
            <p className="text-xs font-semibold text-red-700">{noSpendError}</p>
          )}
        </div>

        <div className="grid grid-cols-7 sm:grid-cols-10 lg:grid-cols-[repeat(15,minmax(0,1fr))] gap-2">
          {snapshot.noSpendStats.daysStatus.map((d) => {
            const dayNum = d.date.slice(8, 10);
            const cls =
              d.status === 'confirmed'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : d.status === 'invalidated'
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-slate-200 bg-slate-50 text-slate-500';
            const label =
              d.status === 'confirmed'
                ? 'Sah'
                : d.status === 'invalidated'
                ? 'Jajan'
                : 'Belum';

            return (
              <button
                key={d.date}
                type="button"
                onClick={() => setNoSpendDate(d.date)}
                title={`${d.date}: ${label}`}
                className={`rounded-xl border p-2 text-center transition-colors ${cls} ${
                  noSpendDate === d.date ? 'ring-2 ring-[#0C8FC5]' : ''
                }`}
              >
                <p className="font-mono-num text-xs font-bold">{dayNum}</p>
                <p className="text-[10px] mt-0.5 truncate">{label}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Edit Budget Limits Inline */}
      <form
        onSubmit={handleSaveLimits}
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900">
              Ubah Batas Anggaran Anda
            </h3>
            <p className="text-xs text-slate-500">
              Perubahan batas berlaku mulai saat ini dan tercatat di audit tanpa memanipulasi transaksi historis.
            </p>
          </div>
          {savedToast && (
            <span className="text-xs font-semibold text-emerald-700">Batas berhasil disimpan</span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              Rokok / Minggu
            </label>
            <input
              type="number"
              min={0}
              step={5000}
              value={cigLimit}
              onChange={(e) => setCigLimit(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              Nongkrong / Minggu
            </label>
            <input
              type="number"
              min={0}
              step={5000}
              value={hangLimit}
              onChange={(e) => setHangLimit(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              Konsumtif Harian
            </label>
            <input
              type="number"
              min={0}
              step={5000}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              Konsumtif Mingguan
            </label>
            <input
              type="number"
              min={0}
              step={10000}
              value={weeklyLimit}
              onChange={(e) => setWeeklyLimit(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              Konsumtif Bulanan
            </label>
            <input
              type="number"
              min={0}
              step={25000}
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-[#0976A6] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[42px]"
          >
            <Save className="w-4 h-4" />
            <span>Simpan Perubahan Batas</span>
          </button>
        </div>
      </form>

      {/* Category Management & General Long-Term Presets */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900">
              Manajemen Kategori & Preset Keuangan Umum
            </h3>
            <p className="text-xs text-slate-500">
              Tambah kategori khusus (mis. sewa/kos, gaji, listrik, pajak, BPJS) atau pasang preset jangka panjang sekaligus.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onCommit(installGeneralPresetCategoriesAction(state))}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-2 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9]"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Pasang Preset Umum</span>
            </button>
            <button
              type="button"
              onClick={() => setShowArchivedCats((v) => !v)}
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
            >
              {showArchivedCats ? 'Aktif Saja' : 'Tampilkan Arsip'}
            </button>
            <button
              type="button"
              onClick={() => setShowNewCat((v) => !v)}
              className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Kategori Baru</span>
            </button>
          </div>
        </div>

        {catError && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {catError}
          </p>
        )}

        {showNewCat && (
          <form
            onSubmit={handleAddCategory}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs"
          >
            <input
              type="text"
              required
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              placeholder="Nama Kategori"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            />
            <select
              value={catType}
              onChange={(e) => setCatType(e.target.value as 'expense' | 'income')}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="expense">Pengeluaran</option>
              <option value="income">Pemasukan</option>
            </select>
            {catType === 'expense' ? (
              <select
                value={catClass}
                onChange={(e) => setCatClass(e.target.value as CategoryClassification)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                <option value="essential">Esensial (Kebutuhan Pokok)</option>
                <option value="discretionary">Konsumtif (Terkontrol)</option>
                <option value="obligation">Kewajiban / Tagihan</option>
              </select>
            ) : (
              <input
                type="text"
                disabled
                value="Klasifikasi: Pemasukan"
                className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-slate-500"
              />
            )}
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                value={catWeekly}
                onChange={(e) => setCatWeekly(e.target.value)}
                placeholder="Batas/mgg (Rp)"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#0976A6] px-3 py-2 font-semibold text-white shrink-0"
              >
                Simpan
              </button>
            </div>
          </form>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
          {visibleCats.map((cat) => (
            <div
              key={cat.id}
              className={`rounded-xl border p-3 flex items-center justify-between gap-2 ${
                cat.isArchived ? 'border-slate-200 bg-slate-50 opacity-65' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 truncate">{cat.name}</p>
                <p className="text-[11px] text-slate-500">
                  {cat.type === 'income' ? 'Pemasukan' : `Keluar (${cat.classification})`}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {cat.type === 'expense' && (
                  <input
                    type="number"
                    min={0}
                    step={5000}
                    defaultValue={cat.weeklyLimit}
                    onBlur={(e) => {
                      const val = Math.max(0, Number(e.target.value) || 0);
                      if (val !== cat.weeklyLimit) {
                        onCommit(editCategoryAction(state, cat.id, { weeklyLimit: val }));
                      }
                    }}
                    title="Batas mingguan (Rp) — ubah lalu keluar fokus untuk simpan"
                    className="w-20 rounded border border-slate-200 px-2 py-1 text-right font-mono-num"
                  />
                )}
                {!cat.isSystem && (
                  <button
                    type="button"
                    onClick={() => onCommit(archiveCategoryAction(state, cat.id))}
                    className="p-1.5 rounded border border-slate-200 text-slate-500 hover:text-slate-800"
                    title={cat.isArchived ? 'Pulihkan kategori' : 'Arsipkan kategori'}
                  >
                    {cat.isArchived ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Budget & Category Audit History */}
      {budgetAuditLogs.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2.5">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-[#0976A6]" />
            <h3 className="font-display text-sm font-bold text-slate-900">
              Riwayat Perubahan Batas & Kategori ({budgetAuditLogs.length})
            </h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto text-xs">
            {budgetAuditLogs.slice(0, 12).map((l) => (
              <div key={l.id} className="py-2 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-800">{l.summary}</p>
                  {l.beforeValue && l.afterValue && (
                    <p className="text-[11px] text-slate-500">
                      {l.beforeValue} → {l.afterValue}
                    </p>
                  )}
                </div>
                <span className="text-[11px] text-slate-400 font-mono-num shrink-0">
                  {new Date(l.timestamp).toLocaleDateString('id-ID')}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
