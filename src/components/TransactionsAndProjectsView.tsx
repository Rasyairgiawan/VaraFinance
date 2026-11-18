import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArrowLeftRight,
  Ban,
  Briefcase,
  CheckCircle2,
  ClipboardList,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Scale,
  Search,
  Trash2,
  Wallet,
} from 'lucide-react';
import { FinanceSnapshot } from '../engine/financeEngine';
import {
  addAccountAction,
  addProjectExpenseAction,
  addProjectPaymentAction,
  archiveAccountAction,
  archiveProjectAction,
  closeAccountAction,
  createProjectAction,
  deleteAccountAction,
  deleteTransactionAction,
  distributeProjectPersonalShareAction,
  editAccountAction,
  getTransactionLinkInfo,
  markProjectPaymentReceivedAction,
  reconcileAccountAction,
  reopenAccountAction,
  voidTransactionAction,
} from '../hooks/financeActions';
import { Account, FinanceState, Transaction } from '../types/finance';
import { formatDateID, formatIDR, todayISO } from '../utils/format';
import {
  getTransactionAccountDisplay,
  getTransactionNatureBadge,
} from '../utils/transactionDisplay';
import { QuickPreset } from './QuickTransactionModal';

interface TransactionsAndProjectsViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
  onOpenQuickTx: (preset: QuickPreset) => void;
  onEditTx: (tx: Transaction) => void;
}

export const TransactionsAndProjectsView: React.FC<TransactionsAndProjectsViewProps> = ({
  state,
  snapshot,
  onCommit,
  onOpenQuickTx,
  onEditTx,
}) => {
  const [subTab, setSubTab] = useState<'ledger' | 'freelance' | 'accounts'>('ledger');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [showVoided, setShowVoided] = useState(true);
  const [voidingTxId, setVoidingTxId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [txError, setTxError] = useState<string | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);

  // New Project Form state
  const [showNewProject, setShowNewProject] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [clientName, setClientName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [contractValue, setContractValue] = useState('');
  const [paymentScheme, setPaymentScheme] = useState<'full' | 'dp_final' | 'milestone' | 'custom'>('dp_final');
  const [businessSharePct, setBusinessSharePct] = useState('30');

  // Project action inputs
  const [activeProjAction, setActiveProjAction] = useState<{
    projectId: string;
    mode: 'payment' | 'expense' | 'distribute';
  } | null>(null);
  const [projPayType, setProjPayType] = useState<'dp' | 'installment' | 'final' | 'full'>('dp');
  const [projPayStatus, setProjPayStatus] = useState<'received' | 'expected'>('received');
  const [projAmount, setProjAmount] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projDate, setProjDate] = useState(todayISO());
  const [projAccountId, setProjAccountId] = useState('acc-business');
  const [projTargetPersonalAccId, setProjTargetPersonalAccId] = useState('acc-bank');

  // Account Create/Edit/Archive/Close/Reconcile state
  const [showAccForm, setShowAccForm] = useState(false);
  const [showInactiveAccounts, setShowInactiveAccounts] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accName, setAccName] = useState('');
  const [accType, setAccType] = useState<Account['accountType']>('ewallet');
  const [accOpening, setAccOpening] = useState('0');
  const [accIsBiz, setAccIsBiz] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);

  const [reconcileAccId, setReconcileAccId] = useState<string | null>(null);
  const [reconcileActual, setReconcileActual] = useState('');
  const [reconcileNote, setReconcileNote] = useState('');

  const filteredTx = useMemo(() => {
    return state.transactions.filter((t) => {
      if (!showVoided && t.isVoided) return false;
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const cat = state.categories.find((c) => c.id === t.categoryId)?.name.toLowerCase() ?? '';
        return (
          t.description.toLowerCase().includes(q) ||
          cat.includes(q) ||
          (t.notes ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [state.transactions, state.categories, typeFilter, search, showVoided]);

  const handleConfirmVoid = (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidingTxId) return;
    setTxError(null);
    try {
      onCommit(voidTransactionAction(state, voidingTxId, voidReason || 'Dibatalkan pengguna'));
      setVoidingTxId(null);
      setVoidReason('');
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Gagal membatalkan (void) transaksi.');
    }
  };

  const handleDeleteTx = (txId: string) => {
    setTxError(null);
    try {
      onCommit(deleteTransactionAction(state, txId));
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Gagal menghapus transaksi.');
    }
  };

  const handleCreateProject = (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(contractValue) || 0;
    if (!clientName.trim() || !projectName.trim() || val <= 0) return;
    const { state: next } = createProjectAction(state, {
      clientName,
      projectName,
      contractValue: val,
      paymentScheme,
      businessSharePct: Math.max(0, Math.min(100, Number(businessSharePct) || 0)),
    });
    onCommit(next);
    setClientName('');
    setProjectName('');
    setContractValue('');
    setShowNewProject(false);
  };

  const handleProjectActionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProjAction) return;
    const amt = Number(projAmount) || 0;
    if (amt <= 0) return;

    if (activeProjAction.mode === 'payment') {
      const next = addProjectPaymentAction(state, {
        projectId: activeProjAction.projectId,
        paymentType: projPayType,
        amount: amt,
        status: projPayStatus,
        date: projDate,
        accountId: projAccountId,
        notes: projDesc,
      });
      onCommit(next);
    } else if (activeProjAction.mode === 'expense') {
      const next = addProjectExpenseAction(state, {
        projectId: activeProjAction.projectId,
        description: projDesc || 'Biaya operasional proyek',
        amount: amt,
        date: projDate,
        accountId: projAccountId,
      });
      onCommit(next);
    } else if (activeProjAction.mode === 'distribute') {
      const next = distributeProjectPersonalShareAction(state, {
        projectId: activeProjAction.projectId,
        amount: amt,
        fromAccountId: 'acc-business',
        toAccountId: projTargetPersonalAccId,
        date: projDate,
      });
      onCommit(next);
    }

    setActiveProjAction(null);
    setProjAmount('');
    setProjDesc('');
  };

  const openNewAccountForm = () => {
    setAccError(null);
    setEditingAccountId(null);
    setAccName('');
    setAccType('ewallet');
    setAccOpening('0');
    setAccIsBiz(false);
    setShowAccForm(true);
  };

  const openEditAccountForm = (acc: Account) => {
    setAccError(null);
    setEditingAccountId(acc.id);
    setAccName(acc.name);
    setAccType(acc.accountType);
    setAccOpening(String(acc.openingBalance));
    setAccIsBiz(acc.isBusiness);
    setShowAccForm(true);
  };

  const handleSaveAccount = (e: React.FormEvent) => {
    e.preventDefault();
    setAccError(null);
    try {
      if (editingAccountId) {
        onCommit(
          editAccountAction(state, editingAccountId, {
            name: accName,
            accountType: accType,
            openingBalance: Number(accOpening) || 0,
            isBusiness: accIsBiz,
          })
        );
      } else {
        onCommit(
          addAccountAction(state, {
            name: accName,
            accountType: accType,
            openingBalance: Number(accOpening) || 0,
            isBusiness: accIsBiz,
          })
        );
      }
      setShowAccForm(false);
      setEditingAccountId(null);
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Gagal menyimpan akun.');
    }
  };

  const handleDeleteAccount = (accId: string) => {
    setAccError(null);
    try {
      onCommit(deleteAccountAction(state, accId));
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Gagal menghapus akun.');
    }
  };

  const handleArchiveAccount = (accId: string) => {
    setAccError(null);
    try {
      onCommit(archiveAccountAction(state, accId));
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Gagal mengarsipkan akun.');
    }
  };

  const handleCloseAccount = (accId: string) => {
    setAccError(null);
    try {
      onCommit(closeAccountAction(state, accId));
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Gagal menutup akun.');
    }
  };

  const handleReconcileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reconcileAccId) return;
    setAccError(null);
    try {
      onCommit(
        reconcileAccountAction(state, {
          accountId: reconcileAccId,
          actualBalance: Number(reconcileActual) || 0,
          note: reconcileNote,
        })
      );
      setReconcileAccId(null);
      setReconcileActual('');
      setReconcileNote('');
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Gagal melakukan rekonsiliasi.');
    }
  };

  const accTypeLabels: Record<Account['accountType'], string> = {
    cash: 'Tunai',
    bank: 'Rekening Bank',
    ewallet: 'E-Wallet',
    savings: 'Tabungan',
    investment: 'Investasi',
  };

  const displayedAccounts = snapshot.accounts.filter((a) =>
    showInactiveAccounts ? true : (a.status ?? 'active') === 'active'
  );
  const archivedAccountsCount = snapshot.accounts.filter(
    (a) => a.status === 'archived' || a.status === 'closed'
  ).length;
  const archivedProjects = state.projects.filter((p) => p.isArchived);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1">
          {[
            { id: 'ledger', label: 'Buku Transaksi' },
            { id: 'freelance', label: 'Proyek Freelance' },
            { id: 'accounts', label: 'Akun & Transfer' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as typeof subTab)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                subTab === t.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenQuickTx('transfer')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
          >
            <ArrowLeftRight className="w-4 h-4" />
            <span>Transfer Akun</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenQuickTx(null)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[40px]"
          >
            <Plus className="w-4 h-4" />
            <span>Catat Transaksi</span>
          </button>
        </div>
      </div>

      {/* TAB 1: LEDGER */}
      {subTab === 'ledger' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari deskripsi, kategori, atau catatan..."
                className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm focus:border-[#0C8FC5] focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-xl bg-white border border-slate-200 p-1">
                {[
                  { id: 'all', label: 'Semua' },
                  { id: 'expense', label: 'Keluar' },
                  { id: 'income', label: 'Masuk' },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setTypeFilter(f.id as typeof typeFilter)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                      typeFilter === f.id
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showVoided}
                  onChange={(e) => setShowVoided(e.target.checked)}
                />
                <span>Tampilkan Void</span>
              </label>
            </div>
          </div>

          {txError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 flex items-center justify-between gap-2">
              <span>{txError}</span>
              <button
                type="button"
                onClick={() => setTxError(null)}
                className="text-red-800 underline shrink-0"
              >
                Tutup
              </button>
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            {filteredTx.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Tidak ada transaksi yang cocok dengan filter saat ini.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredTx.map((tx) => {
                  const cat = state.categories.find((c) => c.id === tx.categoryId);
                  const accLabel = getTransactionAccountDisplay(tx, state.accounts);
                  const natureBadge = getTransactionNatureBadge(tx);
                  const linkInfo = getTransactionLinkInfo(state, tx.id);

                  return (
                    <div key={tx.id} className="px-5 py-3.5 hover:bg-slate-50 space-y-2">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p
                              className={`text-sm font-semibold truncate ${
                                tx.isVoided ? 'line-through text-slate-400' : 'text-slate-900'
                              }`}
                            >
                              {tx.description}
                            </p>
                            {natureBadge && (
                              <span className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                                {natureBadge}
                              </span>
                            )}
                            {linkInfo.isLinked && !tx.isVoided && (
                              <span
                                className="inline-flex items-center gap-1 rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                                title={linkInfo.reason}
                              >
                                <Lock className="w-2.5 h-2.5" />
                                <span>Terikat Relasi</span>
                              </span>
                            )}
                            {tx.isVoided && (
                              <span className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                                VOID
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5 truncate">
                            {cat?.name} · {accLabel} · {formatDateID(tx.date)}
                            {tx.overrideReason ? ` · Alasan: "${tx.overrideReason}"` : ''}
                            {tx.isVoided && tx.voidReason ? ` · Void: "${tx.voidReason}"` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-sm font-bold font-mono-num ${
                              tx.isVoided
                                ? 'line-through text-slate-400'
                                : tx.type === 'income'
                                ? 'text-emerald-700'
                                : 'text-slate-900'
                            }`}
                          >
                            {tx.type === 'income' ? '+' : '-'}
                            {formatIDR(tx.amount)}
                          </span>
                          {!tx.isVoided && (
                            <>
                              <button
                                type="button"
                                onClick={() => onEditTx(tx)}
                                className="p-2 text-slate-400 hover:text-[#0976A6] rounded-lg"
                                title={
                                  linkInfo.isLinked
                                    ? 'Edit catatan/deskripsi (nominal, akun, kategori dikunci)'
                                    : 'Edit transaksi'
                                }
                                aria-label="Edit transaksi"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setTxError(null);
                                  if (!linkInfo.canDirectVoid) {
                                    setTxError(
                                      linkInfo.reason ??
                                        'Transaksi terikat relasi ini tidak dapat di-void langsung.'
                                    );
                                    return;
                                  }
                                  setVoidingTxId(tx.id);
                                  setVoidReason('');
                                }}
                                className={`p-2 rounded-lg ${
                                  linkInfo.canDirectVoid
                                    ? 'text-slate-400 hover:text-amber-700'
                                    : 'text-slate-300 cursor-not-allowed'
                                }`}
                                title={
                                  linkInfo.canDirectVoid
                                    ? 'Void transaksi (batalkan tanpa hapus riwayat)'
                                    : linkInfo.reason
                                }
                                aria-label="Void transaksi"
                              >
                                <Ban className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDeleteTx(tx.id)}
                            className={`p-2 rounded-lg ${
                              linkInfo.isLinked
                                ? 'text-slate-300 cursor-not-allowed'
                                : 'text-slate-400 hover:text-red-600'
                            }`}
                            title={
                              linkInfo.isLinked
                                ? 'Transaksi terikat relasi tidak dapat dihapus permanen. Gunakan Void.'
                                : 'Hapus permanen transaksi'
                            }
                            aria-label="Hapus permanen transaksi"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {voidingTxId === tx.id && (
                        <form
                          onSubmit={handleConfirmVoid}
                          className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
                        >
                          <input
                            type="text"
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value)}
                            placeholder="Alasan pembatalan (mis. salah input nominal)"
                            className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs"
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              type="button"
                              onClick={() => setVoidingTxId(null)}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold"
                            >
                              Batal
                            </button>
                            <button
                              type="submit"
                              className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Konfirmasi Void
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {state.transfers.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  Riwayat Transfer Antar Akun (Tidak Dihitung sebagai Pemasukan/Pengeluaran)
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {state.transfers.map((tr) => {
                  const from = state.accounts.find((a) => a.id === tr.fromAccountId)?.name;
                  const to = state.accounts.find((a) => a.id === tr.toAccountId)?.name;
                  return (
                    <div key={tr.id} className="px-5 py-3 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-semibold text-slate-900">
                          {from} → {to}
                        </p>
                        <p className="text-slate-500">
                          {formatDateID(tr.date)} {tr.notes ? `· ${tr.notes}` : ''}
                        </p>
                      </div>
                      <span className="font-mono-num font-bold text-[#0976A6]">
                        {formatIDR(tr.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Collapsible Audit / Change Log */}
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAuditLog((v) => !v)}
              className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50"
            >
              <span className="inline-flex items-center gap-2 font-display text-sm font-bold text-slate-900">
                <ClipboardList className="w-4 h-4 text-[#0976A6]" />
                Riwayat Perubahan & Audit ({(state.changeLogs ?? []).length})
              </span>
              <span className="text-xs font-semibold text-[#0976A6]">
                {showAuditLog ? 'Tutup' : 'Lihat Riwayat'}
              </span>
            </button>
            {showAuditLog && (
              <div className="border-t border-slate-100 divide-y divide-slate-100 max-h-72 overflow-y-auto">
                {(state.changeLogs ?? []).length === 0 ? (
                  <p className="px-5 py-4 text-xs text-slate-500">Belum ada catatan audit perubahan.</p>
                ) : (
                  (state.changeLogs ?? []).map((log) => (
                    <div key={log.id} className="px-5 py-3 text-xs space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{log.summary}</span>
                        <span className="text-[11px] text-slate-400 font-mono-num">
                          {new Date(log.timestamp).toLocaleString('id-ID')}
                        </span>
                      </div>
                      {(log.beforeValue || log.afterValue) && (
                        <p className="text-[11px] text-slate-500">
                          {log.beforeValue ? `Sebelum: ${log.beforeValue}` : ''}
                          {log.beforeValue && log.afterValue ? ' → ' : ''}
                          {log.afterValue ? `Sesudah: ${log.afterValue}` : ''}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: FREELANCE PROJECTS */}
      {subTab === 'freelance' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#B9E2F5] bg-[#E8F6FC] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[#064B6B]">
                Kas Bisnis Freelance Terpisah dari Uang Pribadi
              </p>
              <p className="text-xl font-extrabold font-mono-num text-slate-900 mt-0.5">
                {formatIDR(snapshot.businessBalance)}
              </p>
              <p className="text-[11px] text-[#075D83] mt-0.5">
                Nilai kontrak atau pembayaran berstatus &ldquo;Diharapkan&rdquo; tidak pernah masuk ke saldo kas sebelum benar-benar diterima.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {archivedProjects.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowArchivedProjects((v) => !v)}
                  className="rounded-xl border border-[#B9E2F5] bg-white px-3 py-2 text-xs font-semibold text-[#0976A6]"
                >
                  {showArchivedProjects
                    ? 'Sembunyikan Arsip'
                    : `Arsip (${archivedProjects.length})`}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowNewProject((v) => !v)}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0976A6] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[42px]"
              >
                <Briefcase className="w-4 h-4" />
                <span>Proyek Baru</span>
              </button>
            </div>
          </div>

          {showNewProject && (
            <form
              onSubmit={handleCreateProject}
              className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
            >
              <h3 className="font-display text-sm font-bold text-slate-900">
                Tambah Proyek Website / Freelance
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Nama Klien"
                  className="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                />
                <input
                  type="text"
                  required
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Nama Proyek (mis. Landing Page UMKM)"
                  className="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                />
                <input
                  type="number"
                  required
                  min={1}
                  value={contractValue}
                  onChange={(e) => setContractValue(e.target.value)}
                  placeholder="Nilai Kontrak (Rp)"
                  className="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-mono-num"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={paymentScheme}
                    onChange={(e) => setPaymentScheme(e.target.value as typeof paymentScheme)}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  >
                    <option value="dp_final">DP + Pelunasan</option>
                    <option value="milestone">Termin / Milestone</option>
                    <option value="full">Bayar Penuh</option>
                    <option value="custom">Kustom</option>
                  </select>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={businessSharePct}
                    onChange={(e) => setBusinessSharePct(e.target.value)}
                    placeholder="% Dana Bisnis"
                    className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-mono-num"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewProject(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#075D83]"
                >
                  Simpan Proyek
                </button>
              </div>
            </form>
          )}

          {snapshot.projectSummaries.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Belum ada proyek freelance aktif. Catat proyek pertama Anda untuk memisahkan omzet bisnis, biaya operasional, dan profit pribadi.
            </div>
          ) : (
            <div className="space-y-4">
              {snapshot.projectSummaries.map((ps) => {
                const payments = state.projectPayments.filter(
                  (p) => p.projectId === ps.project.id && !p.isVoided
                );
                const expenses = state.projectExpenses.filter(
                  (e) => e.projectId === ps.project.id && !e.isVoided
                );
                const isActionOpen = activeProjAction?.projectId === ps.project.id;

                return (
                  <div
                    key={ps.project.id}
                    className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <h3 className="font-display text-base font-bold text-slate-900">
                          {ps.project.projectName}
                        </h3>
                        <p className="text-xs text-slate-500">
                          Klien: {ps.project.clientName} · Retensi Bisnis {ps.project.businessSharePct}% / Pribadi {ps.project.personalSharePct}%
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveProjAction({ projectId: ps.project.id, mode: 'payment' });
                            setProjAmount('');
                            setProjDesc('');
                          }}
                          className="rounded-lg border border-[#B9E2F5] bg-[#E8F6FC] px-3 py-1.5 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9]"
                        >
                          + Pembayaran
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveProjAction({ projectId: ps.project.id, mode: 'expense' });
                            setProjAmount('');
                            setProjDesc('');
                          }}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          + Biaya Proyek
                        </button>
                        {ps.personalShare > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveProjAction({ projectId: ps.project.id, mode: 'distribute' });
                              setProjAmount(String(ps.personalShare));
                            }}
                            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                          >
                            Tarik Profit Pribadi
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onCommit(archiveProjectAction(state, ps.project.id))}
                          className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:text-slate-800"
                          title="Arsipkan proyek"
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
                      <div className="rounded-xl bg-slate-50 p-3">
                        <p className="text-slate-500">Nilai Kontrak</p>
                        <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                          {formatIDR(ps.project.contractValue)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-50 p-3">
                        <p className="text-slate-500">Diterima Aktual</p>
                        <p className="font-mono-num font-bold text-emerald-700 mt-0.5">
                          {formatIDR(ps.receivedAmount)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-50 p-3">
                        <p className="text-slate-500">Piutang Klien</p>
                        <p className="font-mono-num font-bold text-amber-700 mt-0.5">
                          {formatIDR(ps.outstandingReceivables)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-50 p-3">
                        <p className="text-slate-500">Biaya Proyek</p>
                        <p className="font-mono-num font-bold text-red-700 mt-0.5">
                          {formatIDR(ps.totalExpenses)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-50 p-3">
                        <p className="text-slate-500">Profit Bersih</p>
                        <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                          {formatIDR(ps.netProfit)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#E8F6FC] p-3">
                        <p className="text-[#075D83]">Jatah Pribadi / Bisnis</p>
                        <p className="font-mono-num font-bold text-slate-900 mt-0.5">
                          {formatIDR(ps.personalShare)} / {formatIDR(ps.businessRetained)}
                        </p>
                      </div>
                    </div>

                    {isActionOpen && (
                      <form
                        onSubmit={handleProjectActionSubmit}
                        className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-4 space-y-3"
                      >
                        <p className="text-xs font-bold text-slate-900">
                          {activeProjAction.mode === 'payment'
                            ? 'Catat Pembayaran Proyek (Diharapkan vs Diterima)'
                            : activeProjAction.mode === 'expense'
                            ? 'Catat Biaya Operasional Proyek (Domain/Hosting/API)'
                            : 'Tarik Profit Bersih Pribadi ke Akun Pribadi'}
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                          <input
                            type="number"
                            required
                            min={1}
                            value={projAmount}
                            onChange={(e) => setProjAmount(e.target.value)}
                            placeholder="Nominal (Rp)"
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono-num"
                          />
                          {activeProjAction.mode === 'payment' && (
                            <>
                              <select
                                value={projPayType}
                                onChange={(e) => setProjPayType(e.target.value as typeof projPayType)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                              >
                                <option value="dp">Uang Muka (DP)</option>
                                <option value="installment">Cicilan</option>
                                <option value="final">Pelunasan Akhir</option>
                                <option value="full">Bayar Penuh</option>
                              </select>
                              <select
                                value={projPayStatus}
                                onChange={(e) => setProjPayStatus(e.target.value as typeof projPayStatus)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                              >
                                <option value="received">Sudah Diterima (Masuk Kas)</option>
                                <option value="expected">Masih Diharapkan (Piutang)</option>
                              </select>
                            </>
                          )}
                          {activeProjAction.mode === 'expense' && (
                            <input
                              type="text"
                              required
                              value={projDesc}
                              onChange={(e) => setProjDesc(e.target.value)}
                              placeholder="Keperluan (mis. Domain .com)"
                              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs sm:col-span-2"
                            />
                          )}
                          {activeProjAction.mode === 'distribute' && (
                            <select
                              value={projTargetPersonalAccId}
                              onChange={(e) => setProjTargetPersonalAccId(e.target.value)}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs sm:col-span-2"
                            >
                              {snapshot.activeAccounts
                                .filter((a) => !a.isBusiness)
                                .map((a) => (
                                  <option key={a.id} value={a.id}>
                                    Kirim ke: {a.name}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="date"
                            value={projDate}
                            onChange={(e) => setProjDate(e.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setActiveProjAction(null)}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
                            >
                              Batal
                            </button>
                            <button
                              type="submit"
                              className="rounded-lg bg-[#0976A6] px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Simpan
                            </button>
                          </div>
                        </div>
                      </form>
                    )}

                    {(payments.length > 0 || expenses.length > 0) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-100 pt-3 text-xs">
                        <div className="space-y-1.5">
                          <p className="font-bold text-slate-700">Pembayaran Klien</p>
                          {payments.map((pay) => (
                            <div
                              key={pay.id}
                              className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
                            >
                              <div>
                                <p className="font-semibold text-slate-900 uppercase">
                                  {pay.paymentType} ·{' '}
                                  <span
                                    className={
                                      pay.status === 'received' ? 'text-emerald-700' : 'text-amber-700'
                                    }
                                  >
                                    {pay.status === 'received' ? 'Diterima' : 'Diharapkan'}
                                  </span>
                                </p>
                                <p className="text-[11px] text-slate-500">
                                  {formatDateID(pay.receivedDate ?? pay.expectedDate ?? '')}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono-num font-bold">{formatIDR(pay.amount)}</span>
                                {pay.status === 'expected' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onCommit(
                                        markProjectPaymentReceivedAction(
                                          state,
                                          pay.id,
                                          'acc-business',
                                          todayISO()
                                        )
                                      )
                                    }
                                    className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-white"
                                  >
                                    <CheckCircle2 className="w-3 h-3" />
                                    Terima
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="space-y-1.5">
                          <p className="font-bold text-slate-700">Biaya Operasional Proyek</p>
                          {expenses.length === 0 ? (
                            <p className="text-slate-400">Belum ada biaya operasional tercatat.</p>
                          ) : (
                            expenses.map((ex) => (
                              <div
                                key={ex.id}
                                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
                              >
                                <div>
                                  <p className="font-semibold text-slate-900">{ex.description}</p>
                                  <p className="text-[11px] text-slate-500">{formatDateID(ex.date)}</p>
                                </div>
                                <span className="font-mono-num font-bold text-red-700">
                                  -{formatIDR(ex.amount)}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {showArchivedProjects && archivedProjects.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="text-xs font-bold text-slate-700">Proyek Diarsipkan</p>
              {archivedProjects.map((ap) => (
                <div
                  key={ap.id}
                  className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-3.5 py-2.5 text-xs"
                >
                  <div>
                    <p className="font-semibold text-slate-800">{ap.projectName}</p>
                    <p className="text-slate-500">Klien: {ap.clientName}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onCommit(archiveProjectAction(state, ap.id))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-[#0976A6]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Pulihkan
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: ACCOUNTS (CREATE, EDIT, ARCHIVE, CLOSE, RECONCILE, DELETE) */}
      {subTab === 'accounts' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-slate-500">Total Aset Aktif & Terlindungi Lintas Akun</p>
              <p className="font-display text-2xl font-extrabold font-mono-num text-slate-900">
                {formatIDR(snapshot.totalNetAssets)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {archivedAccountsCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowInactiveAccounts((v) => !v)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
                >
                  {showInactiveAccounts
                    ? 'Tampilkan Akun Aktif Saja'
                    : `Arsip / Ditutup (${archivedAccountsCount})`}
                </button>
              )}
              <button
                type="button"
                onClick={openNewAccountForm}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83] min-h-[40px]"
              >
                <Wallet className="w-4 h-4" />
                <span>Tambah Akun</span>
              </button>
            </div>
          </div>

          {accError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">
              {accError}
            </div>
          )}

          {showAccForm && (
            <form
              onSubmit={handleSaveAccount}
              className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
            >
              <h3 className="font-display text-sm font-bold text-slate-900">
                {editingAccountId ? 'Edit Informasi Akun' : 'Tambah Akun / Dompet Baru'}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  required
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                  placeholder="Nama Akun (mis. SeaBank / GoPay)"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <select
                  value={accType}
                  onChange={(e) => setAccType(e.target.value as Account['accountType'])}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="cash">Tunai</option>
                  <option value="bank">Rekening Bank</option>
                  <option value="ewallet">E-Wallet</option>
                  <option value="savings">Tabungan Terlindungi</option>
                  <option value="investment">Akun Investasi</option>
                </select>
                <input
                  type="number"
                  min={0}
                  value={accOpening}
                  onChange={(e) => setAccOpening(e.target.value)}
                  placeholder="Saldo Awal (Rp)"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={accIsBiz}
                  onChange={(e) => setAccIsBiz(e.target.checked)}
                />
                <span>Tandai sebagai akun khusus Bisnis Freelance (terpisah dari kas pribadi)</span>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAccForm(false);
                    setEditingAccountId(null);
                  }}
                  className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white"
                >
                  {editingAccountId ? 'Simpan Perubahan' : 'Simpan Akun'}
                </button>
              </div>
            </form>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayedAccounts.map((acc) => {
              const status = acc.status ?? 'active';
              const isReconciling = reconcileAccId === acc.id;
              const reconcileDiff = isReconciling
                ? (Number(reconcileActual) || 0) - acc.currentBalance
                : 0;

              return (
                <div
                  key={acc.id}
                  className={`rounded-2xl border bg-white p-5 flex flex-col justify-between space-y-4 ${
                    status === 'active'
                      ? 'border-slate-200'
                      : 'border-slate-200 bg-slate-50/70 opacity-85'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-xs font-medium text-slate-500">
                          {accTypeLabels[acc.accountType]}
                          {acc.isBusiness ? ' · Bisnis' : acc.isProtected ? ' · Terlindungi' : ' · Likuid'}
                        </p>
                        {status !== 'active' && (
                          <span className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                            {status === 'archived' ? 'Diarsipkan' : 'Ditutup'}
                          </span>
                        )}
                      </div>
                      <h4 className="font-display text-base font-bold text-slate-900 mt-1">
                        {acc.name}
                      </h4>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditAccountForm(acc)}
                        className="p-1.5 text-slate-400 hover:text-[#0976A6] rounded-lg"
                        aria-label={`Edit ${acc.name}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteAccount(acc.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                        aria-label={`Hapus ${acc.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="font-mono-num text-xl font-extrabold text-slate-900">
                      {formatIDR(acc.currentBalance)}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono-num mt-0.5">
                      Saldo awal: {formatIDR(acc.openingBalance)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 text-[11px]">
                    {status === 'active' && (
                      <button
                        type="button"
                        onClick={() => {
                          setReconcileAccId(isReconciling ? null : acc.id);
                          setReconcileActual(String(acc.currentBalance));
                          setReconcileNote('');
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#B9E2F5] bg-[#E8F6FC] px-2.5 py-1 font-semibold text-[#0976A6]"
                      >
                        <Scale className="w-3 h-3" />
                        <span>Rekonsiliasi</span>
                      </button>
                    )}

                    {status !== 'closed' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleArchiveAccount(acc.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Archive className="w-3 h-3" />
                          <span>{status === 'archived' ? 'Aktifkan' : 'Arsipkan'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCloseAccount(acc.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-slate-600 hover:text-red-700"
                          title="Tutup akun permanen (wajib bersaldo Rp0)"
                        >
                          <Lock className="w-3 h-3" />
                          <span>Tutup</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onCommit(reopenAccountAction(state, acc.id))}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-[#0976A6]"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Buka Kembali</span>
                      </button>
                    )}
                  </div>

                  {isReconciling && (
                    <form
                      onSubmit={handleReconcileSubmit}
                      className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 p-3 space-y-2 text-xs"
                    >
                      <p className="font-bold text-slate-900">Rekonsiliasi Saldo Aktual</p>
                      <input
                        type="number"
                        min={0}
                        required
                        value={reconcileActual}
                        onChange={(e) => setReconcileActual(e.target.value)}
                        placeholder="Saldo fisik/bank aktual (Rp)"
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono-num"
                      />
                      <input
                        type="text"
                        value={reconcileNote}
                        onChange={(e) => setReconcileNote(e.target.value)}
                        placeholder="Catatan penyesuaian (opsional)"
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
                      />
                      <p className="text-[11px] text-slate-600 font-mono-num">
                        Selisih:{' '}
                        <strong className={reconcileDiff >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                          {reconcileDiff >= 0 ? '+' : ''}
                          {formatIDR(reconcileDiff)}
                        </strong>
                      </p>
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReconcileAccId(null)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-semibold"
                        >
                          Batal
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg bg-[#0976A6] px-2.5 py-1 font-semibold text-white"
                        >
                          Sesuaikan
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
