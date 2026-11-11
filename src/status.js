import { fmt, HOUR } from './time.js';

export const SUBMISSION_STATUSES = {
  not_checked: 'Not checked yet',
  student_claimed: 'Student says submitted',
  outstanding: 'Confirmed not submitted',
  awaiting_review: 'Awaiting tutor review',
  revision_requested: 'Revision requested',
  approved: 'Approved',
};

export const TICKET_STATUSES = {
  awaiting_tutor: 'Waiting on tutor',
  awaiting_student: 'Waiting on student',
  resolved: 'Resolved',
};

export const DEFAULT_SKILLS = [
  'PostgreSQL imports', 'CTEs', 'Joins', 'Window functions', 'Python', 'pandas',
  'Git & GitHub', 'Excel', 'Power BI', 'Environment setup', 'Other',
];

/** The deadline used for reminders: an approved extension / resubmission date wins over the original. */
export const effectiveDue = (row) => row.due_override_at || row.due_at;

/** Statuses where the student still owes something. */
export const OWING = ['not_checked', 'outstanding', 'revision_requested'];

/**
 * Derive what a submission row means right now. `row` needs status, due_at, due_override_at.
 *  - overdue: deadline passed AND a tutor (or a reliable export) confirmed no submission.
 *  - needsConfirm: deadline passed but nobody has checked — we ask, we don't accuse.
 */
export function derive(row, at = new Date()) {
  const due = effectiveDue(row);
  const past = new Date(due) <= at;
  const soon = !past && new Date(due) - at <= 24 * HOUR;
  const s = row.status;
  const base = { due, past, soon, overdue: false, needsConfirm: false, done: false, owing: OWING.includes(s) };

  if (s === 'approved') return { ...base, done: true, owing: false, tone: 'good', label: 'Approved', staff: 'Approved' };
  if (s === 'awaiting_review') return { ...base, tone: 'info', label: 'Awaiting tutor review', staff: 'Awaiting review' };
  if (s === 'student_claimed') return { ...base, tone: 'info', label: 'Submitted — tutor checking', staff: 'Student says submitted — verify in Squad' };
  if (s === 'outstanding' && past) return { ...base, overdue: true, tone: 'bad', label: 'Overdue', staff: 'Overdue (confirmed)' };
  if (s === 'revision_requested') {
    return past
      ? { ...base, needsConfirm: true, tone: 'warn', label: 'Resubmission deadline passed — confirm', staff: 'Revision deadline passed — verify' }
      : { ...base, tone: 'warn', label: 'Revision requested', staff: 'Revision requested' };
  }
  if (past) return { ...base, needsConfirm: true, tone: 'warn', label: 'Please confirm your submission', staff: 'Past deadline — needs verification' };
  if (soon) return { ...base, tone: 'warn', label: 'Due within 24 hours', staff: 'Due soon' };
  return { ...base, tone: 'neutral', label: 'To do', staff: s === 'outstanding' ? 'Not submitted' : 'Not due yet' };
}

export function deliverablesPhrase(deliverables) {
  const items = String(deliverables || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return 'submission';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Plain-language next step for the student. */
export function studentNextStep(row, d) {
  const what = deliverablesPhrase(row.deliverables);
  if (d.done) return 'Nothing to do — this is approved.';
  if (row.status === 'awaiting_review') return 'Nothing to do right now — your tutor will review your submission.';
  if (row.status === 'student_claimed') return 'Your tutor is checking Squad for your submission. No action needed unless they contact you.';
  if (row.status === 'revision_requested' && !d.past) {
    return `Resubmit in Squad’s Project Lab by ${fmt(d.due)} with: ${row.revision_items || what}.`;
  }
  if (d.overdue) return `Submit your ${what} in Squad’s Project Lab, then select “I already submitted”. If something technical is blocking you, report a blocker.`;
  if (d.needsConfirm) return `The deadline has passed and your tutor hasn’t checked Squad yet. If you submitted, select “I already submitted”. If not, submit your ${what} in Squad now.`;
  return `Submit your ${what} in Squad’s Project Lab by ${fmt(d.due)}.`;
}
