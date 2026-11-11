// Early-warning rules: each signal triggers one specific follow-up.
import { all, get, run, leadsFor } from './db.js';
import { effectiveDue, derive } from './status.js';
import { addWorkingDays, HOUR } from './time.js';
import * as msg from './messages.js';

export const RECURRING_THRESHOLD = Number(process.env.RECURRING_THRESHOLD || 3);
const RECURRING_WINDOW_DAYS = 14;

function submissionRows() {
  return all(`
    SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.cohort_id,
           u.first_name, u.last_name, u.email, u.tutor_id, u.created_at AS joined_at
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN users u ON u.id = s.student_id
    WHERE a.required = 1 AND u.role = 'student' AND u.active = 1`);
}

/** Create a follow-up once per rule key. Returns the new id, or null if it already existed. */
export function createFollowup({ kind, ownerId, studentId = null, ticketId = null, issueId = null, planId = null, nextAction, dueAt, ruleKey = null, at = new Date() }) {
  const res = run(
    `INSERT OR IGNORE INTO followups (kind, owner_id, student_id, ticket_id, issue_id, plan_id, next_action, due_at, rule_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    kind, ownerId, studentId, ticketId, issueId, planId, nextAction, new Date(dueAt).toISOString(), ruleKey, at.toISOString(),
  );
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export function closeFollowups(where, params, note, at = new Date()) {
  run(`UPDATE followups SET status = 'done', done_at = ?, done_note = ? WHERE status = 'open' AND ${where}`, at.toISOString(), note, ...params);
}

export function studentName(u) {
  return `${u.first_name} ${u.last_name}`.trim();
}

/**
 * Run every rule once. Safe to call repeatedly: every notice and follow-up is keyed, so it fires once.
 * @param {Date} at  "now" — injectable for tests.
 */
export async function runRules(at = new Date()) {
  const summary = { reminders: 0, overdueNotices: 0, confirmRequests: 0, catchUpFlags: 0, ticketFlags: 0, recurringIssues: 0, attachedToIssues: 0 };
  const rows = submissionRows();

  // ── Student notices: 24h reminder, overdue notice, or "please confirm" ──────────────
  for (const r of rows) {
    const due = effectiveDue(r);
    // Students who join mid-cohort aren't chased for deadlines that passed before they joined
    // (unless a tutor has since set a new deadline or confirmed the status).
    if (due < r.joined_at && r.status === 'not_checked') continue;
    const msLeft = new Date(due) - at;
    const owing = ['not_checked', 'outstanding', 'revision_requested'].includes(r.status);
    if (owing && msLeft > 0 && msLeft <= 24 * HOUR) {
      if (await msg.reminder24h(r, due)) summary.reminders++;
    }
    if (msLeft <= 0) {
      if (r.status === 'outstanding') {
        // Confirmed by a tutor (or a reliable Squad export) → overdue notice.
        if (await msg.overdueNotice(r, due)) summary.overdueNotices++;
      } else if (r.status === 'not_checked' || r.status === 'revision_requested') {
        // Not checked → ask the student to confirm instead of marking overdue.
        if (await msg.confirmSubmissionNotice(r, due)) summary.confirmRequests++;
      }
    }
  }

  // ── Signal: two required assignments overdue, or a required project overdue ─────────
  const overdueByStudent = new Map();
  for (const r of rows) {
    if (!derive(r, at).overdue) continue;
    if (!overdueByStudent.has(r.student_id)) overdueByStudent.set(r.student_id, []);
    overdueByStudent.get(r.student_id).push(r);
  }
  for (const [studentId, items] of overdueByStudent) {
    const projects = items.filter((i) => i.kind === 'project').length;
    if (items.length < 2 && projects < 1) continue;
    const active = get(
      `SELECT 1 FROM followups WHERE student_id = ? AND kind IN ('catch_up','check_in') AND status = 'open'
       UNION SELECT 1 FROM catchup_plans WHERE student_id = ? AND status IN ('proposed','agreed')`,
      studentId, studentId,
    );
    if (active) continue;
    const s = items[0];
    const ownerId = s.tutor_id || leadsFor(s.cohort_id)[0]?.id;
    if (!ownerId) continue;
    const reason = projects ? `${projects} required project${projects > 1 ? 's' : ''} overdue` : `${items.length} required assignments overdue`;
    const key = `catchup:${studentId}:${items.map((i) => i.id).sort((a, b) => a - b).join(',')}`;
    const id = createFollowup({
      kind: 'catch_up', ownerId, studentId, at, ruleKey: key,
      nextAction: `${reason}. Check ${studentName(s)}’s record and agree a catch-up plan.`,
      dueAt: addWorkingDays(at, 2),
    });
    if (id) {
      summary.catchUpFlags++;
      await msg.staffAlert(ownerId, {
        title: `Catch-up needed: ${studentName(s)}`,
        body: `${reason}: ${items.map((i) => i.title).join(', ')}. Check the record and propose a catch-up plan.`,
        link: `/students/${studentId}`,
        dedupeKey: `alert:${key}`,
      });
    }
  }

  // ── Signal: technical ticket with no tutor reply after one working day ──────────────
  const waiting = all(`
    SELECT t.*, u.first_name, u.last_name, u.cohort_id AS student_cohort FROM tickets t JOIN users u ON u.id = t.student_id
    WHERE t.status = 'awaiting_tutor'`);
  for (const t of waiting) {
    if (addWorkingDays(t.awaiting_since, 1) > at) continue;
    const leads = leadsFor(t.student_cohort);
    if (!leads.length) continue;
    const assignee = t.assignee_id ? get('SELECT * FROM users WHERE id = ?', t.assignee_id) : null;
    const key = `ticket-sla:${t.id}:${t.awaiting_since}`;
    const id = createFollowup({
      kind: 'ticket_sla', ownerId: leads[0].id, studentId: t.student_id, ticketId: t.id, at, ruleKey: key,
      nextAction: `Ticket #${t.id} (${t.skill}) has had no tutor reply for over a working day${assignee ? ` — follow up with ${assignee.first_name} or reassign` : ' — assign a tutor'}.`,
      dueAt: new Date(at.getTime() + 4 * HOUR),
    });
    if (id) {
      summary.ticketFlags++;
      run('UPDATE tickets SET escalated_at = ? WHERE id = ?', at.toISOString(), t.id);
      await msg.staffAlert(leads[0].id, {
        title: `Unanswered ticket #${t.id}: ${t.skill}`,
        body: `${studentName(t)} has waited over one working day for a tutor reply.`,
        link: `/support/${t.id}`,
        dedupeKey: `alert:${key}`,
      });
    }
  }

  // ── Signal: several students report the same issue ─────────────────────────────────
  const since = new Date(at.getTime() - RECURRING_WINDOW_DAYS * 24 * HOUR).toISOString();
  const unlinked = all(`
    SELECT t.* FROM tickets t WHERE t.status != 'resolved' AND t.issue_id IS NULL AND t.created_at >= ?`, since);
  const groups = new Map();
  for (const t of unlinked) {
    const k = `${t.cohort_id}|${t.skill}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const [, tickets] of groups) {
    const { cohort_id: cohortId, skill } = tickets[0];
    let issue = get(`SELECT * FROM issues WHERE cohort_id = ? AND skill = ? AND status != 'resolved' ORDER BY id DESC`, cohortId, skill);
    if (!issue) {
      const students = new Set(tickets.map((t) => t.student_id));
      if (students.size < RECURRING_THRESHOLD) continue;
      const ownerId = mostCommon(tickets.map((t) => t.assignee_id).filter(Boolean)) || leadsFor(cohortId)[0]?.id;
      if (!ownerId) continue;
      const res = run(
        `INSERT INTO issues (cohort_id, skill, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        cohortId, skill, `${students.size} students blocked on ${skill}`, ownerId, at.toISOString(),
      );
      issue = get('SELECT * FROM issues WHERE id = ?', Number(res.lastInsertRowid));
      summary.recurringIssues++;
      createFollowup({
        kind: 'shared_fix', ownerId, issueId: issue.id, at, ruleKey: `issue:${issue.id}`,
        nextAction: `${students.size} students report the same ${skill} problem. Share a fix or run a walkthrough, then check they can proceed.`,
        dueAt: addWorkingDays(at, 1),
      });
      for (const u of [ownerId, ...leadsFor(cohortId).map((l) => l.id)]) {
        await msg.staffAlert(u, {
          title: `Recurring issue: ${skill}`,
          body: `${students.size} students have open tickets about ${skill}.`,
          link: `/issues/${issue.id}`,
          dedupeKey: `alert:issue:${issue.id}:${u}`,
        });
      }
    }
    for (const t of tickets) {
      run('UPDATE tickets SET issue_id = ? WHERE id = ?', issue.id, t.id);
      summary.attachedToIssues++;
      // If a fix was already shared, send it straight to students who report it later.
      if (issue.status === 'fix_shared') {
        const student = get('SELECT * FROM users WHERE id = ?', t.student_id);
        await msg.fixShared(t, issue, student);
      }
    }
  }

  run('INSERT INTO rule_runs (started_at, summary) VALUES (?, ?)', at.toISOString(), JSON.stringify(summary));
  return summary;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
