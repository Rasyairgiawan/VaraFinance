import React, { useEffect, useState } from 'react';

interface SplashScreenProps {
  onFinish?: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onFinish }) => {
  const [phase, setPhase] = useState<'visible' | 'fading' | 'done'>(() => {
    if (typeof window !== 'undefined' && window.sessionStorage.getItem('ku_splash_shown') === '1') {
      return 'done';
    }
    return 'visible';
  });

  useEffect(() => {
    if (phase === 'done') return;
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('ku_splash_shown', '1');
    }

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const fadeDelay = prefersReduced ? 150 : 750;
    const hideDelay = prefersReduced ? 250 : 1100;

    const t1 = window.setTimeout(() => setPhase('fading'), fadeDelay);
    const t2 = window.setTimeout(() => {
      setPhase('done');
      onFinish?.();
    }, hideDelay);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [phase, onFinish]);

  if (phase === 'done') return null;

  return (
    <div
      onClick={() => {
        setPhase('done');
        onFinish?.();
      }}
      role="status"
      aria-label="Memuat VaraFinance"
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#0C87C0] px-6 transition-opacity duration-300 cursor-pointer select-none ${
        phase === 'fading' ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="flex flex-col items-center gap-4 max-w-sm w-full">
        <img
          src="/assets/aistudio/logo-text2_5ca33bfc.jpeg"
          alt="Logo VaraFinance"
          referrerPolicy="no-referrer"
          className="w-64 sm:w-80 h-auto object-contain rounded-2xl"
        />
        <div className="text-center space-y-1">
          <p className="font-display text-base font-bold tracking-tight text-white">
            VaraFinance
          </p>
          <p className="text-xs font-medium tracking-wide text-white/90">
            Sistem Disiplin &amp; Kontrol Keuangan Pribadi
          </p>
        </div>
      </div>
    </div>
  );
};
