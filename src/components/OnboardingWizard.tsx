import React, { useState } from 'react';
import { Check, SlidersHorizontal, ShieldAlert } from 'lucide-react';
import { AllocationRules, UserFinancialSettings } from '../types/finance';
import { formatIDR } from '../utils/format';

interface OnboardingWizardProps {
  initialSettings: UserFinancialSettings;
  onComplete: (settings: UserFinancialSettings) => void;
  onSkip?: () => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  initialSettings,
  onComplete,
  onSkip,
}) => {
  const [form, setForm] = useState<UserFinancialSettings>({ ...initialSettings });
  const [activeAllocTab, setActiveAllocTab] = useState<'allowance' | 'freelance'>('allowance');
  const [error, setError] = useState<string | null>(null);

  const currentRules =
    activeAllocTab === 'allowance'
      ? form.allowanceAllocationRules
      : form.freelanceAllocationRules;

  const totalPct = (Object.values(currentRules) as number[]).reduce((s, v) => s + v, 0);

  const updateRule = (key: keyof AllocationRules, val: number) => {
    const clean = Math.max(0, Math.min(100, Math.round(val || 0)));
    if (activeAllocTab === 'allowance') {
      setForm((prev) => ({
        ...prev,
        allowanceAllocationRules: { ...prev.allowanceAllocationRules, [key]: clean },
      }));
    } else {
      setForm((prev) => ({
        ...prev,
        freelanceAllocationRules: { ...prev.freelanceAllocationRules, [key]: clean },
      }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const allowanceSum = (Object.values(form.allowanceAllocationRules) as number[]).reduce(
      (s, v) => s + v,
      0
    );
    const freelanceSum = (Object.values(form.freelanceAllocationRules) as number[]).reduce(
      (s, v) => s + v,
      0
    );
    if (allowanceSum !== 100) {
      setActiveAllocTab('allowance');
      setError(`Total persentase alokasi Pemasukan Rutin harus 100% (saat ini ${allowanceSum}%).`);
      return;
    }
    if (freelanceSum !== 100) {
      setActiveAllocTab('freelance');
      setError(`Total persentase alokasi Profit Freelance/Usaha harus 100% (saat ini ${freelanceSum}%).`);
      return;
    }
    setError(null);
    onComplete({ ...form, onboardingCompleted: true });
  };

  const allocFields: { key: keyof AllocationRules; label: string }[] = [
    { key: 'obligations', label: 'Kewajiban & Tagihan Rutin' },
    { key: 'debt', label: 'Pelunasan Utang' },
    { key: 'essential', label: 'Cadangan Kebutuhan Pokok' },
    { key: 'emergency', label: 'Dana Darurat' },
    { key: 'personal_savings', label: 'Tabungan Pribadi' },
    { key: 'business', label: 'Dana Pengembangan Bisnis' },
    { key: 'investment', label: 'Dana Investasi' },
    { key: 'discretionary', label: 'Jajan / Hiburan / Rokok' },
  ];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 sm:p-6 backdrop-blur-xs">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden my-4">
        <div className="border-b border-slate-200 px-6 py-5 bg-slate-50">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0976A6] text-white shrink-0">
                <SlidersHorizontal className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Konfigurasi Profil & Disiplin Finansial
                </h2>
                <p className="text-xs text-slate-600">
                  Sesuaikan batas anggaran, aturan alokasi, dan target untuk penggunaan jangka panjang.
                </p>
              </div>
            </div>
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-1"
              >
                Tutup
              </button>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Profil Awal Bawaan yang Dapat Disesuaikan */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-950 space-y-1">
                <p className="font-semibold">Titik Awal Tersedia & Fleksibel Jangka Panjang:</p>
                <p>
                  Profil awal dimulai dengan saldo kas Rp0, satu utang awal Rp27.000 (tanpa jatuh tempo otomatis), dan satu kewajiban sementara KKN Rp30.000/minggu. Anda dapat mengubah kewajiban, kategori umum (gaji, kos/sewa, tagihan, pajak), serta akun kapan saja.
                </p>
              </div>
            </div>
          </div>

          {/* Nama & Batas Anggaran */}
          <div className="space-y-4">
            <h3 className="font-display text-sm font-bold text-slate-900">
              1. Batas Pengeluaran Konsumtif & Anggaran Pribadi
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Nama Pengguna
                </label>
                <input
                  type="text"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Batas Mingguan Rokok (IDR)
                </label>
                <input
                  type="number"
                  min={0}
                  step={5000}
                  value={form.cigaretteWeeklyLimit}
                  onChange={(e) =>
                    setForm({ ...form, cigaretteWeeklyLimit: Number(e.target.value) || 0 })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Saat ini: {formatIDR(form.cigaretteWeeklyLimit)}/minggu
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Batas Mingguan Nongkrong & Sosial (IDR)
                </label>
                <input
                  type="number"
                  min={0}
                  step={5000}
                  value={form.hangoutWeeklyLimit}
                  onChange={(e) =>
                    setForm({ ...form, hangoutWeeklyLimit: Number(e.target.value) || 0 })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Batas Belanja Konsumtif Harian (IDR)
                </label>
                <input
                  type="number"
                  min={0}
                  step={5000}
                  value={form.dailyBudgetLimit}
                  onChange={(e) =>
                    setForm({ ...form, dailyBudgetLimit: Number(e.target.value) || 0 })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Batas Belanja Mingguan & Bulanan (IDR)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    step={10000}
                    value={form.weeklyBudgetLimit}
                    onChange={(e) =>
                      setForm({ ...form, weeklyBudgetLimit: Number(e.target.value) || 0 })
                    }
                    placeholder="Mingguan"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                  />
                  <input
                    type="number"
                    min={0}
                    step={25000}
                    value={form.monthlyBudgetLimit}
                    onChange={(e) =>
                      setForm({ ...form, monthlyBudgetLimit: Number(e.target.value) || 0 })
                    }
                    placeholder="Bulanan"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Cadangan Kebutuhan Pokok & Target Dana Darurat
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    step={10000}
                    value={form.essentialReserveTarget}
                    onChange={(e) =>
                      setForm({ ...form, essentialReserveTarget: Number(e.target.value) || 0 })
                    }
                    title="Cadangan Kebutuhan Pokok"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                  />
                  <input
                    type="number"
                    min={0}
                    step={50000}
                    value={form.emergencyFundTarget}
                    onChange={(e) =>
                      setForm({ ...form, emergencyFundTarget: Number(e.target.value) || 0 })
                    }
                    title="Target Dana Darurat"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Persentase Alokasi Pemasukan */}
          <div className="space-y-3 border-t border-slate-200 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-sm font-bold text-slate-900">
                2. Persentase Alokasi Pemasukan (Harus 100%)
              </h3>
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setActiveAllocTab('allowance')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    activeAllocTab === 'allowance'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Pemasukan Rutin / Saku
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAllocTab('freelance')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    activeAllocTab === 'freelance'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Net Profit Freelance / Bisnis
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {allocFields.map((f) => (
                <div key={f.key} className="rounded-xl border border-slate-200 p-2.5">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1 truncate">
                    {f.label}
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={currentRules[f.key]}
                      onChange={(e) => updateRule(f.key, Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono-num focus:border-[#0C8FC5] focus:outline-none"
                    />
                    <span className="text-xs font-semibold text-slate-500">%</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">
                Total Alokasi ({activeAllocTab === 'allowance' ? 'Pemasukan Rutin' : 'Freelance/Bisnis'}):
              </span>
              <span
                className={`font-mono-num font-bold ${
                  totalPct === 100 ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {totalPct}% {totalPct === 100 ? '(Valid)' : '(Harus tepat 100%)'}
              </span>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="submit"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] px-6 py-3 text-sm font-semibold text-white hover:bg-[#075D83] transition-colors min-h-[44px]"
            >
              <Check className="w-4 h-4" />
              <span>Simpan Konfigurasi & Mulai</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
