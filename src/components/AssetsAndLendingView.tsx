import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  DollarSign,
  History,
  Package,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import { FinanceSnapshot, isPhysicalLoanOverdue } from '../engine/financeEngine';
import {
  borrowPhysicalItemAction,
  cancelAssetCompensationAction,
  lendPhysicalAssetAction,
  purchaseAssetAction,
  recoverLostAssetAction,
  reportAssetLostAction,
  returnPhysicalItemAction,
  sellAssetAction,
  updateAssetConditionAction,
} from '../hooks/financeActions';
import {
  AssetCategory,
  AssetCondition,
  AssetPaymentMethod,
  FinanceState,
  PhysicalAsset,
  PhysicalItemLoan,
} from '../types/finance';
import { formatDateID, formatIDR, todayISO } from '../utils/format';

interface AssetsAndLendingViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
}

const CATEGORY_LABELS: Record<AssetCategory, string> = {
  electronics: 'Elektronik',
  vehicle: 'Kendaraan',
  gadget: 'Gadget / HP',
  equipment: 'Peralatan',
  furniture: 'Furnitur',
  other: 'Lainnya',
};

const CONDITION_LABELS: Record<AssetCondition, string> = {
  excellent: 'Sangat Baik',
  good: 'Baik',
  fair: 'Cukup / Terpakai',
  damaged: 'Rusak',
};

const PAYMENT_LABELS: Record<AssetPaymentMethod, string> = {
  cash: 'Tunai',
  credit: 'Kredit Penuh',
  credit_with_down_payment: 'Kredit + Uang Muka',
};

const ASSET_STATUS_STYLE: Record<PhysicalAsset['status'], { label: string; cls: string }> = {
  active: { label: 'Aktif Dimiliki', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  lent: { label: 'Dipinjamkan (Tetap Aset)', cls: 'bg-[#E8F6FC] text-[#0976A6] border-[#B9E2F5]' },
  sold: { label: 'Terjual', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  lost: { label: 'Hilang', cls: 'bg-red-50 text-red-800 border-red-200' },
  voided: { label: 'Void', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

type SubView = 'assets' | 'lending';
type ModalMode =
  | null
  | { type: 'purchase' }
  | { type: 'condition'; asset: PhysicalAsset }
  | { type: 'sell'; asset: PhysicalAsset }
  | { type: 'lost'; asset: PhysicalAsset }
  | { type: 'recover'; asset: PhysicalAsset }
  | { type: 'borrow' }
  | { type: 'lend'; preselectedAssetId?: string }
  | { type: 'return'; loan: PhysicalItemLoan };

export const AssetsAndLendingView: React.FC<AssetsAndLendingViewProps> = ({
  state,
  snapshot,
  onCommit,
}) => {
  const [subView, setSubView] = useState<SubView>('assets');
  const [searchQuery, setSearchQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<'all' | 'active' | 'lent' | 'sold' | 'lost'>('all');
  const [loanFilter, setLoanFilter] = useState<'all' | 'active' | 'overdue' | 'returned' | 'lost'>('all');
  const [expandedAssetIds, setExpandedAssetIds] = useState<Record<string, boolean>>({});
  const [expandedLoanIds, setExpandedLoanIds] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<ModalMode>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeAccounts = useMemo(
    () => snapshot.activeAccounts.filter((a) => !a.isBusiness),
    [snapshot.activeAccounts]
  );
  const allActiveAccounts = snapshot.activeAccounts;

  // Purchase form state
  const [pName, setPName] = useState('');
  const [pCat, setPCat] = useState<AssetCategory>('electronics');
  const [pDate, setPDate] = useState(todayISO());
  const [pValue, setPValue] = useState('');
  const [pCondition, setPCondition] = useState<AssetCondition>('excellent');
  const [pMethod, setPMethod] = useState<AssetPaymentMethod>('cash');
  const [pAccId, setPAccId] = useState(activeAccounts[0]?.id ?? allActiveAccounts[0]?.id ?? '');
  const [pDp, setPDp] = useState('');
  const [pCreditor, setPCreditor] = useState('');
  const [pDueDate, setPDueDate] = useState('');
  const [pBrand, setPBrand] = useState('');
  const [pSerial, setPSerial] = useState('');
  const [pNotes, setPNotes] = useState('');

  // Condition update state
  const [cCondition, setCCondition] = useState<AssetCondition>('good');
  const [cDate, setCDate] = useState(todayISO());
  const [cNote, setCNote] = useState('');

  // Sell form state
  const [sPrice, setSPrice] = useState('');
  const [sDate, setSDate] = useState(todayISO());
  const [sMode, setSMode] = useState<'cash' | 'receivable'>('cash');
  const [sAccId, setSAccId] = useState(activeAccounts[0]?.id ?? allActiveAccounts[0]?.id ?? '');
  const [sBuyer, setSBuyer] = useState('');
  const [sDueDate, setSDueDate] = useState('');
  const [sNotes, setSNotes] = useState('');

  // Lost form state
  const [lDate, setLDate] = useState(todayISO());
  const [lReason, setLReason] = useState('');
  const [lRequireComp, setLRequireComp] = useState(false);
  const [lLiable, setLLiable] = useState('');
  const [lCompAmount, setLCompAmount] = useState('');
  const [lCompDue, setLCompDue] = useState('');
  const [lNotes, setLNotes] = useState('');

  // Recover form state
  const [rDate, setRDate] = useState(todayISO());
  const [rCondition, setRCondition] = useState<AssetCondition>('good');
  const [rCancelComp, setRCancelComp] = useState(true);
  const [rCancelReason, setRCancelReason] = useState('');
  const [rNotes, setRNotes] = useState('');

  // Borrow form state
  const [bItem, setBItem] = useState('');
  const [bCat, setBCat] = useState<AssetCategory>('equipment');
  const [bOwner, setBOwner] = useState('');
  const [bDate, setBDate] = useState(todayISO());
  const [bExpected, setBExpected] = useState('');
  const [bCond, setBCond] = useState<AssetCondition>('good');
  const [bNotes, setBNotes] = useState('');

  // Lend form state
  const [lnAssetId, setLnAssetId] = useState('');
  const [lnBorrower, setLnBorrower] = useState('');
  const [lnDate, setLnDate] = useState(todayISO());
  const [lnExpected, setLnExpected] = useState('');
  const [lnCond, setLnCond] = useState<AssetCondition>('good');
  const [lnNotes, setLnNotes] = useState('');

  // Return loan form state
  const [rtDate, setRtDate] = useState(todayISO());
  const [rtCond, setRtCond] = useState<AssetCondition>('good');
  const [rtNotes, setRtNotes] = useState('');

  const assets = useMemo(
    () =>
      (state.physicalAssets ?? []).filter(
        (a) => !a.isVoided && !a.deletedAt && a.status !== 'voided'
      ),
    [state.physicalAssets]
  );

  const loans = useMemo(
    () =>
      (state.physicalItemLoans ?? []).filter(
        (l) => !l.isVoided && !l.deletedAt && l.status !== 'voided'
      ),
    [state.physicalItemLoans]
  );

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (assetFilter !== 'all' && a.status !== assetFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        CATEGORY_LABELS[a.category].toLowerCase().includes(q) ||
        (a.brandOrModel ?? '').toLowerCase().includes(q)
      );
    });
  }, [assets, assetFilter, searchQuery]);

  const filteredLoans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return loans.filter((l) => {
      const overdue = isPhysicalLoanOverdue(l, snapshot.nowISO);
      if (loanFilter === 'overdue' && !overdue) return false;
      if (loanFilter !== 'all' && loanFilter !== 'overdue' && l.status !== loanFilter) return false;
      if (!q) return true;
      return (
        l.itemName.toLowerCase().includes(q) ||
        l.counterpartyName.toLowerCase().includes(q)
      );
    });
  }, [loans, loanFilter, searchQuery, snapshot.nowISO]);

  const lendableAssets = useMemo(
    () => assets.filter((a) => a.status === 'active'),
    [assets]
  );

  const openPurchaseModal = () => {
    setErrorMsg(null);
    setPName('');
    setPCat('electronics');
    setPDate(todayISO());
    setPValue('');
    setPCondition('excellent');
    setPMethod('cash');
    setPAccId(activeAccounts[0]?.id ?? allActiveAccounts[0]?.id ?? '');
    setPDp('');
    setPCreditor('');
    setPDueDate('');
    setPBrand('');
    setPSerial('');
    setPNotes('');
    setModal({ type: 'purchase' });
  };

  const openBorrowModal = () => {
    setErrorMsg(null);
    setBItem('');
    setBCat('equipment');
    setBOwner('');
    setBDate(todayISO());
    setBExpected('');
    setBCond('good');
    setBNotes('');
    setModal({ type: 'borrow' });
  };

  const openLendModal = (preselectedAssetId?: string) => {
    setErrorMsg(null);
    const chosenId = preselectedAssetId ?? lendableAssets[0]?.id ?? '';
    const chosen = assets.find((a) => a.id === chosenId);
    setLnAssetId(chosenId);
    setLnBorrower('');
    setLnDate(todayISO());
    setLnExpected('');
    setLnCond(chosen?.condition ?? 'good');
    setLnNotes('');
    setModal({ type: 'lend', preselectedAssetId });
  };

  const openLostModal = (asset: PhysicalAsset) => {
    setErrorMsg(null);
    const activeLoan = loans.find(
      (l) => l.direction === 'lent' && l.assetId === asset.id && l.status === 'active'
    );
    setLDate(todayISO());
    setLReason('');
    setLRequireComp(Boolean(activeLoan));
    setLLiable(activeLoan?.counterpartyName ?? '');
    setLCompAmount(String(asset.acquisitionValue));
    setLCompDue('');
    setLNotes('');
    setModal({ type: 'lost', asset });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!modal) return;
    try {
      if (modal.type === 'purchase') {
        const res = purchaseAssetAction(state, {
          name: pName,
          category: pCat,
          acquisitionDate: pDate,
          acquisitionValue: Number(pValue),
          condition: pCondition,
          paymentMethod: pMethod,
          accountId: pMethod === 'credit' ? undefined : pAccId,
          downPaymentAmount: pMethod === 'credit_with_down_payment' ? Number(pDp) : undefined,
          creditor: pMethod === 'cash' ? undefined : pCreditor,
          dueDate: pMethod === 'cash' ? undefined : pDueDate || undefined,
          brandOrModel: pBrand || undefined,
          serialNumber: pSerial || undefined,
          notes: pNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'condition') {
        const next = updateAssetConditionAction(state, {
          assetId: modal.asset.id,
          condition: cCondition,
          date: cDate,
          note: cNote,
        });
        onCommit(next);
      } else if (modal.type === 'sell') {
        const res = sellAssetAction(state, {
          assetId: modal.asset.id,
          salePrice: Number(sPrice),
          soldDate: sDate,
          proceedsMode: sMode,
          accountId: sMode === 'cash' ? sAccId : undefined,
          buyerName: sBuyer || undefined,
          dueDate: sMode === 'receivable' ? sDueDate || undefined : undefined,
          notes: sNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'lost') {
        const res = reportAssetLostAction(state, {
          assetId: modal.asset.id,
          lostDate: lDate,
          reason: lReason,
          requireCompensation: lRequireComp,
          liableParty: lRequireComp ? lLiable : undefined,
          compensationAmount: lRequireComp ? Number(lCompAmount) : undefined,
          compensationDueDate: lRequireComp ? lCompDue || undefined : undefined,
          notes: lNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'recover') {
        const res = recoverLostAssetAction(state, {
          assetId: modal.asset.id,
          recoveredDate: rDate,
          condition: rCondition,
          cancelUnpaidCompensation: rCancelComp,
          cancelReason: rCancelReason || undefined,
          notes: rNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'borrow') {
        const res = borrowPhysicalItemAction(state, {
          itemName: bItem,
          category: bCat,
          ownerName: bOwner,
          loanDate: bDate,
          expectedReturnDate: bExpected || undefined,
          conditionReceived: bCond,
          notes: bNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'lend') {
        const res = lendPhysicalAssetAction(state, {
          assetId: lnAssetId,
          borrowerName: lnBorrower,
          loanDate: lnDate,
          expectedReturnDate: lnExpected || undefined,
          conditionGiven: lnCond,
          notes: lnNotes || undefined,
        });
        onCommit(res.state);
      } else if (modal.type === 'return') {
        const next = returnPhysicalItemAction(state, {
          loanId: modal.loan.id,
          returnedDate: rtDate,
          conditionReturned: rtCond,
          notes: rtNotes || undefined,
        });
        onCommit(next);
      }
      setModal(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Terjadi kesalahan saat memproses data.');
    }
  };

  const handleCancelUnpaidComp = (asset: PhysicalAsset, lossId: string) => {
    setErrorMsg(null);
    try {
      const next = cancelAssetCompensationAction(state, {
        assetId: asset.id,
        lossRecordId: lossId,
        reason: 'Piutang ganti rugi dibatalkan oleh pengguna',
      });
      onCommit(next);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membatalkan piutang ganti rugi.');
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Total Nilai Aset Dimiliki</p>
          <p className="font-mono-num text-xl font-extrabold text-slate-900 mt-1">
            {formatIDR(snapshot.physicalAssetsTotal)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 font-mono-num">
            {snapshot.physicalAssetsCount} aset aktif · {snapshot.lentAssetsActiveCount} dipinjamkan
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Peminjaman Barang Fisik</p>
          <p className="font-mono-num text-xl font-extrabold text-[#0976A6] mt-1">
            {snapshot.lentLoansActiveCount + snapshot.borrowedItemsActiveCount} aktif
          </p>
          <p className="text-[11px] text-slate-500 mt-1 font-mono-num">
            {snapshot.lentLoansActiveCount} dipinjamkan · {snapshot.borrowedItemsActiveCount} pinjaman
            {snapshot.overdueItemLoansCount > 0 && ` · ${snapshot.overdueItemLoansCount} terlambat`}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Laba / Rugi Penjualan Aset</p>
          <p
            className={`font-mono-num text-xl font-extrabold mt-1 ${
              snapshot.assetSaleGainLossTotal >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {snapshot.assetSaleGainLossTotal >= 0 ? '+' : ''}
            {formatIDR(snapshot.assetSaleGainLossTotal)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Selisih harga jual vs nilai perolehan</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Nilai Aset Hilang</p>
          <p className="font-mono-num text-xl font-extrabold text-red-700 mt-1">
            {formatIDR(snapshot.assetCurrentLostValueTotal)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 font-mono-num">
            Riwayat kehilangan total: {formatIDR(snapshot.assetHistoricalLossTotal)}
          </p>
        </div>
      </div>

      {/* Sub-navigation & Primary Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 self-start">
          <button
            type="button"
            onClick={() => {
              setSubView('assets');
              setErrorMsg(null);
            }}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              subView === 'assets'
                ? 'bg-white text-[#0976A6] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Aset Fisik Dimiliki ({assets.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSubView('lending');
              setErrorMsg(null);
            }}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              subView === 'lending'
                ? 'bg-white text-[#0976A6] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Peminjaman Barang ({loans.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:w-52">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={subView === 'assets' ? 'Cari aset fisik...' : 'Cari barang/pihak...'}
              className="w-full rounded-xl border border-slate-200 bg-white pl-8 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-[#0976A6] focus:outline-none"
            />
          </div>

          {subView === 'assets' ? (
            <button
              type="button"
              onClick={openPurchaseModal}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83] whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>Tambah / Beli Aset</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={openBorrowModal}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <ArrowDownLeft className="w-4 h-4 text-slate-600" />
                <span>Pinjam Barang Orang</span>
              </button>
              <button
                type="button"
                onClick={() => openLendModal()}
                disabled={lendableAssets.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0976A6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#075D83] disabled:opacity-50 whitespace-nowrap"
              >
                <ArrowUpRight className="w-4 h-4" />
                <span>Pinjamkan Aset Saya</span>
              </button>
            </>
          )}
        </div>
      </div>

      {errorMsg && !modal && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 flex items-center justify-between gap-2">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-red-700 hover:underline font-semibold">
            Tutup
          </button>
        </div>
      )}

      {/* SUBVIEW: ASSETS */}
      {subView === 'assets' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'Semua' },
                  { id: 'active', label: 'Aktif' },
                  { id: 'lent', label: 'Dipinjamkan' },
                  { id: 'sold', label: 'Terjual' },
                  { id: 'lost', label: 'Hilang' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setAssetFilter(f.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    assetFilter === f.id
                      ? 'border-[#0976A6] bg-[#E8F6FC] text-[#0976A6]'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              Pembelian aset bukan pengeluaran konsumsi &amp; tidak memengaruhi Dana Aman secara konsumtif. Aset masuk ke Kekayaan Bersih Pribadi.
            </p>
          </div>

          {filteredAssets.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center space-y-2.5">
              <Package className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-800">
                Belum ada aset fisik pada filter ini
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Catat barang tahan lama bernilai milik Anda (laptop, smartphone, motor, elektronik) agar kekayaan bersih dan riwayat perolehan tercatat utuh.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAssets.map((asset) => {
                const statusBadge = ASSET_STATUS_STYLE[asset.status];
                const linkedDebt = asset.purchaseDebtId
                  ? state.debts.find((d) => d.id === asset.purchaseDebtId && !d.isVoided)
                  : undefined;
                const activeLoan = loans.find(
                  (l) => l.direction === 'lent' && l.assetId === asset.id && l.status === 'active'
                );
                const latestLoss = asset.lossHistory?.[0];
                const compDebt = latestLoss?.compensationDebtId
                  ? state.debts.find((d) => d.id === latestLoss.compensationDebtId && !d.isVoided)
                  : undefined;
                const compHasPaid = compDebt
                  ? state.debtPayments.some((dp) => dp.debtId === compDebt.id && !dp.isVoided)
                  : false;
                const expanded = Boolean(expandedAssetIds[asset.id]);

                return (
                  <article
                    key={asset.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-base font-bold text-slate-900">
                            {asset.name}
                          </h3>
                          <span
                            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusBadge.cls}`}
                          >
                            {statusBadge.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {CATEGORY_LABELS[asset.category]}
                          <span aria-hidden="true"> · </span>
                          Perolehan {formatDateID(asset.acquisitionDate)}
                          <span aria-hidden="true"> · </span>
                          {PAYMENT_LABELS[asset.paymentMethod]}
                          <span aria-hidden="true"> · </span>
                          Kondisi: {CONDITION_LABELS[asset.condition]}
                        </p>
                        {(asset.brandOrModel || asset.serialNumber) && (
                          <p className="text-[11px] text-slate-500">
                            {asset.brandOrModel}
                            {asset.brandOrModel && asset.serialNumber && ' · '}
                            {asset.serialNumber && `SN: ${asset.serialNumber}`}
                          </p>
                        )}
                      </div>

                      <div className="sm:text-right shrink-0">
                        <p className="text-[11px] text-slate-500">Nilai Perolehan</p>
                        <p className="font-mono-num text-lg font-extrabold text-slate-900">
                          {formatIDR(asset.acquisitionValue)}
                        </p>
                        {linkedDebt && (
                          <p className="text-[11px] font-mono-num text-slate-600 mt-0.5">
                            Utang cicilan ke {linkedDebt.creditor}: sisa{' '}
                            <span className="font-semibold text-red-700">
                              {formatIDR(linkedDebt.remainingAmount)}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Active Lent Info */}
                    {asset.status === 'lent' && activeLoan && (
                      <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/60 px-3.5 py-2.5 text-xs text-slate-800 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          Dipinjam oleh <span className="font-semibold">{activeLoan.counterpartyName}</span> sejak{' '}
                          {formatDateID(activeLoan.loanDate)}
                          {activeLoan.expectedReturnDate && ` · Rencana kembali ${formatDateID(activeLoan.expectedReturnDate)}`}
                          . Barang tetap dihitung dalam aset milik Anda.
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSubView('lending');
                          }}
                          className="text-[#0976A6] font-semibold hover:underline"
                        >
                          Lihat di Peminjaman
                        </button>
                      </div>
                    )}

                    {/* Disposal / Sale Details */}
                    {asset.status === 'sold' && asset.disposal && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          Terjual {formatDateID(asset.disposal.soldDate)} ({asset.disposal.proceedsMode === 'cash' ? 'Tunai ke kas' : `Piutang ke ${asset.disposal.buyerName ?? 'Pembeli'}`})
                          sebesar <span className="font-mono-num font-bold text-slate-900">{formatIDR(asset.disposal.salePrice)}</span>
                        </div>
                        <div
                          className={`font-mono-num font-bold ${
                            asset.disposal.gainOrLoss >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {asset.disposal.gainOrLoss >= 0 ? 'Laba Pelepasan +' : 'Rugi Pelepasan -'}
                          {formatIDR(Math.abs(asset.disposal.gainOrLoss))}
                        </div>
                      </div>
                    )}

                    {/* Lost Details */}
                    {asset.status === 'lost' && latestLoss && (
                      <div className="rounded-xl border border-red-200 bg-red-50/70 px-3.5 py-2.5 text-xs text-red-950 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            Hilang {formatDateID(latestLoss.lostDate)} · {latestLoss.reason}
                          </span>
                          <span className="font-mono-num font-bold">
                            Kerugian nilai aset: {formatIDR(latestLoss.lossAmount)}
                          </span>
                        </div>
                        {compDebt && (
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-red-200/70">
                            <span>
                              Piutang ganti rugi ({compDebt.creditor}):{' '}
                              <span className="font-mono-num font-bold">
                                {formatIDR(compDebt.remainingAmount)}
                              </span>{' '}
                              dari {formatIDR(compDebt.initialAmount)}
                            </span>
                            {!compHasPaid && compDebt.remainingAmount > 0 && (
                              <button
                                type="button"
                                onClick={() => handleCancelUnpaidComp(asset, latestLoss.id)}
                                className="font-semibold text-red-800 hover:underline"
                              >
                                Batalkan Piutang Ganti Rugi
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action Row */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100">
                      <div className="flex flex-wrap items-center gap-2">
                        {asset.status === 'active' && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setErrorMsg(null);
                                setCCondition(asset.condition);
                                setCDate(todayISO());
                                setCNote('');
                                setModal({ type: 'condition', asset });
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              <Wrench className="w-3.5 h-3.5" />
                              <span>Ubah Kondisi</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openLendModal(asset.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-[#B9E2F5] bg-[#E8F6FC] px-2.5 py-1.5 text-xs font-semibold text-[#0976A6] hover:bg-[#D5EEF9]"
                            >
                              <ArrowUpRight className="w-3.5 h-3.5" />
                              <span>Pinjamkan</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setErrorMsg(null);
                                setSPrice(String(asset.acquisitionValue));
                                setSDate(todayISO());
                                setSMode('cash');
                                setSAccId(activeAccounts[0]?.id ?? allActiveAccounts[0]?.id ?? '');
                                setSBuyer('');
                                setSDueDate('');
                                setSNotes('');
                                setModal({ type: 'sell', asset });
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              <DollarSign className="w-3.5 h-3.5" />
                              <span>Jual Aset</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openLostModal(asset)}
                              className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                            >
                              <ShieldAlert className="w-3.5 h-3.5" />
                              <span>Catat Hilang</span>
                            </button>
                          </>
                        )}

                        {asset.status === 'lent' && (
                          <button
                            type="button"
                            onClick={() => openLostModal(asset)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            <span>Laporkan Hilang</span>
                          </button>
                        )}

                        {asset.status === 'lost' && (
                          <button
                            type="button"
                            onClick={() => {
                              setErrorMsg(null);
                              setRDate(todayISO());
                              setRCondition(asset.condition);
                              setRCancelComp(Boolean(compDebt && !compHasPaid));
                              setRCancelReason('');
                              setRNotes('');
                              setModal({ type: 'recover', asset });
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Aset Ditemukan Kembali</span>
                          </button>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedAssetIds((prev) => ({
                            ...prev,
                            [asset.id]: !prev[asset.id],
                          }))
                        }
                        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 ml-auto"
                      >
                        <History className="w-3.5 h-3.5" />
                        <span>Riwayat ({(asset.conditionHistory?.length ?? 0) + (asset.lossHistory?.length ?? 0) + (asset.recoveryHistory?.length ?? 0)})</span>
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {expanded && (
                      <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 space-y-2.5 text-xs">
                        {asset.recoveryHistory && asset.recoveryHistory.length > 0 && (
                          <div className="space-y-1">
                            <p className="font-semibold text-emerald-800">Riwayat Pemulihan:</p>
                            {asset.recoveryHistory.map((rr) => (
                              <p key={rr.id} className="text-slate-700">
                                {formatDateID(rr.recoveredDate)} · Kondisi {CONDITION_LABELS[rr.condition]}
                                {rr.compensationCancelled && ' · Piutang ganti rugi dibatalkan'}
                                {rr.notes && ` · ${rr.notes}`}
                              </p>
                            ))}
                          </div>
                        )}
                        {asset.lossHistory && asset.lossHistory.length > 0 && (
                          <div className="space-y-1">
                            <p className="font-semibold text-red-800">Riwayat Kehilangan:</p>
                            {asset.lossHistory.map((lr) => (
                              <p key={lr.id} className="text-slate-700">
                                {formatDateID(lr.lostDate)} · {lr.reason} · Nilai {formatIDR(lr.lossAmount)}
                                {lr.compensationAmount ? ` · Ganti rugi ${formatIDR(lr.compensationAmount)} (${lr.liableParty ?? '-'})` : ''}
                                {lr.compensationCancelled && ' [Ganti rugi dibatalkan]'}
                              </p>
                            ))}
                          </div>
                        )}
                        <div className="space-y-1">
                          <p className="font-semibold text-slate-700">Riwayat Kondisi:</p>
                          {(asset.conditionHistory ?? []).map((ch) => (
                            <p key={ch.id} className="text-slate-600">
                              {formatDateID(ch.date)} ·{' '}
                              {ch.previousCondition
                                ? `${CONDITION_LABELS[ch.previousCondition]} → ${CONDITION_LABELS[ch.condition]}`
                                : CONDITION_LABELS[ch.condition]}
                              {ch.note && ` · ${ch.note}`}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SUBVIEW: PHYSICAL ITEM LENDING */}
      {subView === 'lending' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'Semua' },
                  { id: 'active', label: 'Aktif' },
                  { id: 'overdue', label: 'Terlambat' },
                  { id: 'returned', label: 'Dikembalikan' },
                  { id: 'lost', label: 'Hilang' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setLoanFilter(f.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    loanFilter === f.id
                      ? 'border-[#0976A6] bg-[#E8F6FC] text-[#0976A6]'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              Peminjaman fisik tidak memengaruhi kas, pemasukan, pengeluaran, utang, maupun piutang kecuali terjadi kehilangan dengan ganti rugi.
            </p>
          </div>

          {filteredLoans.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center space-y-2.5">
              <Clock className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-800">
                Belum ada catatan peminjaman barang fisik
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Catat barang milik orang lain yang Anda pinjam maupun aset Anda yang dipinjamkan ke pihak lain beserta pengingat tanggal kembali dan kondisi fisiknya.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredLoans.map((loan) => {
                const overdue = isPhysicalLoanOverdue(loan, snapshot.nowISO);
                const expanded = Boolean(expandedLoanIds[loan.id]);
                const linkedAsset = loan.assetId
                  ? assets.find((a) => a.id === loan.assetId)
                  : undefined;

                const statusLabel =
                  loan.status === 'returned'
                    ? 'Dikembalikan'
                    : loan.status === 'lost'
                    ? 'Hilang'
                    : overdue
                    ? 'Terlambat'
                    : 'Aktif';
                const statusCls =
                  loan.status === 'returned'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : loan.status === 'lost' || overdue
                    ? 'bg-red-50 text-red-800 border-red-200'
                    : 'bg-[#E8F6FC] text-[#0976A6] border-[#B9E2F5]';

                return (
                  <article
                    key={loan.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-[#0976A6]">
                            {loan.direction === 'lent' ? 'Aset Anda Dipinjamkan' : 'Pinjam Barang Orang Lain (Bukan Aset)'}
                          </span>
                          <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusCls}`}>
                            {statusLabel}
                          </span>
                        </div>
                        <h3 className="font-display text-base font-bold text-slate-900">
                          {loan.itemName}
                        </h3>
                        <p className="text-xs text-slate-500">
                          {loan.direction === 'lent' ? 'Peminjam' : 'Pemilik'}: {loan.counterpartyName}
                          <span aria-hidden="true"> · </span>
                          Tanggal Pinjam {formatDateID(loan.loanDate)}
                          {loan.expectedReturnDate && (
                            <>
                              <span aria-hidden="true"> · </span>
                              Target Kembali {formatDateID(loan.expectedReturnDate)}
                            </>
                          )}
                        </p>
                        <p className="text-xs text-slate-500">
                          Kondisi Awal: {CONDITION_LABELS[loan.conditionGivenOrReceived]}
                          {loan.returnedDate && (
                            <>
                              <span aria-hidden="true"> · </span>
                              Dikembalikan {formatDateID(loan.returnedDate)} (Kondisi:{' '}
                              {loan.conditionReturned ? CONDITION_LABELS[loan.conditionReturned] : '-'})
                            </>
                          )}
                        </p>
                      </div>

                      {linkedAsset && (
                        <div className="sm:text-right shrink-0">
                          <p className="text-[11px] text-slate-500">Nilai Aset Tetap Tercatat</p>
                          <p className="font-mono-num text-sm font-bold text-slate-900">
                            {formatIDR(linkedAsset.acquisitionValue)}
                          </p>
                        </div>
                      )}
                    </div>

                    {overdue && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                        <span>
                          Melewati target tanggal pengembalian ({formatDateID(loan.expectedReturnDate!)}). Segera konfirmasi pengembalian atau tindak lanjuti.
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100">
                      <div className="flex flex-wrap items-center gap-2">
                        {loan.status === 'active' && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setErrorMsg(null);
                                setRtDate(todayISO());
                                setRtCond(loan.conditionGivenOrReceived);
                                setRtNotes('');
                                setModal({ type: 'return', loan });
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Catat Pengembalian</span>
                            </button>
                            {loan.direction === 'lent' && linkedAsset && (
                              <button
                                type="button"
                                onClick={() => openLostModal(linkedAsset)}
                                className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                              >
                                <ShieldAlert className="w-3.5 h-3.5" />
                                <span>Catat Hilang &amp; Ganti Rugi</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedLoanIds((prev) => ({
                            ...prev,
                            [loan.id]: !prev[loan.id],
                          }))
                        }
                        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 ml-auto"
                      >
                        <History className="w-3.5 h-3.5" />
                        <span>Riwayat Kondisi ({loan.conditionHistory?.length ?? 0})</span>
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {expanded && (
                      <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 space-y-1 text-xs">
                        {(loan.conditionHistory ?? []).map((ch) => (
                          <p key={ch.id} className="text-slate-600">
                            {formatDateID(ch.date)} ·{' '}
                            {ch.previousCondition
                              ? `${CONDITION_LABELS[ch.previousCondition]} → ${CONDITION_LABELS[ch.condition]}`
                              : CONDITION_LABELS[ch.condition]}
                            {ch.note && ` · ${ch.note}`}
                          </p>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODALS */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-slate-900">
                {modal.type === 'purchase' && 'Catat Pembelian / Perolehan Aset Fisik'}
                {modal.type === 'condition' && `Perbarui Kondisi: ${modal.asset.name}`}
                {modal.type === 'sell' && `Jual / Lepas Aset: ${modal.asset.name}`}
                {modal.type === 'lost' && `Catat Kehilangan Aset: ${modal.asset.name}`}
                {modal.type === 'recover' && `Pemulihan Aset: ${modal.asset.name}`}
                {modal.type === 'borrow' && 'Catat Pinjam Barang Milik Orang Lain'}
                {modal.type === 'lend' && 'Pinjamkan Aset Milik Sendiri'}
                {modal.type === 'return' && `Catat Pengembalian: ${modal.loan.itemName}`}
              </h3>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Tutup"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
              {errorMsg && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-900">
                  {errorMsg}
                </div>
              )}

              {modal.type === 'purchase' && (
                <>
                  <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
                    {(['cash', 'credit', 'credit_with_down_payment'] as AssetPaymentMethod[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPMethod(m)}
                        className={`rounded-lg py-2 px-2 text-[11px] font-semibold transition-colors ${
                          pMethod === m ? 'bg-white text-[#0976A6] shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        {PAYMENT_LABELS[m]}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Nama Aset</label>
                      <input
                        type="text"
                        required
                        value={pName}
                        onChange={(e) => setPName(e.target.value)}
                        placeholder="Misal: Laptop Kerja MacBook / Motor Harian"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kategori</label>
                      <select
                        value={pCat}
                        onChange={(e) => setPCat(e.target.value as AssetCategory)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Perolehan</label>
                      <input
                        type="date"
                        required
                        value={pDate}
                        onChange={(e) => setPDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Nilai Perolehan Total (Rp)</label>
                      <input
                        type="number"
                        required
                        min={1}
                        value={pValue}
                        onChange={(e) => setPValue(e.target.value)}
                        placeholder="5000000"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kondisi Saat Ini</label>
                      <select
                        value={pCondition}
                        onChange={(e) => setPCondition(e.target.value as AssetCondition)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    {pMethod !== 'credit' && (
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          {pMethod === 'cash' ? 'Akun Pembayaran' : 'Akun Pembayaran DP'}
                        </label>
                        <select
                          value={pAccId}
                          onChange={(e) => setPAccId(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                        >
                          {allActiveAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              {acc.name} ({formatIDR(acc.currentBalance)})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {pMethod === 'credit_with_down_payment' && (
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">Nominal Uang Muka / DP (Rp)</label>
                        <input
                          type="number"
                          required
                          min={1}
                          value={pDp}
                          onChange={(e) => setPDp(e.target.value)}
                          placeholder="1000000"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-[#0976A6] focus:outline-none"
                        />
                      </div>
                    )}
                    {pMethod !== 'cash' && (
                      <>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">Pihak Pemberi Kredit</label>
                          <input
                            type="text"
                            required
                            value={pCreditor}
                            onChange={(e) => setPCreditor(e.target.value)}
                            placeholder="Toko / Leasing / Bank"
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">Jatuh Tempo Kredit (Opsional)</label>
                          <input
                            type="date"
                            value={pDueDate}
                            onChange={(e) => setPDueDate(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                          />
                        </div>
                      </>
                    )}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Merek / Model (Opsional)</label>
                      <input
                        type="text"
                        value={pBrand}
                        onChange={(e) => setPBrand(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Nomor Seri (Opsional)</label>
                      <input
                        type="text"
                        value={pSerial}
                        onChange={(e) => setPSerial(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Catatan (Opsional)</label>
                      <input
                        type="text"
                        value={pNotes}
                        onChange={(e) => setPNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {modal.type === 'condition' && (
                <>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Kondisi Baru</label>
                    <select
                      value={cCondition}
                      onChange={(e) => setCCondition(e.target.value as AssetCondition)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                    >
                      {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Tanggal Pembaruan</label>
                    <input
                      type="date"
                      required
                      value={cDate}
                      onChange={(e) => setCDate(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Catatan Kondisi</label>
                    <input
                      type="text"
                      value={cNote}
                      onChange={(e) => setCNote(e.target.value)}
                      placeholder="Misal: Ganti baterai / lecet pemakaian"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                    />
                  </div>
                </>
              )}

              {modal.type === 'sell' && (
                <>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-slate-700">
                    Nilai perolehan tercatat: <span className="font-mono-num font-bold">{formatIDR(modal.asset.acquisitionValue)}</span>. Hasil penjualan aset tidak dicatat sebagai penghasilan operasional.
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => setSMode('cash')}
                      className={`rounded-lg py-2 text-xs font-semibold ${
                        sMode === 'cash' ? 'bg-white text-[#0976A6] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Terima Kas Langsung
                    </button>
                    <button
                      type="button"
                      onClick={() => setSMode('receivable')}
                      className={`rounded-lg py-2 text-xs font-semibold ${
                        sMode === 'receivable' ? 'bg-white text-[#0976A6] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Jual Kredit (Piutang)
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Harga Jual (Rp)</label>
                      <input
                        type="number"
                        required
                        min={1}
                        value={sPrice}
                        onChange={(e) => setSPrice(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Jual</label>
                      <input
                        type="date"
                        required
                        value={sDate}
                        onChange={(e) => setSDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    {sMode === 'cash' ? (
                      <div className="sm:col-span-2">
                        <label className="block font-semibold text-slate-700 mb-1">Akun Penerima</label>
                        <select
                          value={sAccId}
                          onChange={(e) => setSAccId(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                        >
                          {allActiveAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              {acc.name} ({formatIDR(acc.currentBalance)})
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">Nama Pembeli</label>
                          <input
                            type="text"
                            required
                            value={sBuyer}
                            onChange={(e) => setSBuyer(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">Jatuh Tempo Piutang</label>
                          <input
                            type="date"
                            value={sDueDate}
                            onChange={(e) => setSDueDate(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                          />
                        </div>
                      </>
                    )}
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Catatan (Opsional)</label>
                      <input
                        type="text"
                        value={sNotes}
                        onChange={(e) => setSNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {modal.type === 'lost' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Kejadian</label>
                      <input
                        type="date"
                        required
                        value={lDate}
                        onChange={(e) => setLDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Alasan / Kronologi</label>
                      <input
                        type="text"
                        required
                        value={lReason}
                        onChange={(e) => setLReason(e.target.value)}
                        placeholder="Hilang / Dicuri / Rusak total"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 font-semibold text-slate-800 pt-1">
                    <input
                      type="checkbox"
                      checked={lRequireComp}
                      onChange={(e) => setLRequireComp(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    <span>Catat piutang ganti rugi dari pihak yang bertanggung jawab</span>
                  </label>
                  {lRequireComp && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">Pihak Penanggung</label>
                        <input
                          type="text"
                          required
                          value={lLiable}
                          onChange={(e) => setLLiable(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">Nominal Ganti Rugi (Rp)</label>
                        <input
                          type="number"
                          required
                          min={1}
                          value={lCompAmount}
                          onChange={(e) => setLCompAmount(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-mono-num focus:border-[#0976A6] focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block font-semibold text-slate-700 mb-1">Jatuh Tempo Ganti Rugi (Opsional)</label>
                        <input
                          type="date"
                          value={lCompDue}
                          onChange={(e) => setLCompDue(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                        />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Catatan (Opsional)</label>
                    <input
                      type="text"
                      value={lNotes}
                      onChange={(e) => setLNotes(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                    />
                  </div>
                </>
              )}

              {modal.type === 'recover' && (
                <>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
                    Memulihkan aset akan mengembalikan nilai <span className="font-mono-num font-bold">{formatIDR(modal.asset.acquisitionValue)}</span> ke total aset aktif Anda tanpa menghapus riwayat kehilangan historis.
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Ditemukan</label>
                      <input
                        type="date"
                        required
                        value={rDate}
                        onChange={(e) => setRDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kondisi Ditemukan</label>
                      <select
                        value={rCondition}
                        onChange={(e) => setRCondition(e.target.value as AssetCondition)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {Boolean(modal.asset.lossHistory?.[0]?.compensationDebtId) && (
                    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <label className="flex items-center gap-2 font-semibold text-slate-800">
                        <input
                          type="checkbox"
                          checked={rCancelComp}
                          onChange={(e) => setRCancelComp(e.target.checked)}
                          className="rounded border-slate-300"
                        />
                        <span>Batalkan piutang ganti rugi yang belum dibayar</span>
                      </label>
                      {rCancelComp && (
                        <input
                          type="text"
                          value={rCancelReason}
                          onChange={(e) => setRCancelReason(e.target.value)}
                          placeholder="Alasan pembatalan ganti rugi (opsional)"
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                        />
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Catatan Pemulihan (Opsional)</label>
                    <input
                      type="text"
                      value={rNotes}
                      onChange={(e) => setRNotes(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                    />
                  </div>
                </>
              )}

              {modal.type === 'borrow' && (
                <>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-700">
                    Barang milik orang lain yang dipinjam tidak akan dicatat sebagai aset milik Anda dan tidak memengaruhi saldo kas atau utang uang.
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Nama Barang</label>
                      <input
                        type="text"
                        required
                        value={bItem}
                        onChange={(e) => setBItem(e.target.value)}
                        placeholder="Misal: Kamera Mirrorless / Bor Listrik"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Nama Pemilik Barang</label>
                      <input
                        type="text"
                        required
                        value={bOwner}
                        onChange={(e) => setBOwner(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Pinjam</label>
                      <input
                        type="date"
                        required
                        value={bDate}
                        onChange={(e) => setBDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Target Dikembalikan</label>
                      <input
                        type="date"
                        value={bExpected}
                        onChange={(e) => setBExpected(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kategori Barang</label>
                      <select
                        value={bCat}
                        onChange={(e) => setBCat(e.target.value as AssetCategory)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kondisi Diterima</label>
                      <select
                        value={bCond}
                        onChange={(e) => setBCond(e.target.value as AssetCondition)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Catatan (Opsional)</label>
                      <input
                        type="text"
                        value={bNotes}
                        onChange={(e) => setBNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {modal.type === 'lend' && (
                <>
                  <div className="rounded-xl border border-[#B9E2F5] bg-[#E8F6FC]/70 p-3 text-slate-800">
                    Aset yang dipinjamkan ke orang lain tetap tercatat dalam total nilai aset milik Anda tanpa memengaruhi kas maupun piutang uang.
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Pilih Aset Milik Anda</label>
                      <select
                        value={lnAssetId}
                        onChange={(e) => setLnAssetId(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {lendableAssets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({formatIDR(a.acquisitionValue)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Nama Peminjam</label>
                      <input
                        type="text"
                        required
                        value={lnBorrower}
                        onChange={(e) => setLnBorrower(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kondisi Diserahkan</label>
                      <select
                        value={lnCond}
                        onChange={(e) => setLnCond(e.target.value as AssetCondition)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Dipinjamkan</label>
                      <input
                        type="date"
                        required
                        value={lnDate}
                        onChange={(e) => setLnDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Target Kembali (Opsional)</label>
                      <input
                        type="date"
                        value={lnExpected}
                        onChange={(e) => setLnExpected(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Catatan (Opsional)</label>
                      <input
                        type="text"
                        value={lnNotes}
                        onChange={(e) => setLnNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {modal.type === 'return' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Tanggal Dikembalikan</label>
                      <input
                        type="date"
                        required
                        value={rtDate}
                        onChange={(e) => setRtDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Kondisi Saat Kembali</label>
                      <select
                        value={rtCond}
                        onChange={(e) => setRtCond(e.target.value as AssetCondition)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      >
                        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Catatan Pengembalian (Opsional)</label>
                      <input
                        type="text"
                        value={rtNotes}
                        onChange={(e) => setRtNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-[#0976A6] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setModal(null)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0976A6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#075D83]"
                >
                  Simpan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
