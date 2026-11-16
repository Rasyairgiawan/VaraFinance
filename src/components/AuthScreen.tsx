import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  User,
} from 'lucide-react';
import {
  evaluatePasswordStrength,
  hasAnyRegisteredLocalUser,
  loginWithPassword,
  recoverLocalPasswordWithKey,
  registerAccount,
  requestCloudPasswordReset,
} from '../services/authService';
import { AuthSession, AuthUserSummary } from '../types/finance';

interface AuthScreenProps {
  isSupabaseConfigured: boolean;
  onAuthenticated: (result: {
    session: AuthSession;
    user: AuthUserSummary;
    isNewRegistration?: boolean;
  }) => void;
}

type AuthTab = 'login' | 'register' | 'forgot';

export const AuthScreen: React.FC<AuthScreenProps> = ({
  isSupabaseConfigured,
  onAuthenticated,
}) => {
  const hasExistingLocal = hasAnyRegisteredLocalUser();
  const [tab, setTab] = useState<AuthTab>(
    !isSupabaseConfigured && !hasExistingLocal ? 'register' : 'login'
  );

  // Login state
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Register state
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regPin, setRegPin] = useState('');
  const [regConfirmPin, setRegConfirmPin] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [showRegPin, setShowRegPin] = useState(false);

  // Forgot password state
  const [forgotUsername, setForgotUsername] = useState('');
  const [forgotRecoveryKey, setForgotRecoveryKey] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  // Shared async / feedback state
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // Post-registration / post-recovery one-time Recovery Key screen
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
  const [pendingAuthPayload, setPendingAuthPayload] = useState<{
    session: AuthSession;
    user: AuthUserSummary;
    isNewRegistration?: boolean;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const strength = evaluatePasswordStrength(regPassword);
  const forgotStrength = evaluatePasswordStrength(forgotNewPassword);

  const switchTab = (next: AuthTab) => {
    setTab(next);
    setErrorMsg(null);
    setInfoMsg(null);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setLoading(true);
    try {
      const res = await loginWithPassword({
        username: loginUsername,
        password: loginPassword,
      });
      onAuthenticated({ session: res.session, user: res.user });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal melakukan autentikasi.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setLoading(true);
    try {
      const res = await registerAccount({
        username: regUsername,
        email: regEmail || undefined,
        password: regPassword,
        confirmPassword: regConfirmPassword,
        pin: regPin,
        confirmPin: regConfirmPin,
      });

      if (res.requiresEmailVerification) {
        setInfoMsg(
          'Akun berhasil dibuat. Periksa kotak masuk email Anda untuk memverifikasi akun sebelum masuk.'
        );
        setTab('login');
        return;
      }

      if (res.recoveryKey) {
        setPendingRecoveryKey(res.recoveryKey);
        setPendingAuthPayload({
          session: res.session,
          user: res.user,
          isNewRegistration: true,
        });
      } else {
        onAuthenticated({
          session: res.session,
          user: res.user,
          isNewRegistration: true,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat akun.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setLoading(true);
    try {
      if (isSupabaseConfigured) {
        const sentTo = await requestCloudPasswordReset(forgotUsername);
        setInfoMsg(
          `Tautan reset password telah dikirim ke ${sentTo}. Ikuti instruksi pada email Anda lalu login kembali.`
        );
      } else {
        const { newRecoveryKey } = await recoverLocalPasswordWithKey({
          username: forgotUsername,
          recoveryKey: forgotRecoveryKey,
          newPassword: forgotNewPassword,
          confirmPassword: forgotConfirmPassword,
        });
        setPendingRecoveryKey(newRecoveryKey);
        setPendingAuthPayload(null);
        setInfoMsg(
          'Password berhasil diperbarui tanpa menghapus data keuangan Anda. Simpan kode pemulihan baru di bawah ini.'
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memproses pemulihan password.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRecoveryKey = async () => {
    if (!pendingRecoveryKey) return;
    try {
      await navigator.clipboard.writeText(pendingRecoveryKey);
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // Clipboard fallback ignored if blocked in non-HTTPS iframe
    }
  };

  if (pendingRecoveryKey) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-3">
            <img
              src="/assets/aistudio/logo-white_9d5ca417.jpeg"
              alt="Logo VaraFinance"
              referrerPolicy="no-referrer"
              className="w-11 h-11 rounded-xl object-cover border border-slate-200 shrink-0"
            />
            <div>
              <h1 className="font-display text-lg font-bold text-slate-900">
                Simpan Kode Pemulihan Darurat
              </h1>
              <p className="text-xs text-slate-500">
                VaraFinance · Keamanan Akun Lokal
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 space-y-1.5">
            <p className="font-semibold">Hanya ditampilkan satu kali</p>
            <p className="leading-relaxed">
              Karena akun lokal tidak bergantung pada server pusat, kode ini satu-satunya cara untuk mereset password apabila Anda lupa di kemudian hari tanpa menghapus data keuangan.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex items-center justify-between gap-3">
            <code className="font-mono-num text-base sm:text-lg font-bold tracking-wider text-slate-900 select-all">
              {pendingRecoveryKey}
            </code>
            <button
              type="button"
              onClick={handleCopyRecoveryKey}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 shrink-0 min-h-[40px]"
            >
              {copiedKey ? (
                <>
                  <Check className="w-4 h-4 text-emerald-600" />
                  <span>Tersalin</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  <span>Salin</span>
                </>
              )}
            </button>
          </div>

          {infoMsg && (
            <p className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2.5">
              {infoMsg}
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              const payload = pendingAuthPayload;
              setPendingRecoveryKey(null);
              setPendingAuthPayload(null);
              if (payload) {
                onAuthenticated(payload);
              } else {
                setTab('login');
                setForgotRecoveryKey('');
                setForgotNewPassword('');
                setForgotConfirmPassword('');
              }
            }}
            className="w-full rounded-xl bg-[#0976A6] py-3 px-4 text-sm font-semibold text-white hover:bg-[#075D83] transition-colors min-h-[44px]"
          >
            {pendingAuthPayload
              ? 'Saya Sudah Simpan, Lanjutkan ke Aplikasi'
              : 'Kembali ke Halaman Login'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:grid lg:grid-cols-12">
      {/* Left Desktop Brand Panel */}
      <aside className="hidden lg:flex lg:col-span-5 xl:col-span-5 bg-[#0C87C0] text-white flex-col justify-between p-10 xl:p-14">
        <div className="space-y-8">
          <div className="max-w-xs">
            <img
              src="/assets/aistudio/logo-text2_5ca33bfc.jpeg"
              alt="Logo VaraFinance"
              referrerPolicy="no-referrer"
              className="w-56 h-auto object-contain rounded-xl"
            />
          </div>

          <div className="space-y-3 max-w-md">
            <h1 className="font-display text-3xl font-bold tracking-tight leading-tight text-balance">
              VaraFinance
            </h1>
            <p className="text-sm text-white/90 leading-relaxed">
              Sistem manajemen keuangan pribadi dan disiplin finansial: pisahkan uang bisnis &amp; pribadi, jaga batas anggaran rokok serta nongkrong, pantau utang dan kewajiban berkala.
            </p>
          </div>
        </div>

        <div className="space-y-4 border-t border-white/20 pt-6 max-w-md">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-white shrink-0 mt-0.5" />
            <div className="text-xs text-white/90 space-y-1">
              <p className="font-semibold text-white">Proteksi Kredensial &amp; PIN 6 Digit</p>
              <p>
                {isSupabaseConfigured
                  ? 'Terhubung dengan autentikasi Cloud Supabase & Row Level Security per pengguna, dilengkapi PIN buka cepat 6 digit.'
                  : 'Mode Lokal Offline-First: password dan PIN 6 digit disimpan menggunakan hash PBKDF2-SHA256 (bukan teks biasa) di perangkat ini.'}
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* Right Auth Form Viewport */}
      <main className="flex-1 lg:col-span-7 xl:col-span-7 flex items-center justify-center px-4 py-8 sm:px-8">
        <div className="w-full max-w-md space-y-6">
          {/* Mobile / Compact Brand Header */}
          <div className="flex items-center gap-3.5 lg:hidden">
            <img
              src="/assets/aistudio/logo-white_9d5ca417.jpeg"
              alt="Logo VaraFinance"
              referrerPolicy="no-referrer"
              className="w-12 h-12 rounded-xl object-cover border border-slate-200 bg-white shrink-0"
            />
            <div>
              <h1 className="font-display text-xl font-bold text-slate-900 leading-tight">
                VaraFinance
              </h1>
              <p className="text-xs text-slate-500">
                Personal Finance &amp; Discipline System
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
            {/* Segmented Mode Tabs */}
            {tab !== 'forgot' ? (
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => switchTab('login')}
                  className={`py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap min-h-[40px] ${
                    tab === 'login'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Masuk
                </button>
                <button
                  type="button"
                  onClick={() => switchTab('register')}
                  className={`py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap min-h-[40px] ${
                    tab === 'register'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Buat Akun Baru
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => switchTab('login')}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0976A6] hover:text-[#075D83] min-h-[40px]"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Kembali ke Login</span>
                </button>
              </div>
            )}

            {/* Heading */}
            <div className="space-y-1">
              <h2 className="font-display text-xl font-bold text-slate-900">
                {tab === 'login'
                  ? 'Masuk ke Akun Anda'
                  : tab === 'register'
                  ? 'Buat Akun & Keamanan Awal'
                  : 'Pemulihan Password'}
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                {tab === 'login'
                  ? 'Gunakan username dan password untuk mengakses catatan keuangan Anda.'
                  : tab === 'register'
                  ? 'Atur username unik, password kuat, dan PIN 6 digit untuk akses cepat.'
                  : isSupabaseConfigured
                  ? 'Masukkan username atau email terdaftar untuk menerima tautan reset password.'
                  : 'Verifikasi Kode Pemulihan darurat Anda untuk menyetel password baru tanpa menghapus data.'}
              </p>
            </div>

            {errorMsg && (
              <div
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {infoMsg && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-medium text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>{infoMsg}</span>
              </div>
            )}

            {/* LOGIN FORM */}
            {tab === 'login' && (
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="login-username"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Username{isSupabaseConfigured ? ' atau Email' : ''}
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-username"
                      type="text"
                      required
                      autoComplete="username"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder={isSupabaseConfigured ? 'username atau email' : 'Contoh: arya_pratama'}
                      className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="login-password"
                      className="block text-xs font-semibold text-slate-700"
                    >
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => switchTab('forgot')}
                      className="text-xs font-semibold text-[#0976A6] hover:text-[#075D83]"
                    >
                      Lupa Password?
                    </button>
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      required
                      autoComplete="current-password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Masukkan password"
                      className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-11 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((v) => !v)}
                      aria-label={showLoginPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[38px] min-h-[38px] flex items-center justify-center text-slate-500 hover:text-slate-800 rounded-lg"
                    >
                      {showLoginPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] py-3 px-4 text-sm font-semibold text-white hover:bg-[#075D83] disabled:opacity-60 transition-colors min-h-[46px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Memverifikasi...</span>
                    </>
                  ) : (
                    <span>Masuk</span>
                  )}
                </button>
              </form>
            )}

            {/* REGISTER FORM */}
            {tab === 'register' && (
              <form onSubmit={handleRegisterSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="reg-username"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Username Unik
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-username"
                      type="text"
                      required
                      minLength={3}
                      maxLength={24}
                      autoComplete="username"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      placeholder="huruf, angka, titik, atau _"
                      className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                  </div>
                </div>

                {isSupabaseConfigured && (
                  <div>
                    <label
                      htmlFor="reg-email"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Email Pemulihan &amp; Cloud
                    </label>
                    <input
                      id="reg-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      placeholder="nama@email.com"
                      className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                  </div>
                )}

                <div>
                  <label
                    htmlFor="reg-password"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Password (min. 8 karakter, huruf &amp; angka)
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-password"
                      type={showRegPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Buat password kuat"
                      className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-11 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowRegPassword((v) => !v)}
                      aria-label={showRegPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[38px] min-h-[38px] flex items-center justify-center text-slate-500 hover:text-slate-800 rounded-lg"
                    >
                      {showRegPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {regPassword.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="grid grid-cols-3 gap-1.5">
                        {[1, 2, 3].map((step) => (
                          <div
                            key={step}
                            className={`h-1 rounded-full transition-colors ${
                              strength.score >= step
                                ? strength.score === 3
                                  ? 'bg-emerald-600'
                                  : strength.score === 2
                                  ? 'bg-[#0C8FC5]'
                                  : 'bg-amber-500'
                                : 'bg-slate-200'
                            }`}
                          />
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Kekuatan: <strong className="text-slate-700">{strength.label}</strong>
                        {!strength.valid && strength.errors.length > 0
                          ? ` — ${strength.errors.join(' ')}`
                          : ''}
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="reg-confirm-password"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Konfirmasi Password
                  </label>
                  <input
                    id="reg-confirm-password"
                    type={showRegPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={regConfirmPassword}
                    onChange={(e) => setRegConfirmPassword(e.target.value)}
                    placeholder="Ulangi password"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                  />
                </div>

                <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="reg-pin"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      PIN Buka Cepat (6 digit)
                    </label>
                    <div className="relative">
                      <input
                        id="reg-pin"
                        type={showRegPin ? 'text' : 'password'}
                        inputMode="numeric"
                        maxLength={6}
                        required
                        value={regPin}
                        onChange={(e) => setRegPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6 digit angka"
                        className="w-full rounded-xl border border-slate-300 bg-white pl-3.5 pr-10 py-2.5 text-sm font-mono-num tracking-widest text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegPin((v) => !v)}
                        aria-label={showRegPin ? 'Sembunyikan PIN' : 'Tampilkan PIN'}
                        className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-500 hover:text-slate-800 rounded-lg"
                      >
                        {showRegPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="reg-confirm-pin"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Konfirmasi PIN 6 Digit
                    </label>
                    <input
                      id="reg-confirm-pin"
                      type={showRegPin ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={regConfirmPin}
                      onChange={(e) =>
                        setRegConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      placeholder="Ulangi PIN"
                      className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono-num tracking-widest text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] py-3 px-4 text-sm font-semibold text-white hover:bg-[#075D83] disabled:opacity-60 transition-colors min-h-[46px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Menyiapkan Keamanan...</span>
                    </>
                  ) : (
                    <span>Buat Akun &amp; Mulai</span>
                  )}
                </button>
              </form>
            )}

            {/* FORGOT PASSWORD FORM */}
            {tab === 'forgot' && (
              <form onSubmit={handleForgotSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="forgot-username"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    {isSupabaseConfigured ? 'Username atau Email Terdaftar' : 'Username Terdaftar'}
                  </label>
                  <input
                    id="forgot-username"
                    type="text"
                    required
                    value={forgotUsername}
                    onChange={(e) => setForgotUsername(e.target.value)}
                    placeholder={isSupabaseConfigured ? 'username atau email' : 'Masukkan username'}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                  />
                </div>

                {!isSupabaseConfigured && (
                  <>
                    <div>
                      <label
                        htmlFor="forgot-recovery-key"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Kode Pemulihan Darurat
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          id="forgot-recovery-key"
                          type="text"
                          required
                          value={forgotRecoveryKey}
                          onChange={(e) => setForgotRecoveryKey(e.target.value.toUpperCase())}
                          placeholder="KU-XXXX-XXXX-XXXX"
                          className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-2.5 text-sm font-mono-num uppercase text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="forgot-new-pwd"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Password Baru (min. 8 karakter, huruf &amp; angka)
                      </label>
                      <div className="relative">
                        <input
                          id="forgot-new-pwd"
                          type={showForgotPassword ? 'text' : 'password'}
                          required
                          value={forgotNewPassword}
                          onChange={(e) => setForgotNewPassword(e.target.value)}
                          placeholder="Buat password baru"
                          className="w-full rounded-xl border border-slate-300 bg-white pl-3.5 pr-11 py-2.5 text-sm text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowForgotPassword((v) => !v)}
                          aria-label={showForgotPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[38px] min-h-[38px] flex items-center justify-center text-slate-500 hover:text-slate-800 rounded-lg"
                        >
                          {showForgotPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      {forgotNewPassword.length > 0 && !forgotStrength.valid && (
                        <p className="text-[11px] text-amber-700 mt-1">
                          {forgotStrength.errors.join(' ')}
                        </p>
                      )}
                    </div>

                    <div>
                      <label
                        htmlFor="forgot-confirm-pwd"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Konfirmasi Password Baru
                      </label>
                      <input
                        id="forgot-confirm-pwd"
                        type={showForgotPassword ? 'text' : 'password'}
                        required
                        value={forgotConfirmPassword}
                        onChange={(e) => setForgotConfirmPassword(e.target.value)}
                        placeholder="Ulangi password baru"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                      />
                    </div>
                  </>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] py-3 px-4 text-sm font-semibold text-white hover:bg-[#075D83] disabled:opacity-60 transition-colors min-h-[46px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Memproses...</span>
                    </>
                  ) : isSupabaseConfigured ? (
                    <span>Kirim Tautan Reset Password</span>
                  ) : (
                    <span>Reset Password Akun</span>
                  )}
                </button>
              </form>
            )}
          </div>

          {/* Transparent Environment Mode Notice */}
          <p className="text-center text-xs text-slate-500 px-2">
            {isSupabaseConfigured
              ? 'Autentikasi Cloud Supabase aktif · Data terisolasi per akun pengguna.'
              : 'Berjalan dalam Mode Lokal di perangkat Anda · Kredensial di-hash dengan PBKDF2-SHA256.'}
          </p>
        </div>
      </main>
    </div>
  );
};
