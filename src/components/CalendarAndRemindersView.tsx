import React, { useMemo, useState } from 'react';
import {
  Bell,
  BellOff,
  Calendar as CalendarIcon,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { buildCalendarEventsForMonth, CalendarEventType } from '../engine/calendarEvents';
import { FinanceSnapshot } from '../engine/financeEngine';
import {
  addCustomReminderAction,
  completeReminderAction,
  deleteCustomReminderAction,
  disableReminderAction,
  resetReminderStateAction,
  snoozeReminderAction,
  toggleCustomReminderAction,
  updateReminderSettingsAction,
} from '../hooks/financeActions';
import { FinanceState } from '../types/finance';
import { daysInMonth, formatDateID, formatIDR, todayISO } from '../utils/format';

interface CalendarAndRemindersViewProps {
  state: FinanceState;
  snapshot: FinanceSnapshot;
  onCommit: (next: FinanceState) => void;
}

const EVENT_META: Record<CalendarEventType, { label: string; dot: string; badge: string }> = {
  income: { label: 'Pemasukan Aktual', dot: 'bg-emerald-600', badge: 'text-emerald-800 bg-emerald-50 border-emerald-200' },
  expense: { label: 'Pengeluaran', dot: 'bg-slate-700', badge: 'text-slate-800 bg-slate-50 border-slate-200' },
  debt_due: { label: 'Jatuh Tempo Utang', dot: 'bg-red-600', badge: 'text-red-800 bg-red-50 border-red-200' },
  receivable_due: { label: 'Jatuh Tempo Piutang', dot: 'bg-[#0976A6]', badge: 'text-[#075D83] bg-[#E8F6FC] border-[#B9E2F5]' },
  obligation_due: { label: 'Kewajiban Rutin', dot: 'bg-[#0C8FC5]', badge: 'text-[#075D83] bg-[#E8F6FC] border-[#B9E2F5]' },
  scheduled_expense_due: { label: 'Pengeluaran Terjadwal', dot: 'bg-orange-500', badge: 'text-orange-800 bg-orange-50 border-orange-200' },
  freelance_expected: { label: 'Jadwal Bayar Freelance', dot: 'bg-amber-500', badge: 'text-amber-800 bg-amber-50 border-amber-200' },
  goal_contribution: { label: 'Setoran Tabungan', dot: 'bg-teal-600', badge: 'text-teal-800 bg-teal-50 border-teal-200' },
  no_spend_confirmed: { label: 'Hari Tanpa Jajan', dot: 'bg-emerald-500', badge: 'text-emerald-800 bg-emerald-50 border-emerald-200' },
  custom_reminder: { label: 'Pengingat Pribadi', dot: 'bg-indigo-600', badge: 'text-indigo-800 bg-indigo-50 border-indigo-200' },
};

export const CalendarAndRemindersView: React.FC<CalendarAndRemindersViewProps> = ({
  state,
  snapshot,
  onCommit,
}) => {
  const [yearMonth, setYearMonth] = useState(snapshot.nowISO.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(snapshot.nowISO);
  const [newRemTitle, setNewRemTitle] = useState('');
  const [newRemDate, setNewRemDate] = useState(todayISO());
  const [newRemNote, setNewRemNote] = useState('');
  const [notifMsg, setNotifMsg] = useState<string | null>(null);

  const eventsMap = useMemo(
    () => buildCalendarEventsForMonth(state, yearMonth),
    [state, yearMonth]
  );

  const [y, m] = yearMonth.split('-').map(Number);
  const totalDays = daysInMonth(`${yearMonth}-01`);
  const firstDayOfWeek = new Date(y, m - 1, 1).getDay();
  const leadingEmpty = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  const monthLabel = new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(y, m - 1, 1));

  const shiftMonth = (delta: number) => {
    const dt = new Date(y, m - 1 + delta, 1);
    const nextYm = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    setYearMonth(nextYm);
  };

  const selectedEvents = eventsMap.get(selectedDate) ?? [];
  const rs = state.settings.reminderSettings;
  const suppressedEntries = Object.entries(rs.reminderStates ?? {});

  const handleAddCustomReminder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRemTitle.trim()) return;
    onCommit(
      addCustomReminderAction(state, {
        title: newRemTitle,
        date: newRemDate,
        note: newRemNote,
      })
    );
    setNewRemTitle('');
    setNewRemNote('');
  };

  const handleToggleBrowserNotifications = async (checked: boolean) => {
    setNotifMsg(null);
    if (!checked) {
      onCommit(updateReminderSettingsAction(state, { browserNotificationsEnabled: false }));
      return;
    }
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifMsg('Browser/perangkat ini tidak mendukung Web Notification API.');
      return;
    }
    try {
      const permission = await window.Notification.requestPermission();
      if (permission === 'granted') {
        onCommit(updateReminderSettingsAction(state, { browserNotificationsEnabled: true }));
        setNotifMsg('Notifikasi browser diaktifkan untuk pengingat jatuh tempo.');
      } else {
        setNotifMsg('Izin notifikasi browser ditolak. Pengingat tetap tampil di dalam aplikasi.');
      }
    } catch {
      setNotifMsg('Gagal meminta izin notifikasi browser.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Monthly Calendar Grid */}
        <section className="lg:col-span-8 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <CalendarIcon className="w-5 h-5 text-[#0976A6]" />
              <h2 className="font-display text-base font-bold text-slate-900 capitalize">
                {monthLabel}
              </h2>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-50"
                aria-label="Bulan sebelumnya"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setYearMonth(snapshot.nowISO.slice(0, 7));
                  setSelectedDate(snapshot.nowISO);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 hover:bg-slate-50"
              >
                Hari Ini
              </button>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-50"
                aria-label="Bulan berikutnya"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold text-slate-500">
            {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((day) => (
              <div key={day} className="py-1">
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: leadingEmpty }).map((_, idx) => (
              <div key={`empty-${idx}`} className="h-16 sm:h-20 rounded-xl bg-slate-50/50" />
            ))}
            {Array.from({ length: totalDays }).map((_, idx) => {
              const dayNum = idx + 1;
              const iso = `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
              const evs = eventsMap.get(iso) ?? [];
              const isSelected = selectedDate === iso;
              const isToday = snapshot.nowISO === iso;
              const uniqueTypes = Array.from(new Set(evs.map((e) => e.type)));

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setSelectedDate(iso)}
                  className={`h-16 sm:h-20 rounded-xl border p-1.5 sm:p-2 flex flex-col justify-between text-left transition-colors ${
                    isSelected
                      ? 'border-[#0976A6] bg-[#E8F6FC]/80'
                      : isToday
                      ? 'border-[#0C8FC5] bg-white'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`font-mono-num text-xs font-bold ${
                      isToday ? 'text-[#0976A6]' : 'text-slate-800'
                    }`}
                  >
                    {dayNum}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {uniqueTypes.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        title={EVENT_META[t].label}
                        className={`w-2 h-2 rounded-full ${EVENT_META[t].dot}`}
                      />
                    ))}
                    {evs.length > 4 && (
                      <span className="text-[10px] font-mono-num text-slate-500">
                        +{evs.length - 4}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="border-t border-slate-100 pt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-slate-600">
            {(Object.keys(EVENT_META) as CalendarEventType[]).map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${EVENT_META[key].dot}`} />
                {EVENT_META[key].label}
              </span>
            ))}
          </div>
        </section>

        {/* Day Agenda Details */}
        <section className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div>
            <p className="text-xs text-slate-500">Agenda Tanggal</p>
            <h3 className="font-display text-base font-bold text-slate-900">
              {formatDateID(selectedDate)}
            </h3>
          </div>

          {selectedEvents.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-200 rounded-xl">
              Tidak ada aktivitas atau jadwal pada tanggal ini.
            </p>
          ) : (
            <div className="space-y-2.5">
              {selectedEvents.map((ev) => (
                <div
                  key={ev.id}
                  className={`rounded-xl border p-3 text-xs space-y-1 ${EVENT_META[ev.type].badge}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">{EVENT_META[ev.type].label}</span>
                    {ev.amount !== undefined && (
                      <span className="font-mono-num font-extrabold">{formatIDR(ev.amount)}</span>
                    )}
                  </div>
                  <p className="font-semibold text-slate-900">{ev.title}</p>
                  {ev.detail && <p className="opacity-80">{ev.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Active Reminders Action Queue (Snooze / Complete / Disable) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              Antrean Pengingat Aktif ({snapshot.upcomingReminders.length})
            </h2>
            <p className="text-xs text-slate-500">
              Tunda, tandai selesai, atau matikan pengingat yang tidak relevan saat ini.
            </p>
          </div>
        </div>

        {snapshot.upcomingReminders.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center rounded-xl border border-dashed border-slate-200">
            Tidak ada pengingat aktif untuk ditindaklanjuti saat ini.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {snapshot.upcomingReminders.map((rem) => (
              <div
                key={rem.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div>
                  <p className="font-bold text-slate-900">{rem.title}</p>
                  <p className="text-slate-500">
                    Jadwal: {formatDateID(rem.dueDate)}
                    {rem.amount !== undefined ? ` · ${formatIDR(rem.amount)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onCommit(snoozeReminderAction(state, rem.id, 1, snapshot.nowISO))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <span>Tunda 1h</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onCommit(snoozeReminderAction(state, rem.id, 3, snapshot.nowISO))}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Tunda 3h
                  </button>
                  <button
                    type="button"
                    onClick={() => onCommit(completeReminderAction(state, rem.id))}
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 font-semibold text-emerald-800 hover:bg-emerald-100"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Selesai</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onCommit(disableReminderAction(state, rem.id))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-slate-500 hover:text-red-700"
                  >
                    <BellOff className="w-3.5 h-3.5" />
                    <span>Matikan</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {suppressedEntries.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2 text-xs">
            <p className="font-bold text-slate-700">
              Pengingat Ditunda / Selesai / Dinonaktifkan ({suppressedEntries.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {suppressedEntries.map(([id, st]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onCommit(resetReminderStateAction(state, id))}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:border-[#0976A6]"
                >
                  <RotateCcw className="w-3 h-3 text-[#0976A6]" />
                  <span>
                    Aktifkan lagi ({st.status === 'snoozed' ? `tunda s.d. ${st.snoozedUntil}` : st.status})
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Configurable Reminders Panel */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2.5">
            <Bell className="w-5 h-5 text-[#0976A6]" />
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                Pengaturan Pengingat Keuangan
              </h2>
              <p className="text-xs text-slate-500">
                Aktifkan atau nonaktifkan pengingat jatuh tempo utang, piutang, kewajiban rutin, rokok, dan Hari Tanpa Jajan.
              </p>
            </div>
          </div>
          <label className="inline-flex items-center gap-2.5 text-xs font-semibold text-slate-900 cursor-pointer">
            <input
              type="checkbox"
              checked={rs.enabled}
              onChange={(e) =>
                onCommit(updateReminderSettingsAction(state, { enabled: e.target.checked }))
              }
              className="h-4 w-4 rounded border-slate-300 text-[#0976A6]"
            />
            <span>{rs.enabled ? 'Pengingat Aktif' : 'Semua Pengingat Nonaktif'}</span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="rounded-xl border border-slate-200 p-4 space-y-3">
            <p className="font-bold text-slate-900">Aturan Pengingat Otomatis</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-600">Ingatkan kewajiban & tagihan sebelum jatuh tempo (hari):</span>
              <input
                type="number"
                min={0}
                max={30}
                disabled={!rs.enabled}
                value={rs.obligationDaysBefore}
                onChange={(e) =>
                  onCommit(
                    updateReminderSettingsAction(state, {
                      obligationDaysBefore: Math.max(0, Number(e.target.value) || 0),
                    })
                  )
                }
                className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-center font-mono-num"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-600">Ingatkan jatuh tempo utang & piutang (hari):</span>
              <input
                type="number"
                min={0}
                max={30}
                disabled={!rs.enabled}
                value={rs.debtDueDaysBefore}
                onChange={(e) =>
                  onCommit(
                    updateReminderSettingsAction(state, {
                      debtDueDaysBefore: Math.max(0, Number(e.target.value) || 0),
                    })
                  )
                }
                className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-center font-mono-num"
              />
            </div>
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-slate-600">Pengingat konfirmasi Hari Tanpa Jajan</span>
              <input
                type="checkbox"
                disabled={!rs.enabled}
                checked={rs.dailyNoSpendReminder}
                onChange={(e) =>
                  onCommit(
                    updateReminderSettingsAction(state, { dailyNoSpendReminder: e.target.checked })
                  )
                }
              />
            </label>
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-slate-600">Peringatan saat rokok mencapai 75% batas</span>
              <input
                type="checkbox"
                disabled={!rs.enabled}
                checked={rs.cigaretteLimitAlert}
                onChange={(e) =>
                  onCommit(
                    updateReminderSettingsAction(state, { cigaretteLimitAlert: e.target.checked })
                  )
                }
              />
            </label>
            <label className="flex items-center justify-between gap-3 cursor-pointer pt-1 border-t border-slate-100">
              <span className="text-slate-600">Aktifkan Notifikasi Browser (Web Notification API)</span>
              <input
                type="checkbox"
                disabled={!rs.enabled}
                checked={Boolean(rs.browserNotificationsEnabled)}
                onChange={(e) => handleToggleBrowserNotifications(e.target.checked)}
              />
            </label>
            {notifMsg && <p className="text-[11px] font-medium text-[#0976A6]">{notifMsg}</p>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4 space-y-3">
            <p className="font-bold text-slate-900">Pengingat Khusus Buatan Anda</p>
            <form onSubmit={handleAddCustomReminder} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                required
                value={newRemTitle}
                onChange={(e) => setNewRemTitle(e.target.value)}
                placeholder="Judul pengingat"
                className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs sm:col-span-2"
              />
              <input
                type="date"
                required
                value={newRemDate}
                onChange={(e) => setNewRemDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
              />
              <input
                type="text"
                value={newRemNote}
                onChange={(e) => setNewRemNote(e.target.value)}
                placeholder="Catatan opsional"
                className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs sm:col-span-2"
              />
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#0976A6] px-3 py-2 text-xs font-semibold text-white"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah</span>
              </button>
            </form>

            {(rs.customReminders ?? []).length === 0 ? (
              <p className="text-slate-400">Belum ada pengingat khusus.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {(rs.customReminders ?? []).map((cr) => (
                  <div key={cr.id} className="py-2 flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 cursor-pointer min-w-0">
                      <input
                        type="checkbox"
                        checked={cr.enabled}
                        onChange={() => onCommit(toggleCustomReminderAction(state, cr.id))}
                      />
                      <div className="min-w-0">
                        <p className={`font-semibold truncate ${cr.enabled ? 'text-slate-900' : 'line-through text-slate-400'}`}>
                          {cr.title}
                        </p>
                        <p className="text-[11px] text-slate-500">{formatDateID(cr.date)}</p>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => onCommit(deleteCustomReminderAction(state, cr.id))}
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      aria-label="Hapus pengingat"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
