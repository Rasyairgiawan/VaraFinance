export type AccountType = 'cash' | 'bank' | 'ewallet' | 'savings' | 'investment';
export type AccountStatus = 'active' | 'archived' | 'closed';

export type CategoryClassification =
  | 'essential'
  | 'discretionary'
  | 'obligation'
  | 'debt'
  | 'savings'
  | 'business'
  | 'income';

export type FinancialMode = 'recovery' | 'stabilization' | 'saving' | 'growth';

export type WarningLevel = 'normal' | 'warning' | 'critical' | 'recovery_alert';

export type IncomeSourceType = 'daily_allowance' | 'freelance' | 'salary' | 'business' | 'passive' | 'other';

export type ObligationFrequency = 'once' | 'weekly' | 'monthly' | 'yearly';
export type ObligationDurationType = 'temporary' | 'indefinite' | 'fixed_term' | 'one_time';
export type ObligationStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type ObligationKind = 'obligation' | 'scheduled_expense';

export type DebtDirection = 'payable' | 'receivable';

export type ReceivableKind = 'personal_loan' | 'project_sales';

export type DebtReceiptKind = 'cash_received' | 'direct_expense';

export type TransactionNature =
  | 'standard'
  | 'loan_disbursement'
  | 'debt_receipt'
  | 'debt_direct_expense'
  | 'debt_repayment'
  | 'receivable_collection'
  | 'reconciliation';

export interface AllocationRules {
  obligations: number;
  debt: number;
  essential: number;
  emergency: number;
  personal_savings: number;
  business: number;
  investment: number;
  discretionary: number;
}

export interface CustomReminder {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  note?: string;
  enabled: boolean;
}

export interface ReminderActionState {
  status: 'active' | 'snoozed' | 'completed' | 'disabled';
  snoozedUntil?: string; // YYYY-MM-DD
  updatedAt: string;
}

export interface ReminderSettings {
  enabled: boolean;
  obligationDaysBefore: number;
  debtDueDaysBefore: number;
  dailyNoSpendReminder: boolean;
  cigaretteLimitAlert: boolean;
  browserNotificationsEnabled?: boolean;
  customReminders: CustomReminder[];
  reminderStates?: Record<string, ReminderActionState>;
}

export interface ProjectionAssumptions {
  expectedExtraIncome: number;
  dailyDiscretionaryOverride: number | null;
  includeDebtInProjection: boolean;
  includeObligationsInProjection: boolean;
  includeScheduledExpenses: boolean;
}

export interface UserFinancialSettings {
  fullName: string;
  username?: string;
  onboardingCompleted: boolean;
  dailyBudgetLimit: number;
  weeklyBudgetLimit: number;
  monthlyBudgetLimit: number;
  cigaretteWeeklyLimit: number;
  hangoutWeeklyLimit: number;
  essentialReserveTarget: number;
  emergencyFundTarget: number;
  allowanceAllocationRules: AllocationRules;
  freelanceAllocationRules: AllocationRules;
  reminderSettings: ReminderSettings;
  securityPinHash?: string;
  pinEnabled?: boolean;
  requirePinOnReopen?: boolean;
  autoLockMinutes?: number;
}

export type AuthProviderMode = 'local' | 'cloud';

export interface SecurityPreferences {
  pinEnabled: boolean;
  requirePinOnReopen: boolean;
  autoLockMinutes: number; // 0 = disabled, otherwise minutes of inactivity
}

export interface AuthUserSummary {
  userId: string;
  username: string;
  email?: string;
  mode: AuthProviderMode;
  pinConfigured: boolean;
  pinEnabled: boolean;
  requirePinOnReopen: boolean;
  autoLockMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  userId: string;
  username: string;
  email?: string;
  mode: AuthProviderMode;
  deviceId: string;
  issuedAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

export interface PinGuardState {
  failedAttempts: number;
  lockedUntil: number | null; // epoch ms
}

export interface Account {
  id: string;
  systemKey?: string;
  name: string;
  accountType: AccountType;
  openingBalance: number;
  isBusiness: boolean;
  isProtected: boolean;
  status?: AccountStatus;
  archivedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface Category {
  id: string;
  systemKey?: string;
  name: string;
  type: 'income' | 'expense';
  classification: CategoryClassification;
  weeklyLimit: number;
  monthlyLimit: number;
  isSystem: boolean;
  isArchived?: boolean;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface Transaction {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  description: string;
  notes?: string;
  tags: string[];
  incomeSource?: IncomeSourceType;
  projectId?: string;
  debtId?: string;
  transactionNature?: TransactionNature;
  affectsAccountBalance?: boolean;
  excludeFromExpenseStats?: boolean;
  excludeFromIncomeStats?: boolean;
  isEssential: boolean;
  isDiscretionary: boolean;
  exceededBudget: boolean;
  overrideReason?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface AccountTransfer {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  date: string;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface FreelanceProject {
  id: string;
  clientName: string;
  projectName: string;
  contractValue: number;
  paymentScheme: 'full' | 'dp_final' | 'milestone' | 'custom';
  status: 'active' | 'completed' | 'cancelled';
  businessSharePct: number;
  personalSharePct: number;
  notes?: string;
  isArchived?: boolean;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface ProjectPayment {
  id: string;
  projectId: string;
  paymentType: 'full' | 'dp' | 'installment' | 'final';
  amount: number;
  status: 'expected' | 'received';
  expectedDate?: string;
  receivedDate?: string;
  accountId?: string;
  transactionId?: string;
  notes?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface ProjectExpense {
  id: string;
  projectId: string;
  description: string;
  amount: number;
  date: string;
  accountId: string;
  transactionId?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface Debt {
  id: string;
  systemKey?: string;
  direction?: DebtDirection; // 'payable' (utang) | 'receivable' (piutang), default 'payable'
  receivableType?: ReceivableKind;
  debtReceiptType?: DebtReceiptKind;
  accountId?: string;
  expenseCategoryId?: string;
  transactionId?: string;
  projectId?: string;
  projectPaymentId?: string;
  revenueAlreadyRecorded?: boolean;
  date?: string;
  idempotencyKey?: string;
  creditor: string;
  description: string;
  initialAmount: number;
  remainingAmount: number;
  dueDate?: string;
  priority: number;
  status: 'active' | 'paid';
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface DebtPayment {
  id: string;
  debtId: string;
  amount: number;
  date: string;
  accountId: string;
  transactionId?: string;
  notes?: string;
  idempotencyKey?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface RecurringObligation {
  id: string;
  systemKey?: string;
  kind?: ObligationKind; // 'obligation' | 'scheduled_expense', default 'obligation'
  name: string;
  category: string;
  amount: number;
  frequency: ObligationFrequency;
  durationType: ObligationDurationType;
  startDate: string;
  nextDueDate: string;
  endDate?: string;
  status: ObligationStatus;
  reservedAmount: number;
  reminderEnabled: boolean;
  reminderDaysBefore: number;
  reallocatedToGoalId?: string;
  isActive: boolean;
  isArchived?: boolean;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface ObligationLog {
  id: string;
  obligationId: string;
  action: 'reserve' | 'pay' | 'reallocate' | 'status_change';
  amount: number;
  date: string;
  accountId?: string;
  transactionId?: string;
  notes?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export type GoalType = 'emergency' | 'personal' | 'smartphone' | 'business' | 'investment' | 'buffer';

export interface SavingsGoal {
  id: string;
  systemKey?: string;
  name: string;
  goalType: GoalType;
  targetAmount: number;
  currentAmount: number;
  virtualReservedInLiquid: number;
  targetDate?: string;
  priority: number;
  monthlyTarget: number;
  isProtected: boolean;
  isArchived?: boolean;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface GoalContribution {
  id: string;
  goalId: string;
  amount: number;
  date: string;
  fromAccountId: string;
  toAccountId?: string;
  transferId?: string;
  notes?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface NoSpendConfirmation {
  date: string; // YYYY-MM-DD
  status: 'confirmed' | 'revoked';
  note?: string;
  confirmedAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export type ChangeEntityType =
  | 'settings'
  | 'budget'
  | 'allocation'
  | 'obligation'
  | 'scheduled_expense'
  | 'goal'
  | 'account'
  | 'category'
  | 'transaction'
  | 'debt'
  | 'receivable';

export interface ChangeLogEntry {
  id: string;
  entityType: ChangeEntityType;
  entityId: string;
  action: 'create' | 'update' | 'archive' | 'close' | 'reopen' | 'void' | 'delete' | 'reconcile';
  summary: string;
  beforeValue?: string;
  afterValue?: string;
  note?: string;
  timestamp: string;
}

export interface SyncMeta {
  lastModifiedAt: string;
  deviceId: string;
  version: number;
}

export interface FinanceState {
  schemaVersion?: number;
  settings: UserFinancialSettings;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  transfers: AccountTransfer[];
  projects: FreelanceProject[];
  projectPayments: ProjectPayment[];
  projectExpenses: ProjectExpense[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  obligations: RecurringObligation[];
  obligationLogs: ObligationLog[];
  goals: SavingsGoal[];
  goalContributions: GoalContribution[];
  noSpendConfirmations: NoSpendConfirmation[];
  changeLogs?: ChangeLogEntry[];
  projectionAssumptions?: ProjectionAssumptions;
  syncMeta?: SyncMeta;
}

export interface DisciplineCheckResult {
  requiresConfirmation: boolean;
  level: WarningLevel;
  title: string;
  message: string;
  impactDetails: string[];
  isEssentialBypass: boolean;
}
