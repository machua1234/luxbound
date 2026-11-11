import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.RECURRING_THRESHOLD = '3';
const { run, get, all, ensureSubmissionRows } = await import('../src/db.js');
const { runRules } = await import('../src/rules.js');
const { addWorkingDays } = await import('../src/time.js');
const { derive } = await import('../src/status.js');

const H = 3600_000, D = 24 * H;
// Wednesday 11 Nov 2026, 10:00 EAT
const NOW = new Date('2026-11-11T07:00:00Z');
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
let cohort, tutor, lead, students = [], asg = {};

before(() => {
  cohort = Number(run(`INSERT INTO cohorts (name, created_at) VALUES ('Cohort 9', ?)`, iso(0)).lastInsertRowid);
  const user = (email, role, tutorId = null) => Number(run(`INSERT INTO users (email, first_name, role, cohort_id, tutor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`, email, email.split('@')[0], role, cohort, tutorId, iso(-60 * D)).lastInsertRowid);
  lead = user('lead@x.test', 'lead');
  tutor = user('tutor@x.test', 'tutor');
  for (let i = 0; i < 4; i++) students.push(user(`s${i}@x.test`, 'student', tutor));
  const a = (code, kind, dueMs) => Number(run(`INSERT INTO assignments (cohort_id, code, title, kind, due_at, deliverables, created_at) VALUES (?, ?, ?, ?, ?, 'GitHub link', ?)`, cohort, code, `Item ${code}`, kind, iso(dueMs), iso(0)).lastInsertRowid);
  asg.soon = a('SOON', 'assignment', 10 * H);
  asg.late1 = a('LATE1', 'assignment', -2 * D);
  asg.late2 = a('LATE2', 'assignment', -1 * D);
  asg.proj = a('PROJ', 'project', -3 * H);
  ensureSubmissionRows(cohort);
  // Student 1 already submitted the item due soon.
  run('UPDATE submissions SET status = ? WHERE student_id = ? AND assignment_id = ?', 'awaiting_review', students[1], asg.soon);
});

const sub = (student, a) => get('SELECT * FROM submissions WHERE student_id = ? AND assignment_id = ?', student, a);
const setStatus = (student, a, status) => run('UPDATE submissions SET status = ? WHERE student_id = ? AND assignment_id = ?', status, student, a);
const notices = (student, kind) => all('SELECT * FROM notifications WHERE user_id = ? AND kind = ?', student, kind);

test('working days skip the weekend', () => {
  const fri = new Date('2026-11-13T14:00:00Z'); // Fri 17:00 EAT
  assert.equal(addWorkingDays(fri, 1).toISOString(), '2026-11-16T14:00:00.000Z'); // Mon 17:00 EAT
  const sat = new Date('2026-11-14T09:00:00Z');
  assert.equal(addWorkingDays(sat, 1).toISOString(), '2026-11-17T05:00:00.000Z'); // Mon 08:00 → Tue 08:00 EAT
});

test('unchecked past-deadline work asks the student to confirm, not overdue', async () => {
  await runRules(NOW);
  const s = students[0];
  assert.equal(notices(s, 'confirm_submission').length, 3);
  assert.equal(notices(s, 'overdue').length, 0);
  assert.equal(derive({ ...sub(s, asg.late1), due_at: iso(-2 * D) }, NOW).overdue, false);
});

test('24h reminder only while outstanding, once', async () => {
  await runRules(NOW);
  await runRules(NOW);
  assert.equal(notices(students[0], 'reminder_24h').length, 1);
  assert.equal(notices(students[1], 'reminder_24h').length, 0);
});

test('tutor-confirmed missing work gets an overdue notice once', async () => {
  setStatus(students[2], asg.late1, 'outstanding');
  await runRules(NOW);
  await runRules(NOW);
  const n = notices(students[2], 'overdue');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /still outstanding/);
  assert.ok(get('SELECT * FROM outbox WHERE notification_id = ?', n[0].id), 'email recorded');
  // One overdue assignment is not enough for a catch-up flag.
  assert.equal(get(`SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ?`, students[2]).n, 0);
});

test('two overdue assignments → tutor catch-up follow-up with owner, action, due date', async () => {
  setStatus(students[2], asg.late2, 'outstanding');
  await runRules(NOW);
  const f = all(`SELECT * FROM followups WHERE kind = 'catch_up' AND student_id = ?`, students[2]);
  assert.equal(f.length, 1);
  assert.equal(f[0].owner_id, tutor);
  assert.match(f[0].next_action, /catch-up plan/);
  assert.ok(f[0].due_at > NOW.toISOString());
});

test('one overdue project alone triggers catch-up', async () => {
  setStatus(students[3], asg.proj, 'outstanding');
  await runRules(NOW);
  assert.equal(get(`SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ?`, students[3]).n, 1);
});

test('approved extension moves the deadline used for reminders', async () => {
  run(`UPDATE submissions SET due_override_at = ?, override_reason = 'extension' WHERE student_id = ? AND assignment_id = ?`, iso(5 * H), students[3], asg.proj);
  await runRules(NOW);
  const s = { ...sub(students[3], asg.proj), due_at: iso(-3 * H) };
  assert.equal(derive(s, NOW).overdue, false);
  assert.equal(all(`SELECT * FROM notifications WHERE user_id = ? AND dedupe_key LIKE ?`, students[3], `remind24:${s.id}:%`).length, 1);
});

test('ticket with no tutor reply after one working day is flagged to the lead', async () => {
  const mk = (student, created) => Number(run(`INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, assignee_id, created_at, awaiting_since) VALUES (?, ?, 'CTEs', 'x', ?, ?, ?)`, student, cohort, tutor, created, created).lastInsertRowid);
  const old = mk(students[0], iso(-26 * H));
  const fresh = mk(students[1], iso(-3 * H));
  await runRules(NOW);
  const f = all(`SELECT * FROM followups WHERE kind = 'ticket_sla'`);
  assert.deepEqual(f.map((x) => x.ticket_id), [old]);
  assert.equal(f[0].owner_id, lead);
  assert.ok(get('SELECT escalated_at FROM tickets WHERE id = ?', old).escalated_at);
  assert.equal(get('SELECT escalated_at FROM tickets WHERE id = ?', fresh).escalated_at, null);
});

test('several students with the same issue → one recurring issue + shared-fix follow-up', async () => {
  for (const s of students.slice(0, 3)) {
    run(`INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, assignee_id, created_at, awaiting_since) VALUES (?, ?, 'PostgreSQL imports', 'copy', ?, ?, ?)`, s, cohort, tutor, iso(-H), iso(-H));
  }
  await runRules(NOW);
  await runRules(NOW);
  const issues = all(`SELECT * FROM issues WHERE skill = 'PostgreSQL imports'`);
  assert.equal(issues.length, 1);
  assert.equal(get(`SELECT COUNT(*) n FROM tickets WHERE issue_id = ?`, issues[0].id).n, 3);
  assert.equal(get(`SELECT COUNT(*) n FROM followups WHERE kind = 'shared_fix' AND issue_id = ?`, issues[0].id).n, 1);
  // CTEs has only two students → no issue.
  assert.equal(get(`SELECT COUNT(*) n FROM issues WHERE skill = 'CTEs'`).n, 0);
});

test('a student who joins mid-cohort is not chased for deadlines before they joined', async () => {
  const late = Number(run(`INSERT INTO users (email, first_name, role, cohort_id, tutor_id, created_at) VALUES ('late@x.test', 'late', 'student', ?, ?, ?)`, cohort, tutor, iso(-H)).lastInsertRowid);
  ensureSubmissionRows(cohort);
  await runRules(NOW);
  assert.equal(notices(late, 'confirm_submission').length, 0);
  assert.equal(notices(late, 'reminder_24h').length, 1);
});
