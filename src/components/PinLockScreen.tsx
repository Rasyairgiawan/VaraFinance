import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
} from 'lucide-react';
import {
  getPinCooldownSeconds,
  resetPinWithPassword,
  resolveStorageUserId,
  verifyPinCode,
} from '../services/authService';
import { AuthSession } from '../types/finance';

interface PinLockScreenProps {
  session: AuthSession;
  onUnlocked: () => void;
  onLogout: () => void;
}

export const PinLockScreen: React.FC<PinLockScreenProps> = ({
  session,
  onUnlocked,
  onLogout,
}) => {
  const guardUserId = resolveStorageUserId(session) ?? session.userId;
  const [digits, setDigits] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(() =>
    getPinCooldownSeconds(guardUserId)
  );

  // Forgot PIN (password verification) mode
  const [forgotMode, setForgotMode] = useState(false);
  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    setCooldownSeconds(getPinCooldownSeconds(guardUserId));
    const interval = window.setInterval(() => {
      const rem = getPinCooldownSeconds(guardUserId);
      setCooldownSeconds(rem);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [guardUserId]);

  const submitPin = useCallback(
    async (pinValue: string) => {
      if (pinValue.length !== 6 || verifying) return;
      const rem = getPinCooldownSeconds(guardUserId);
      if (rem > 0) {
        setCooldownSeconds(rem);
        setDigits('');
        return;
      }

      setVerifying(true);
      setErrorMsg(null);
      try {
        const res = await verifyPinCode(session, pinValue);
        if (res.success) {
          setDigits('');
          onUnlocked();
        } else {
          setDigits('');
          setCooldownSeconds(res.remainingSeconds);
          setErrorMsg(res.message ?? 'PIN salah.');
        }
      } finally {
        setVerifying(false);
      }
    },
    [session, verifying, onUnlocked]
  );

  const handleDigitPress = useCallback(
    (d: string) => {
      if (verifying || cooldownSeconds > 0) return;
      setErrorMsg(null);
      setDigits((prev) => {
        if (prev.length >= 6) return prev;
        const next = `${prev}${d}`;
        if (next.length === 6) {
          window.setTimeout(() => submitPin(next), 60);
        }
        return next;
      });
    },
    [verifying, cooldownSeconds, submitPin]
  );

  const handleBackspace = useCallback(() => {
    if (verifying) return;
    setErrorMsg(null);
    setDigits((prev) => prev.slice(0, -1));
  }, [verifying]);

  const handleClear = useCallback(() => {
    if (verifying) return;
    setErrorMsg(null);
    setDigits('');
  }, [verifying]);

  // Physical keyboard support when on PIN keypad view
  useEffect(() => {
    if (forgotMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigitPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClear();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [forgotMode, handleDigitPress, handleBackspace, handleClear]);

  const handleResetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError(null);
    setResetLoading(true);
    try {
      await resetPinWithPassword(session, {
        password: pwd,
        newPin,
        confirmPin: confirmNewPin,
      });
      setPwd('');
      setNewPin('');
      setConfirmNewPin('');
      setForgotMode(false);
      setCooldownSeconds(0);
      setErrorMsg(null);
      onUnlocked();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Gagal mengatur ulang PIN.');
    } finally {
      setResetLoading(false);
    }
  };

  if (forgotMode) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 space-y-5">
          <button
            type="button"
            onClick={() => {
              setForgotMode(false);
              setResetError(null);
            }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0976A6] hover:text-[#075D83] min-h-[36px]"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Kembali ke Layar PIN</span>
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#E8F6FC] text-[#0976A6] flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold text-slate-900">
                Lupa PIN — Verifikasi Password
              </h1>
              <p className="text-xs text-slate-500">
                Akun: <strong className="text-slate-700">{session.username}</strong>
              </p>
            </div>
          </div>

          {resetError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{resetError}</span>
            </div>
          )}

          <form onSubmit={handleResetPinSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="forgot-pin-password"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Password Akun Saat Ini
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="forgot-pin-password"
                  type={showPwd ? 'text' : 'password'}
                  required
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  placeholder="Masukkan password akun"
                  className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-11 py-2.5 text-sm text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  aria-label={showPwd ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[38px] min-h-[38px] flex items-center justify-center text-slate-500 hover:text-slate-800 rounded-lg"
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="forgot-pin-new"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  PIN Baru (6 digit)
                </label>
                <input
                  id="forgot-pin-new"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 digit angka"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono-num tracking-widest text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                />
              </div>
              <div>
                <label
                  htmlFor="forgot-pin-confirm"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  Konfirmasi PIN Baru
                </label>
                <input
                  id="forgot-pin-confirm"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={confirmNewPin}
                  onChange={(e) =>
                    setConfirmNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  placeholder="Ulangi PIN"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono-num tracking-widest text-slate-900 focus:border-[#0C8FC5] focus:outline-none min-h-[44px]"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={resetLoading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#0976A6] py-3 px-4 text-sm font-semibold text-white hover:bg-[#075D83] disabled:opacity-60 min-h-[46px]"
            >
              {resetLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Memverifikasi...</span>
                </>
              ) : (
                <span>Simpan PIN Baru &amp; Buka Aplikasi</span>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-6 select-none">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 sm:p-7 space-y-6">
        {/* Brand & User Header */}
        <div className="flex flex-col items-center text-center space-y-2.5">
          <img
            src="/assets/aistudio/logo-white_9d5ca417.jpeg"
            alt="Logo VaraFinance"
            referrerPolicy="no-referrer"
            className="w-12 h-12 rounded-xl object-cover border border-slate-200"
          />
          <div>
            <h1 className="font-display text-lg font-bold text-slate-900">
              Masukkan PIN 6 Digit
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Akun aktif: <strong className="text-slate-800">{session.username}</strong>
            </p>
          </div>
        </div>

        {/* 6 Masked PIN Dots — NEVER plaintext */}
        <div
          className="flex items-center justify-center gap-3 py-1"
          aria-label={`PIN terisi ${digits.length} dari 6 digit`}
        >
          {[0, 1, 2, 3, 4, 5].map((idx) => {
            const filled = idx < digits.length;
            return (
              <div
                key={idx}
                className={`w-4 h-4 rounded-full border transition-all duration-150 ${
                  filled
                    ? 'bg-[#0976A6] border-[#0976A6] scale-110'
                    : 'bg-slate-100 border-slate-300'
                }`}
              />
            );
          })}
        </div>

        {/* Status / Cooldown / Error Feedback */}
        {cooldownSeconds > 0 ? (
          <div
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-950 text-center tabular-nums"
          >
            Percobaan PIN dijeda sementara. Coba lagi dalam{' '}
            <strong>{cooldownSeconds} detik</strong>.
          </div>
        ) : errorMsg ? (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800 text-center"
          >
            {errorMsg}
          </div>
        ) : verifying ? (
          <div className="flex items-center justify-center gap-2 text-xs font-medium text-[#0976A6]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Memverifikasi PIN...</span>
          </div>
        ) : (
          <p className="text-center text-[11px] text-slate-400">
            Ketuk tombol angka atau gunakan keyboard
          </p>
        )}

        {/* Mobile-Comfortable Numeric Keypad */}
        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              type="button"
              disabled={verifying || cooldownSeconds > 0}
              onClick={() => handleDigitPress(d)}
              className="h-14 rounded-xl border border-slate-200 bg-slate-50 text-xl font-mono-num font-bold text-slate-900 hover:bg-[#E8F6FC] hover:border-[#B9E2F5] active:scale-[0.97] disabled:opacity-45 transition-all"
            >
              {d}
            </button>
          ))}

          <button
            type="button"
            disabled={verifying || digits.length === 0}
            onClick={handleClear}
            className="h-14 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-100 active:scale-[0.97] disabled:opacity-40 transition-all"
          >
            Hapus
          </button>

          <button
            type="button"
            disabled={verifying || cooldownSeconds > 0}
            onClick={() => handleDigitPress('0')}
            className="h-14 rounded-xl border border-slate-200 bg-slate-50 text-xl font-mono-num font-bold text-slate-900 hover:bg-[#E8F6FC] hover:border-[#B9E2F5] active:scale-[0.97] disabled:opacity-45 transition-all"
          >
            0
          </button>

          <button
            type="button"
            disabled={verifying || digits.length === 0}
            onClick={handleBackspace}
            aria-label="Hapus satu digit"
            className="h-14 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-700 hover:bg-slate-100 active:scale-[0.97] disabled:opacity-40 transition-all"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        {/* Recovery & Switch Account Footer Actions */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setForgotMode(true)}
            className="text-xs font-semibold text-[#0976A6] hover:text-[#075D83] min-h-[40px] px-1"
          >
            Lupa PIN?
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-red-700 min-h-[40px] px-1"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Akun</span>
          </button>
        </div>
      </div>
    </div>
  );
};
