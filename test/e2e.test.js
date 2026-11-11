// End-to-end: boots the real server on a temp DB with the demo seed, then walks every feature as each role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luxbound-e2e-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'portal.db'), UPLOAD_DIR: path.join(tmp, 'uploads'), RULES_INTERVAL_MIN: '999', PORTAL_URL: BASE, NODE_NO_WARNINGS: '1' };
let server, db;

const q = (sql, ...p) => db.prepare(sql).get(...p);
const qa = (sql, ...p) => db.prepare(sql).all(...p);
const userId = (email) => q('SELECT id FROM users WHERE email = ?', email).id;
const subId = (email, code) => q(`SELECT s.id FROM submissions s JOIN users u ON u.id = s.student_id JOIN assignments a ON a.id = s.assignment_id WHERE u.email = ? AND a.code = ?`, email, code).id;

class Client {
  jar = new Map();
  async req(p, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + p, { method, body, redirect: 'manual', headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/expires=thu, 01 jan 1970/i.test(c) || kv.slice(i + 1) === '') this.jar.delete(kv.slice(0, i));
      else this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  get(p) { return this.req(p); }
  async csrf(from) { return /name="_csrf" value="([^"]+)"/.exec((await this.get(from)).text)?.[1]; }
  /** POST a form. `data` may be an object or an array of [key, value] pairs (for repeated keys). */
  async post(p, data = {}, from = p.replace(/\/[a-z-]+$/, '')) {
    const pairs = [['_csrf', await this.csrf(from)], ...(Array.isArray(data) ? data : Object.entries(data))];
    return this.req(p, { method: 'POST', body: new URLSearchParams(pairs) });
  }
  async upload(p, fields, from, files = {}) {
    const fd = new FormData();
    fd.set('_csrf', await this.csrf(from));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    for (const [k, [buf, name, type]] of Object.entries(files)) fd.set(k, new Blob([buf], { type }), name);
    return this.req(p, { method: 'POST', body: fd });
  }
  async login(email, password = 'luxdev123') {
    const r = await this.post('/login', { email, password }, '/login');
    assert.equal(r.status, 302);
    return r;
  }
}
const ok = (r, msg) => assert.ok([200, 302].includes(r.status), `${msg}: got ${r.status}`);

before(async () => {
  execFileSync(process.execPath, ['scripts/seed.js'], { env, stdio: 'ignore' });
  db = new DatabaseSync(env.DB_PATH);
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('→') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => { server?.kill(); db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const lead = new Client(), brian = new Client(), wanjiru = new Client(), achieng = new Client(), kevin = new Client(), grace = new Client();

test('auth: bad password rejected, every role lands on its home page', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/progress')).location, '/login?next=%2Fprogress');
  const bad = await anon.post('/login', { email: 'achieng@students.test', password: 'nope' }, '/login');
  assert.match(bad.location, /^\/login/);
  assert.equal(anon.jar.has('lp_session'), false);
  await lead.login('lead@luxdevhq.test');
  await brian.login('brian@luxdevhq.test');
  await wanjiru.login('wanjiru@luxdevhq.test');
  await achieng.login('achieng@students.test');
  await kevin.login('kevin@students.test');
  await grace.login('grace@students.test');
  assert.equal((await lead.get('/')).location, '/overview');
  assert.equal((await brian.get('/')).location, '/queue');
  assert.equal((await achieng.get('/')).location, '/progress');
});

test('auth: forgot password → emailed link → set password → sign in', async () => {
  const anon = new Client();
  await anon.post('/forgot', { email: 'mercy@students.test' }, '/forgot');
  const mail = q(`SELECT * FROM outbox WHERE to_email = 'mercy@students.test' AND subject = 'Reset your password'`);
  assert.ok(mail, 'reset email recorded');
  const link = /\/set-password\?token=[a-f0-9]+/.exec(mail.text)[0];
  assert.ok(mail.text.includes(BASE), 'email links use PORTAL_URL');
  const token = link.split('=')[1];
  const r = await anon.post('/set-password', { token, password: 'newpass123' }, link);
  assert.equal(r.location, '/');
  const again = new Client();
  await again.login('mercy@students.test', 'newpass123');
  assert.equal((await again.get('/')).location, '/progress');
  // Token is single-use.
  assert.match((await new Client().get(link)).text, /expired/);
});

test('auth: sign out ends the session', async () => {
  const c = new Client();
  await c.login('ian@students.test');
  await c.post('/logout', {}, '/progress');
  assert.match((await c.get('/progress')).location, /^\/login/);
});

test('every page renders for the right role', async () => {
  const pages = {
    lead: ['/overview', '/queue', '/queue?owner=all', '/students', '/assignments', '/support', '/support?status=all', '/admin', '/admin/outbox', '/notifications', '/issues/1'],
    brian: ['/queue', '/students', '/assignments', '/support', '/notifications'],
    achieng: ['/progress', '/support', '/support/new', '/notifications'],
  };
  const clients = { lead, brian, achieng };
  for (const [who, list] of Object.entries(pages)) {
    for (const p of list) assert.equal((await clients[who].get(p)).status, 200, `${who} ${p}`);
  }
  const a = q('SELECT id FROM assignments LIMIT 1').id;
  assert.equal((await brian.get(`/assignments/${a}`)).status, 200);
  assert.equal((await brian.get(`/students/${userId('kevin@students.test')}`)).status, 200);
});

test('privacy: students and tutors only see what they should', async () => {
  const graceId = userId('grace@students.test');
  for (const p of ['/queue', '/overview', '/admin', `/students/${graceId}`, '/assignments']) assert.equal((await achieng.get(p)).status, 403, `student ${p}`);
  assert.equal((await achieng.get(`/progress/${subId('grace@students.test', 'W10-SQL')}`)).status, 404);
  const graceTicket = q('SELECT id FROM tickets WHERE student_id = ?', graceId).id;
  assert.equal((await achieng.get(`/support/${graceTicket}`)).status, 404);
  assert.equal((await brian.get('/overview')).status, 403);
  assert.equal((await brian.get('/admin')).status, 403);
  // Brian is not Grace's tutor and doesn't handle her tickets.
  assert.equal((await brian.get(`/students/${graceId}`)).status, 404);
  assert.equal((await brian.get(`/support/${graceTicket}`)).status, 404);
  assert.doesNotMatch((await brian.get('/students')).text, /Grace/);
});

test('security: POST without CSRF token is refused', async () => {
  const r = await achieng.req(`/progress/${subId('achieng@students.test', 'W10-SQL')}/claim`, { method: 'POST', body: new URLSearchParams({}) });
  assert.equal(r.status, 403);
});

test('My Progress: owed work, side-by-side status, next step on the record', async () => {
  const page = (await achieng.get('/progress')).text;
  assert.match(page, /Submission status/);
  assert.match(page, /Support status/);
  assert.match(page, /Needs your attention/);
  assert.match(page, /Week 10 SQL assignment/);
  const rec = (await achieng.get(`/progress/${subId('achieng@students.test', 'W10-SQL')}`)).text;
  assert.match(rec, /Overdue/);
  assert.match(rec, /What to do next/);
  assert.match(rec, /I already submitted/);
  assert.match(rec, /Report a blocker/);
  assert.match(rec, /squad\.example\.com/);
  assert.match(rec, /Notices sent/);
});

test('student: "I already submitted" → tutor verify follow-up → tutor confirms → awaiting review', async () => {
  const sid = subId('achieng@students.test', 'P1');
  ok(await achieng.post(`/progress/${sid}/claim`, {}, `/progress/${sid}`), 'claim');
  assert.equal(q('SELECT status FROM submissions WHERE id = ?', sid).status, 'student_claimed');
  assert.ok(q(`SELECT 1 FROM followups WHERE kind = 'verify' AND status = 'open' AND rule_key LIKE ?`, `verify:${sid}:%`));
  assert.match((await brian.get('/queue')).text, /Student says submitted/);
  ok(await brian.post(`/submissions/${sid}/status`, { status: 'awaiting_review', back: '/queue' }, '/queue'), 'verify');
  assert.equal(q('SELECT status FROM submissions WHERE id = ?', sid).status, 'awaiting_review');
  assert.equal(q(`SELECT COUNT(*) n FROM followups WHERE kind = 'verify' AND status = 'open' AND rule_key LIKE ?`, `verify:${sid}:%`).n, 0);
  assert.match((await achieng.get(`/progress/${sid}`)).text, /Awaiting tutor review/);
});

test('student: report a blocker with screenshot; screenshot private; tutor reply; student reply; resolve', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bb0000000049454e44ae426082', 'hex');
  const aid = q(`SELECT id FROM assignments WHERE code = 'W11-PY'`).id;
  const r = await achieng.upload('/support', {
    skill: 'Python', assignment_id: String(aid), trying_to_do: 'Run the pipeline script', error_text: "ModuleNotFoundError: No module named 'pandas'", tried: 'pip install pandas',
  }, `/support/new?assignment=${aid}`, { screenshot: [png, 'err.png', 'image/png'] });
  assert.equal(r.status, 302);
  const tid = Number(r.location.split('/').pop());
  const t = q('SELECT * FROM tickets WHERE id = ?', tid);
  assert.equal(t.assignee_id, userId('brian@luxdevhq.test'));
  assert.equal(t.assignment_id, aid);
  assert.ok(t.screenshot);
  assert.equal((await achieng.get(`/uploads/${t.screenshot}`)).status, 200);
  assert.equal((await grace.get(`/uploads/${t.screenshot}`)).status, 404);
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND link = ?`, t.assignee_id, `/support/${tid}`), 'tutor alerted');
  // Missing required fields are rejected.
  const bad = await achieng.upload('/support', { skill: 'Python', trying_to_do: '', tried: '' }, '/support/new');
  assert.equal(bad.location, '/support/new');

  ok(await brian.post(`/support/${tid}/reply`, { body: 'Activate your venv first.' }), 'tutor reply');
  let after = q('SELECT * FROM tickets WHERE id = ?', tid);
  assert.equal(after.status, 'awaiting_student');
  assert.ok(after.first_reply_at);
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'ticket_reply'`, userId('achieng@students.test')));
  ok(await achieng.post(`/support/${tid}/reply`, { body: 'Still failing' }), 'student reply');
  assert.equal(q('SELECT status FROM tickets WHERE id = ?', tid).status, 'awaiting_tutor');
  ok(await achieng.post(`/support/${tid}/resolve`), 'resolve');
  assert.equal(q('SELECT status FROM tickets WHERE id = ?', tid).status, 'resolved');
  assert.match((await achieng.get(`/support/${tid}`)).text, /Resolved/);
});

test('tutor: revision request lists missing deliverables + resubmission deadline', async () => {
  const sid = subId('achieng@students.test', 'P1');
  ok(await brian.post(`/submissions/${sid}/revision`, { items: 'README with setup steps\nDashboard screenshot', due: '2026-12-20T23:59' }, `/progress/${sid}`), 'revision');
  const s = q('SELECT * FROM submissions WHERE id = ?', sid);
  assert.equal(s.status, 'revision_requested');
  assert.equal(s.override_reason, 'resubmission');
  assert.equal(s.due_override_at, '2026-12-20T20:59:00.000Z');
  const mail = q(`SELECT * FROM outbox WHERE to_email = 'achieng@students.test' AND subject LIKE 'Revision requested%'`);
  assert.match(mail.text, /README with setup steps/);
  assert.match(mail.text, /Dashboard screenshot/);
  assert.match(mail.text, /20 Dec 2026/);
  assert.match((await achieng.get(`/progress/${sid}`)).text, /Still missing/);
});

test('tutor: approved extension changes the deadline and clears overdue', async () => {
  const sid = subId('achieng@students.test', 'W10-SQL');
  ok(await brian.post(`/submissions/${sid}/extension`, { due: '2026-12-01T23:59', note: 'Family emergency' }, `/progress/${sid}`), 'extension');
  const s = q('SELECT * FROM submissions WHERE id = ?', sid);
  assert.equal(s.override_reason, 'extension');
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'extension'`, s.student_id));
  assert.doesNotMatch((await achieng.get(`/progress/${sid}`)).text, /pill bad">Overdue/);
});

test('tutor: bulk confirm from Squad + approve', async () => {
  const aid = q(`SELECT id FROM assignments WHERE code = 'W10-SQL'`).id;
  const daniel = subId('daniel@students.test', 'W10-SQL');
  const faith = subId('faith@students.test', 'W10-SQL');
  ok(await brian.post(`/assignments/${aid}/bulk`, [['status', 'awaiting_review'], ['ids', String(daniel)], ['ids', String(faith)]], `/assignments/${aid}`), 'bulk');
  assert.equal(q('SELECT status FROM submissions WHERE id = ?', daniel).status, 'awaiting_review');
  assert.equal(q('SELECT status FROM submissions WHERE id = ?', faith).status, 'awaiting_review');
  ok(await brian.post(`/submissions/${daniel}/status`, { status: 'approved', back: '/queue' }, '/queue'), 'approve');
  assert.equal(q('SELECT status FROM submissions WHERE id = ?', daniel).status, 'approved');
  // Brian cannot update a student who isn't his.
  const graceSub = subId('grace@students.test', 'W10-SQL');
  assert.equal((await brian.post(`/submissions/${graceSub}/status`, { status: 'approved' }, '/queue')).status, 404);
});

test('tutor: confirming "no submission" past deadline sends overdue notice', async () => {
  const sid = subId('mercy@students.test', 'W10-SQL');
  ok(await wanjiru.post(`/submissions/${sid}/status`, { status: 'outstanding', back: '/queue' }, '/queue'), 'mark outstanding');
  const mail = q(`SELECT * FROM outbox WHERE to_email = 'mercy@students.test' AND subject = 'Your Week 10 SQL assignment is overdue'`);
  assert.ok(mail, 'overdue email sent');
  assert.match(mail.text, /Our records show that your GitHub link is still outstanding/);
  assert.match(mail.text, /I already submitted/);
  assert.match(mail.text, /Report a blocker/);
  assert.match(mail.text, /View assignment status: http/);
});

test('catch-up: tutor proposes plan with new deadline → student agrees → check-in → complete', async () => {
  const kevinId = userId('kevin@students.test');
  assert.ok(q(`SELECT 1 FROM followups WHERE kind = 'catch_up' AND student_id = ? AND status = 'open'`, kevinId), 'catch-up flagged by rule');
  const w09 = subId('kevin@students.test', 'W09-CTE');
  ok(await brian.post(`/students/${kevinId}/plan`, { plan: 'Finish W09 first, then W10.', check_in: '2026-11-16T10:00', [`due_${w09}`]: '2026-11-15T23:59' }, `/students/${kevinId}/plan`), 'propose');
  const plan = q('SELECT * FROM catchup_plans WHERE student_id = ?', kevinId);
  assert.equal(plan.status, 'proposed');
  assert.equal(q('SELECT override_reason FROM submissions WHERE id = ?', w09).override_reason, 'catch_up');
  assert.equal(q(`SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ? AND status = 'open'`, kevinId).n, 0);
  assert.ok(q(`SELECT 1 FROM followups WHERE kind = 'check_in' AND plan_id = ? AND status = 'open'`, plan.id));
  const mail = q(`SELECT * FROM outbox WHERE to_email = 'kevin@students.test' AND subject LIKE 'A catch-up plan from Brian%'`);
  assert.match(mail.text, /Let’s check in on/);
  assert.match(mail.text, /Week 9 CTEs assignment/);
  assert.match((await kevin.get('/progress')).text, /Review and agree/);
  ok(await kevin.post(`/plans/${plan.id}/agree`, {}, `/plans/${plan.id}`), 'agree');
  assert.equal(q('SELECT status FROM catchup_plans WHERE id = ?', plan.id).status, 'agreed');
  ok(await brian.post(`/plans/${plan.id}/complete`, {}, `/plans/${plan.id}`), 'complete');
  assert.equal(q('SELECT status FROM catchup_plans WHERE id = ?', plan.id).status, 'completed');
  assert.equal(q(`SELECT status FROM followups WHERE kind = 'check_in' AND plan_id = ?`, plan.id).status, 'done');
});

test('tutor queue: follow-up shows owner/action/due and can be marked done', async () => {
  const f = q(`SELECT * FROM followups WHERE kind = 'catch_up' AND status = 'open' AND owner_id = ?`, userId('brian@luxdevhq.test'));
  assert.ok(f, 'Daniel catch-up still open');
  const page = (await brian.get('/queue')).text;
  assert.match(page, /Next action/);
  assert.match(page, /Propose plan/);
  ok(await brian.post(`/followups/${f.id}/done`, {}, '/queue'), 'done');
  assert.equal(q('SELECT status FROM followups WHERE id = ?', f.id).status, 'done');
});

test('lead: unanswered ticket flagged → reassign closes the flag and alerts new tutor', async () => {
  const t = q(`SELECT * FROM tickets WHERE escalated_at IS NOT NULL`);
  assert.ok(t, 'seeded SLA breach was flagged');
  assert.ok(q(`SELECT 1 FROM followups WHERE kind = 'ticket_sla' AND ticket_id = ? AND status = 'open' AND owner_id = ?`, t.id, userId('lead@luxdevhq.test')));
  assert.match((await lead.get('/overview')).text, /Unanswered tickets/);
  const brianId = userId('brian@luxdevhq.test');
  ok(await lead.post(`/support/${t.id}/assign`, { assignee_id: String(brianId) }), 'reassign');
  assert.equal(q('SELECT assignee_id FROM tickets WHERE id = ?', t.id).assignee_id, brianId);
  assert.equal(q(`SELECT status FROM followups WHERE kind = 'ticket_sla' AND ticket_id = ?`, t.id).status, 'done');
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE ?`, brianId, `Ticket #${t.id} reassigned%`));
});

test('recurring issue: fix shared → students asked "can you proceed?" → answers recorded', async () => {
  const issue = q(`SELECT * FROM issues WHERE skill = 'PostgreSQL imports'`);
  ok(await lead.post(`/issues/${issue.id}/fix`, { fix_text: "Run SET datestyle TO 'ISO, DMY'; before \\copy" }), 'share fix');
  assert.equal(q('SELECT status FROM issues WHERE id = ?', issue.id).status, 'fix_shared');
  const affected = qa(`SELECT * FROM tickets WHERE issue_id = ?`, issue.id);
  for (const t of affected) assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'issue_fix'`, t.student_id), `fix sent to ${t.student_id}`);
  assert.ok(q(`SELECT 1 FROM followups WHERE kind = 'proceed_check' AND issue_id = ? AND status = 'open'`, issue.id));
  const at = affected.find((t) => t.student_id === userId('achieng@students.test'));
  const gt = affected.find((t) => t.student_id === userId('grace@students.test'));
  assert.match((await achieng.get(`/support/${at.id}`)).text, /Can you continue now/);
  ok(await achieng.post(`/support/${at.id}/proceed`, { answer: 'yes' }), 'yes');
  ok(await grace.post(`/support/${gt.id}/proceed`, { answer: 'no' }), 'no');
  assert.equal(q('SELECT status FROM tickets WHERE id = ?', at.id).status, 'resolved');
  assert.equal(q('SELECT status FROM tickets WHERE id = ?', gt.id).status, 'awaiting_tutor');
  assert.match((await lead.get(`/issues/${issue.id}`)).text, /Still blocked/);
  ok(await lead.post(`/issues/${issue.id}/resolve`), 'close issue');
  assert.equal(q('SELECT status FROM issues WHERE id = ?', issue.id).status, 'resolved');
});

test('lead: imports (roster, assignments, Squad status) + invite → new user can set password', async () => {
  const roster = fs.readFileSync('samples/roster.csv');
  ok(await lead.upload('/admin/import/roster', { cohort_id: '1' }, '/admin', { file: [roster, 'roster.csv', 'text/csv'] }), 'roster');
  const neema = q(`SELECT * FROM users WHERE email = 'new.student@students.test'`);
  assert.ok(neema);
  assert.equal(neema.tutor_id, userId('wanjiru@luxdevhq.test'));
  const invite = q(`SELECT * FROM outbox WHERE to_email = 'new.student@students.test' AND subject LIKE 'Welcome%'`);
  assert.ok(invite);
  const link = /\/set-password\?token=[a-f0-9]+/.exec(invite.text)[0];
  const n = new Client();
  ok(await n.post('/set-password', { token: link.split('=')[1], password: 'neema12345' }, link), 'set pw');
  assert.equal((await n.get('/')).location, '/progress');

  ok(await lead.upload('/admin/import/assignments', { cohort_id: '1' }, '/admin', { file: [fs.readFileSync('samples/assignments.csv'), 'a.csv', 'text/csv'] }), 'assignments');
  const p2 = q(`SELECT * FROM assignments WHERE code = 'P2'`);
  assert.equal(p2.kind, 'project');
  assert.ok(q('SELECT 1 FROM submissions WHERE assignment_id = ? AND student_id = ?', p2.id, neema.id), 'rows created for everyone');
  // Re-import updates, never duplicates.
  await lead.upload('/admin/import/assignments', { cohort_id: '1' }, '/admin', { file: [fs.readFileSync('samples/assignments.csv'), 'a.csv', 'text/csv'] });
  assert.equal(q(`SELECT COUNT(*) n FROM assignments WHERE code = 'P2'`).n, 1);

  ok(await lead.upload('/admin/import/status', { cohort_id: '1' }, '/admin', { file: [fs.readFileSync('samples/status.csv'), 's.csv', 'text/csv'] }), 'status');
  assert.equal(q('SELECT status_source FROM submissions WHERE id = ?', subId('mercy@students.test', 'W10-SQL')).status_source, 'tutor', 'Mercy was already outstanding — unchanged');
  assert.equal(qa('SELECT * FROM imports').length, 4);
  // Bad file rows are reported, not fatal.
  ok(await lead.upload('/admin/import/assignments', { cohort_id: '1' }, '/admin', { file: [Buffer.from('code,title,due_at\nX,,nope\n'), 'bad.csv', 'text/csv'] }), 'bad import');
  assert.match(q('SELECT errors FROM imports ORDER BY id DESC').errors, /row 2/);
});

test('lead: add staff, change a student’s tutor, run rules, outbox', async () => {
  ok(await lead.post('/admin/staff', { first_name: 'Otieno', last_name: 'Ouma', email: 'otieno@luxdevhq.test', role: 'tutor' }, '/admin'), 'staff');
  const otieno = userId('otieno@luxdevhq.test');
  assert.ok(q(`SELECT 1 FROM outbox WHERE to_email = 'otieno@luxdevhq.test'`));
  const ian = userId('ian@students.test');
  ok(await lead.post(`/students/${ian}/tutor`, { tutor_id: String(otieno) }, `/students/${ian}`), 'set tutor');
  assert.equal(q('SELECT tutor_id FROM users WHERE id = ?', ian).tutor_id, otieno);
  const runs = q('SELECT COUNT(*) n FROM rule_runs').n;
  ok(await lead.post('/admin/rules/run', {}, '/admin'), 'run rules');
  assert.equal(q('SELECT COUNT(*) n FROM rule_runs').n, runs + 1);
  assert.match((await lead.get('/admin/outbox')).text, /Your Week 10 SQL assignment is overdue/);
});

test('notifications: list, open marks read and goes to the record, mark all read', async () => {
  const me = userId('kevin@students.test');
  const n = q('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL AND link IS NOT NULL', me);
  assert.match((await kevin.get('/notifications')).text, new RegExp(n.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)));
  const r = await kevin.get(`/n/${n.id}`);
  assert.equal(r.location, n.link);
  assert.ok(q('SELECT read_at FROM notifications WHERE id = ?', n.id).read_at);
  // Can't open someone else's notification.
  const other = q('SELECT id FROM notifications WHERE user_id != ? LIMIT 1', me).id;
  assert.equal((await kevin.get(`/n/${other}`)).location, '/notifications');
  ok(await kevin.post('/notifications/read-all', {}, '/notifications'), 'read all');
  assert.equal(q('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', me).n, 0);
});

test('every notice was recorded with an email status', async () => {
  assert.equal(q(`SELECT COUNT(*) n FROM notifications WHERE email_status IS NULL`).n, 0);
  assert.equal(q(`SELECT COUNT(*) n FROM notifications WHERE email_status = 'failed'`).n, 0);
});
