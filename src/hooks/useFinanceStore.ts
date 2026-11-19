import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeFinanceSnapshot, FinanceSnapshot } from '../engine/financeEngine';
import { isSupabaseConfigured } from '../lib/supabase';
import { createUuidInitialFinanceState } from '../services/financeMigration';
import {
  getLastSyncedTimestamp,
  loadLocalState,
  resetLocalState,
  saveLocalState,
  SyncStatus,
} from '../services/financeRepository';
import { FinanceState } from '../types/finance';
import { syncExpiredObligationsAction } from './financeActions';

function loadScopedState(activeStorageUserId?: string | null): FinanceState {
  if (!activeStorageUserId) {
    // Unauthenticated view holds transient in-memory initial state only
    // so generic pre-user localStorage data is never overwritten or mixed.
    return syncExpiredObligationsAction(createUuidInitialFinanceState());
  }
  return syncExpiredObligationsAction(loadLocalState(activeStorageUserId));
}

export function useFinanceStore(activeStorageUserId?: string | null) {
  const [state, setState] = useState<FinanceState>(() => loadScopedState(activeStorageUserId));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    mode: 'local_demo',
    authenticatedEmail: null,
    lastSyncedAt: activeStorageUserId ? getLastSyncedTimestamp(activeStorageUserId) : null,
    error: null,
    conflictDetected: false,
    conflictDetail: null,
  });

  // Reload user-scoped financial state whenever activeStorageUserId changes (login / register / switch account / link)
  useEffect(() => {
    setState(loadScopedState(activeStorageUserId));
    setSyncStatus({
      mode: 'local_demo',
      authenticatedEmail: null,
      lastSyncedAt: activeStorageUserId ? getLastSyncedTimestamp(activeStorageUserId) : null,
      error: null,
      conflictDetected: false,
      conflictDetail: null,
    });
  }, [activeStorageUserId]);

  const commitState = useCallback(
    (updater: FinanceState | ((prev: FinanceState) => FinanceState)) => {
      setState((prev) => {
        const rawNext = typeof updater === 'function' ? updater(prev) : updater;
        const next = syncExpiredObligationsAction(rawNext);
        if (activeStorageUserId) {
          saveLocalState(next, activeStorageUserId);
        }
        return next;
      });
    },
    [activeStorageUserId]
  );

  const dismissConflictNotice = useCallback(() => {
    setSyncStatus((s) => ({ ...s, conflictDetected: false, conflictDetail: null }));
  }, []);

  const preferCloudSnapshot = useCallback(async () => {
    // Full-table FinanceState cloud sync is intentionally disabled in Phase 3.2B
  }, []);

  const snapshot: FinanceSnapshot = useMemo(() => computeFinanceSnapshot(state), [state]);

  const resetAllData = useCallback(() => {
    if (!activeStorageUserId) {
      setState(syncExpiredObligationsAction(createUuidInitialFinanceState()));
      return;
    }
    const fresh = resetLocalState(activeStorageUserId);
    setState(fresh);
  }, [activeStorageUserId]);

  return {
    state,
    snapshot,
    commitState,
    resetAllData,
    syncStatus,
    isSyncing: false,
    isSupabaseConfigured,
    dismissConflictNotice,
    preferCloudSnapshot,
    canRestoreCloudSnapshot: false,
  };
}
