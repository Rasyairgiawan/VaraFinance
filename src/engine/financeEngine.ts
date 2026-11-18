import { DEFAULT_PROJECTION_ASSUMPTIONS } from '../data/initialProfile';
import {
  Account,
  AllocationRules,
  CustodialFund,
  DisciplineCheckResult,
  FinanceState,
  FinancialMode,
  FreelanceProject,
  FundAllocation,
  PhysicalAsset,
  PhysicalItemLoan,
  ProjectAdvance,
  ProjectExpense,
  ProjectPayment,
  ProjectionAssumptions,
  RecurringObligation,
  Transaction,
  WarningLevel,
} from '../types/finance';
import {
  addDaysISO,
  daysInMonth,
  formatIDR,
  startOfMonthISO,
  startOfWeekISO,
  todayISO,
} from '../utils/format';

export interface AccountWithBalance extends Account {
  currentBalance: number;
}

export interface AccountBalanceBreakdown {
  cash: number;
  bankPersonal: number;
  ewallet: number;
  savings: number;
  investment: number;
  business: number;
}

export interface ProjectFinancialSummary {
  project: FreelanceProject;
  receivedAmount: number;
  expectedAmount: number;
  outstandingReceivables: number;
  totalExpenses: number;
  reimbursableAdvancesTotal: number;
  netProfit: number;
  distributableProfit: number;
  businessRetained: number;
  personalShare: number;
  recognizedAdvanceAmount: number;
  unrecognizedAdvanceAmount: number;
  refundedAdvanceAmount: number;
}

export interface PeriodBudgetStatus {
  period: 'daily' | 'weekly' | 'monthly';
  label: string;
  limit: number;
  dynamicSafeLimit: number;
  spent: number;
  discretionarySpent: number;
  essentialSpent: number;
  remaining: number;
  utilizationPct: number;
  level: WarningLevel;
}

export interface CategoryBudgetStatus {
  categoryId: string;
  categoryName: string;
  classification: string;
  weeklyLimit: number;
  weeklySpent: number;
  monthlyLimit: number;
  monthlySpent: number;
  weeklyRemaining: number;
  weeklyUtilizationPct: number;
  level: WarningLevel;
}

export interface ModeEvaluation {
  mode: FinancialMode;
  label: string;
  shortDesc: string;
  reasons: string[];
  behavioralRules: string[];
}

export interface CigaretteAnalysis {
  weeklySpent: number;
  weeklyLimit: number;
  prevWeekSpent: number;
  monthlySpent: number;
  purchaseCountThisMonth: number;
  estimatedPacksThisMonth: number;
  potentialMonthlySavings50Pct: number;
  potentialYearlySavings50Pct: number;
  level: WarningLevel;
}

export interface HangoutAnalysis {
  weeklySpent: number;
  weeklyLimit: number;
  prevWeekSpent: number;
  monthlySpent: number;
  frequencyThisWeek: number;
  frequencyThisMonth: number;
  avgPerSession: number;
  level: WarningLevel;
}

export interface SnackAnalysis {
  weeklySpent: number;
  prevWeekSpent: number;
  monthlySpent: number;
  frequencyThisMonth: number;
  avgPerPurchase: number;
}

export interface NoSpendDayStatus {
  date: string;
  status: 'confirmed' | 'unconfirmed' | 'invalidated';
  hasDiscretionary: boolean;
  hasEssentialOnly: boolean;
  discretionaryTotal: number;
  note?: string;
}

export interface NoSpendStats {
  todayStatus: NoSpendDayStatus;
  todayIsNoSpend: boolean;
  weeklyNoSpendDays: number;
  weeklyTotalDaysElapsed: number;
  monthlyNoSpendDays: number;
  monthlyTotalDaysElapsed: number;
  periodLabel: string;
  invalidatedDaysCount: number;
  unconfirmedDaysCount: number;
  daysStatus: NoSpendDayStatus[];
}

export interface RecommendationItem {
  id: string;
  severity: WarningLevel;
  title: string;
  message: string;
  reason: string;
  actionLabel?: string;
  targetTab?: string;
}

export interface PeriodComparison {
  currentIncome: number;
  previousIncome: number;
  currentExpense: number;
  previousExpense: number;
  currentDiscretionary: number;
  previousDiscretionary: number;
}

export interface ActiveReminderItem {
  id: string;
  kind:
    | 'obligation'
    | 'scheduled_expense'
    | 'debt'
    | 'receivable'
    | 'goal'
    | 'no_spend'
    | 'cigarette'
    | 'budget_warning'
    | 'asset_loan'
    | 'custom';
  title: string;
  dueDate: string;
  daysRemaining: number;
  amount?: number;
  severity: WarningLevel;
}

export interface MonthlyPrediction {
  confirmedIncomeThisMonth: number;
  confirmedExpenseThisMonth: number;
  confirmedNetCashFlow: number;
  savingsRatioPct: number | null;
  discretionaryRatioPct: number | null;
  expectedFreelanceReceivables: number;
  expectedExtraIncomeAssumption: number;
  avgDailyDiscretionaryRate: number;
  appliedDailyDiscretionaryRate: number;
  remainingDaysInMonth: number;
  estimatedRemainingDiscretionarySpend: number;
  estimatedUpcomingObligations: number;
  estimatedUpcomingScheduledExpenses: number;
  estimatedUpcomingDebt: number;
  estimatedEndOfMonthLiquidBalance: number;
  potentialShortfall: number;
  assumptions: ProjectionAssumptions;
}

export interface ExpenseImpactSimulation {
  amount: number;
  categoryName: string;
  accountName: string;
  isEssential: boolean;
  safeToSpendBefore: number;
  safeToSpendAfter: number;
  fundingShortfallBefore: number;
  fundingShortfallAfter: number;
  dailyRemainingBefore: number;
  dailyRemainingAfter: number;
  weeklyRemainingBefore: number;
  weeklyRemainingAfter: number;
  monthlyRemainingBefore: number;
  monthlyRemainingAfter: number;
  accountBalanceBefore: number;
  accountBalanceAfter: number;
  projectedEndOfMonthBefore: number;
  projectedEndOfMonthAfter: number;
  unfundedObligationsRisk: string;
  debtImpactNote: string;
  emergencyFundImpactNote: string;
  savingsGoalsImpactNote: string;
  modeBefore: FinancialMode;
  modeAfter: FinancialMode;
  warningLevel: WarningLevel;
  reasons: string[];
}

export interface FinanceSnapshot {
  nowISO: string;
  accounts: AccountWithBalance[];
  activeAccounts: AccountWithBalance[];
  archivedBalanceTotal: number;
  accountBreakdown: AccountBalanceBreakdown;
  liquidPersonalBalance: number;
  businessBalance: number;
  protectedAccountBalance: number;
  totalNetAssets: number;
  custodialFundsHeldTotal: number;
  custodialInLiquid: number;
  custodialInProtected: number;
  custodialInBusiness: number;
  deferredProjectAdvancesTotal: number;
  deferredAdvanceRecognizedTotal: number;
  deferredAdvanceRefundedTotal: number;
  deferredAdvancesInLiquid: number;
  deferredAdvancesInProtected: number;
  deferredAdvancesInBusiness: number;
  personalLiquidOwnNet: number;
  protectedFreeBalance: number;
  businessFreeBalance: number;
  physicalAssetsTotal: number;
  physicalAssetsCount: number;
  lentAssetsActiveCount: number;
  borrowedItemsActiveCount: number;
  lentLoansActiveCount: number;
  overdueItemLoansCount: number;
  assetSaleGainLossTotal: number;
  assetCurrentLostValueTotal: number;
  assetHistoricalLossTotal: number;
  totalPersonalWealthNet: number;
  writtenOffReceivableTotal: number;
  writtenOffRecognizedLossTotal: number;
  writtenOffUnrecognizedTotal: number;
  recognizedIncomeThisMonth: number;
  cashReceiptsThisMonth: number;
  linkedDebtObligationsExcludedTotal: number;
  reservedObligations: number;
  unfundedObligations: number;
  reservedScheduledExpenses: number;
  unfundedScheduledExpenses: number;
  allocatedTotal: number;
  outstandingDebtTotal: number;
  outstandingReceivableTotal: number;
  essentialReserve: number;
  protectedVirtualSavings: number;
  fundingShortfall: number;
  rawDiscretionarySurplus: number;
  safeToSpend: number;
  emergencySaved: number;
  emergencyTarget: number;
  totalSavingsSaved: number;
  totalSavingsTarget: number;
  completedObligationsNeedingReallocation: RecurringObligation[];
  modeEvaluation: ModeEvaluation;
  dailyBudget: PeriodBudgetStatus;
  weeklyBudget: PeriodBudgetStatus;
  monthlyBudget: PeriodBudgetStatus;
  categoryBudgets: CategoryBudgetStatus[];
  projectSummaries: ProjectFinancialSummary[];
  cigaretteAnalysis: CigaretteAnalysis;
  hangoutAnalysis: HangoutAnalysis;
  snackAnalysis: SnackAnalysis;
  discretionarySharePct: number;
  excessiveTransactions: Transaction[];
  noSpendStats: NoSpendStats;
  weeklyComparison: PeriodComparison;
  monthlyComparison: PeriodComparison;
  upcomingReminders: ActiveReminderItem[];
  recommendations: RecommendationItem[];
  hasEnoughDisciplineData: boolean;
  disciplineScore: number | null;
  disciplineScoreReason: string;
  disciplineScoreBreakdown: { label: string; score: number; max: number }[];
  monthlyPrediction: MonthlyPrediction;
}

export function isPhysicalLoanOverdue(loan: PhysicalItemLoan, referenceISO: string): boolean {
  return (
    !loan.isVoided &&
    !loan.deletedAt &&
    loan.status === 'active' &&
    Boolean(loan.expectedReturnDate) &&
    referenceISO > (loan.expectedReturnDate as string)
  );
}

export function isObligationAllocatable(ob: RecurringObligation, referenceISO: string): boolean {
  if (ob.status !== 'active' || ob.isArchived) return false;
  if (ob.endDate && referenceISO > ob.endDate) return false;
  return true;
}

export function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = new Date(fromISO + 'T00:00:00').getTime();
  const b = new Date(toISO + 'T00:00:00').getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

export function computeAccountBalances(state: FinanceState): AccountWithBalance[] {
  const balances = new Map<string, number>();
  for (const acc of state.accounts) {
    balances.set(acc.id, acc.openingBalance);
  }

  for (const tx of state.transactions) {
    if (tx.isVoided || tx.affectsAccountBalance === false) continue;
    const prev = balances.get(tx.accountId) ?? 0;
    if (tx.type === 'income') {
      balances.set(tx.accountId, prev + tx.amount);
    } else {
      balances.set(tx.accountId, prev - tx.amount);
    }
  }

  for (const tr of state.transfers) {
    balances.set(tr.fromAccountId, (balances.get(tr.fromAccountId) ?? 0) - tr.amount);
    balances.set(tr.toAccountId, (balances.get(tr.toAccountId) ?? 0) + tr.amount);
  }

  return state.accounts.map((acc) => ({
    ...acc,
    status: acc.status ?? 'active',
    currentBalance: balances.get(acc.id) ?? acc.openingBalance,
  }));
}

function classifyRestrictedAllocations(
  items: Array<{
    remainingAmount: number;
    holdingAccountId: string;
    fundAllocations?: FundAllocation[];
    status: string;
    isVoided?: boolean;
    deletedAt?: string;
  }>,
  activeAccountMap: Map<string, AccountWithBalance>
): { totalHeld: number; inLiquid: number; inProtected: number; inBusiness: number } {
  let totalHeld = 0;
  let inLiquid = 0;
  let inProtected = 0;
  let inBusiness = 0;

  for (const item of items) {
    if (item.isVoided || Boolean(item.deletedAt) || item.status !== 'active' || item.remainingAmount <= 0) {
      continue;
    }
    totalHeld += item.remainingAmount;

    const rawAllocations =
      Array.isArray(item.fundAllocations) && item.fundAllocations.length > 0
        ? item.fundAllocations.filter((a) => a.amount > 0)
        : [{ accountId: item.holdingAccountId, amount: item.remainingAmount }];

    const allocSum = rawAllocations.reduce((s, a) => s + a.amount, 0);
    const allocations =
      allocSum > 0
        ? rawAllocations
        : [{ accountId: item.holdingAccountId, amount: item.remainingAmount }];

    for (const alloc of allocations) {
      const acc = activeAccountMap.get(alloc.accountId);
      if (!acc) continue;
      if (acc.isBusiness) {
        inBusiness += alloc.amount;
      } else if (
        Boolean(acc.isProtected) ||
        acc.accountType === 'savings' ||
        acc.accountType === 'investment'
      ) {
        inProtected += alloc.amount;
      } else {
        inLiquid += alloc.amount;
      }
    }
  }

  return { totalHeld, inLiquid, inProtected, inBusiness };
}

export function computeProjectSummary(
  project: FreelanceProject,
  payments: ProjectPayment[],
  expenses: ProjectExpense[],
  projectAdvances: ProjectAdvance[] = []
): ProjectFinancialSummary {
  const projPayments = payments.filter((p) => p.projectId === project.id && !p.isVoided);
  const projExpenses = expenses.filter((e) => e.projectId === project.id && !e.isVoided);
  const projAdvances = projectAdvances.filter(
    (a) => a.projectId === project.id && !a.isVoided && !a.deletedAt
  );

  const recognizedAdvanceAmount = projAdvances.reduce((sum, a) => sum + a.recognizedAmount, 0);
  const unrecognizedAdvanceAmount = projAdvances
    .filter((a) => a.status === 'active')
    .reduce((sum, a) => sum + a.remainingAmount, 0);
  const refundedAdvanceAmount = projAdvances.reduce((sum, a) => sum + a.refundedAmount, 0);

  const receivedAmount =
    projPayments
      .filter((p) => p.status === 'received')
      .reduce((sum, p) => sum + p.amount, 0) + recognizedAdvanceAmount;

  const expectedAmount = projPayments
    .filter((p) => p.status === 'expected')
    .reduce((sum, p) => sum + p.amount, 0);

  const outstandingReceivables = Math.max(
    0,
    project.contractValue - receivedAmount - unrecognizedAdvanceAmount
  );
  const totalExpenses = projExpenses
    .filter((e) => (e.expenseKind ?? 'project_cost') === 'project_cost')
    .reduce((sum, e) => sum + e.amount, 0);
  const reimbursableAdvancesTotal = projExpenses
    .filter((e) => e.expenseKind === 'pure_advance' || e.expenseKind === 'pass_through')
    .reduce((sum, e) => sum + e.amount, 0);
  const netProfit = receivedAmount - totalExpenses;
  const distributableProfit = Math.max(0, netProfit);
  const businessRetained = Math.round(distributableProfit * (project.businessSharePct / 100));
  const personalShare = distributableProfit - businessRetained;

  return {
    project,
    receivedAmount,
    expectedAmount,
    outstandingReceivables,
    totalExpenses,
    reimbursableAdvancesTotal,
    netProfit,
    distributableProfit,
    businessRetained,
    personalShare,
    recognizedAdvanceAmount,
    unrecognizedAdvanceAmount,
    refundedAdvanceAmount,
  };
}

export function computeAllocationBreakdown(
  amount: number,
  rules: AllocationRules,
  source: 'daily_allowance' | 'freelance' | 'other' | string
): { key: keyof AllocationRules; label: string; percentage: number; amount: number }[] {
  const entries: { key: keyof AllocationRules; label: string }[] = [
    { key: 'obligations', label: 'Kewajiban & Tagihan Rutin' },
    { key: 'debt', label: 'Pelunasan Utang' },
    { key: 'essential', label: 'Kebutuhan Pokok' },
    { key: 'emergency', label: 'Dana Darurat' },
    { key: 'personal_savings', label: 'Tabungan Pribadi' },
    { key: 'business', label: 'Dana Pengembangan Bisnis' },
    { key: 'investment', label: 'Dana Investasi' },
    { key: 'discretionary', label: 'Belanja Bebas / Hiburan' },
  ];

  return entries
    .map((e) => {
      const pct = rules[e.key] ?? 0;
      return {
        ...e,
        percentage: pct,
        amount: Math.round((amount * pct) / 100),
      };
    })
    .filter((item) => item.percentage > 0 || (source === 'freelance' && item.key === 'business'));
}

function getWarningLevel(spent: number, limit: number, inRecovery: boolean, hasDiscretionary: boolean): WarningLevel {
  if (limit <= 0) {
    if (inRecovery && hasDiscretionary && spent > 0) return 'recovery_alert';
    return 'normal';
  }
  const ratio = spent / limit;
  if (ratio >= 1) return inRecovery ? 'recovery_alert' : 'critical';
  if (ratio >= 0.75) return 'warning';
  return 'normal';
}

export function computeFinanceSnapshot(
  state: FinanceState,
  referenceISO: string = todayISO()
): FinanceSnapshot {
  const accounts = computeAccountBalances(state);
  const activeAccounts = accounts.filter((a) => (a.status ?? 'active') === 'active');
  const archivedBalanceTotal = accounts
    .filter((a) => a.status === 'archived' || a.status === 'closed')
    .reduce((s, a) => s + a.currentBalance, 0);

  const accountBreakdown: AccountBalanceBreakdown = {
    cash: activeAccounts
      .filter((a) => !a.isBusiness && !a.isProtected && a.accountType === 'cash')
      .reduce((s, a) => s + a.currentBalance, 0),
    bankPersonal: activeAccounts
      .filter((a) => !a.isBusiness && !a.isProtected && a.accountType === 'bank')
      .reduce((s, a) => s + a.currentBalance, 0),
    ewallet: activeAccounts
      .filter((a) => !a.isBusiness && !a.isProtected && a.accountType === 'ewallet')
      .reduce((s, a) => s + a.currentBalance, 0),
    savings: activeAccounts
      .filter((a) => !a.isBusiness && a.accountType === 'savings')
      .reduce((s, a) => s + a.currentBalance, 0),
    investment: activeAccounts
      .filter((a) => !a.isBusiness && a.accountType === 'investment')
      .reduce((s, a) => s + a.currentBalance, 0),
    business: activeAccounts.filter((a) => a.isBusiness).reduce((s, a) => s + a.currentBalance, 0),
  };

  const liquidPersonalBalance =
    accountBreakdown.cash + accountBreakdown.bankPersonal + accountBreakdown.ewallet;
  const businessBalance = accountBreakdown.business;
  const protectedAccountBalance = activeAccounts
    .filter(
      (a) =>
        !a.isBusiness &&
        (Boolean(a.isProtected) || a.accountType === 'savings' || a.accountType === 'investment')
    )
    .reduce((s, a) => s + a.currentBalance, 0);
  const totalNetAssets = liquidPersonalBalance + businessBalance + protectedAccountBalance + archivedBalanceTotal;

  const activeAccountMap = new Map<string, AccountWithBalance>(
    activeAccounts.map((a) => [a.id, a])
  );
  const custodialFundsList: CustodialFund[] = state.custodialFunds ?? [];
  const projectAdvancesList: ProjectAdvance[] = state.projectAdvances ?? [];

  const custodialBreakdown = classifyRestrictedAllocations(custodialFundsList, activeAccountMap);
  const custodialFundsHeldTotal = custodialBreakdown.totalHeld;
  const custodialInLiquid = custodialBreakdown.inLiquid;
  const custodialInProtected = custodialBreakdown.inProtected;
  const custodialInBusiness = custodialBreakdown.inBusiness;

  const advanceBreakdown = classifyRestrictedAllocations(projectAdvancesList, activeAccountMap);
  const deferredProjectAdvancesTotal = advanceBreakdown.totalHeld;
  const deferredAdvancesInLiquid = advanceBreakdown.inLiquid;
  const deferredAdvancesInProtected = advanceBreakdown.inProtected;
  const deferredAdvancesInBusiness = advanceBreakdown.inBusiness;
  const deferredAdvanceRecognizedTotal = projectAdvancesList
    .filter((a) => !a.isVoided && !a.deletedAt)
    .reduce((sum, a) => sum + a.recognizedAmount, 0);
  const deferredAdvanceRefundedTotal = projectAdvancesList
    .filter((a) => !a.isVoided && !a.deletedAt)
    .reduce((sum, a) => sum + a.refundedAmount, 0);

  const personalLiquidOwnNet =
    liquidPersonalBalance - custodialInLiquid - deferredAdvancesInLiquid;
  const protectedFreeBalance =
    protectedAccountBalance - custodialInProtected - deferredAdvancesInProtected;
  const businessFreeBalance =
    businessBalance - custodialInBusiness - deferredAdvancesInBusiness;

  // Separate Obligations vs Scheduled Expenses (both active and within date range)
  const activeAllCommitments = state.obligations.filter((o) => isObligationAllocatable(o, referenceISO));
  const activeObligations = activeAllCommitments.filter((o) => (o.kind ?? 'obligation') === 'obligation');
  const activeScheduled = activeAllCommitments.filter((o) => o.kind === 'scheduled_expense');

  // Utang (payable) vs Piutang (receivable) vs Write-Off
  const activePayableDebts = state.debts.filter(
    (d) => !d.isVoided && d.status === 'active' && (d.direction ?? 'payable') === 'payable'
  );
  const activePayableDebtIds = new Set(
    activePayableDebts.filter((d) => d.remainingAmount > 0).map((d) => d.id)
  );
  const outstandingDebtTotal = activePayableDebts.reduce((sum, d) => sum + d.remainingAmount, 0);

  const outstandingReceivableTotal = state.debts
    .filter((d) => !d.isVoided && d.status === 'active' && d.direction === 'receivable')
    .reduce((sum, d) => sum + d.remainingAmount, 0);

  const writtenOffReceivables = state.debts.filter(
    (d) => !d.isVoided && d.direction === 'receivable' && d.status === 'written_off'
  );
  const writtenOffReceivableTotal = writtenOffReceivables.reduce(
    (sum, d) => sum + (d.writtenOffAmount ?? 0),
    0
  );
  const writtenOffRecognizedLossTotal = writtenOffReceivables
    .filter((d) => Boolean(d.revenueAlreadyRecorded))
    .reduce((sum, d) => sum + (d.writtenOffAmount ?? 0), 0);
  const writtenOffUnrecognizedTotal = writtenOffReceivables
    .filter((d) => !d.revenueAlreadyRecorded)
    .reduce((sum, d) => sum + (d.writtenOffAmount ?? 0), 0);

  // Prevent double-deduction between Debt and RecurringObligation with linkedDebtId
  const isCoveredByActiveDebt = (o: RecurringObligation): boolean =>
    Boolean(o.linkedDebtId && activePayableDebtIds.has(o.linkedDebtId));

  const standaloneObligations = activeObligations.filter((o) => !isCoveredByActiveDebt(o));
  const standaloneScheduled = activeScheduled.filter((o) => !isCoveredByActiveDebt(o));
  const linkedDebtObligationsExcludedTotal = [...activeObligations, ...activeScheduled]
    .filter(isCoveredByActiveDebt)
    .reduce((sum, o) => sum + o.amount, 0);

  const reservedObligations = standaloneObligations.reduce((sum, o) => sum + o.reservedAmount, 0);
  const unfundedObligations = standaloneObligations.reduce(
    (sum, o) => sum + Math.max(0, o.amount - o.reservedAmount),
    0
  );

  const reservedScheduledExpenses = standaloneScheduled.reduce((sum, o) => sum + o.reservedAmount, 0);
  const unfundedScheduledExpenses = standaloneScheduled.reduce(
    (sum, o) => sum + Math.max(0, o.amount - o.reservedAmount),
    0
  );

  const totalReservedCommitments = reservedObligations + reservedScheduledExpenses;
  const totalUnfundedCommitments = unfundedObligations + unfundedScheduledExpenses;

  const completedObligationsNeedingReallocation = state.obligations.filter(
    (o) =>
      !o.isArchived &&
      (o.status === 'completed' || (o.status === 'active' && o.endDate && referenceISO > o.endDate)) &&
      !o.reallocatedToGoalId
  );

  const essentialReserve = state.settings.essentialReserveTarget;
  const activeGoals = state.goals.filter((g) => !g.isArchived);
  const protectedVirtualSavings = activeGoals
    .filter((g) => g.isProtected)
    .reduce((sum, g) => sum + g.virtualReservedInLiquid, 0);

  const allocatedTotal = totalReservedCommitments + protectedVirtualSavings;

  const rawDiscretionarySurplus =
    personalLiquidOwnNet -
    totalReservedCommitments -
    totalUnfundedCommitments -
    outstandingDebtTotal -
    essentialReserve -
    protectedVirtualSavings;

  const safeToSpend = Math.max(0, rawDiscretionarySurplus);
  const fundingShortfall = Math.max(0, -rawDiscretionarySurplus);

  const physicalAssetsList: PhysicalAsset[] = (state.physicalAssets ?? []).filter(
    (a) => !a.isVoided && !a.deletedAt && a.status !== 'voided'
  );
  const ownedActiveAssets = physicalAssetsList.filter(
    (a) => a.status === 'active' || a.status === 'lent'
  );
  const physicalAssetsTotal = ownedActiveAssets.reduce((sum, a) => sum + a.acquisitionValue, 0);
  const physicalAssetsCount = ownedActiveAssets.length;
  const lentAssetsActiveCount = ownedActiveAssets.filter((a) => a.status === 'lent').length;
  const assetSaleGainLossTotal = physicalAssetsList
    .filter((a) => a.status === 'sold' && a.disposal)
    .reduce((sum, a) => sum + (a.disposal?.gainOrLoss ?? 0), 0);
  const assetCurrentLostValueTotal = physicalAssetsList
    .filter((a) => a.status === 'lost')
    .reduce((sum, a) => sum + a.acquisitionValue, 0);
  const assetHistoricalLossTotal = physicalAssetsList.reduce(
    (sum, a) => sum + (a.lossHistory ?? []).reduce((ls, l) => ls + l.lossAmount, 0),
    0
  );

  const activePhysicalLoans: PhysicalItemLoan[] = (state.physicalItemLoans ?? []).filter(
    (l) => !l.isVoided && !l.deletedAt && l.status === 'active'
  );
  const borrowedItemsActiveCount = activePhysicalLoans.filter(
    (l) => l.direction === 'borrowed'
  ).length;
  const lentLoansActiveCount = activePhysicalLoans.filter(
    (l) => l.direction === 'lent'
  ).length;
  const overdueItemLoansCount = activePhysicalLoans.filter((l) =>
    isPhysicalLoanOverdue(l, referenceISO)
  ).length;

  const totalPersonalWealthNet =
    totalNetAssets -
    custodialFundsHeldTotal -
    deferredProjectAdvancesTotal +
    outstandingReceivableTotal -
    outstandingDebtTotal +
    physicalAssetsTotal;

  const emergencyGoal = activeGoals.find((g) => g.goalType === 'emergency');
  const emergencySaved = emergencyGoal?.currentAmount ?? 0;
  const emergencyTarget = emergencyGoal?.targetAmount ?? state.settings.emergencyFundTarget;
  const totalSavingsSaved = activeGoals.reduce((sum, g) => sum + g.currentAmount, 0);
  const totalSavingsTarget = activeGoals.reduce((sum, g) => sum + g.targetAmount, 0);

  const modeEvaluation = evaluateFinancialMode({
    liquidPersonalBalance: personalLiquidOwnNet,
    safeToSpend,
    rawDiscretionarySurplus,
    outstandingDebtTotal,
    unfundedObligations: totalUnfundedCommitments,
    emergencySaved,
    emergencyTarget,
    essentialReserve,
  });

  const inRecovery = modeEvaluation.mode === 'recovery';

  const weekStart = startOfWeekISO(referenceISO);
  const prevWeekStart = addDaysISO(weekStart, -7);
  const prevWeekEnd = addDaysISO(weekStart, -1);
  const monthStart = startOfMonthISO(referenceISO);

  const [currY, currM] = referenceISO.slice(0, 7).split('-').map(Number);
  const prevMDate = new Date(currY, currM - 2, 1);
  const prevMonthStart = `${prevMDate.getFullYear()}-${String(prevMDate.getMonth() + 1).padStart(2, '0')}-01`;
  const prevMonthEnd = `${prevMDate.getFullYear()}-${String(prevMDate.getMonth() + 1).padStart(2, '0')}-${String(
    daysInMonth(prevMonthStart)
  ).padStart(2, '0')}`;

  const validTransactions = state.transactions.filter((t) => !t.isVoided);
  const personalExpenseTx = validTransactions.filter(
    (t) =>
      t.type === 'expense' &&
      t.categoryId !== 'cat-biz-ops' &&
      t.categoryId !== 'cat-debt' &&
      !t.excludeFromExpenseStats
  );
  const allIncomeTx = validTransactions.filter(
    (t) => t.type === 'income' && !t.excludeFromIncomeStats
  );

  const todayExpenses = personalExpenseTx.filter((t) => t.date === referenceISO);
  const weekExpenses = personalExpenseTx.filter((t) => t.date >= weekStart && t.date <= referenceISO);
  const prevWeekExpenses = personalExpenseTx.filter(
    (t) => t.date >= prevWeekStart && t.date <= prevWeekEnd
  );
  const monthExpenses = personalExpenseTx.filter((t) => t.date >= monthStart && t.date <= referenceISO);
  const prevMonthExpenses = personalExpenseTx.filter(
    (t) => t.date >= prevMonthStart && t.date <= prevMonthEnd
  );

  const sumTotals = (list: Transaction[]) => ({
    total: list.reduce((s, t) => s + t.amount, 0),
    discretionary: list.filter((t) => t.isDiscretionary).reduce((s, t) => s + t.amount, 0),
    essential: list.filter((t) => t.isEssential).reduce((s, t) => s + t.amount, 0),
  });

  const dSum = sumTotals(todayExpenses);
  const wSum = sumTotals(weekExpenses);
  const pwSum = sumTotals(prevWeekExpenses);
  const mSum = sumTotals(monthExpenses);
  const pmSum = sumTotals(prevMonthExpenses);

  const weeklyComparison: PeriodComparison = {
    currentIncome: allIncomeTx
      .filter((t) => t.date >= weekStart && t.date <= referenceISO)
      .reduce((s, t) => s + t.amount, 0),
    previousIncome: allIncomeTx
      .filter((t) => t.date >= prevWeekStart && t.date <= prevWeekEnd)
      .reduce((s, t) => s + t.amount, 0),
    currentExpense: wSum.total,
    previousExpense: pwSum.total,
    currentDiscretionary: wSum.discretionary,
    previousDiscretionary: pwSum.discretionary,
  };

  const monthlyComparison: PeriodComparison = {
    currentIncome: allIncomeTx
      .filter((t) => t.date >= monthStart && t.date <= referenceISO)
      .reduce((s, t) => s + t.amount, 0),
    previousIncome: allIncomeTx
      .filter((t) => t.date >= prevMonthStart && t.date <= prevMonthEnd)
      .reduce((s, t) => s + t.amount, 0),
    currentExpense: mSum.total,
    previousExpense: pmSum.total,
    currentDiscretionary: mSum.discretionary,
    previousDiscretionary: pmSum.discretionary,
  };

  const dayOfWeek = new Date(referenceISO + 'T00:00:00').getDay();
  const remainingDaysInWeek = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const dynamicDailyCap =
    safeToSpend > 0
      ? Math.min(
          state.settings.dailyBudgetLimit || safeToSpend,
          Math.max(0, Math.floor(safeToSpend / remainingDaysInWeek))
        )
      : 0;

  const dailyBudget: PeriodBudgetStatus = {
    period: 'daily',
    label: 'Anggaran Harian',
    limit: state.settings.dailyBudgetLimit,
    dynamicSafeLimit: dynamicDailyCap,
    spent: dSum.total,
    discretionarySpent: dSum.discretionary,
    essentialSpent: dSum.essential,
    remaining: Math.max(0, state.settings.dailyBudgetLimit - dSum.discretionary),
    utilizationPct:
      state.settings.dailyBudgetLimit > 0
        ? Math.min(100, Math.round((dSum.discretionary / state.settings.dailyBudgetLimit) * 100))
        : 0,
    level: getWarningLevel(
      dSum.discretionary,
      state.settings.dailyBudgetLimit,
      inRecovery,
      dSum.discretionary > 0
    ),
  };

  const weeklyBudget: PeriodBudgetStatus = {
    period: 'weekly',
    label: 'Anggaran Mingguan',
    limit: state.settings.weeklyBudgetLimit,
    dynamicSafeLimit: Math.min(state.settings.weeklyBudgetLimit || safeToSpend, safeToSpend + wSum.discretionary),
    spent: wSum.total,
    discretionarySpent: wSum.discretionary,
    essentialSpent: wSum.essential,
    remaining: Math.max(0, state.settings.weeklyBudgetLimit - wSum.discretionary),
    utilizationPct:
      state.settings.weeklyBudgetLimit > 0
        ? Math.min(100, Math.round((wSum.discretionary / state.settings.weeklyBudgetLimit) * 100))
        : 0,
    level: getWarningLevel(
      wSum.discretionary,
      state.settings.weeklyBudgetLimit,
      inRecovery,
      wSum.discretionary > 0
    ),
  };

  const monthlyBudget: PeriodBudgetStatus = {
    period: 'monthly',
    label: 'Anggaran Bulanan',
    limit: state.settings.monthlyBudgetLimit,
    dynamicSafeLimit: Math.min(state.settings.monthlyBudgetLimit || safeToSpend, safeToSpend + mSum.discretionary),
    spent: mSum.total,
    discretionarySpent: mSum.discretionary,
    essentialSpent: mSum.essential,
    remaining: Math.max(0, state.settings.monthlyBudgetLimit - mSum.discretionary),
    utilizationPct:
      state.settings.monthlyBudgetLimit > 0
        ? Math.min(100, Math.round((mSum.discretionary / state.settings.monthlyBudgetLimit) * 100))
        : 0,
    level: getWarningLevel(
      mSum.discretionary,
      state.settings.monthlyBudgetLimit,
      inRecovery,
      mSum.discretionary > 0
    ),
  };

  const categoryBudgets: CategoryBudgetStatus[] = state.categories
    .filter((c) => c.type === 'expense' && !c.isArchived)
    .map((cat) => {
      const effectiveWeeklyLimit =
        cat.id === 'cat-cig'
          ? state.settings.cigaretteWeeklyLimit
          : cat.id === 'cat-hangout'
          ? state.settings.hangoutWeeklyLimit
          : cat.weeklyLimit;

      const weeklySpent = weekExpenses
        .filter((t) => t.categoryId === cat.id)
        .reduce((s, t) => s + t.amount, 0);
      const monthlySpent = monthExpenses
        .filter((t) => t.categoryId === cat.id)
        .reduce((s, t) => s + t.amount, 0);

      const util =
        effectiveWeeklyLimit > 0
          ? Math.min(100, Math.round((weeklySpent / effectiveWeeklyLimit) * 100))
          : 0;

      return {
        categoryId: cat.id,
        categoryName: cat.name,
        classification: cat.classification,
        weeklyLimit: effectiveWeeklyLimit,
        weeklySpent,
        monthlyLimit: cat.monthlyLimit || effectiveWeeklyLimit * 4,
        monthlySpent,
        weeklyRemaining: Math.max(0, effectiveWeeklyLimit - weeklySpent),
        weeklyUtilizationPct: util,
        level:
          cat.classification === 'essential'
            ? 'normal'
            : getWarningLevel(weeklySpent, effectiveWeeklyLimit, inRecovery, weeklySpent > 0),
      };
    });

  const cigWeek = weekExpenses.filter((t) => t.categoryId === 'cat-cig');
  const cigPrevWeek = prevWeekExpenses.filter((t) => t.categoryId === 'cat-cig');
  const cigMonth = monthExpenses.filter((t) => t.categoryId === 'cat-cig');
  const cigWeeklySpent = cigWeek.reduce((s, t) => s + t.amount, 0);
  const cigMonthlySpent = cigMonth.reduce((s, t) => s + t.amount, 0);
  const cigLimit = state.settings.cigaretteWeeklyLimit;

  const cigaretteAnalysis: CigaretteAnalysis = {
    weeklySpent: cigWeeklySpent,
    weeklyLimit: cigLimit,
    prevWeekSpent: cigPrevWeek.reduce((s, t) => s + t.amount, 0),
    monthlySpent: cigMonthlySpent,
    purchaseCountThisMonth: cigMonth.length,
    estimatedPacksThisMonth: Math.round((cigMonthlySpent / 22000) * 10) / 10,
    potentialMonthlySavings50Pct: Math.round(cigMonthlySpent * 0.5),
    potentialYearlySavings50Pct: Math.round(cigMonthlySpent * 0.5 * 12),
    level: getWarningLevel(cigWeeklySpent, cigLimit, inRecovery, cigWeeklySpent > 0),
  };

  const hangWeek = weekExpenses.filter((t) => t.categoryId === 'cat-hangout');
  const hangPrevWeek = prevWeekExpenses.filter((t) => t.categoryId === 'cat-hangout');
  const hangMonth = monthExpenses.filter((t) => t.categoryId === 'cat-hangout');
  const hangWeeklySpent = hangWeek.reduce((s, t) => s + t.amount, 0);
  const hangMonthlySpent = hangMonth.reduce((s, t) => s + t.amount, 0);
  const hangLimit = state.settings.hangoutWeeklyLimit;

  const hangoutAnalysis: HangoutAnalysis = {
    weeklySpent: hangWeeklySpent,
    weeklyLimit: hangLimit,
    prevWeekSpent: hangPrevWeek.reduce((s, t) => s + t.amount, 0),
    monthlySpent: hangMonthlySpent,
    frequencyThisWeek: hangWeek.length,
    frequencyThisMonth: hangMonth.length,
    avgPerSession: hangMonth.length > 0 ? Math.round(hangMonthlySpent / hangMonth.length) : 0,
    level: getWarningLevel(hangWeeklySpent, hangLimit, inRecovery, hangWeeklySpent > 0),
  };

  const snackWeek = weekExpenses.filter((t) => t.categoryId === 'cat-other-exp');
  const snackPrevWeek = prevWeekExpenses.filter((t) => t.categoryId === 'cat-other-exp');
  const snackMonth = monthExpenses.filter((t) => t.categoryId === 'cat-other-exp');
  const snackMonthlySpent = snackMonth.reduce((s, t) => s + t.amount, 0);

  const snackAnalysis: SnackAnalysis = {
    weeklySpent: snackWeek.reduce((s, t) => s + t.amount, 0),
    prevWeekSpent: snackPrevWeek.reduce((s, t) => s + t.amount, 0),
    monthlySpent: snackMonthlySpent,
    frequencyThisMonth: snackMonth.length,
    avgPerPurchase: snackMonth.length > 0 ? Math.round(snackMonthlySpent / snackMonth.length) : 0,
  };

  const discretionarySharePct =
    mSum.total > 0 ? Math.round((mSum.discretionary / mSum.total) * 100) : 0;

  const excessiveTransactions = validTransactions.filter((t) => t.exceededBudget);

  // Strict Manual No-Spend Day Evaluation (ONLY up to referenceISO, NEVER future dates)
  const dayNum = Number(referenceISO.slice(8, 10));
  const confirmations = (state.noSpendConfirmations ?? []).filter((c) => c.date <= referenceISO);
  const daysStatus: NoSpendDayStatus[] = [];

  for (let d = 1; d <= dayNum; d++) {
    const iso = `${referenceISO.slice(0, 7)}-${String(d).padStart(2, '0')}`;
    const dayTx = personalExpenseTx.filter((t) => t.date === iso);
    const discTotal = dayTx.filter((t) => t.isDiscretionary).reduce((s, t) => s + t.amount, 0);
    const hasDiscretionary = discTotal > 0;
    const hasEss = !hasDiscretionary && dayTx.some((t) => t.isEssential);
    const conf = confirmations.find((c) => c.date === iso);

    let status: NoSpendDayStatus['status'] = 'unconfirmed';
    if (hasDiscretionary) {
      status = 'invalidated';
    } else if (conf && conf.status === 'confirmed') {
      status = 'confirmed';
    }

    daysStatus.push({
      date: iso,
      status,
      hasDiscretionary,
      hasEssentialOnly: hasEss,
      discretionaryTotal: discTotal,
      note: conf?.note,
    });
  }

  const weekDaysStatus = daysStatus.filter((d) => d.date >= weekStart && d.date <= referenceISO);
  const todayStatus = daysStatus.find((d) => d.date === referenceISO) ?? {
    date: referenceISO,
    status: 'unconfirmed',
    hasDiscretionary: false,
    hasEssentialOnly: false,
    discretionaryTotal: 0,
  };

  const noSpendStats: NoSpendStats = {
    todayStatus,
    todayIsNoSpend: todayStatus.status === 'confirmed',
    weeklyNoSpendDays: weekDaysStatus.filter((d) => d.status === 'confirmed').length,
    weeklyTotalDaysElapsed: weekDaysStatus.length,
    monthlyNoSpendDays: daysStatus.filter((d) => d.status === 'confirmed').length,
    monthlyTotalDaysElapsed: daysStatus.length,
    periodLabel: `Tgl 1–${dayNum} (${daysStatus.length} hari berjalan; tanggal mendatang tidak dihitung)`,
    invalidatedDaysCount: daysStatus.filter((d) => d.status === 'invalidated').length,
    unconfirmedDaysCount: daysStatus.filter((d) => d.status === 'unconfirmed').length,
    daysStatus,
  };

  const writtenOffProjectPaymentIds = new Set(
    writtenOffReceivables
      .map((d) => d.projectPaymentId)
      .filter((ppId): ppId is string => Boolean(ppId))
  );
  const activeProjectPaymentsForSummary = state.projectPayments.filter(
    (pp) => !(pp.status === 'expected' && writtenOffProjectPaymentIds.has(pp.id))
  );

  const projectSummaries = state.projects
    .filter((p) => !p.isArchived)
    .map((p) =>
      computeProjectSummary(
        p,
        activeProjectPaymentsForSummary,
        state.projectExpenses,
        projectAdvancesList
      )
    );

  const confirmedIncomeThisMonth = monthlyComparison.currentIncome;
  const recognizedIncomeThisMonth = confirmedIncomeThisMonth;
  const cashReceiptsThisMonth = validTransactions
    .filter(
      (t) =>
        t.type === 'income' &&
        t.affectsAccountBalance !== false &&
        t.date >= monthStart &&
        t.date <= referenceISO
    )
    .reduce((s, t) => s + t.amount, 0);
  const confirmedExpenseThisMonth = mSum.total;
  const expectedFreelanceReceivables = projectSummaries.reduce((s, p) => s + p.expectedAmount, 0);

  // Projection Calculation with Visible & Editable Assumptions
  const assumptions: ProjectionAssumptions = {
    ...DEFAULT_PROJECTION_ASSUMPTIONS,
    ...(state.projectionAssumptions ?? {}),
  };

  const totalDaysInCurrMonth = daysInMonth(referenceISO);
  const remainingDaysInMonth = Math.max(0, totalDaysInCurrMonth - dayNum);
  const avgDailyDiscretionaryRate = dayNum > 0 ? Math.round(mSum.discretionary / dayNum) : 0;
  const appliedDailyDiscretionaryRate =
    assumptions.dailyDiscretionaryOverride !== null && assumptions.dailyDiscretionaryOverride >= 0
      ? assumptions.dailyDiscretionaryOverride
      : avgDailyDiscretionaryRate;
  const estimatedRemainingDiscretionarySpend = appliedDailyDiscretionaryRate * remainingDaysInMonth;

  // Important fix: reserved obligations & scheduled expenses still sit inside personalLiquidOwnNet until actually paid;
  // also avoid double-subtracting obligations linked to active debts when debt is included in projection.
  const activeObligationsTotalAmount = (
    assumptions.includeDebtInProjection ? standaloneObligations : activeObligations
  ).reduce((s, o) => s + o.amount, 0);
  const activeScheduledTotalAmount = (
    assumptions.includeDebtInProjection ? standaloneScheduled : activeScheduled
  ).reduce((s, o) => s + o.amount, 0);

  const estimatedUpcomingObligations = assumptions.includeObligationsInProjection
    ? activeObligationsTotalAmount
    : 0;
  const estimatedUpcomingScheduledExpenses = assumptions.includeScheduledExpenses
    ? activeScheduledTotalAmount
    : 0;
  const estimatedUpcomingDebt = assumptions.includeDebtInProjection ? outstandingDebtTotal : 0;

  const estimatedEndOfMonthLiquidBalance =
    personalLiquidOwnNet +
    assumptions.expectedExtraIncome -
    estimatedRemainingDiscretionarySpend -
    estimatedUpcomingObligations -
    estimatedUpcomingScheduledExpenses -
    estimatedUpcomingDebt;

  const potentialShortfall =
    estimatedEndOfMonthLiquidBalance < 0 ? Math.abs(estimatedEndOfMonthLiquidBalance) : 0;

  const confirmedNetCashFlow = confirmedIncomeThisMonth - confirmedExpenseThisMonth;
  const savingsRatioPct =
    confirmedIncomeThisMonth > 0
      ? Math.round((confirmedNetCashFlow / confirmedIncomeThisMonth) * 100)
      : null;
  const discretionaryRatioPct =
    mSum.total > 0 ? Math.round((mSum.discretionary / mSum.total) * 100) : null;

  const monthlyPrediction: MonthlyPrediction = {
    confirmedIncomeThisMonth,
    confirmedExpenseThisMonth,
    confirmedNetCashFlow,
    savingsRatioPct,
    discretionaryRatioPct,
    expectedFreelanceReceivables,
    expectedExtraIncomeAssumption: assumptions.expectedExtraIncome,
    avgDailyDiscretionaryRate,
    appliedDailyDiscretionaryRate,
    remainingDaysInMonth,
    estimatedRemainingDiscretionarySpend,
    estimatedUpcomingObligations,
    estimatedUpcomingScheduledExpenses,
    estimatedUpcomingDebt,
    estimatedEndOfMonthLiquidBalance,
    potentialShortfall,
    assumptions,
  };

  // Reminders evaluation (respecting snooze / completed / disabled states)
  const upcomingReminders = buildActiveReminders(
    state,
    referenceISO,
    todayStatus,
    cigaretteAnalysis,
    dailyBudget,
    weeklyBudget
  );

  // Discipline Score: Require sufficient real activity before generating a numeric score
  const validNoSpendActions = confirmations.filter((c) => c.status === 'confirmed').length;
  const hasEnoughDisciplineData =
    validTransactions.length >= 2 || validNoSpendActions >= 2;

  const budgetAdherenceScore =
    (cigaretteAnalysis.weeklySpent <= cigLimit ? 15 : 0) +
    (hangoutAnalysis.weeklySpent <= hangLimit ? 15 : 0);
  const noSpendScore =
    noSpendStats.weeklyTotalDaysElapsed > 0
      ? Math.round((noSpendStats.weeklyNoSpendDays / noSpendStats.weeklyTotalDaysElapsed) * 25)
      : 0;
  const obligationScore =
    activeAllCommitments.length === 0
      ? 25
      : Math.round(
          (activeAllCommitments.reduce((s, o) => s + Math.min(o.reservedAmount, o.amount), 0) /
            Math.max(1, activeAllCommitments.reduce((s, o) => s + o.amount, 0))) *
            25
        );
  const debtAndSavingsScore =
    (outstandingDebtTotal === 0 ? 10 : state.debtPayments.some((dp) => !dp.isVoided) ? 5 : 0) +
    (emergencyTarget > 0 ? Math.min(10, Math.round((emergencySaved / emergencyTarget) * 10)) : 10);

  const disciplineScore = hasEnoughDisciplineData
    ? Math.min(100, budgetAdherenceScore + noSpendScore + obligationScore + debtAndSavingsScore)
    : null;

  const disciplineScoreReason = hasEnoughDisciplineData
    ? 'Dihitung dari kepatuhan batas konsumtif, konfirmasi Hari Tanpa Jajan, cadangan kewajiban, dan progres utang/darurat.'
    : 'Belum cukup data: catat minimal 2 transaksi atau konfirmasi 2 Hari Tanpa Jajan agar skor disiplin dihitung secara akurat tanpa asumsi.';

  const disciplineScoreBreakdown = [
    { label: 'Kepatuhan Batas Rokok & Nongkrong', score: budgetAdherenceScore, max: 30 },
    { label: 'Konfirmasi Hari Tanpa Jajan', score: noSpendScore, max: 25 },
    { label: 'Cadangan Kewajiban & Tagihan', score: obligationScore, max: 25 },
    { label: 'Progres Utang & Dana Darurat', score: debtAndSavingsScore, max: 20 },
  ];

  const recommendations = buildRecommendations({
    state,
    liquidPersonalBalance,
    safeToSpend,
    outstandingDebtTotal,
    outstandingReceivableTotal,
    unfundedObligations: totalUnfundedCommitments,
    modeEvaluation,
    cigaretteAnalysis,
    hangoutAnalysis,
    emergencySaved,
    emergencyTarget,
    potentialShortfall,
    completedObligationsNeedingReallocation,
    hasEnoughDisciplineData,
    overdueItemLoansCount,
  });

  return {
    nowISO: referenceISO,
    accounts,
    activeAccounts,
    archivedBalanceTotal,
    accountBreakdown,
    liquidPersonalBalance,
    businessBalance,
    protectedAccountBalance,
    totalNetAssets,
    custodialFundsHeldTotal,
    custodialInLiquid,
    custodialInProtected,
    custodialInBusiness,
    deferredProjectAdvancesTotal,
    deferredAdvanceRecognizedTotal,
    deferredAdvanceRefundedTotal,
    deferredAdvancesInLiquid,
    deferredAdvancesInProtected,
    deferredAdvancesInBusiness,
    personalLiquidOwnNet,
    protectedFreeBalance,
    businessFreeBalance,
    physicalAssetsTotal,
    physicalAssetsCount,
    lentAssetsActiveCount,
    borrowedItemsActiveCount,
    lentLoansActiveCount,
    overdueItemLoansCount,
    assetSaleGainLossTotal,
    assetCurrentLostValueTotal,
    assetHistoricalLossTotal,
    totalPersonalWealthNet,
    writtenOffReceivableTotal,
    writtenOffRecognizedLossTotal,
    writtenOffUnrecognizedTotal,
    recognizedIncomeThisMonth,
    cashReceiptsThisMonth,
    linkedDebtObligationsExcludedTotal,
    reservedObligations,
    unfundedObligations,
    reservedScheduledExpenses,
    unfundedScheduledExpenses,
    allocatedTotal,
    outstandingDebtTotal,
    outstandingReceivableTotal,
    essentialReserve,
    protectedVirtualSavings,
    fundingShortfall,
    rawDiscretionarySurplus,
    safeToSpend,
    emergencySaved,
    emergencyTarget,
    totalSavingsSaved,
    totalSavingsTarget,
    completedObligationsNeedingReallocation,
    modeEvaluation,
    dailyBudget,
    weeklyBudget,
    monthlyBudget,
    categoryBudgets,
    projectSummaries,
    cigaretteAnalysis,
    hangoutAnalysis,
    snackAnalysis,
    discretionarySharePct,
    excessiveTransactions,
    noSpendStats,
    weeklyComparison,
    monthlyComparison,
    upcomingReminders,
    recommendations,
    hasEnoughDisciplineData,
    disciplineScore,
    disciplineScoreReason,
    disciplineScoreBreakdown,
    monthlyPrediction,
  };
}

function isReminderSuppressed(
  state: FinanceState,
  reminderId: string,
  referenceISO: string
): boolean {
  const rs = state.settings.reminderSettings.reminderStates?.[reminderId];
  if (!rs) return false;
  if (rs.status === 'disabled' || rs.status === 'completed') return true;
  if (rs.status === 'snoozed' && rs.snoozedUntil && referenceISO < rs.snoozedUntil) {
    return true;
  }
  return false;
}

function buildActiveReminders(
  state: FinanceState,
  referenceISO: string,
  todayStatus: NoSpendDayStatus,
  cigaretteAnalysis: CigaretteAnalysis,
  dailyBudget: PeriodBudgetStatus,
  weeklyBudget: PeriodBudgetStatus
): ActiveReminderItem[] {
  const rs = state.settings.reminderSettings;
  if (!rs || !rs.enabled) return [];

  const items: ActiveReminderItem[] = [];

  for (const ob of state.obligations) {
    if (!isObligationAllocatable(ob, referenceISO) || !ob.reminderEnabled) continue;
    const days = daysBetweenISO(referenceISO, ob.nextDueDate);
    if (days <= (ob.reminderDaysBefore ?? rs.obligationDaysBefore)) {
      const shortfall = Math.max(0, ob.amount - ob.reservedAmount);
      const isSched = ob.kind === 'scheduled_expense';
      const id = `rem-ob-${ob.id}`;
      if (!isReminderSuppressed(state, id, referenceISO)) {
        items.push({
          id,
          kind: isSched ? 'scheduled_expense' : 'obligation',
          title:
            shortfall > 0
              ? `${isSched ? 'Tagihan terjadwal' : 'Kewajiban'} ${ob.name} (kurang ${formatIDR(shortfall)})`
              : `Siap bayar ${isSched ? 'tagihan' : 'kewajiban'}: ${ob.name}`,
          dueDate: ob.nextDueDate,
          daysRemaining: days,
          amount: ob.amount,
          severity: days <= 0 ? 'critical' : shortfall > 0 ? 'warning' : 'normal',
        });
      }
    }
  }

  for (const d of state.debts) {
    if (d.isVoided || d.status !== 'active' || !d.dueDate) continue;
    const days = daysBetweenISO(referenceISO, d.dueDate);
    if (days <= rs.debtDueDaysBefore) {
      const isReceivable = d.direction === 'receivable';
      const id = `rem-debt-${d.id}`;
      if (!isReminderSuppressed(state, id, referenceISO)) {
        items.push({
          id,
          kind: isReceivable ? 'receivable' : 'debt',
          title: isReceivable
            ? `Tagih piutang dari ${d.creditor}`
            : `Jatuh tempo utang ke ${d.creditor}`,
          dueDate: d.dueDate,
          daysRemaining: days,
          amount: d.remainingAmount,
          severity: days <= 0 ? 'critical' : 'warning',
        });
      }
    }
  }

  // Savings goal target date reminder
  for (const g of state.goals) {
    if (g.isArchived || !g.targetDate || g.currentAmount >= g.targetAmount) continue;
    const days = daysBetweenISO(referenceISO, g.targetDate);
    if (days <= 14) {
      const id = `rem-goal-${g.id}`;
      if (!isReminderSuppressed(state, id, referenceISO)) {
        items.push({
          id,
          kind: 'goal',
          title: `Target tabungan "${g.name}" (kurang ${formatIDR(g.targetAmount - g.currentAmount)})`,
          dueDate: g.targetDate,
          daysRemaining: days,
          amount: g.targetAmount - g.currentAmount,
          severity: days <= 3 ? 'warning' : 'normal',
        });
      }
    }
  }

  if (rs.dailyNoSpendReminder && todayStatus.status === 'unconfirmed' && !todayStatus.hasDiscretionary) {
    const id = `rem-nospend-${referenceISO}`;
    if (!isReminderSuppressed(state, id, referenceISO)) {
      items.push({
        id,
        kind: 'no_spend',
        title: 'Konfirmasi Hari Tanpa Jajan hari ini jika tidak membeli item konsumtif',
        dueDate: referenceISO,
        daysRemaining: 0,
        severity: 'normal',
      });
    }
  }

  if (
    rs.cigaretteLimitAlert &&
    cigaretteAnalysis.weeklyLimit > 0 &&
    cigaretteAnalysis.weeklySpent >= cigaretteAnalysis.weeklyLimit * 0.75
  ) {
    const id = 'rem-cig-limit';
    if (!isReminderSuppressed(state, id, referenceISO)) {
      items.push({
        id,
        kind: 'cigarette',
        title:
          cigaretteAnalysis.weeklySpent >= cigaretteAnalysis.weeklyLimit
            ? 'Batas rokok mingguan telah terlampaui'
            : 'Pengeluaran rokok mendekati batas mingguan',
        dueDate: referenceISO,
        daysRemaining: 0,
        amount: cigaretteAnalysis.weeklySpent,
        severity: cigaretteAnalysis.weeklySpent >= cigaretteAnalysis.weeklyLimit ? 'critical' : 'warning',
      });
    }
  }

  if (
    (dailyBudget.limit > 0 && dailyBudget.discretionarySpent >= dailyBudget.limit * 0.85) ||
    (weeklyBudget.limit > 0 && weeklyBudget.discretionarySpent >= weeklyBudget.limit * 0.85)
  ) {
    const id = `rem-budget-warn-${referenceISO}`;
    if (!isReminderSuppressed(state, id, referenceISO)) {
      items.push({
        id,
        kind: 'budget_warning',
        title:
          weeklyBudget.discretionarySpent >= weeklyBudget.limit
            ? 'Peringatan: Anggaran konsumtif mingguan sudah penuh/terlampaui'
            : 'Peringatan: Anggaran konsumtif harian/mingguan hampir habis',
        dueDate: referenceISO,
        daysRemaining: 0,
        amount: weeklyBudget.discretionarySpent,
        severity:
          weeklyBudget.discretionarySpent >= weeklyBudget.limit || dailyBudget.discretionarySpent >= dailyBudget.limit
            ? 'critical'
            : 'warning',
      });
    }
  }

  for (const loan of state.physicalItemLoans ?? []) {
    if (loan.isVoided || loan.deletedAt || loan.status !== 'active' || !loan.expectedReturnDate) {
      continue;
    }
    const days = daysBetweenISO(referenceISO, loan.expectedReturnDate);
    if (days <= 3) {
      const id = `rem-loan-${loan.id}`;
      if (!isReminderSuppressed(state, id, referenceISO)) {
        const isLent = loan.direction === 'lent';
        items.push({
          id,
          kind: 'asset_loan',
          title: isLent
            ? days < 0
              ? `Barang dipinjamkan terlambat kembali: ${loan.itemName} (${loan.counterpartyName})`
              : `Jadwal kembali barang dipinjamkan: ${loan.itemName} (${loan.counterpartyName})`
            : days < 0
            ? `Barang pinjaman terlambat dikembalikan: ${loan.itemName} (milik ${loan.counterpartyName})`
            : `Jadwal kembalikan barang pinjaman: ${loan.itemName} (milik ${loan.counterpartyName})`,
          dueDate: loan.expectedReturnDate,
          daysRemaining: days,
          severity: days < 0 ? 'critical' : days <= 1 ? 'warning' : 'normal',
        });
      }
    }
  }

  for (const cr of rs.customReminders ?? []) {
    if (!cr.enabled) continue;
    const days = daysBetweenISO(referenceISO, cr.date);
    if (days >= -1 && days <= 7) {
      const id = `rem-custom-${cr.id}`;
      if (!isReminderSuppressed(state, id, referenceISO)) {
        items.push({
          id,
          kind: 'custom',
          title: cr.title,
          dueDate: cr.date,
          daysRemaining: days,
          severity: days <= 0 ? 'warning' : 'normal',
        });
      }
    }
  }

  return items.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

function evaluateFinancialMode(params: {
  liquidPersonalBalance: number;
  safeToSpend: number;
  rawDiscretionarySurplus: number;
  outstandingDebtTotal: number;
  unfundedObligations: number;
  emergencySaved: number;
  emergencyTarget: number;
  essentialReserve: number;
}): ModeEvaluation {
  const {
    liquidPersonalBalance,
    safeToSpend,
    rawDiscretionarySurplus,
    outstandingDebtTotal,
    unfundedObligations,
    emergencySaved,
    emergencyTarget,
    essentialReserve,
  } = params;

  const reasons: string[] = [];

  const isRecovery =
    liquidPersonalBalance <= 0 ||
    rawDiscretionarySurplus < 0 ||
    (unfundedObligations > 0 && liquidPersonalBalance < unfundedObligations + essentialReserve) ||
    (outstandingDebtTotal > 0 &&
      (safeToSpend <= 0 || liquidPersonalBalance < outstandingDebtTotal + unfundedObligations));

  if (isRecovery) {
    if (liquidPersonalBalance <= 0) {
      reasons.push('Saldo likuid pribadi saat ini Rp0 sehingga belum ada penyangga kas.');
    }
    if (outstandingDebtTotal > 0) {
      reasons.push(`Masih terdapat sisa utang aktif sebesar ${formatIDR(outstandingDebtTotal)}.`);
    }
    if (unfundedObligations > 0) {
      reasons.push(
        `Kewajiban & tagihan aktif masih kekurangan cadangan sebesar ${formatIDR(unfundedObligations)}.`
      );
    }
    if (rawDiscretionarySurplus < 0) {
      reasons.push(
        `Dana Aman Dibelanjakan mengalami defisit ${formatIDR(rawDiscretionarySurplus)} terhadap komitmen & kebutuhan pokok.`
      );
    }

    return {
      mode: 'recovery',
      label: 'Mode Pemulihan',
      shortDesc: 'Prioritaskan pelunasan utang, cadangan kewajiban, dan tahan belanja konsumtif.',
      reasons,
      behavioralRules: [
        'Tahan pengeluaran rokok, nongkrong, dan jajan non-esensial.',
        'Alokasikan pemasukan pertama untuk menyisihkan kewajiban dan melunasi utang.',
        'Target investasi tetap boleh dicatat, tetapi setoran investasi ditunda sampai prioritas dasar terpenuhi.',
        'Kebutuhan pokok tetap diutamakan.',
      ],
    };
  }

  if (outstandingDebtTotal > 0 || unfundedObligations > 0 || emergencySaved < emergencyTarget * 0.5) {
    if (outstandingDebtTotal === 0) {
      reasons.push('Seluruh utang aktif sudah lunas.');
    } else {
      reasons.push(
        `Saldo cukup untuk menutup utang (${formatIDR(outstandingDebtTotal)}) tanpa mengganggu kewajiban.`
      );
    }
    if (unfundedObligations === 0) {
      reasons.push('Kewajiban & tagihan aktif sudah tercukupi.');
    }
    reasons.push(
      `Dana Darurat masih ${formatIDR(emergencySaved)} dari target ${formatIDR(emergencyTarget)} (< 50%).`
    );

    return {
      mode: 'stabilization',
      label: 'Mode Stabilisasi',
      shortDesc: 'Kewajiban aman; jaga disiplin belanja dan bangun Dana Darurat sebelum investasi agresif.',
      reasons,
      behavioralRules: [
        'Pertahankan batas mingguan rokok & nongkrong.',
        'Sisihkan dana kewajiban & tagihan terjadwal sebelum jatuh tempo.',
        'Isi Dana Darurat secara bertahap sebelum rekomendasi investasi dibuka.',
      ],
    };
  }

  if (emergencySaved < emergencyTarget) {
    reasons.push('Tidak ada utang tertunggak dan kewajiban rutin sudah aman.');
    reasons.push(
      `Dana Darurat telah mencapai ${Math.round((emergencySaved / Math.max(1, emergencyTarget)) * 100)}% dari target.`
    );
    return {
      mode: 'saving',
      label: 'Mode Menabung',
      shortDesc: 'Arus kas stabil; fokus selesaikan target Dana Darurat dan tabungan pribadi.',
      reasons,
      behavioralRules: [
        'Lindungi saldo tabungan dari penarikan konsumtif.',
        'Konfirmasi Hari Tanpa Jajan secara konsisten setiap minggu.',
      ],
    };
  }

  reasons.push('Utang lunas, kewajiban rutin aman, dan Dana Darurat sudah memenuhi target.');
  reasons.push(`Dana Aman Dibelanjakan tersedia sebesar ${formatIDR(safeToSpend)}.`);
  return {
    mode: 'growth',
    label: 'Mode Pertumbuhan',
    shortDesc: 'Fondasi keuangan sehat; siap alokasi investasi & pengembangan bisnis.',
    reasons,
    behavioralRules: [
      'Arahkan surplus ke Dana Bisnis & Target Investasi.',
      'Tetap patuhi batas mingguan agar gaya hidup tidak melonjak.',
    ],
  };
}

function buildRecommendations(ctx: {
  state: FinanceState;
  liquidPersonalBalance: number;
  safeToSpend: number;
  outstandingDebtTotal: number;
  outstandingReceivableTotal: number;
  unfundedObligations: number;
  modeEvaluation: ModeEvaluation;
  cigaretteAnalysis: CigaretteAnalysis;
  hangoutAnalysis: HangoutAnalysis;
  emergencySaved: number;
  emergencyTarget: number;
  potentialShortfall: number;
  completedObligationsNeedingReallocation: RecurringObligation[];
  hasEnoughDisciplineData: boolean;
  overdueItemLoansCount?: number;
}): RecommendationItem[] {
  const recs: RecommendationItem[] = [];

  if ((ctx.overdueItemLoansCount ?? 0) > 0) {
    recs.push({
      id: 'rec-overdue-item-loans',
      severity: 'warning',
      title: `${ctx.overdueItemLoansCount} Peminjaman Barang Melewati Batas Pengembalian`,
      message: 'Terdapat barang fisik yang dipinjam atau dipinjamkan melewati tanggal pengembalian yang direncanakan.',
      reason: 'Segera tindak lanjuti pengembalian atau catat kehilangan aset bila barang tidak dapat dikembalikan.',
      actionLabel: 'Kelola Barang',
      targetTab: 'assets',
    });
  }

  if (ctx.completedObligationsNeedingReallocation.length > 0) {
    const ob = ctx.completedObligationsNeedingReallocation[0];
    recs.push({
      id: `rec-realloc-${ob.id}`,
      severity: 'normal',
      title: `Kewajiban "${ob.name}" Telah Selesai`,
      message: `Alokasi rutin sebesar ${formatIDR(ob.amount)} sudah berhenti otomatis. Alihkan porsi ini ke Dana Darurat atau Target Tabungan.`,
      reason: 'Mencegah dana eks-kewajiban berubah menjadi belanja konsumtif.',
      actionLabel: 'Alihkan Dana',
      targetTab: 'obligations',
    });
  }

  if (ctx.modeEvaluation.mode === 'recovery') {
    recs.push({
      id: 'rec-recovery',
      severity: 'recovery_alert',
      title: 'Mode Pemulihan Aktif — Tahan Setoran Investasi & Belanja Konsumtif',
      message:
        'Prioritaskan pelunasan utang, kewajiban aktif, dan kebutuhan pokok. Target investasi tetap tersimpan sebagai rencana, namun setoran investasi ditunda sampai dana aman positif.',
      reason: ctx.modeEvaluation.reasons[0] || 'Saldo likuid belum mencukupi komitmen.',
      actionLabel: 'Lihat Kewajiban',
      targetTab: 'obligations',
    });
  }

  if (ctx.unfundedObligations > 0) {
    recs.push({
      id: 'rec-kkn',
      severity: 'warning',
      title: `Sisihkan ${formatIDR(ctx.unfundedObligations)} untuk Kewajiban & Tagihan Aktif`,
      message: `Kewajiban dan pengeluaran terjadwal masih kekurangan cadangan ${formatIDR(ctx.unfundedObligations)}.`,
      reason: 'Komitmen terjadwal tidak boleh terpakai untuk jajan.',
      actionLabel: 'Sisihkan Sekarang',
      targetTab: 'obligations',
    });
  }

  if (ctx.outstandingDebtTotal > 0 && ctx.liquidPersonalBalance >= ctx.outstandingDebtTotal) {
    recs.push({
      id: 'rec-pay-debt',
      severity: 'warning',
      title: 'Saldo Cukup untuk Cicil/Lunasi Utang',
      message: `Saldo likuid ${formatIDR(ctx.liquidPersonalBalance)} mencukupi untuk menutup sisa utang ${formatIDR(ctx.outstandingDebtTotal)}.`,
      reason: 'Melunasi utang membantu memulihkan Dana Aman Dibelanjakan.',
      actionLabel: 'Bayar Utang',
      targetTab: 'obligations',
    });
  }

  if (ctx.outstandingReceivableTotal > 0) {
    recs.push({
      id: 'rec-receivable',
      severity: 'normal',
      title: `Pantau Piutang Belum Cair (${formatIDR(ctx.outstandingReceivableTotal)})`,
      message: 'Piutang aktif belum dihitung sebagai kas likuid atau Dana Aman sebelum benar-benar diterima.',
      reason: 'Menghindari kesalahan belanja menggunakan uang yang belum diterima.',
      actionLabel: 'Kelola Piutang',
      targetTab: 'obligations',
    });
  }

  if (ctx.cigaretteAnalysis.weeklyLimit > 0) {
    if (ctx.cigaretteAnalysis.weeklySpent > ctx.cigaretteAnalysis.weeklyLimit) {
      recs.push({
        id: 'rec-cig-over',
        severity: 'critical',
        title: 'Batas Rokok Mingguan Terlampaui',
        message: `Pengeluaran rokok minggu ini (${formatIDR(ctx.cigaretteAnalysis.weeklySpent)}) melampaui batas ${formatIDR(ctx.cigaretteAnalysis.weeklyLimit)}.`,
        reason: `Menekan belanja rokok 50% menghemat sekitar ${formatIDR(ctx.cigaretteAnalysis.potentialMonthlySavings50Pct)}/bulan.`,
        actionLabel: 'Atur Batas',
        targetTab: 'budgets',
      });
    } else if (ctx.cigaretteAnalysis.weeklySpent >= ctx.cigaretteAnalysis.weeklyLimit * 0.75) {
      recs.push({
        id: 'rec-cig-warn',
        severity: 'warning',
        title: 'Pengeluaran Rokok Mendekati Batas Mingguan',
        message: `Sisa jatah rokok minggu ini tinggal ${formatIDR(ctx.cigaretteAnalysis.weeklyLimit - ctx.cigaretteAnalysis.weeklySpent)}.`,
        reason: 'Kontrol frekuensi pembelian agar tidak melewati batas mingguan.',
      });
    }
  }

  if (ctx.hangoutAnalysis.weeklyLimit > 0 && ctx.hangoutAnalysis.weeklySpent > ctx.hangoutAnalysis.weeklyLimit) {
    recs.push({
      id: 'rec-hangout-over',
      severity: 'critical',
      title: 'Anggaran Nongkrong Mingguan Terlampaui',
      message: `Total nongkrong minggu ini ${formatIDR(ctx.hangoutAnalysis.weeklySpent)} dari batas ${formatIDR(ctx.hangoutAnalysis.weeklyLimit)}.`,
      reason: 'Batasi frekuensi nongkrong minggu ini dan pilih aktivitas tanpa biaya.',
    });
  }

  if (
    ctx.modeEvaluation.mode === 'growth' &&
    ctx.safeToSpend > 50000
  ) {
    recs.push({
      id: 'rec-growth-invest',
      severity: 'normal',
      title: 'Prioritas Terpenuhi — Siap Alokasi Investasi & Bisnis',
      message: `Utang lunas, kewajiban aman, dan Dana Darurat terpenuhi. Anda bisa menyisihkan surplus ${formatIDR(ctx.safeToSpend)} ke target investasi atau pengembangan bisnis.`,
      reason: 'Investasi direkomendasikan hanya setelah fondasi kas aman.',
      actionLabel: 'Lihat Target',
      targetTab: 'obligations',
    });
  } else if (
    ctx.emergencySaved === 0 &&
    ctx.outstandingDebtTotal === 0 &&
    ctx.unfundedObligations === 0 &&
    ctx.safeToSpend > 25000
  ) {
    recs.push({
      id: 'rec-emergency-empty',
      severity: 'normal',
      title: 'Mulai Isi Dana Darurat Bulan Ini',
      message: 'Dana Darurat Anda masih Rp0 sementara utang & kewajiban sudah aman. Sisihkan sedikit dari Dana Aman.',
      reason: `Target awal Dana Darurat Anda adalah ${formatIDR(ctx.emergencyTarget)}.`,
      actionLabel: 'Isi Tabungan',
      targetTab: 'obligations',
    });
  }

  if (ctx.potentialShortfall > 0 && ctx.liquidPersonalBalance > 0) {
    recs.push({
      id: 'rec-shortfall',
      severity: 'warning',
      title: 'Potensi Kekurangan Kas Akhir Bulan',
      message: `Dengan asumsi proyeksi saat ini, akhir bulan berpotensi kurang ${formatIDR(ctx.potentialShortfall)}.`,
      reason: 'Proyeksi tidak mengasumsikan uang saku harian yang belum diterima.',
    });
  }

  return recs;
}

export function simulateExpenseImpact(
  state: FinanceState,
  input: {
    amount: number;
    categoryId: string;
    accountId: string;
    date?: string;
  },
  snapshot?: FinanceSnapshot
): ExpenseImpactSimulation {
  const dateISO = input.date ?? todayISO();
  const snap = snapshot ?? computeFinanceSnapshot(state, dateISO);
  const amount = Math.max(0, Math.round(input.amount));
  const cat = state.categories.find((c) => c.id === input.categoryId);
  const acc = snap.accounts.find((a) => a.id === input.accountId);

  const isEssential =
    cat?.classification === 'essential' ||
    cat?.classification === 'obligation' ||
    cat?.classification === 'debt' ||
    cat?.classification === 'business';

  const accountBalanceBefore = acc?.currentBalance ?? 0;
  const accountBalanceAfter = accountBalanceBefore - amount;

  const affectsPersonalLiquid = acc ? !acc.isBusiness && !acc.isProtected : true;
  const rawAfter = affectsPersonalLiquid
    ? snap.rawDiscretionarySurplus - amount
    : snap.rawDiscretionarySurplus;

  const safeToSpendAfter = Math.max(0, rawAfter);
  const fundingShortfallAfter = Math.max(0, -rawAfter);

  const dailyRemainingAfter = isEssential
    ? snap.dailyBudget.remaining
    : Math.max(0, snap.dailyBudget.remaining - amount);
  const weeklyRemainingAfter = isEssential
    ? snap.weeklyBudget.remaining
    : Math.max(0, snap.weeklyBudget.remaining - amount);
  const monthlyRemainingAfter = isEssential
    ? snap.monthlyBudget.remaining
    : Math.max(0, snap.monthlyBudget.remaining - amount);

  const projectedEndOfMonthAfter = affectsPersonalLiquid
    ? snap.monthlyPrediction.estimatedEndOfMonthLiquidBalance - amount
    : snap.monthlyPrediction.estimatedEndOfMonthLiquidBalance;

  const nextMode = evaluateFinancialMode({
    liquidPersonalBalance: affectsPersonalLiquid
      ? snap.personalLiquidOwnNet - amount
      : snap.personalLiquidOwnNet,
    safeToSpend: safeToSpendAfter,
    rawDiscretionarySurplus: rawAfter,
    outstandingDebtTotal: snap.outstandingDebtTotal,
    unfundedObligations: snap.unfundedObligations + snap.unfundedScheduledExpenses,
    emergencySaved: snap.emergencySaved,
    emergencyTarget: snap.emergencyTarget,
    essentialReserve: snap.essentialReserve,
  }).mode;

  const totalUnfunded = snap.unfundedObligations + snap.unfundedScheduledExpenses;
  const unfundedObligationsRisk =
    totalUnfunded === 0
      ? 'Tidak ada kewajiban/tagihan yang kekurangan cadangan.'
      : affectsPersonalLiquid && amount > snap.safeToSpend
      ? `Berisiko memakan dana untuk kewajiban belum terdanai (${formatIDR(totalUnfunded)}).`
      : `Kewajiban belum terdanai tetap ${formatIDR(totalUnfunded)}, aman selama saldo cadangan dijaga.`;

  const debtImpactNote =
    snap.outstandingDebtTotal === 0
      ? 'Tidak ada utang aktif.'
      : amount > snap.safeToSpend && affectsPersonalLiquid
      ? `Mengurangi kemampuan melunasi utang aktif sebesar ${formatIDR(snap.outstandingDebtTotal)}.`
      : `Sisa utang ${formatIDR(snap.outstandingDebtTotal)} masih tertutup oleh kas cadangan.`;

  const emergencyGap = Math.max(0, snap.emergencyTarget - snap.emergencySaved);
  const emergencyFundImpactNote =
    emergencyGap === 0
      ? 'Target Dana Darurat sudah terpenuhi.'
      : `Menunda potensi pengisian kekurangan Dana Darurat (${formatIDR(emergencyGap)}) sebesar ${formatIDR(amount)}.`;

  const activeNonEmergGoals = state.goals.filter((g) => !g.isArchived && g.goalType !== 'emergency' && g.currentAmount < g.targetAmount);
  const savingsGoalsImpactNote =
    activeNonEmergGoals.length === 0
      ? 'Tidak ada target tabungan tertunda.'
      : `Mengurangi kapasitas setoran untuk ${activeNonEmergGoals.length} target tabungan aktif.`;

  const reasons: string[] = [];
  if (acc && accountBalanceAfter < 0) {
    reasons.push(`Saldo akun "${acc.name}" tidak mencukupi (menjadi ${formatIDR(accountBalanceAfter)}).`);
  }
  if (!isEssential && affectsPersonalLiquid && amount > snap.safeToSpend) {
    reasons.push(`Melebihi Dana Aman Dibelanjakan sebesar ${formatIDR(amount - snap.safeToSpend)}.`);
  }
  if (!isEssential && snap.weeklyBudget.limit > 0 && snap.weeklyBudget.discretionarySpent + amount > snap.weeklyBudget.limit) {
    reasons.push('Melampaui batas anggaran konsumtif mingguan.');
  }
  if (nextMode === 'recovery' && snap.modeEvaluation.mode !== 'recovery') {
    reasons.push('Pengeluaran ini akan menurunkan kondisi keuangan ke Mode Pemulihan.');
  }

  let warningLevel: WarningLevel = 'normal';
  if (reasons.length > 0 || nextMode === 'recovery') {
    warningLevel = amount > snap.safeToSpend || (acc && accountBalanceAfter < 0) ? 'recovery_alert' : 'critical';
  } else if (!isEssential && snap.weeklyBudget.limit > 0 && snap.weeklyBudget.discretionarySpent + amount >= snap.weeklyBudget.limit * 0.75) {
    warningLevel = 'warning';
  }

  return {
    amount,
    categoryName: cat?.name ?? 'Kategori',
    accountName: acc?.name ?? 'Akun',
    isEssential,
    safeToSpendBefore: snap.safeToSpend,
    safeToSpendAfter,
    fundingShortfallBefore: snap.fundingShortfall,
    fundingShortfallAfter,
    dailyRemainingBefore: snap.dailyBudget.remaining,
    dailyRemainingAfter,
    weeklyRemainingBefore: snap.weeklyBudget.remaining,
    weeklyRemainingAfter,
    monthlyRemainingBefore: snap.monthlyBudget.remaining,
    monthlyRemainingAfter,
    accountBalanceBefore,
    accountBalanceAfter,
    projectedEndOfMonthBefore: snap.monthlyPrediction.estimatedEndOfMonthLiquidBalance,
    projectedEndOfMonthAfter,
    unfundedObligationsRisk,
    debtImpactNote,
    emergencyFundImpactNote,
    savingsGoalsImpactNote,
    modeBefore: snap.modeEvaluation.mode,
    modeAfter: nextMode,
    warningLevel,
    reasons,
  };
}

export function evaluateDisciplineForExpense(
  state: FinanceState,
  input: {
    amount: number;
    categoryId: string;
    accountId: string;
    date?: string;
  },
  snapshot?: FinanceSnapshot
): DisciplineCheckResult {
  const snap = snapshot ?? computeFinanceSnapshot(state, input.date ?? todayISO());
  const cat = state.categories.find((c) => c.id === input.categoryId);
  const acc = snap.accounts.find((a) => a.id === input.accountId);

  const isEssential =
    cat?.classification === 'essential' ||
    cat?.classification === 'obligation' ||
    cat?.classification === 'debt' ||
    cat?.classification === 'business';

  if (isEssential) {
    const lowBalance = acc && acc.currentBalance < input.amount;
    return {
      requiresConfirmation: false,
      isEssentialBypass: true,
      level: lowBalance ? 'warning' : 'normal',
      title: lowBalance ? 'Catatan Saldo Akun Rendah' : 'Pengeluaran Esensial Diizinkan',
      message: lowBalance
        ? `Pengeluaran esensial (${cat?.name}) tetap diizinkan dan tidak diblokir, namun saldo ${acc?.name} saat ini (${formatIDR(acc?.currentBalance ?? 0)}) lebih kecil dari nominal transaksi.`
        : 'Pengeluaran kebutuhan pokok/kewajiban tidak dibatasi oleh anggaran konsumtif.',
      impactDetails: [],
    };
  }

  const catBudget = snap.categoryBudgets.find((b) => b.categoryId === input.categoryId);
  const projectedCatWeekly = (catBudget?.weeklySpent ?? 0) + input.amount;
  const catLimit = catBudget?.weeklyLimit ?? 0;
  const exceedsCatWeekly = catLimit > 0 && projectedCatWeekly > catLimit;

  const projectedWeeklyDisc = snap.weeklyBudget.discretionarySpent + input.amount;
  const exceedsOverallWeekly =
    snap.weeklyBudget.limit > 0 && projectedWeeklyDisc > snap.weeklyBudget.limit;

  const exceedsSafeToSpend = input.amount > snap.safeToSpend;
  const inRecovery = snap.modeEvaluation.mode === 'recovery';

  const impactDetails: string[] = [];
  if (exceedsCatWeekly) {
    impactDetails.push(
      `Anggaran mingguan ${cat?.name}: ${formatIDR(projectedCatWeekly)} / batas ${formatIDR(catLimit)} (lebih ${formatIDR(projectedCatWeekly - catLimit)}).`
    );
  }
  if (exceedsOverallWeekly) {
    impactDetails.push(
      `Total belanja bebas minggu ini menjadi ${formatIDR(projectedWeeklyDisc)} dari batas ${formatIDR(snap.weeklyBudget.limit)}.`
    );
  }
  if (exceedsSafeToSpend) {
    impactDetails.push(
      `Melebihi Dana Aman Dibelanjakan (${formatIDR(snap.safeToSpend)}) — berisiko mengganggu cadangan kewajiban, utang, atau kebutuhan pokok.`
    );
  }
  if (inRecovery) {
    impactDetails.push(
      'Mode Pemulihan sedang aktif: setiap pengeluaran non-esensial memperlambat pelunasan utang dan stabilitas kas.'
    );
  }

  if (exceedsCatWeekly || exceedsOverallWeekly || exceedsSafeToSpend || inRecovery) {
    return {
      requiresConfirmation: true,
      isEssentialBypass: false,
      level: inRecovery || exceedsSafeToSpend ? 'recovery_alert' : 'critical',
      title:
        inRecovery
          ? 'Peringatan Mode Pemulihan: Konfirmasi Diperlukan'
          : `Peringatan Keras: Melebihi Batas ${cat?.name ?? 'Konsumtif'}`,
      message:
        `Pengeluaran ${cat?.name ?? 'konsumtif'} sebesar ${formatIDR(input.amount)} berpotensi merusak prioritas keuangan Anda. Aplikasi mewajibkan Anda menulis alasan yang jujur sebelum mencatat transaksi ini.`,
      impactDetails,
    };
  }

  if (catLimit > 0 && projectedCatWeekly >= catLimit * 0.75) {
    return {
      requiresConfirmation: false,
      isEssentialBypass: false,
      level: 'warning',
      title: `Mendekati Batas Mingguan ${cat?.name}`,
      message: `Setelah transaksi ini, sisa anggaran mingguan ${cat?.name} tinggal ${formatIDR(catLimit - projectedCatWeekly)}.`,
      impactDetails: [],
    };
  }

  return {
    requiresConfirmation: false,
    isEssentialBypass: false,
    level: 'normal',
    title: 'Dalam Batas Anggaran',
    message: 'Transaksi masih berada dalam batas aman anggaran Anda.',
    impactDetails: [],
  };
}
