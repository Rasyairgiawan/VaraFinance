import React, { useState } from 'react';
import { Download, Share, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3.5 py-2 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9] transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>{compact ? 'Install' : 'Install Aplikasi'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
        >
          <Share className="w-4 h-4 shrink-0" />
          <span>{compact ? 'Install' : 'Pasang di iPhone'}</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Pasang VaraFinance di iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-2 text-slate-400 hover:text-slate-700 rounded-lg"
                  aria-label="Tutup panduan"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <ol className="mt-4 space-y-2.5 text-sm text-slate-600 list-decimal pl-5">
                <li>
                  Ketuk tombol <strong>Bagikan (Share)</strong> di bilah bawah Safari.
                </li>
                <li>
                  Gulir ke bawah dan pilih <strong>Tambahkan ke Layar Utama (Add to Home Screen)</strong>.
                </li>
                <li>
                  Ketuk <strong>Tambah</strong> untuk membuka aplikasi seperti aplikasi native.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-xl bg-[#0976A6] py-2.5 text-sm font-semibold text-white hover:bg-[#075D83] transition-colors"
              >
                Mengerti
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 lg:bottom-5 left-4 z-50 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 shadow-md">
      <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
      <span>Mode Offline — Data tersimpan aman di perangkat Anda</span>
    </div>
  );
};
