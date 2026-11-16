import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  CloudOff,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogOut,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import {
  changePinWithCurrentPin,
  regenerateLocalRecoveryKey,
  resetPinWithPassword,
  updateSecurityPreferences,
} from '../services/authService';
import {
  createBackupPayload,
  parseAndValidateBackupJSON,
  SyncStatus,
} from '../services/financeRepository';
import { AuthSession, AuthUserSummary, FinanceState } from '../types/finance';
import { PWAInstallButton } from './PWAInstallBanner';

interface SettingsViewProps {
  state: FinanceState;
  session: AuthSession;
  authUser: AuthUserSummary;
  syncStatus: SyncStatus;
  isSupabaseConfigured: boolean;
  onOpenWizard: () => void;
  onRestoreState: (restored: FinanceState) => void;
  onCommit: (next: FinanceState) => void;
  onResetData: () => void;
  onLockNow: () => void;
  onLogout: () => void;
  onRefreshAuthUser: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  state,
  session,
  authUser,
  syncStatus,
  isSupabaseConfigured,
  onOpenWizard,
  onRestoreState,
  onResetData,
  onLockNow,
  onLogout,
  onRefreshAuthUser,
}) => {
  const [confirmReset, setConfirmReset] = useState(false);

  // Unified 6-digit PIN & Session Security state
  const [pinSubMode, setPinSubMode] = useState<'change' | 'reset_with_pwd'>(
    authUser.pinConfigured ? 'change' : 'reset_with_pwd'
  );
  const [currentPin, setCurrentPin] = useState('');
  const [verifyPwd, setVerifyPwd] = useState('');
  const [showVerifyPwd, setShowVerifyPwd] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinSaving, setPinSaving] = useState(false);

  // Local Recovery Key regeneration
  const [regenPwd, setRegenPwd] = useState('');
  const [showRegenPwd, setShowRegenPwd] = useState(false);
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [recoveryErr, setRecoveryErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Backup & Restore state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<FinanceState | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  const handleTogglePinEnabled = async () => {
    setPinErr(null);
    setPinMsg(null);
    try {
      const nextEnabled = !authUser.pinEnabled;
      await updateSecurityPreferences(session, { pinEnabled: nextEnabled });
      onRefreshAuthUser();
      setPinMsg(
        nextEnabled
          ? 'Kunci PIN 6 digit berhasil diaktifkan.'
          : 'Kunci PIN cepat dinonaktifkan. Anda tetap terlindungi oleh login username & password.'
      );
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Gagal mengubah status PIN.');
    }
  };

  const handleToggleRequirePinOnReopen = async () => {
    setPinErr(null);
    setPinMsg(null);
    try {
      await updateSecurityPreferences(session, {
        requirePinOnReopen: !authUser.requirePinOnReopen,
      });
      onRefreshAuthUser();
      setPinMsg(
        !authUser.requirePinOnReopen
          ? 'Aplikasi akan meminta PIN setiap kali dibuka kembali.'
          : 'Permintaan PIN saat aplikasi dibuka kembali dimatikan (kunci otomatis/manual tetap tersedia).'
      );
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Gagal memperbarui pengaturan buka ulang.');
    }
  };

  const handleAutoLockChange = async (minutes: number) => {
    setPinErr(null);
    setPinMsg(null);
    try {
      await updateSecurityPreferences(session, { autoLockMinutes: minutes });
      onRefreshAuthUser();
      setPinMsg(
        minutes === 0
          ? 'Kunci otomatis saat tidak aktif dimatikan.'
          : `Kunci otomatis diatur ke ${minutes} menit tanpa aktivitas.`
      );
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Gagal memperbarui waktu kunci otomatis.');
    }
  };

  const handlePinFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinErr(null);
    setPinMsg(null);
    setPinSaving(true);
    try {
      if (pinSubMode === 'change' && authUser.pinConfigured) {
        await changePinWithCurrentPin(session, {
          currentPin,
          newPin,
          confirmPin,
        });
        setPinMsg('PIN 6 digit berhasil diperbarui.');
      } else {
        await resetPinWithPassword(session, {
          password: verifyPwd,
          newPin,
          confirmPin,
        });
        setPinMsg('PIN 6 digit baru berhasil disimpan dan diaktifkan.');
      }
      setCurrentPin('');
      setVerifyPwd('');
      setNewPin('');
      setConfirmPin('');
      setPinSubMode('change');
      onRefreshAuthUser();
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Gagal memperbarui PIN.');
    } finally {
      setPinSaving(false);
    }
  };

  const handleRegenerateRecoveryKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryErr(null);
    setNewRecoveryKey(null);
    try {
      const key = await regenerateLocalRecoveryKey(session, regenPwd);
      setNewRecoveryKey(key);
      setRegenPwd('');
    } catch (err) {
      setRecoveryErr(err instanceof Error ? err.message : 'Gagal membuat ulang kode pemulihan.');
    }
  };

  const handleCopyKey = async () => {
    if (!newRecoveryKey) return;
    try {
      await navigator.clipboard.writeText(newRecoveryKey);
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // ignore if clipboard blocked
    }
  };

  const handleExportJSON = () => {
    const payload = createBackupPayload(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `varafinance-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSelectRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setRestoreError(null);
    setRestoreSuccess(null);
    setPendingRestore(null);
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const validated = parseAndValidateBackupJSON(text);
      setPendingRestore(validated);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Gagal membaca berkas backup.');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleConfirmRestore = () => {
    if (!pendingRestore) return;
    onRestoreState(pendingRestore);
    setRestoreSuccess(
      `Data berhasil dipulihkan (${pendingRestore.accounts.length} akun, ${pendingRestore.transactions.length} transaksi, ${pendingRestore.obligations.length} kewajiban).`
    );
    setPendingRestore(null);
  };

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Configuration Wizard Trigger */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900">
            Aturan Batas Anggaran &amp; Persentase Alokasi
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Ubah batas rokok, nongkrong, kebutuhan pokok, target dana darurat, serta persentase distribusi pemasukan rutin &amp; freelance.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenWizard}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#075D83] shrink-0 min-h-[42px]"
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span>Buka Konfigurasi Lengkap</span>
        </button>
      </section>

      {/* Unified Account, Session, Auto-Lock & 6-Digit PIN Security */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#E8F6FC] text-[#0976A6] flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                Keamanan Akun, Sesi &amp; PIN 6 Digit
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Akun aktif: <strong className="text-slate-900">{authUser.username}</strong>
                <span aria-hidden="true"> · </span>
                <span>
                  {authUser.mode === 'cloud' ? 'Cloud Supabase' : 'Mode Lokal (PBKDF2-SHA256)'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {authUser.pinEnabled && (
              <button
                type="button"
                onClick={onLockNow}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3.5 py-2 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9] min-h-[40px]"
              >
                <Lock className="w-4 h-4" />
                <span>Kunci Sekarang</span>
              </button>
            )}
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 min-h-[40px]"
            >
              <LogOut className="w-4 h-4" />
              <span>Keluar (Logout)</span>
            </button>
          </div>
        </div>

        {/* Session & Device Lock Toggles */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-slate-900">PIN Buka Cepat (6 Digit)</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {authUser.pinEnabled ? 'Aktif' : 'Nonaktif'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleTogglePinEnabled}
              disabled={!authUser.pinConfigured}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                authUser.pinEnabled
                  ? 'bg-[#0976A6] text-white hover:bg-[#075D83]'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
              } disabled:opacity-50`}
            >
              {authUser.pinEnabled ? 'Aktif' : 'Aktifkan'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-slate-900">Minta PIN Saat Dibuka</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Sesi tetap valid tanpa login ulang
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleRequirePinOnReopen}
              disabled={!authUser.pinEnabled}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                authUser.requirePinOnReopen && authUser.pinEnabled
                  ? 'bg-[#0976A6] text-white hover:bg-[#075D83]'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
              } disabled:opacity-50`}
            >
              {authUser.requirePinOnReopen ? 'Ya' : 'Tidak'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-slate-900">Kunci Otomatis Idle</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Saat aplikasi tidak aktif</p>
            </div>
            <select
              aria-label="Durasi kunci otomatis saat tidak aktif"
              value={authUser.autoLockMinutes}
              disabled={!authUser.pinEnabled}
              onChange={(e) => handleAutoLockChange(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 disabled:opacity-50 min-h-[36px]"
            >
              <option value={0}>Nonaktif</option>
              <option value={1}>1 menit</option>
              <option value={5}>5 menit</option>
              <option value={15}>15 menit</option>
              <option value={30}>30 menit</option>
            </select>
          </div>
        </div>

        {/* Change / Reset 6-Digit PIN Form */}
        <div className="pt-2 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold text-slate-800">
              {authUser.pinConfigured ? 'Ubah atau Reset PIN 6 Digit' : 'Atur PIN 6 Digit'}
            </h3>
            {authUser.pinConfigured && (
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => {
                    setPinSubMode('change');
                    setPinErr(null);
                    setPinMsg(null);
                  }}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-md ${
                    pinSubMode === 'change'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600'
                  }`}
                >
                  Pakai PIN Lama
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPinSubMode('reset_with_pwd');
                    setPinErr(null);
                    setPinMsg(null);
                  }}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-md ${
                    pinSubMode === 'reset_with_pwd'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600'
                  }`}
                >
                  Lupa PIN (Verifikasi Password)
                </button>
              </div>
            )}
          </div>

          <form
            onSubmit={handlePinFormSubmit}
            className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            {pinSubMode === 'change' && authUser.pinConfigured ? (
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  PIN Saat Ini (6 digit)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono-num tracking-widest min-h-[42px]"
                />
              </div>
            ) : (
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Verifikasi Password Akun
                </label>
                <div className="relative">
                  <input
                    type={showVerifyPwd ? 'text' : 'password'}
                    required
                    value={verifyPwd}
                    onChange={(e) => setVerifyPwd(e.target.value)}
                    placeholder="Password akun"
                    className="w-full rounded-xl border border-slate-300 pl-3.5 pr-9 py-2 text-sm min-h-[42px]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowVerifyPwd((v) => !v)}
                    aria-label={showVerifyPwd ? 'Sembunyikan password' : 'Tampilkan password'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-slate-500"
                  >
                    {showVerifyPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                PIN Baru (6 digit angka)
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono-num tracking-widest min-h-[42px]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Konfirmasi PIN Baru
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono-num tracking-widest min-h-[42px]"
              />
            </div>

            <button
              type="submit"
              disabled={pinSaving}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 min-h-[42px]"
            >
              {pinSaving ? 'Menyimpan...' : 'Simpan PIN 6 Digit'}
            </button>
          </form>

          {pinErr && (
            <p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              {pinErr}
            </p>
          )}
          {pinMsg && (
            <p className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
              {pinMsg}
            </p>
          )}
        </div>

        {/* Recovery Key Regeneration (Local Mode) */}
        {authUser.mode === 'local' && (
          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div className="flex items-start gap-2.5">
              <KeyRound className="w-4 h-4 text-[#0976A6] shrink-0 mt-0.5" />
              <div>
                <h3 className="text-xs font-bold text-slate-800">
                  Buat Ulang Kode Pemulihan Password (Mode Lokal)
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Jika Anda kehilangan Kode Pemulihan lama saat masih login, verifikasi password Anda untuk membuat kode baru (kode lama otomatis tidak berlaku).
                </p>
              </div>
            </div>

            <form
              onSubmit={handleRegenerateRecoveryKey}
              className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center"
            >
              <div className="relative flex-1 max-w-xs">
                <input
                  type={showRegenPwd ? 'text' : 'password'}
                  required
                  value={regenPwd}
                  onChange={(e) => setRegenPwd(e.target.value)}
                  placeholder="Masukkan password akun Anda"
                  className="w-full rounded-xl border border-slate-300 pl-3.5 pr-9 py-2 text-xs min-h-[40px]"
                />
                <button
                  type="button"
                  onClick={() => setShowRegenPwd((v) => !v)}
                  aria-label={showRegenPwd ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-slate-500"
                >
                  {showRegenPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button
                type="submit"
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 min-h-[40px]"
              >
                Terbitkan Kode Pemulihan Baru
              </button>
            </form>

            {recoveryErr && (
              <p className="text-xs font-semibold text-red-700">{recoveryErr}</p>
            )}
            {newRecoveryKey && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-amber-950">
                  <span className="font-semibold block">Kode Pemulihan Baru (simpan sekarang):</span>
                  <code className="font-mono-num text-sm font-bold tracking-wider">
                    {newRecoveryKey}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={handleCopyKey}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-950"
                >
                  {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedKey ? 'Tersalin' : 'Salin'}</span>
                </button>
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-slate-500">
          Catatan: Logout hanya mengakhiri sesi di perangkat ini dan <strong>tidak menghapus</strong> data transaksi, akun, utang, maupun target tabungan Anda. Perangkat baru selalu diwajibkan login dengan username dan password.
        </p>
      </section>

      {/* Supabase Cloud Sync Status */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex items-center gap-2.5">
          {syncStatus.mode === 'cloud' ? (
            <Cloud className="w-5 h-5 text-emerald-700" />
          ) : (
            <CloudOff className="w-5 h-5 text-amber-700" />
          )}
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              Status Penyimpanan &amp; Sinkronisasi Cloud
            </h2>
            <p className="text-xs text-slate-600">
              Status saat ini:{' '}
              <strong>
                {syncStatus.mode === 'cloud'
                  ? `Terhubung ke Supabase (${syncStatus.authenticatedEmail})`
                  : 'Mode Lokal (Offline-First di Perangkat)'}
              </strong>
            </p>
          </div>
        </div>

        {!isSupabaseConfigured ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 space-y-2">
            <p className="font-bold">
              Kredensial Supabase belum dikonfigurasi pada environment saat ini.
            </p>
            <p>
              Aplikasi berjalan lokal di perangkat Anda dengan isolasi data per akun serta hash kredensial PBKDF2-SHA256. Untuk mengaktifkan autentikasi &amp; sinkronisasi cloud multi-perangkat dengan Row Level Security:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                Jalankan skrip migrasi SQL berurutan pada Supabase:{' '}
                <code>0001_initial_schema.sql</code>,{' '}
                <code>0002_long_term_obligations_and_calendar.sql</code>,{' '}
                <code>0003_audit_and_long_term_readiness.sql</code>, dan{' '}
                <code>0004_user_profiles_auth_pin.sql</code>.
              </li>
              <li>
                Salin <code>VITE_SUPABASE_URL</code> dan <code>VITE_SUPABASE_ANON_KEY</code> ke file <code>.env</code>.
              </li>
              <li>Restart dev server atau rebuild aplikasi web/APK.</li>
            </ol>
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-950">
            <p className="font-semibold">
              Sinkronisasi Supabase aktif untuk {syncStatus.authenticatedEmail || authUser.username}.
            </p>
            {syncStatus.lastSyncedAt && (
              <p className="mt-0.5">
                Sinkronisasi terakhir: {new Date(syncStatus.lastSyncedAt).toLocaleString('id-ID')}
              </p>
            )}
          </div>
        )}
      </section>

      {/* PWA, Backup, Restore & Reset */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900">
            Aplikasi Perangkat, Backup &amp; Pemulihan Data
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Ekspor seluruh data ke berkas JSON (kompatibel lintas versi v1–v3) atau pulihkan cadangan kapan saja tanpa kehilangan riwayat.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PWAInstallButton />

          <button
            type="button"
            onClick={handleExportJSON}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
          >
            <Download className="w-4 h-4" />
            <span>Ekspor Backup JSON</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleSelectRestoreFile}
            className="hidden"
            aria-label="Pilih file backup JSON"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-4 py-2.5 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9] min-h-[40px]"
          >
            <Upload className="w-4 h-4" />
            <span>Pulihkan / Impor Backup JSON</span>
          </button>

          {!confirmReset ? (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-100 min-h-[40px]"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Reset ke Kondisi Awal Profil</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2">
              <span className="text-xs font-semibold text-red-900">Yakin reset semua data?</span>
              <button
                type="button"
                onClick={() => {
                  onResetData();
                  setConfirmReset(false);
                }}
                className="rounded-lg bg-red-700 px-3 py-1 text-xs font-semibold text-white"
              >
                Ya, Reset
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="rounded-lg bg-white border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
              >
                Batal
              </button>
            </div>
          )}
        </div>

        {pendingRestore && (
          <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] p-4 space-y-2.5">
            <p className="text-xs font-bold text-slate-900">
              Berkas Backup Tervalidasi — Siap Dipulihkan
            </p>
            <p className="text-xs text-[#075D83]">
              Profil: <strong>{pendingRestore.settings.fullName}</strong> ·{' '}
              {pendingRestore.accounts.length} akun · {pendingRestore.transactions.length} transaksi
              · {pendingRestore.projects.length} proyek · {pendingRestore.obligations.length}{' '}
              kewajiban · {pendingRestore.goals.length} target tabungan.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleConfirmRestore}
                className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#075D83]"
              >
                Terapkan &amp; Pulihkan Data
              </button>
              <button
                type="button"
                onClick={() => setPendingRestore(null)}
                className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700"
              >
                Batal
              </button>
            </div>
          </div>
        )}

        {restoreError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{restoreError}</span>
          </div>
        )}

        {restoreSuccess && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{restoreSuccess}</span>
          </div>
        )}
      </section>
    </div>
  );
};
