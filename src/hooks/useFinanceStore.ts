import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeFinanceSnapshot, FinanceSnapshot } from '../engine/financeEngine';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  getLastSyncedTimestamp,
  hasUnsyncedLocalChanges,
  loadLocalState,
  mergeFinanceStatesById,
  pullFromSupabase,
  pushStateToSupabase,
  resetLocalState,
  saveLocalState,
  SyncStatus,
} from '../services/financeRepository';
import { FinanceState } from '../types/finance';
import { syncExpiredObligationsAction } from './financeActions';

export function useFinanceStore(activeUserId?: string | null) {
  const [state, setState] = useState<FinanceState>(() =>
    syncExpiredObligationsAction(loadLocalState(activeUserId))
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    mode: 'local_demo',
    authenticatedEmail: null,
    lastSyncedAt: getLastSyncedTimestamp(activeUserId),
    error: null,
    conflictDetected: false,
    conflictDetail: null,
  });
  const [pendingRemoteState, setPendingRemoteState] = useState<FinanceState | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Reload user-scoped financial state whenever activeUserId changes (login / register / switch account)
  useEffect(() => {
    setState(syncExpiredObligationsAction(loadLocalState(activeUserId)));
    setSyncStatus((s) => ({
      ...s,
      lastSyncedAt: getLastSyncedTimestamp(activeUserId),
    }));
  }, [activeUserId]);

  const commitState = useCallback(
    (updater: FinanceState | ((prev: FinanceState) => FinanceState)) => {
      setState((prev) => {
        const rawNext = typeof updater === 'function' ? updater(prev) : updater;
        const next = syncExpiredObligationsAction(rawNext);
        saveLocalState(next, activeUserId);
        if (userId && isSupabaseConfigured) {
          setIsSyncing(true);
          pushStateToSupabase(userId, next)
            .then(() => {
              setSyncStatus((s) => ({
                ...s,
                mode: 'cloud',
                lastSyncedAt: new Date().toISOString(),
                error: null,
                conflictDetected: false,
                conflictDetail: null,
              }));
            })
            .catch((err) => {
              setSyncStatus((s) => ({
                ...s,
                error: err instanceof Error ? err.message : 'Gagal sinkronisasi ke Supabase',
              }));
            })
            .finally(() => setIsSyncing(false));
        }
        return next;
      });
    },
    [userId, activeUserId]
  );

  const handleRemotePull = useCallback(async (uid: string) => {
    setIsSyncing(true);
    try {
      const remote = await pullFromSupabase(uid);
      if (!remote) return;

      const local = loadLocalState(uid);
      const lastSynced = getLastSyncedTimestamp(uid);
      const localUnsynced = hasUnsyncedLocalChanges(local, lastSynced);

      if (localUnsynced) {
        const merged = syncExpiredObligationsAction(mergeFinanceStatesById(local, remote));
        setPendingRemoteState(remote);
        setState(merged);
        saveLocalState(merged, uid);
        await pushStateToSupabase(uid, merged);
        setSyncStatus((s) => ({
          ...s,
          mode: 'cloud',
          lastSyncedAt: new Date().toISOString(),
          conflictDetected: true,
          conflictDetail:
            'Perubahan offline lokal digabungkan otomatis dengan data cloud tanpa menghapus catatan mana pun.',
          error: null,
        }));
      } else {
        const synced = syncExpiredObligationsAction(remote);
        setState(synced);
        saveLocalState(synced, uid);
        setSyncStatus((s) => ({
          ...s,
          mode: 'cloud',
          lastSyncedAt: new Date().toISOString(),
          conflictDetected: false,
          conflictDetail: null,
          error: null,
        }));
      }
    } catch (err) {
      setSyncStatus((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Gagal memuat data cloud',
      }));
    } finally {
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;

    supabase.auth.getSession().then(async ({ data }) => {
      const sessionUser = data.session?.user;
      if (sessionUser) {
        setUserId(sessionUser.id);
        setSyncStatus((s) => ({
          ...s,
          mode: 'cloud',
          authenticatedEmail: sessionUser.email ?? null,
        }));
        await handleRemotePull(sessionUser.id);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const u = session?.user;
      if (u) {
        setUserId(u.id);
        setSyncStatus((s) => ({
          ...s,
          mode: 'cloud',
          authenticatedEmail: u.email ?? null,
          error: null,
        }));
        await handleRemotePull(u.id);
      } else {
        setUserId(null);
        setPendingRemoteState(null);
        setSyncStatus({
          mode: 'local_demo',
          authenticatedEmail: null,
          lastSyncedAt: null,
          error: null,
          conflictDetected: false,
          conflictDetail: null,
        });
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [handleRemotePull]);

  const dismissConflictNotice = useCallback(() => {
    setPendingRemoteState(null);
    setSyncStatus((s) => ({ ...s, conflictDetected: false, conflictDetail: null }));
  }, []);

  const preferCloudSnapshot = useCallback(async () => {
    if (!pendingRemoteState || !userId) return;
    const synced = syncExpiredObligationsAction(pendingRemoteState);
    setState(synced);
    saveLocalState(synced, userId);
    setPendingRemoteState(null);
    setSyncStatus((s) => ({
      ...s,
      lastSyncedAt: new Date().toISOString(),
      conflictDetected: false,
      conflictDetail: null,
    }));
  }, [pendingRemoteState, userId]);

  const snapshot: FinanceSnapshot = useMemo(() => computeFinanceSnapshot(state), [state]);

  const resetAllData = useCallback(() => {
    const fresh = resetLocalState(activeUserId);
    setState(fresh);
  }, [activeUserId]);

  return {
    state,
    snapshot,
    commitState,
    resetAllData,
    syncStatus,
    isSyncing,
    isSupabaseConfigured,
    dismissConflictNotice,
    preferCloudSnapshot,
    canRestoreCloudSnapshot: Boolean(pendingRemoteState),
  };
}
