export function formatIDR(amount: number): string {
  const isNeg = amount < 0;
  const abs = Math.abs(Math.round(amount));
  const formatted = new Intl.NumberFormat('id-ID').format(abs);
  return `${isNeg ? '-' : ''}Rp${formatted}`;
}

export function formatShortIDR(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    return `${sign}Rp${(abs / 1_000_000).toFixed(1).replace('.0', '')}jt`;
  }
  if (abs >= 1_000) {
    return `${sign}Rp${Math.round(abs / 1_000)}rb`;
  }
  return formatIDR(amount);
}

export function todayISO(referenceDate: Date = new Date()): string {
  const y = referenceDate.getFullYear();
  const m = String(referenceDate.getMonth() + 1).padStart(2, '0');
  const d = String(referenceDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysISO(baseISO: string, days: number): string {
  const [y, m, d] = baseISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayISO(dt);
}

export function startOfWeekISO(baseISO: string): string {
  const [y, m, d] = baseISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  dt.setDate(dt.getDate() + diff);
  return todayISO(dt);
}

export function startOfMonthISO(baseISO: string): string {
  return `${baseISO.slice(0, 7)}-01`;
}

export function daysInMonth(baseISO: string): number {
  const [y, m] = baseISO.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function formatDateID(isoDate: string): string {
  if (!isoDate) return '-';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const STRICT_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GENERIC_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStrictUUIDv4(value: unknown): value is string {
  return typeof value === 'string' && STRICT_UUID_V4_REGEX.test(value);
}

export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && GENERIC_UUID_REGEX.test(value);
}
