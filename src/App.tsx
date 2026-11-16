import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Calculator,
  Calendar,
  Home,
  Lock,
  LogOut,
  PiggyBank,
  Plus,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { AnalysisView } from './components/AnalysisView';
import { AuthScreen } from './components/AuthScreen';
import { BudgetsAndDisciplineView } from './components/BudgetsAndDisciplineView';
import { CalendarAndRemindersView } from './components/CalendarAndRemindersView';
import { DashboardView } from './components/DashboardView';
import { DebtsAndGoalsView } from './components/DebtsAndGoalsView';
import { DecisionSimulatorModal } from './components/DecisionSimulatorModal';
import { OnboardingWizard } from './components/OnboardingWizard';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallBanner';
import { PinLockScreen } from './components/PinLockScreen';
import { QuickPreset, QuickTransactionModal } from './components/QuickTransactionModal';
import { SettingsView } from './components/SettingsView';
import { SplashScreen } from './components/SplashScreen';
import { TransactionsAndProjectsView } from './components/TransactionsAndProjectsView';
import { updateSettingsAction } from './hooks/financeActions';
import { useFinanceStore } from './hooks/useFinanceStore';
import {
  getStoredSession,
  getUserSummaryForSession,
  logoutSession,
  resolveValidSession,
  touchSessionActivity,
} from './services/authService';
import { AuthSession, AuthUserSummary, Transaction } from './types/finance';

type NavTab =
  | 'dashboard'
  | 'transactions'
  | 'budgets'
  | 'obligations'
  | 'analysis'
  | 'calendar'
  | 'settings';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(() => getStoredSession());
  const [authUser, setAuthUser] = useState<AuthUserSummary | null>(() =>
    getUserSummaryForSession(getStoredSession())
  );
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    const initialSess = getStoredSession();
    const initialUser = getUserSummaryForSession(initialSess);
    return Boolean(initialSess && initialUser?.pinEnabled && initialUser?.requirePinOnReopen);
  });

  const {
    state,
    snapshot,
    commitState,
    resetAllData,
    syncStatus,
    isSyncing,
    isSupabaseConfigured,
    dismissConflictNotice,
    preferCloudSnapshot,
    canRestoreCloudSnapshot,
  } = useFinanceStore(session?.userId ?? null);

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [simModalOpen, setSimModalOpen] = useState(false);
  const [txPreset, setTxPreset] = useState<QuickPreset>(null);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const lastActivityRef = useRef<number>(Date.now());
  const lastTouchWriteRef = useRef<number>(0);

  const refreshAuthUser = useCallback(() => {
    const latestSess = getStoredSession() ?? session;
    setAuthUser(getUserSummaryForSession(latestSess));
  }, [session]);

  // Verify session asynchronously (supports Supabase cloud session sync on load)
  useEffect(() => {
    let active = true;
    resolveValidSession().then((resolved) => {
      if (!active) return;
      setSession(resolved);
      const summary = getUserSummaryForSession(resolved);
      setAuthUser(summary);
      if (resolved && summary?.pinEnabled && summary?.requirePinOnReopen) {
        setIsLocked((prev) => prev || true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Keep onboarding wizard synchronized with authenticated user's state
  useEffect(() => {
    if (session && !isLocked) {
      setWizardOpen(!state.settings.onboardingCompleted);
    } else {
      setWizardOpen(false);
    }
  }, [session, isLocked, state.settings.onboardingCompleted]);

  // Inactivity auto-lock + background return check
  useEffect(() => {
    if (!session || isLocked) return;
    if (!authUser?.pinEnabled || !authUser.autoLockMinutes || authUser.autoLockMinutes <= 0) {
      return;
    }

    const timeoutMs = authUser.autoLockMinutes * 60 * 1000;
    lastActivityRef.current = Date.now();

    const recordActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastTouchWriteRef.current > 30_000) {
        lastTouchWriteRef.current = now;
        touchSessionActivity();
      }
    };

    const checkTimeout = () => {
      if (Date.now() - lastActivityRef.current >= timeoutMs) {
        setIsLocked(true);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkTimeout();
      }
    };

    window.addEventListener('pointerdown', recordActivity, { passive: true });
    window.addEventListener('keydown', recordActivity);
    window.addEventListener('touchstart', recordActivity, { passive: true });
    window.addEventListener('scroll', recordActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    const interval = window.setInterval(checkTimeout, 5000);

    return () => {
      window.removeEventListener('pointerdown', recordActivity);
      window.removeEventListener('keydown', recordActivity);
      window.removeEventListener('touchstart', recordActivity);
      window.removeEventListener('scroll', recordActivity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [session, isLocked, authUser?.pinEnabled, authUser?.autoLockMinutes]);

  const handleLockNow = useCallback(() => {
    if (authUser?.pinEnabled) {
      setIsLocked(true);
    } else {
      setActiveTab('settings');
    }
  }, [authUser?.pinEnabled]);

  const handleLogout = useCallback(async () => {
    await logoutSession();
    setSession(null);
    setAuthUser(null);
    setIsLocked(false);
    setTxModalOpen(false);
    setSimModalOpen(false);
    setWizardOpen(false);
    setActiveTab('dashboard');
  }, []);

  const openQuickTx = (preset: QuickPreset) => {
    setEditingTx(null);
    setTxPreset(preset);
    setTxModalOpen(true);
  };

  const openEditTx = (tx: Transaction) => {
    setTxPreset(null);
    setEditingTx(tx);
    setTxModalOpen(true);
  };

  const navItems: { id: NavTab; label: string; shortLabel: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Beranda', shortLabel: 'Beranda', icon: <Home className="w-5 h-5" /> },
    {
      id: 'transactions',
      label: 'Transaksi & Akun',
      shortLabel: 'Transaksi',
      icon: <ArrowLeftRight className="w-5 h-5" />,
    },
    {
      id: 'budgets',
      label: 'Anggaran & Disiplin',
      shortLabel: 'Anggaran',
      icon: <SlidersHorizontal className="w-5 h-5" />,
    },
    {
      id: 'obligations',
      label: 'Utang, Kewajiban & Target',
      shortLabel: 'Kewajiban',
      icon: <PiggyBank className="w-5 h-5" />,
    },
    {
      id: 'analysis',
      label: 'Analisis & Laporan',
      shortLabel: 'Analisis',
      icon: <BarChart3 className="w-5 h-5" />,
    },
    {
      id: 'calendar',
      label: 'Kalender & Pengingat',
      shortLabel: 'Kalender',
      icon: <Calendar className="w-5 h-5" />,
    },
    {
      id: 'settings',
      label: 'Pengaturan',
      shortLabel: 'Atur',
      icon: <Settings className="w-5 h-5" />,
    },
  ];

  const currentNav = navItems.find((n) => n.id === activeTab) ?? navItems[0];

  // 1. Primary Authentication Gate (no valid session on this device)
  if (!session || !authUser) {
    return (
      <>
        <SplashScreen />
        <AuthScreen
          isSupabaseConfigured={isSupabaseConfigured}
          onAuthenticated={({ session: nextSess, user: nextUser }) => {
            setSession(nextSess);
            setAuthUser(nextUser);
            setIsLocked(false);
            lastActivityRef.current = Date.now();
            setActiveTab('dashboard');
          }}
        />
      </>
    );
  }

  // 2. 6-Digit PIN Quick-Unlock Gate (valid session, locked on reopen / manual lock / idle timeout)
  if (authUser.pinEnabled && isLocked) {
    return (
      <>
        <SplashScreen />
        <PinLockScreen
          session={session}
          onUnlocked={() => {
            lastActivityRef.current = Date.now();
            touchSessionActivity();
            refreshAuthUser();
            setIsLocked(false);
          }}
          onLogout={handleLogout}
        />
      </>
    );
  }

  return (
    <>
      <SplashScreen />
      <div className="min-h-screen bg-slate-50 text-slate-900 flex">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-200 bg-white no-print">
          <div className="px-6 py-5 border-b border-slate-200">
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className="flex items-center gap-3 text-left"
            >
              <img
                src="/assets/aistudio/logo-white_9d5ca417.jpeg"
                alt="VaraFinance"
                referrerPolicy="no-referrer"
                className="h-9 w-9 rounded-xl object-cover shrink-0 shadow-xs"
              />
              <div className="min-w-0">
                <span className="font-display text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap block leading-tight">
                  VaraFinance
                </span>
                <span className="text-[10px] font-semibold text-[#0976A6] tracking-wide uppercase block">
                  Disiplin Keuangan
                </span>
              </div>
            </button>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Navigasi Utama">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#E8F6FC] text-[#0976A6]'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="p-4 border-t border-slate-200 text-xs text-slate-500 space-y-3">
            <div className="space-y-0.5">
              <p className="font-semibold text-slate-800 truncate">{authUser.username}</p>
              <p className="truncate text-[11px]">
                {syncStatus.mode === 'cloud'
                  ? isSyncing
                    ? 'Menyinkronkan ke Supabase...'
                    : 'Sinkronisasi Cloud Aktif'
                  : 'Mode Lokal (Offline-First)'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {authUser.pinEnabled && (
                <button
                  type="button"
                  onClick={handleLockNow}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 min-h-[36px]"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Kunci</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] font-semibold text-red-700 hover:bg-red-100 min-h-[36px] ${
                  authUser.pinEnabled ? '' : 'col-span-2'
                }`}
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Keluar</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content Shell */}
        <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
          {/* Top Bar Contract */}
          <header className="sticky top-0 z-30 h-14 border-b border-slate-200 bg-white/95 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-3 pt-safe no-print">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/assets/aistudio/logo-white_9d5ca417.jpeg"
                alt="VaraFinance"
                referrerPolicy="no-referrer"
                className="lg:hidden h-7 w-7 rounded-lg object-cover shrink-0"
              />
              <h1 className="font-display text-base sm:text-lg font-bold text-slate-900 truncate">
                {currentNav.label}
              </h1>
              <span className="hidden sm:inline text-xs text-slate-400" aria-hidden="true">
                ·
              </span>
              <span className="hidden sm:inline text-xs font-medium text-slate-500 truncate">
                {snapshot.modeEvaluation.label}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <PWAInstallButton compact />
              <button
                type="button"
                onClick={() => setSimModalOpen(true)}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-2 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9] transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
                title="Simulasi Dampak Pengeluaran"
              >
                <Calculator className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">Simulasi</span>
              </button>
              {authUser.pinEnabled && (
                <button
                  type="button"
                  onClick={handleLockNow}
                  className="lg:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  aria-label="Kunci Aplikasi"
                  title="Kunci Aplikasi"
                >
                  <Lock className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveTab('calendar')}
                className={`lg:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border ${
                  activeTab === 'calendar'
                    ? 'border-[#0C8FC5] bg-[#E8F6FC] text-[#0976A6]'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
                aria-label="Kalender & Pengingat"
              >
                <Calendar className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className={`lg:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border ${
                  activeTab === 'settings'
                    ? 'border-[#0C8FC5] bg-[#E8F6FC] text-[#0976A6]'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
                aria-label="Pengaturan"
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => openQuickTx(null)}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83] transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
              >
                <Plus className="w-4 h-4" />
                <span>Catat</span>
              </button>
            </div>
          </header>

          {/* Offline-Cloud Conflict Notification */}
          {syncStatus.conflictDetected && syncStatus.conflictDetail && (
            <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-3 no-print">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <span>{syncStatus.conflictDetail}</span>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                {canRestoreCloudSnapshot && (
                  <button
                    type="button"
                    onClick={preferCloudSnapshot}
                    className="rounded-lg border border-amber-400 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    Pakai Versi Cloud Saja
                  </button>
                )}
                <button
                  type="button"
                  onClick={dismissConflictNotice}
                  className="rounded-lg bg-amber-800 px-2.5 py-1 font-semibold text-white hover:bg-amber-900"
                >
                  Pertahankan Gabungan
                </button>
              </div>
            </div>
          )}

          {/* Scrollable Content Viewport */}
          <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-5 sm:py-6 pb-24 lg:pb-8">
            {activeTab === 'dashboard' && (
              <DashboardView
                state={state}
                snapshot={snapshot}
                onQuickAction={openQuickTx}
                onOpenSimulator={() => setSimModalOpen(true)}
                onEditTransaction={openEditTx}
                onNavigate={(t) => setActiveTab(t as NavTab)}
                onCommit={commitState}
              />
            )}

            {activeTab === 'transactions' && (
              <TransactionsAndProjectsView
                state={state}
                snapshot={snapshot}
                onCommit={commitState}
                onOpenQuickTx={openQuickTx}
                onEditTx={openEditTx}
              />
            )}

            {activeTab === 'budgets' && (
              <BudgetsAndDisciplineView
                state={state}
                snapshot={snapshot}
                onCommit={commitState}
                onOpenSimulator={() => setSimModalOpen(true)}
              />
            )}

            {activeTab === 'obligations' && (
              <DebtsAndGoalsView
                state={state}
                snapshot={snapshot}
                onCommit={commitState}
              />
            )}

            {activeTab === 'calendar' && (
              <CalendarAndRemindersView
                state={state}
                snapshot={snapshot}
                onCommit={commitState}
              />
            )}

            {activeTab === 'analysis' && (
              <AnalysisView
                state={state}
                snapshot={snapshot}
                onCommit={commitState}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                state={state}
                session={session}
                authUser={authUser}
                syncStatus={syncStatus}
                isSupabaseConfigured={isSupabaseConfigured}
                onOpenWizard={() => setWizardOpen(true)}
                onRestoreState={(restored) => commitState(restored)}
                onCommit={commitState}
                onResetData={resetAllData}
                onLockNow={handleLockNow}
                onLogout={handleLogout}
                onRefreshAuthUser={refreshAuthUser}
              />
            )}
          </main>
        </div>

        {/* Mobile Fixed Bottom Navigation Bar */}
        <nav
          className="lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe no-print"
          aria-label="Navigasi Bawah"
        >
          <div className="grid grid-cols-5 h-16 items-center">
            {navItems.slice(0, 5).map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex flex-col items-center justify-center h-full min-w-[44px] px-1 transition-colors ${
                    active ? 'text-[#0976A6] font-bold' : 'text-slate-500 font-medium'
                  }`}
                >
                  {item.icon}
                  <span className="text-[10px] mt-1 tracking-tight truncate max-w-full">
                    {item.shortLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Modals & Indicators */}
        <QuickTransactionModal
          isOpen={txModalOpen}
          preset={txPreset}
          editingTx={editingTx}
          state={state}
          snapshot={snapshot}
          onClose={() => {
            setTxModalOpen(false);
            setEditingTx(null);
          }}
          onCommit={commitState}
        />

        <DecisionSimulatorModal
          isOpen={simModalOpen}
          state={state}
          snapshot={snapshot}
          onClose={() => setSimModalOpen(false)}
          onCommit={commitState}
        />

        {wizardOpen && (
          <OnboardingWizard
            initialSettings={state.settings}
            onComplete={(newSettings) => {
              commitState((prev) => updateSettingsAction(prev, newSettings));
              setWizardOpen(false);
            }}
            onSkip={
              state.settings.onboardingCompleted ? () => setWizardOpen(false) : undefined
            }
          />
        )}

        <OfflineIndicator />
      </div>
    </>
  );
}
