// Resets the database and loads a realistic Cohort 9 pilot, with deadlines relative to now.
// Usage: npm run seed
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || path.resolve('data/portal.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

const { run, get, nowIso, ensureSubmissionRows } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { runRules } = await import('../src/rules.js');

const PASSWORD = 'luxdev123';
const pw = hashPassword(PASSWORD);
const H = 3600_000, D = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

const cohortId = Number(run('INSERT INTO cohorts (name, created_at) VALUES (?, ?)', 'Cohort 9', nowIso()).lastInsertRowid);
const user = (email, first, last, role, tutorId = null) =>
  Number(run(`INSERT INTO users (email, first_name, last_name, role, cohort_id, tutor_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    email, first, last, role, cohortId, tutorId, pw, ago(60 * D)).lastInsertRowid);

user('lead@luxdevhq.test', 'Amina', 'Otieno', 'lead');
const brian = user('brian@luxdevhq.test', 'Brian', 'Kamau', 'tutor');
const wanjiru = user('wanjiru@luxdevhq.test', 'Wanjiru', 'Njeri', 'tutor');
const S = {
  achieng: user('achieng@students.test', 'Achieng', 'Odhiambo', 'student', brian),
  kevin: user('kevin@students.test', 'Kevin', 'Mwangi', 'student', brian),
  faith: user('faith@students.test', 'Faith', 'Wambui', 'student', brian),
  daniel: user('daniel@students.test', 'Daniel', 'Kiprop', 'student', brian),
  grace: user('grace@students.test', 'Grace', 'Atieno', 'student', wanjiru),
  samuel: user('samuel@students.test', 'Samuel', 'Omondi', 'student', wanjiru),
  mercy: user('mercy@students.test', 'Mercy', 'Chebet', 'student', wanjiru),
  ian: user('ian@students.test', 'Ian', 'Mutua', 'student', wanjiru),
};

const squad = (slug) => `https://squad.example.com/luxdevhq/cohort-9/project-lab/${slug}`;
const A = {};
for (const [key, code, title, week, kind, skill, due, deliverables] of [
  ['w08', 'W08-SQL', 'Week 8 SQL joins assignment', 8, 'assignment', 'Joins', ago(17 * D), 'GitHub link'],
  ['w09', 'W09-CTE', 'Week 9 CTEs assignment', 9, 'assignment', 'CTEs', ago(10 * D), 'GitHub link'],
  ['w10', 'W10-SQL', 'Week 10 SQL assignment', 10, 'assignment', 'PostgreSQL imports', ago(3 * D), 'GitHub link'],
  ['p1', 'P1', 'Project 1: Sales data pipeline', 10, 'project', 'Python', ago(1 * D), 'GitHub link; README with setup steps; dashboard screenshot'],
  ['w11', 'W11-PY', 'Week 11 Python assignment', 11, 'assignment', 'Python', ahead(18 * H), 'GitHub link'],
  ['w12', 'W12-PD', 'Week 12 pandas assignment', 12, 'assignment', 'pandas', ahead(6 * D), 'GitHub link; notebook export'],
]) {
  A[key] = Number(run(`INSERT INTO assignments (cohort_id, code, title, week, kind, skill, due_at, squad_url, deliverables, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cohortId, code, title, week, kind, skill, due, squad(code.toLowerCase()), deliverables, nowIso()).lastInsertRowid);
}
ensureSubmissionRows(cohortId);

// Default: everything past due is approved, the project awaits review, future work not checked yet.
const set = (student, a, status, extra = {}) => {
  const fields = { status, verified_by: brian, verified_at: ago(2 * H), status_source: 'tutor', updated_at: nowIso(), ...extra };
  const cols = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  run(`UPDATE submissions SET ${cols} WHERE student_id = ? AND assignment_id = ?`, ...Object.values(fields), student, A[a]);
};
for (const id of Object.values(S)) {
  for (const a of ['w08', 'w09', 'w10']) set(id, a, 'approved');
  set(id, 'p1', 'awaiting_review');
}
// Achieng: one confirmed overdue assignment, project unchecked, Python due tomorrow, and a ticket open.
set(S.achieng, 'w10', 'outstanding');
set(S.achieng, 'p1', 'not_checked', { verified_by: null, verified_at: null });
// Kevin: two assignments overdue → catch-up flag for Brian.
set(S.kevin, 'w09', 'outstanding');
set(S.kevin, 'w10', 'outstanding');
// Faith: revision requested with a resubmission deadline.
set(S.faith, 'w10', 'revision_requested', { revision_items: 'Query for question 4; README explaining the import steps', due_override_at: ahead(2 * D), override_reason: 'resubmission' });
// Daniel: project overdue → catch-up flag. Says he submitted Week 10.
set(S.daniel, 'p1', 'outstanding');
set(S.daniel, 'w10', 'student_claimed', { student_note: 'Submitted on Sunday night, the link is in Project Lab.', verified_by: null, verified_at: null, status_source: 'student' });
// Grace & Mercy: Week 10 not yet checked.
set(S.grace, 'w10', 'awaiting_review');
set(S.mercy, 'w10', 'not_checked', { verified_by: null, verified_at: null });
// Ian has an extension on the project.
set(S.ian, 'p1', 'outstanding', { due_override_at: ahead(3 * D), override_reason: 'extension' });

const ticket = (student, skill, a, created, { trying, error, tried, status = 'awaiting_tutor', assignee }) =>
  Number(run(`INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, error_text, tried, assignment_id, status, assignee_id, created_at, awaiting_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    student, cohortId, skill, trying, error, tried, a ? A[a] : null, status, assignee, created, created).lastInsertRowid);

const copyErr = 'ERROR:  invalid input syntax for type date: "31/01/2024"\nCONTEXT:  COPY sales, line 2, column order_date: "31/01/2024"';
ticket(S.achieng, 'PostgreSQL imports', 'w10', ago(2 * H), { trying: 'Import sales.csv into the sales table with \\copy for the Week 10 assignment.', error: copyErr, tried: 'Re-saved the CSV as UTF-8 and checked the column order.', assignee: brian });
ticket(S.grace, 'PostgreSQL imports', 'w10', ago(4 * D), { trying: 'Load the orders CSV into PostgreSQL using pgAdmin’s import tool.', error: copyErr, tried: 'Changed the column type to text — it imports but then I can’t filter by date.', assignee: wanjiru });
ticket(S.samuel, 'PostgreSQL imports', null, ago(5 * H), { trying: 'Running COPY from the course dataset.', error: copyErr, tried: 'Searched the error, tried SET datestyle but not sure what value.', assignee: wanjiru });
const resolved = ticket(S.ian, 'CTEs', 'w09', ago(9 * D), { trying: 'Chain two CTEs to compute monthly revenue growth.', error: 'ERROR:  syntax error at or near "WITH"', tried: 'Checked commas.', status: 'resolved', assignee: wanjiru });
run('INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', resolved, wanjiru, 'You only need one WITH — separate CTEs with commas: WITH a AS (...), b AS (...) SELECT ...', ago(9 * D - 3 * H));
run('UPDATE tickets SET first_reply_at = ?, resolved_at = ? WHERE id = ?', ago(9 * D - 3 * H), ago(8 * D), resolved);

const summary = await runRules();
console.log('Seeded Cohort 9. Rules:', summary);
console.log(`\nSign in with password "${PASSWORD}":`);
console.log('  Cohort lead  lead@luxdevhq.test');
console.log('  Tutor        brian@luxdevhq.test  /  wanjiru@luxdevhq.test');
console.log('  Students     achieng@students.test, kevin@…, faith@…, daniel@…, grace@…, samuel@…, mercy@…, ian@students.test');
