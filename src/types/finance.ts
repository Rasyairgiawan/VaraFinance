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

export type ReceivableKind =
  | 'personal_loan'
  | 'project_sales'
  | 'split_bill'
  | 'friend_advance'
  | 'project_reimbursement'
  | 'asset_sale'
  | 'asset_loss_compensation';

export type ProjectExpenseKind = 'project_cost' | 'pure_advance' | 'pass_through';

export type DebtReceiptKind = 'cash_received' | 'direct_expense';

export type TransactionNature =
  | 'standard'
  | 'loan_disbursement'
  | 'debt_receipt'
  | 'debt_direct_expense'
  | 'debt_repayment'
  | 'receivable_collection'
  | 'receivable_write_off'
  | 'custodial_receipt'
  | 'custodial_return'
  | 'project_advance_receipt'
  | 'project_advance_recognition'
  | 'project_advance_refund'
  | 'split_bill_payment'
  | 'split_bill_personal_share'
  | 'friend_advance'
  | 'project_reimbursement_advance'
  | 'reimbursement_collection'
  | 'linked_borrow_lend'
  | 'asset_purchase_cash'
  | 'asset_purchase_credit'
  | 'asset_purchase_down_payment'
  | 'asset_sale_proceeds'
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

export interface AccountLinkRecord {
  localUserId: string;
  cloudUserId: string;
  cloudEmail?: string;
  cloudUsername?: string;
  linkedAt: string;
  updatedAt: string;
  status: 'linked';
}

export interface AuthUserSummary {
  userId: string;
  username: string;
  email?: string;
  mode: AuthProviderMode;
  localUserId?: string;
  cloudUserId?: string;
  linkedLocalUserId?: string;
  linkedCloudUserId?: string;
  linkedCloudEmail?: string;
  isLinked?: boolean;
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
  localUserId?: string;
  cloudUserId?: string;
  storageUserId?: string;
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
  splitBillId?: string;
  custodialFundId?: string;
  projectAdvanceId?: string;
  assetId?: string;
  physicalLoanId?: string;
  ledgerGroupId?: string;
  parentTransactionId?: string;
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

export interface FundAllocation {
  accountId: string;
  amount: number;
}

export interface TransferAllocationMovement {
  fundType: 'custodial' | 'project_advance';
  fundId: string;
  amount: number;
}

export interface AccountTransfer {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  date: string;
  notes?: string;
  idempotencyKey?: string;
  restrictedMovements?: TransferAllocationMovement[];
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
  expenseKind?: ProjectExpenseKind; // 'project_cost' (default) | 'pure_advance' | 'pass_through'
  linkedReceivableId?: string;
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

export type DebtStatus = 'active' | 'paid' | 'written_off';

export interface DebtWriteOffEntry {
  id: string;
  action: 'write_off' | 'recover';
  amount: number;
  date: string;
  revenueAlreadyRecorded: boolean;
  transactionId?: string;
  reason?: string;
  idempotencyKey?: string;
  createdAt: string;
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
  projectExpenseId?: string;
  splitBillId?: string;
  linkedDebtId?: string;
  assetId?: string;
  physicalLoanId?: string;
  reimbursementKind?: 'pure_advance' | 'pass_through';
  revenueAlreadyRecorded?: boolean;
  date?: string;
  idempotencyKey?: string;
  creditor: string;
  description: string;
  initialAmount: number;
  remainingAmount: number;
  dueDate?: string;
  priority: number;
  status: DebtStatus;
  writtenOffAmount?: number;
  writtenOffAt?: string;
  writeOffReason?: string;
  writeOffHistory?: DebtWriteOffEntry[];
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface SplitBillParticipant {
  id: string;
  name: string;
  shareAmount: number;
  debtId: string;
}

export interface SplitBill {
  id: string;
  title: string;
  date: string;
  categoryId: string;
  accountId: string;
  totalAmount: number;
  userShareAmount: number;
  splitMode: 'equal' | 'manual';
  participants: SplitBillParticipant[];
  paymentTransactionId: string;
  personalShareTransactionId?: string;
  ledgerGroupId: string;
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

export type CustodialFundStatus = 'active' | 'returned' | 'voided';

export interface CustodialReturnEntry {
  id: string;
  amount: number;
  date: string;
  accountId: string;
  transactionId: string;
  notes?: string;
  idempotencyKey?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
}

export interface CustodialFund {
  id: string;
  counterparty: string;
  description: string;
  initialAmount: number;
  remainingAmount: number;
  receivedDate: string;
  holdingAccountId: string;
  fundAllocations: FundAllocation[];
  receiptTransactionId: string;
  ledgerGroupId: string;
  status: CustodialFundStatus;
  returns: CustodialReturnEntry[];
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

export type ProjectAdvanceStatus = 'active' | 'settled' | 'voided';

export interface ProjectAdvanceRecognition {
  id: string;
  amount: number;
  date: string;
  transactionId: string;
  allocationDeltas?: FundAllocation[];
  notes?: string;
  idempotencyKey?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
}

export interface ProjectAdvanceRefund {
  id: string;
  amount: number;
  date: string;
  accountId: string;
  transactionId: string;
  notes?: string;
  idempotencyKey?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
}

export interface ProjectAdvance {
  id: string;
  projectId: string;
  clientName: string;
  description: string;
  initialAmount: number;
  recognizedAmount: number;
  refundedAmount: number;
  remainingAmount: number;
  receivedDate: string;
  holdingAccountId: string;
  fundAllocations: FundAllocation[];
  receiptTransactionId: string;
  ledgerGroupId: string;
  status: ProjectAdvanceStatus;
  recognitions: ProjectAdvanceRecognition[];
  refunds: ProjectAdvanceRefund[];
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
  linkedDebtId?: string;
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

export type AssetCategory =
  | 'electronics'
  | 'vehicle'
  | 'gadget'
  | 'equipment'
  | 'furniture'
  | 'other';

export type AssetCondition = 'excellent' | 'good' | 'fair' | 'damaged';

export type AssetStatus = 'active' | 'lent' | 'sold' | 'lost' | 'voided';

export type AssetPaymentMethod = 'cash' | 'credit' | 'credit_with_down_payment';

export interface AssetConditionLogEntry {
  id: string;
  date: string;
  previousCondition?: AssetCondition;
  condition: AssetCondition;
  note?: string;
  createdAt: string;
}

export interface AssetDisposalRecord {
  disposalType: 'sold';
  soldDate: string;
  salePrice: number;
  acquisitionValueAtDisposal: number;
  gainOrLoss: number;
  proceedsMode: 'cash' | 'receivable';
  buyerName?: string;
  saleAccountId?: string;
  saleTransactionId?: string;
  receivableId?: string;
  notes?: string;
  createdAt: string;
}

export interface AssetLossRecord {
  id: string;
  lostDate: string;
  reason: string;
  lossAmount: number;
  loanId?: string;
  liableParty?: string;
  compensationAmount?: number;
  compensationDebtId?: string;
  compensationCancelled?: boolean;
  compensationCancelledAt?: string;
  compensationCancelReason?: string;
  notes?: string;
  createdAt: string;
}

export interface AssetRecoveryRecord {
  id: string;
  recoveredDate: string;
  condition: AssetCondition;
  lossRecordId?: string;
  compensationCancelled?: boolean;
  notes?: string;
  createdAt: string;
}

export interface PhysicalAsset {
  id: string;
  name: string;
  category: AssetCategory;
  acquisitionDate: string;
  acquisitionValue: number;
  condition: AssetCondition;
  status: AssetStatus;
  paymentMethod: AssetPaymentMethod;
  accountId?: string;
  downPaymentAmount?: number;
  purchaseTransactionId?: string;
  downPaymentTransactionId?: string;
  purchaseDebtId?: string;
  ledgerGroupId: string;
  brandOrModel?: string;
  serialNumber?: string;
  notes?: string;
  conditionHistory: AssetConditionLogEntry[];
  disposal?: AssetDisposalRecord;
  lossHistory: AssetLossRecord[];
  recoveryHistory: AssetRecoveryRecord[];
  idempotencyKey?: string;
  isVoided?: boolean;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export type PhysicalLoanDirection = 'borrowed' | 'lent';

export type PhysicalLoanStatus = 'active' | 'returned' | 'lost' | 'voided';

export interface PhysicalItemLoan {
  id: string;
  direction: PhysicalLoanDirection;
  assetId?: string;
  itemName: string;
  category?: AssetCategory;
  counterpartyName: string;
  loanDate: string;
  expectedReturnDate?: string;
  returnedDate?: string;
  conditionGivenOrReceived: AssetCondition;
  conditionReturned?: AssetCondition;
  status: PhysicalLoanStatus;
  conditionHistory: AssetConditionLogEntry[];
  lossRecordId?: string;
  compensationDebtId?: string;
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
  | 'receivable'
  | 'custodial'
  | 'project_advance'
  | 'split_bill'
  | 'physical_asset'
  | 'physical_loan';

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
  splitBills?: SplitBill[];
  custodialFunds?: CustodialFund[];
  projectAdvances?: ProjectAdvance[];
  physicalAssets?: PhysicalAsset[];
  physicalItemLoans?: PhysicalItemLoan[];
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
