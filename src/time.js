// All timestamps are stored as UTC ISO strings and displayed in EAT (UTC+3, no DST).
export const TZ = 'Africa/Nairobi';
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export function fmt(iso) {
  return iso ? `${dateTimeFmt.format(new Date(iso))} EAT` : '—';
}
export function fmtDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}
export function fmtTime(iso) {
  return iso ? `${timeFmt.format(new Date(iso))} EAT` : '—';
}

/** "2026-11-12T23:59" entered in a datetime-local field, interpreted as EAT → UTC ISO */
export function fromLocalInput(value) {
  if (!value) return null;
  const v = value.length === 10 ? `${value}T23:59` : value;
  const d = new Date(`${v.slice(0, 16)}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function toLocalInput(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + EAT_OFFSET_MS).toISOString().slice(0, 16);
}

/** Parse a date from an import file. Accepts ISO with offset, or "YYYY-MM-DD HH:MM" (treated as EAT). */
export function parseImportDate(value) {
  if (!value) return null;
  const v = value.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return fromLocalInput(v.replace(' ', 'T'));
}

function eatDayOfWeek(d) {
  return new Date(d.getTime() + EAT_OFFSET_MS).getUTCDay();
}
const isWeekend = (d) => [0, 6].includes(eatDayOfWeek(d));

/**
 * Add working days (Mon–Fri, EAT). Something raised at the weekend starts the
 * clock at 08:00 EAT on Monday.
 */
export function addWorkingDays(from, n) {
  let d = new Date(from);
  if (isWeekend(d)) {
    while (isWeekend(d)) d = new Date(d.getTime() + DAY);
    const local = new Date(d.getTime() + EAT_OFFSET_MS);
    local.setUTCHours(8, 0, 0, 0);
    d = new Date(local.getTime() - EAT_OFFSET_MS);
  }
  let added = 0;
  while (added < n) {
    d = new Date(d.getTime() + DAY);
    if (!isWeekend(d)) added++;
  }
  return d;
}

export function relative(iso, at = new Date()) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - at.getTime();
  const abs = Math.abs(diff);
  let text;
  if (abs < HOUR) text = `${Math.max(1, Math.round(abs / 60000))} min`;
  else if (abs < DAY) text = `${Math.round(abs / HOUR)} h`;
  else text = `${Math.round(abs / DAY)} day${Math.round(abs / DAY) === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}
