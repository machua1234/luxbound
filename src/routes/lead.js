import { Router } from 'express';
import multer from 'multer';
import { html } from '../html.js';
import { page, csrf, pill, empty, stat } from '../views/layout.js';
import { get, all, run, nowIso, tx, ensureSubmissionRows } from '../db.js';
import { requireRole, requireLogin, issueToken, checkCsrf } from '../auth.js';
import { derive } from '../status.js';
import { fmt, relative, parseImportDate } from '../time.js';
import { runRules, RECURRING_THRESHOLD } from '../rules.js';
import { parseCsv } from '../csv.js';
import { notify } from '../notify.js';
import { transportName } from '../mailer.js';
import { bar } from './staff.js';

const r = Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Notifications (everyone) ──────────────────────────────────────────────────────────
r.get('/notifications', requireLogin, (req, res) => {
  const list = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id);
  res.send(page(req, {
    title: 'Notifications', body: html`
    <div class="row" style="justify-content:space-between"><h1>Notifications</h1>
      <form method="post" action="/notifications/read-all" class="inline">${csrf(req)}<button class="btn sm ghost">Mark all read</button></form></div>
    <p class="sub">Private to you. Each one was also emailed to ${req.user.email}.</p>
    <div class="card">${list.length ? list.map((n) => html`<div class="notif ${n.read_at ? '' : 'unread'}"><div class="dot"></div><div>
      <div class="t"><a href="/n/${n.id}">${n.title}</a></div><div class="muted" style="white-space:pre-line">${n.body}</div>
      <small>${fmt(n.created_at)}</small></div></div>`) : empty('No notifications yet.')}</div>`,
  }));
});
r.get('/n/:id', requireLogin, (req, res) => {
  const n = get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', nowIso(), n.id);
  res.redirect(n.link && n.link.startsWith('/') ? n.link : '/notifications');
});
r.post('/notifications/read-all', requireLogin, (req, res) => {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  res.redirect('/notifications');
});

// ── Cohort Overview (lead) ────────────────────────────────────────────────────────────
r.get('/overview', requireRole('lead'), (req, res) => {
  const at = new Date();
  const cohorts = all('SELECT * FROM cohorts ORDER BY id DESC');
  const cohortId = Number(req.query.cohort) || cohorts[0]?.id;
  const cohort = cohorts.find((c) => c.id === cohortId);
  if (!cohort) return res.send(page(req, { title: 'Cohort Overview', active: '/overview', body: html`<h1>Cohort Overview</h1><p class="sub">No cohort yet. <a href="/admin">Import a roster</a> to get started.</p>` }));

  const subs = all(`SELECT s.*, a.title, a.kind, a.due_at, a.required, a.id AS aid FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
    WHERE a.cohort_id = ? AND a.required = 1 AND u.active = 1`, cohortId).map((s) => ({ ...s, d: derive(s, at) }));
  const students = get(`SELECT COUNT(*) AS n FROM users WHERE cohort_id = ? AND role = 'student' AND active = 1`, cohortId).n;
  const pastDue = subs.filter((s) => s.d.past || ['approved', 'awaiting_review'].includes(s.status));
  const completed = pastDue.filter((s) => ['approved', 'awaiting_review', 'student_claimed'].includes(s.status)).length;
  const overdue = subs.filter((s) => s.d.overdue);
  const unverified = subs.filter((s) => s.d.needsConfirm || s.status === 'student_claimed');
  const unanswered = all(`SELECT t.*, u.first_name, u.last_name, a.first_name AS assignee_first FROM tickets t JOIN users u ON u.id = t.student_id LEFT JOIN users a ON a.id = t.assignee_id
    WHERE t.cohort_id = ? AND t.status = 'awaiting_tutor' ORDER BY t.awaiting_since`, cohortId);
  const skills = all(`SELECT skill, COUNT(*) AS total, COUNT(DISTINCT student_id) AS students, SUM(status != 'resolved') AS open,
      AVG(CASE WHEN first_reply_at IS NOT NULL THEN (julianday(first_reply_at) - julianday(created_at)) * 24 END) AS avg_reply_h
    FROM tickets WHERE cohort_id = ? AND created_at >= ? GROUP BY skill ORDER BY students DESC, total DESC`, cohortId, new Date(at - 30 * 864e5).toISOString());
  const issues = all(`SELECT i.*, u.first_name AS owner_first, (SELECT COUNT(*) FROM tickets t WHERE t.issue_id = i.id) AS n FROM issues i LEFT JOIN users u ON u.id = i.owner_id WHERE i.cohort_id = ? AND i.status != 'resolved'`, cohortId);
  const lateFollowups = all(`SELECT f.*, u.first_name AS owner_first FROM followups f JOIN users u ON u.id = f.owner_id WHERE f.status = 'open' AND f.due_at < ? ORDER BY f.due_at`, at.toISOString());

  const assignments = all('SELECT * FROM assignments WHERE cohort_id = ? AND required = 1 ORDER BY due_at', cohortId);
  const perAssignment = assignments.map((a) => {
    const rows = subs.filter((s) => s.aid === a.id);
    const done = rows.filter((s) => ['approved', 'awaiting_review', 'student_claimed'].includes(s.status)).length;
    return { a, total: rows.length, done, approved: rows.filter((s) => s.status === 'approved').length, overdue: rows.filter((s) => s.d.overdue).length, unverified: rows.filter((s) => s.d.needsConfirm).length };
  });

  const byStudent = new Map();
  for (const s of overdue) byStudent.set(s.student_id, (byStudent.get(s.student_id) || 0) + 1);
  const atRisk = [...byStudent.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([id, n]) => ({ ...get('SELECT id, first_name, last_name FROM users WHERE id = ?', id), n }));
  const lastRun = get('SELECT * FROM rule_runs ORDER BY id DESC LIMIT 1');

  res.send(page(req, {
    title: 'Cohort Overview', active: '/overview', body: html`
    <div class="row" style="justify-content:space-between"><div><h1>${cohort.name} overview</h1>
      <p class="sub">${students} active students · rules last ran ${lastRun ? relative(lastRun.started_at, at) : 'never'}</p></div>
      ${cohorts.length > 1 ? html`<form class="row"><select name="cohort" onchange="this.form.submit()" style="width:auto">${cohorts.map((c) => html`<option value="${c.id}" ${c.id === cohortId ? 'selected' : ''}>${c.name}</option>`)}</select></form>` : ''}</div>

    <div class="stats">
      ${stat('Completion rate', pastDue.length ? `${Math.round((completed / pastDue.length) * 100)}%` : '—', '', `${completed} of ${pastDue.length} due items submitted`)}
      ${stat('Overdue (confirmed)', overdue.length, overdue.length ? 'bad' : 'good', `${byStudent.size} students`)}
      ${stat('Awaiting verification', unverified.length, unverified.length ? 'warn' : '', 'past deadline, not checked')}
      ${stat('Unanswered tickets', unanswered.length, unanswered.some((t) => t.escalated_at) ? 'bad' : unanswered.length ? 'warn' : 'good', `${unanswered.filter((t) => t.escalated_at).length} past one working day`)}
      ${stat('Late follow-ups', lateFollowups.length, lateFollowups.length ? 'bad' : 'good', 'past their due date')}
    </div>

    <div class="card"><h2>Completion by assignment</h2><table><tr><th>Item</th><th>Deadline</th><th>Submitted</th><th>Approved</th><th>Overdue</th><th>Unverified</th></tr>
      ${perAssignment.map((p) => html`<tr><td><a href="/assignments/${p.a.id}">${p.a.title}</a>${p.a.kind === 'project' ? html` <span class="tag">Project</span>` : ''}</td><td>${fmt(p.a.due_at)}</td>
        <td>${bar(p.done, p.total)}<small>${p.done}/${p.total}</small></td><td>${p.approved}</td><td>${p.overdue ? pill('bad', p.overdue) : '0'}</td><td>${p.unverified ? pill('warn', p.unverified) : '0'}</td></tr>`)}</table></div>

    <div class="grid g2">
      <div class="card"><h2>Recurring issues by skill <small class="muted">(last 30 days)</small></h2>
        ${issues.length ? html`<div style="margin-bottom:1rem">${issues.map((i) => html`<div class="next warn"><b>${i.status === 'open' ? 'Needs a fix' : 'Fix shared — checking students can proceed'}</b><a href="/issues/${i.id}">${i.title}</a> · ${i.n} tickets · owner ${i.owner_first || '—'}</div>`)}</div>` : ''}
        ${skills.length ? html`<table><tr><th>Skill</th><th>Students</th><th>Tickets</th><th>Open</th><th>Avg first reply</th></tr>${skills.map((s) => html`<tr><td>${s.skill}</td>
          <td>${s.students >= RECURRING_THRESHOLD ? pill('warn', s.students) : s.students}</td><td>${s.total}</td><td>${s.open}</td><td>${s.avg_reply_h != null ? `${s.avg_reply_h.toFixed(1)} h` : '—'}</td></tr>`)}</table>` : empty('No tickets in the last 30 days.')}</div>
      <div class="card"><h2>Unanswered tickets</h2>
        ${unanswered.length ? html`<table><tr><th>#</th><th>Student</th><th>Skill</th><th>Tutor</th><th>Waiting</th></tr>${unanswered.map((t) => html`<tr><td><a href="/support/${t.id}">#${t.id}</a></td>
          <td>${t.first_name} ${t.last_name}</td><td>${t.skill}</td><td>${t.assignee_first || '—'}</td><td>${t.escalated_at ? pill('bad', relative(t.awaiting_since, at).replace(' ago', '')) : relative(t.awaiting_since, at).replace(' ago', '')}</td></tr>`)}</table>` : empty('Every ticket has a reply.')}</div>
    </div>

    <div class="grid g2">
      <div class="card"><h2>Students with overdue work</h2>${atRisk.length ? html`<table>${atRisk.map((s) => html`<tr><td><a href="/students/${s.id}">${s.first_name} ${s.last_name}</a></td><td>${pill('bad', `${s.n} overdue`)}</td></tr>`)}</table>` : empty('No confirmed overdue work.')}</div>
      <div class="card"><h2>Follow-ups past due</h2>${lateFollowups.length ? html`<table>${lateFollowups.map((f) => html`<tr><td>${f.next_action}</td><td>${f.owner_first}</td><td>${pill('bad', fmt(f.due_at))}</td></tr>`)}</table>` : empty('All follow-ups are on time.')}</div>
    </div>`,
  }));
});

// ── Admin: imports, rules, outbox ─────────────────────────────────────────────────────
r.get('/admin', requireRole('lead'), (req, res) => {
  const cohorts = all('SELECT * FROM cohorts ORDER BY id DESC');
  const imports = all('SELECT i.*, u.first_name FROM imports i LEFT JOIN users u ON u.id = i.actor_id ORDER BY i.id DESC LIMIT 10');
  const runs = all('SELECT * FROM rule_runs ORDER BY id DESC LIMIT 5');
  const staff = all(`SELECT * FROM users WHERE role IN ('tutor','lead') ORDER BY role, first_name`);
  const cohortSelect = html`<label>Cohort<select name="cohort_id">${cohorts.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>`;
  res.send(page(req, {
    title: 'Admin', active: '/admin', body: html`
    <h1>Admin</h1>
    <p class="sub">Pilot setup: import the weekly roster and assignments, then tutors confirm status from Squad. Email transport: <b>${transportName === 'smtp' ? 'SMTP (live)' : 'outbox only — set SMTP_HOST to send'}</b>.</p>
    <div class="grid g3">
      <form class="card stack" method="post" action="/admin/import/roster" enctype="multipart/form-data">${csrf(req)}
        <h2>1 · Weekly roster</h2><p class="muted">CSV: <code>email, first_name, last_name, tutor_email, role</code>. New people get an invite email.</p>
        ${cohortSelect}<label>Or new cohort name<input type="text" name="new_cohort" placeholder="Cohort 10"></label>
        <label>File<input type="file" name="file" accept=".csv,text/csv" required></label>
        <label><input type="checkbox" name="deactivate_missing" value="1" style="width:auto"> Deactivate students not in this file</label>
        <div class="form-actions"><button class="btn">Import roster</button></div><a href="/static/samples/roster.csv">Sample file</a></form>
      <form class="card stack" method="post" action="/admin/import/assignments" enctype="multipart/form-data">${csrf(req)}
        <h2>2 · Assignments</h2><p class="muted">CSV: <code>code, title, week, kind, skill, required, due_at, squad_url, deliverables</code>. Dates in EAT (<code>2026-11-14 23:59</code>). Matched by code.</p>
        ${cohortSelect}<label>File<input type="file" name="file" accept=".csv,text/csv" required></label>
        <div class="form-actions"><button class="btn">Import assignments</button></div><a href="/static/samples/assignments.csv">Sample file</a></form>
      <form class="card stack" method="post" action="/admin/import/status" enctype="multipart/form-data">${csrf(req)}
        <h2>3 · Squad status export <small class="muted">(later)</small></h2><p class="muted">Use only once Squad provides a reliable export. CSV: <code>email, assignment_code, status</code> where status is <code>submitted</code>, <code>not_submitted</code>, <code>approved</code>.</p>
        ${cohortSelect}<label>File<input type="file" name="file" accept=".csv,text/csv" required></label>
        <div class="form-actions"><button class="btn ghost">Import statuses</button></div><a href="/static/samples/status.csv">Sample file</a></form>
    </div>

    <div class="grid g2">
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Early-warning rules</h2>
        <form method="post" action="/admin/rules/run" class="inline">${csrf(req)}<button class="btn sm">Run now</button></form></div>
        <p class="muted">Rules run automatically every ${process.env.RULES_INTERVAL_MIN || 15} minutes and after every status update. Each notice is sent once.</p>
        ${runs.length ? html`<table>${runs.map((x) => html`<tr><td><small>${fmt(x.started_at)}</small></td><td><small>${Object.entries(JSON.parse(x.summary)).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no new actions'}</small></td></tr>`)}</table>` : ''}</div>
      <div class="card"><h2>Recent imports</h2>${imports.length ? html`<table>${imports.map((i) => html`<tr><td><small>${fmt(i.created_at)}</small></td><td>${i.kind}${i.filename ? ` · ${i.filename}` : ''}</td><td>+${i.created} / ~${i.updated}${i.errors ? html`<br><small style="color:var(--bad)">${i.errors}</small>` : ''}</td></tr>`)}</table>` : empty('No imports yet.')}</div>
    </div>

    <div class="grid g2">
      <div class="card"><h2>Staff</h2><table>${staff.map((s) => html`<tr><td>${s.first_name} ${s.last_name}</td><td>${s.email}</td><td>${s.role}</td></tr>`)}</table>
        <form class="stack" method="post" action="/admin/staff">${csrf(req)}<h3 style="margin-top:1rem">Add staff</h3>
          <div class="grid g2"><input type="text" name="first_name" placeholder="First name" required><input type="text" name="last_name" placeholder="Last name"></div>
          <div class="grid g2" style="margin-top:.5rem"><input type="email" name="email" placeholder="Email" required><select name="role"><option value="tutor">Tutor</option><option value="lead">Cohort lead</option></select></div>
          <div class="form-actions"><button class="btn sm">Invite</button></div></form></div>
      <div class="card"><h2>Email outbox</h2><p class="muted">Every email the portal has sent, with the time it was sent.</p><a class="btn sm ghost" href="/admin/outbox">Open outbox</a></div>
    </div>`,
  }));
});

r.post('/admin/rules/run', requireRole('lead'), async (req, res) => {
  const s = await runRules();
  req.setFlash('ok', `Rules ran: ${Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing new to do'}.`);
  res.redirect('/admin');
});

r.get('/admin/outbox', requireRole('lead'), (req, res) => {
  const mails = all('SELECT * FROM outbox ORDER BY id DESC LIMIT 100');
  res.send(page(req, {
    title: 'Outbox', active: '/admin', body: html`<p><a href="/admin">← Admin</a></p><h1>Email outbox</h1><p class="sub">Transport: ${transportName}.</p>
    ${mails.length ? mails.map((m) => html`<details class="card tight"><summary><b>${m.subject}</b> → ${m.to_email} <small class="muted">· ${fmt(m.created_at)}</small></summary><pre style="white-space:pre-wrap;font:inherit;margin-top:1rem">${m.text}</pre></details>`) : empty('No emails yet.')}`,
  }));
});

function cohortFromForm(body) {
  const name = String(body.new_cohort || '').trim();
  if (name) {
    run('INSERT OR IGNORE INTO cohorts (name, created_at) VALUES (?, ?)', name, nowIso());
    return get('SELECT * FROM cohorts WHERE name = ?', name);
  }
  return get('SELECT * FROM cohorts WHERE id = ?', Number(body.cohort_id));
}

function logImport(kind, req, created, updated, errors) {
  run('INSERT INTO imports (kind, filename, actor_id, created, updated, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    kind, req.file?.originalname || null, req.user.id, created, updated, errors.slice(0, 5).join(' | ') || null, nowIso());
  req.setFlash(errors.length ? 'error' : 'ok', `${kind}: ${created} added, ${updated} updated${errors.length ? `, ${errors.length} rows skipped (${errors.slice(0, 3).join('; ')})` : ''}.`);
}

export async function importRoster(rows, cohort, { deactivateMissing = false } = {}) {
  let created = 0, updated = 0;
  const errors = [], invites = [];
  tx(() => {
    const seen = new Set();
    rows.forEach((row, i) => {
      const email = (row.email || '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !row.first_name) { errors.push(`row ${i + 2}: email and first_name required`); return; }
      const role = ['tutor', 'lead'].includes(row.role) ? row.role : 'student';
      const tutor = row.tutor_email ? get(`SELECT id FROM users WHERE email = ? AND role IN ('tutor','lead')`, row.tutor_email) : null;
      if (row.tutor_email && !tutor) errors.push(`row ${i + 2}: tutor ${row.tutor_email} not found (import tutors first)`);
      seen.add(email);
      const existing = get('SELECT * FROM users WHERE email = ?', email);
      if (existing) {
        run(`UPDATE users SET first_name = ?, last_name = ?, cohort_id = ?, tutor_id = COALESCE(?, tutor_id), active = 1 WHERE id = ?`,
          row.first_name, row.last_name || '', cohort.id, tutor?.id ?? null, existing.id);
        updated++;
      } else {
        const id = Number(run(`INSERT INTO users (email, first_name, last_name, role, cohort_id, tutor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          email, row.first_name, row.last_name || '', role, cohort.id, tutor?.id ?? null, nowIso()).lastInsertRowid);
        invites.push(id);
        created++;
      }
    });
    if (deactivateMissing && seen.size) {
      for (const u of all(`SELECT id, email FROM users WHERE cohort_id = ? AND role = 'student' AND active = 1`, cohort.id)) {
        if (!seen.has(u.email.toLowerCase())) run('UPDATE users SET active = 0 WHERE id = ?', u.id);
      }
    }
    ensureSubmissionRows(cohort.id);
  });
  for (const id of invites) await sendInvite(id);
  return { created, updated, errors };
}

export async function sendInvite(userId) {
  const token = issueToken(userId, 'invite', 14);
  await notify({
    userId, kind: 'account', title: 'Welcome to LuxDevHQ Progress & Support', link: `/set-password?token=${token}`,
    body: 'This portal shows your required assignments and projects, what’s still outstanding, and lets you report technical blockers to your tutor. You’ll keep submitting your work in Squad as usual.\n\nSet your password to sign in:',
  });
}

export function importAssignments(rows, cohort) {
  let created = 0, updated = 0;
  const errors = [];
  tx(() => {
    rows.forEach((row, i) => {
      const due = parseImportDate(row.due_at);
      if (!row.code || !row.title || !due) { errors.push(`row ${i + 2}: code, title and a valid due_at required`); return; }
      const kind = row.kind === 'project' ? 'project' : 'assignment';
      const required = ['0', 'no', 'false', 'optional'].includes((row.required || '').toLowerCase()) ? 0 : 1;
      const existing = get('SELECT id FROM assignments WHERE cohort_id = ? AND code = ?', cohort.id, row.code);
      if (existing) {
        run(`UPDATE assignments SET title = ?, week = ?, kind = ?, skill = ?, required = ?, due_at = ?, squad_url = ?, deliverables = ? WHERE id = ?`,
          row.title, Number(row.week) || null, kind, row.skill || '', required, due, row.squad_url || '', row.deliverables || '', existing.id);
        updated++;
      } else {
        run(`INSERT INTO assignments (cohort_id, code, title, week, kind, skill, required, due_at, squad_url, deliverables, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          cohort.id, row.code, row.title, Number(row.week) || null, kind, row.skill || '', required, due, row.squad_url || '', row.deliverables || '', nowIso());
        created++;
      }
    });
    ensureSubmissionRows(cohort.id);
  });
  return { created, updated, errors };
}

r.post('/admin/import/roster', requireRole('lead'), csvUpload.single('file'), checkCsrf, async (req, res) => {
  const cohort = cohortFromForm(req.body);
  if (!cohort || !req.file) { req.setFlash('error', 'Choose a cohort and a CSV file.'); return res.redirect('/admin'); }
  const { created, updated, errors } = await importRoster(parseCsv(req.file.buffer.toString('utf8')), cohort, { deactivateMissing: req.body.deactivate_missing === '1' });
  logImport('Roster', req, created, updated, errors);
  res.redirect('/admin');
});

r.post('/admin/import/assignments', requireRole('lead'), csvUpload.single('file'), checkCsrf, async (req, res) => {
  const cohort = cohortFromForm(req.body);
  if (!cohort || !req.file) { req.setFlash('error', 'Choose a cohort and a CSV file.'); return res.redirect('/admin'); }
  const { created, updated, errors } = importAssignments(parseCsv(req.file.buffer.toString('utf8')), cohort);
  logImport('Assignments', req, created, updated, errors);
  await runRules();
  res.redirect('/admin');
});

const EXPORT_STATUS = { submitted: 'awaiting_review', not_submitted: 'outstanding', missing: 'outstanding', approved: 'approved' };
r.post('/admin/import/status', requireRole('lead'), csvUpload.single('file'), checkCsrf, async (req, res) => {
  const cohort = cohortFromForm(req.body);
  if (!cohort || !req.file) { req.setFlash('error', 'Choose a cohort and a CSV file.'); return res.redirect('/admin'); }
  let updated = 0;
  const errors = [];
  const now = nowIso();
  tx(() => {
    parseCsv(req.file.buffer.toString('utf8')).forEach((row, i) => {
      const status = EXPORT_STATUS[(row.status || '').toLowerCase()];
      const s = get(`SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
        WHERE u.email = ? AND a.code = ? AND a.cohort_id = ?`, row.email || '', row.assignment_code || '', cohort.id);
      if (!s || !status) { errors.push(`row ${i + 2}: unknown student/assignment/status`); return; }
      // Never downgrade something a tutor has already reviewed.
      if (['approved', 'revision_requested'].includes(s.status) && status !== 'approved') return;
      if (s.status === status) return;
      run(`UPDATE submissions SET status = ?, status_source = 'squad_export', verified_at = ?, updated_at = ? WHERE id = ?`, status, now, now, s.id);
      run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, 'Squad export', ?)`, s.id, req.user.id, s.status, status, now);
      updated++;
    });
  });
  logImport('Squad status', req, 0, updated, errors);
  await runRules();
  res.redirect('/admin');
});

r.post('/admin/staff', requireRole('lead'), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'lead' ? 'lead' : 'tutor';
  if (!email || !req.body.first_name || get('SELECT 1 FROM users WHERE email = ?', email)) {
    req.setFlash('error', 'Enter a name and an email that isn’t already registered.');
    return res.redirect('/admin');
  }
  const id = Number(run(`INSERT INTO users (email, first_name, last_name, role, created_at) VALUES (?, ?, ?, ?, ?)`, email, req.body.first_name, req.body.last_name || '', role, nowIso()).lastInsertRowid);
  await sendInvite(id);
  req.setFlash('ok', `Invited ${req.body.first_name}.`);
  res.redirect('/admin');
});

export default r;
