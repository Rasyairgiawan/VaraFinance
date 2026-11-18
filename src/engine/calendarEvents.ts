import { FinanceState } from '../types/finance';
import { addDaysISO, daysInMonth } from '../utils/format';

export type CalendarEventType =
  | 'income'
  | 'expense'
  | 'debt_due'
  | 'receivable_due'
  | 'obligation_due'
  | 'scheduled_expense_due'
  | 'freelance_expected'
  | 'goal_contribution'
  | 'no_spend_confirmed'
  | 'custom_reminder';

export interface CalendarEventItem {
  id: string;
  date: string;
  type: CalendarEventType;
  title: string;
  amount?: number;
  detail?: string;
}

export function buildCalendarEventsForMonth(
  state: FinanceState,
  yearMonth: string // YYYY-MM
): Map<string, CalendarEventItem[]> {
  const map = new Map<string, CalendarEventItem[]>();
  const totalDays = daysInMonth(`${yearMonth}-01`);
  const monthStart = `${yearMonth}-01`;
  const monthEnd = `${yearMonth}-${String(totalDays).padStart(2, '0')}`;

  const push = (ev: CalendarEventItem) => {
    const arr = map.get(ev.date) ?? [];
    arr.push(ev);
    map.set(ev.date, arr);
  };

  // 1. Actual Income & Expenses (exclude voided)
  for (const tx of state.transactions) {
    if (tx.isVoided) continue;
    if (tx.date >= monthStart && tx.date <= monthEnd) {
      const cat = state.categories.find((c) => c.id === tx.categoryId)?.name;
      push({
        id: `tx-${tx.id}`,
        date: tx.date,
        type: tx.type === 'income' ? 'income' : 'expense',
        title: tx.description,
        amount: tx.amount,
        detail: cat,
      });
    }
  }

  // 2. Active Debt & Receivable Due Dates (only when dueDate is explicitly set)
  for (const d of state.debts) {
    if (!d.isVoided && d.status === 'active' && d.dueDate && d.dueDate >= monthStart && d.dueDate <= monthEnd) {
      const isReceivable = d.direction === 'receivable';
      push({
        id: `debt-${d.id}`,
        date: d.dueDate,
        type: isReceivable ? 'receivable_due' : 'debt_due',
        title: isReceivable
          ? `Jatuh tempo piutang: ${d.creditor}`
          : `Jatuh tempo utang: ${d.creditor}`,
        amount: d.remainingAmount,
        detail: d.description,
      });
    }
  }

  // 3. Active Obligations & Scheduled Expenses within Month
  for (const ob of state.obligations) {
    if (ob.status !== 'active' || ob.isArchived) continue;
    let cursor = ob.nextDueDate;
    let guard = 0;

    while (cursor <= monthEnd && guard < 12) {
      guard++;
      const withinEnd = !ob.endDate || cursor <= ob.endDate;
      const withinStart = cursor >= ob.startDate;
      if (cursor >= monthStart && withinStart && withinEnd) {
        const isSched = ob.kind === 'scheduled_expense';
        push({
          id: `ob-${ob.id}-${cursor}`,
          date: cursor,
          type: isSched ? 'scheduled_expense_due' : 'obligation_due',
          title: `${isSched ? 'Pengeluaran Terjadwal' : 'Kewajiban'}: ${ob.name}`,
          amount: ob.amount,
          detail:
            ob.reservedAmount >= ob.amount
              ? 'Dana cadangan siap'
              : `Perlu cadangan Rp${(ob.amount - ob.reservedAmount).toLocaleString('id-ID')}`,
        });
      }
      if (ob.frequency === 'once') break;
      cursor =
        ob.frequency === 'weekly'
          ? addDaysISO(cursor, 7)
          : ob.frequency === 'yearly'
          ? addDaysISO(cursor, 365)
          : addDaysISO(cursor, 30);
    }
  }

  // 4. Expected Freelance Payment Schedules
  for (const pay of state.projectPayments) {
    if (
      !pay.isVoided &&
      pay.status === 'expected' &&
      pay.expectedDate &&
      pay.expectedDate >= monthStart &&
      pay.expectedDate <= monthEnd
    ) {
      const proj = state.projects.find((p) => p.id === pay.projectId);
      push({
        id: `projpay-${pay.id}`,
        date: pay.expectedDate,
        type: 'freelance_expected',
        title: `Jadwal bayar proyek: ${proj?.projectName ?? 'Freelance'}`,
        amount: pay.amount,
        detail: 'Belum diterima (bukan kas aktual)',
      });
    }
  }

  // 5. Goal Contributions
  for (const gc of state.goalContributions) {
    if (gc.date >= monthStart && gc.date <= monthEnd) {
      const goal = state.goals.find((g) => g.id === gc.goalId);
      push({
        id: `gc-${gc.id}`,
        date: gc.date,
        type: 'goal_contribution',
        title: `Setor tabungan: ${goal?.name ?? 'Target'}`,
        amount: gc.amount,
      });
    }
  }

  // 6. Manual No-Spend Day Confirmations
  for (const ns of state.noSpendConfirmations ?? []) {
    if (ns.status === 'confirmed' && ns.date >= monthStart && ns.date <= monthEnd) {
      push({
        id: `ns-${ns.date}`,
        date: ns.date,
        type: 'no_spend_confirmed',
        title: 'Hari Tanpa Jajan Dikonfirmasi',
        detail: ns.note,
      });
    }
  }

  // 7. Custom Reminders
  for (const cr of state.settings.reminderSettings?.customReminders ?? []) {
    if (cr.enabled && cr.date >= monthStart && cr.date <= monthEnd) {
      push({
        id: `cr-${cr.id}`,
        date: cr.date,
        type: 'custom_reminder',
        title: `Pengingat: ${cr.title}`,
        detail: cr.note,
      });
    }
  }

  return map;
}
