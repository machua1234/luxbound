import { Router } from 'express';
import { html, text } from '../html.js';
import { page, csrf, pill, due, ticketPill, empty, stat } from '../views/layout.js';
import { get, all, run, nowIso, tx } from '../db.js';
import { requireRole, canSeeStudent } from '../auth.js';
import { derive, effectiveDue, SUBMISSION_STATUSES } from '../status.js';
import { fmt, fromLocalInput, toLocalInput, addWorkingDays, relative } from '../time.js';
import { closeFollowups, createFollowup, runRules, studentName } from '../rules.js';
import * as msg from '../messages.js';
import { submissionsFor, ticketsFor, plansFor } from './student.js';

const r = Router();
r.use(['/queue', '/followups', '/students', '/assignments', '/submissions'], requireRole('tutor', 'lead'));

/** Students this staff member is responsible for. Leads see everyone; tutors see their assigned students. */
export function myStudents(user) {
  return user.role === 'lead'
    ? all(`SELECT u.*, t.first_name AS tutor_first FROM users u LEFT JOIN users t ON t.id = u.tutor_id WHERE u.role = 'student' AND u.active = 1 ORDER BY u.first_name`)
    : all(`SELECT u.*, t.first_name AS tutor_first FROM users u LEFT JOIN users t ON t.id = u.tutor_id WHERE u.role = 'student' AND u.active = 1 AND u.tutor_id = ? ORDER BY u.first_name`, user.id);
}

function scopedSubmissions(user) {
  const rows = all(`
    SELECT s.*, a.title, a.kind, a.due_at, a.deliverables, a.required, u.first_name, u.last_name, u.tutor_id
    FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
    WHERE a.required = 1 AND u.active = 1 ${user.role === 'tutor' ? 'AND u.tutor_id = ?' : ''}
    ORDER BY COALESCE(s.due_override_at, a.due_at)`, ...(user.role === 'tutor' ? [user.id] : []));
  const at = new Date();
  return rows.map((s) => ({ ...s, d: derive(s, at) }));
}

// ── Tutor Queue ────────────────────────────────────────────────────────────────────────
r.get('/queue', (req, res) => {
  const at = new Date();
  const ownerFilter = req.user.role === 'lead' ? String(req.query.owner || 'me') : 'me';
  const followups = all(`
    SELECT f.*, o.first_name AS owner_first, s.first_name AS s_first, s.last_name AS s_last
    FROM followups f JOIN users o ON o.id = f.owner_id LEFT JOIN users s ON s.id = f.student_id
    WHERE f.status = 'open' ${ownerFilter === 'me' ? 'AND f.owner_id = ?' : ''} ORDER BY f.due_at`, ...(ownerFilter === 'me' ? [req.user.id] : []));
  const subs = scopedSubmissions(req.user);
  const verify = subs.filter((s) => s.status === 'student_claimed' || s.d.needsConfirm);
  const review = subs.filter((s) => s.status === 'awaiting_review');
  const overdue = subs.filter((s) => s.d.overdue);
  const tickets = all(`
    SELECT t.*, s.first_name, s.last_name FROM tickets t JOIN users s ON s.id = t.student_id
    WHERE t.status = 'awaiting_tutor' ${req.user.role === 'tutor' ? 'AND (t.assignee_id = ? OR s.tutor_id = ?)' : ''} ORDER BY t.awaiting_since`,
    ...(req.user.role === 'tutor' ? [req.user.id, req.user.id] : []));

  const subTable = (list, cols) => list.length ? html`<table><tr><th>Student</th><th>Item</th><th>Deadline</th><th>Status</th><th></th></tr>
    ${list.map((s) => html`<tr><td><a href="/students/${s.student_id}">${s.first_name} ${s.last_name}</a></td><td><a href="/progress/${s.id}">${s.title}</a>${s.kind === 'project' ? html` <span class="tag">Project</span>` : ''}</td>
      <td>${due(s.d.due, at)}</td><td>${pill(s.d.tone, s.d.staff)}</td><td class="actions">${cols(s)}</td></tr>`)}</table>` : empty('Nothing here.');

  const quick = (s, st, label, cls = 'sm') => html`<form method="post" action="/submissions/${s.id}/status" class="inline">${csrf(req)}<input type="hidden" name="status" value="${st}"><input type="hidden" name="back" value="/queue"><button class="btn ${cls}">${label}</button></form>`;

  res.send(page(req, {
    title: 'Tutor Queue', active: '/queue', body: html`
    <h1>Tutor Queue</h1>
    <p class="sub">Everything that needs a person to act. Check Squad, update the record here, and the portal sends the right notice.</p>
    <div class="stats">
      ${stat('Open follow-ups', followups.length, followups.some((f) => new Date(f.due_at) < at) ? 'bad' : '')}
      ${stat('Needs verification', verify.length, verify.length ? 'warn' : '')}
      ${stat('Awaiting review', review.length)}
      ${stat('Overdue (confirmed)', overdue.length, overdue.length ? 'bad' : '')}
      ${stat('Tickets waiting on tutor', tickets.length, tickets.length ? 'warn' : '')}
    </div>

    <div class="card"><div class="row" style="justify-content:space-between"><h2>Follow-ups</h2>
      ${req.user.role === 'lead' ? html`<div class="row"><a class="btn sm ${ownerFilter === 'me' ? '' : 'ghost'}" href="?owner=me">Mine</a><a class="btn sm ${ownerFilter === 'all' ? '' : 'ghost'}" href="?owner=all">All staff</a></div>` : ''}</div>
      ${followups.length ? html`<table><tr><th>Owner</th><th>Next action</th><th>Student / item</th><th>Due</th><th></th></tr>
        ${followups.map((f) => html`<tr><td>${f.owner_first}</td><td>${f.next_action}</td>
          <td>${f.student_id ? html`<a href="/students/${f.student_id}">${f.s_first} ${f.s_last}</a>` : ''}${f.ticket_id ? html` <a href="/support/${f.ticket_id}">ticket #${f.ticket_id}</a>` : ''}${f.issue_id ? html` <a href="/issues/${f.issue_id}">issue</a>` : ''}${f.plan_id ? html` <a href="/plans/${f.plan_id}">plan</a>` : ''}</td>
          <td>${new Date(f.due_at) < at ? pill('bad', `Overdue · ${fmt(f.due_at)}`) : due(f.due_at, at)}</td>
          <td class="actions">${f.kind === 'catch_up' ? html`<a class="btn sm" href="/students/${f.student_id}/plan">Propose plan</a> ` : ''}
            <form method="post" action="/followups/${f.id}/done" class="inline">${csrf(req)}<button class="btn sm ghost">Done</button></form></td></tr>`)}</table>` : empty('No open follow-ups. 🎉')}</div>

    <div class="grid g2">
      <div class="card"><h2>Needs verification in Squad</h2><p class="muted">Deadline passed but unchecked, or the student says they submitted.</p>
        ${subTable(verify, (s) => html`${quick(s, 'awaiting_review', 'Submitted')} ${quick(s, 'outstanding', 'No submission', 'sm ghost')}`)}</div>
      <div class="card"><h2>Awaiting review</h2>
        ${subTable(review, (s) => html`${quick(s, 'approved', 'Approve', 'sm good')} <a class="btn sm ghost" href="/progress/${s.id}">Revise…</a>`)}</div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Overdue work</h2><p class="muted">Confirmed no submission after the approved deadline.</p>
        ${subTable(overdue, (s) => html`<a class="btn sm ghost" href="/progress/${s.id}">Extend…</a>`)}</div>
      <div class="card"><h2>Tickets waiting on a tutor</h2>
        ${tickets.length ? html`<table><tr><th>#</th><th>Student</th><th>Skill</th><th>Waiting</th></tr>${tickets.map((t) => html`<tr>
          <td><a href="/support/${t.id}">#${t.id}</a></td><td>${t.first_name} ${t.last_name}</td><td>${t.skill}</td><td>${ticketPill(t)}<br><small>${relative(t.awaiting_since, at).replace(' ago', '')}</small></td></tr>`)}</table>` : empty('No tickets waiting.')}</div>
    </div>`,
  }));
});

r.post('/followups/:id/done', (req, res) => {
  const f = get('SELECT * FROM followups WHERE id = ?', Number(req.params.id));
  if (!f || (f.owner_id !== req.user.id && req.user.role !== 'lead')) return res.status(404).end();
  closeFollowups('id = ?', [f.id], `Marked done by ${req.user.first_name}`);
  req.setFlash('ok', 'Follow-up closed.');
  res.redirect(req.get('referer') || '/queue');
});

// ── Students ──────────────────────────────────────────────────────────────────────────
r.get('/students', (req, res) => {
  const at = new Date();
  const students = myStudents(req.user);
  const subs = scopedSubmissions(req.user);
  const openTickets = all(`SELECT student_id, COUNT(*) AS n, SUM(status = 'awaiting_tutor') AS waiting FROM tickets WHERE status != 'resolved' GROUP BY student_id`);
  const tmap = new Map(openTickets.map((t) => [t.student_id, t]));
  const rows = students.map((u) => {
    const mine = subs.filter((s) => s.student_id === u.id);
    const pastDue = mine.filter((s) => new Date(s.d.due) <= at);
    const done = pastDue.filter((s) => ['approved', 'awaiting_review', 'student_claimed'].includes(s.status)).length;
    return { u, overdue: mine.filter((s) => s.d.overdue).length, unchecked: mine.filter((s) => s.d.needsConfirm).length, done, pastDue: pastDue.length, t: tmap.get(u.id) };
  }).sort((a, b) => b.overdue - a.overdue || b.unchecked - a.unchecked);

  res.send(page(req, {
    title: 'Students', active: '/students', body: html`
    <h1>Students</h1><p class="sub">${req.user.role === 'lead' ? 'Everyone in the cohort.' : 'Students assigned to you.'} Submission and support status are shown side by side.</p>
    <div class="card"><table><tr><th>Student</th>${req.user.role === 'lead' ? html`<th>Tutor</th>` : ''}<th>Completed (due so far)</th><th>Submission status</th><th>Support status</th></tr>
      ${rows.map(({ u, overdue, unchecked, done, pastDue, t }) => html`<tr>
        <td><a href="/students/${u.id}">${u.first_name} ${u.last_name}</a><br><small>${u.email}</small></td>
        ${req.user.role === 'lead' ? html`<td>${u.tutor_first || html`<span class="muted">—</span>`}</td>` : ''}
        <td>${bar(done, pastDue)}<small>${done}/${pastDue}</small></td>
        <td>${overdue ? pill('bad', `${overdue} overdue`) : ''} ${unchecked ? pill('warn', `${unchecked} to verify`) : ''} ${!overdue && !unchecked ? pill('good', 'On track') : ''}</td>
        <td>${t ? html`${pill(t.waiting ? 'warn' : 'info', `${t.n} open ticket${t.n > 1 ? 's' : ''}`)}` : html`<span class="muted">None</span>`}</td></tr>`)}</table></div>`,
  }));
});

export function bar(n, total) {
  const pct = total ? Math.round((n / total) * 100) : 100;
  return html`<div class="bar ${pct < 50 ? 'low' : pct < 80 ? 'mid' : ''}" title="${pct}%"><i style="width:${pct}%"></i></div>`;
}

r.get('/students/:id', (req, res) => {
  const id = Number(req.params.id);
  const student = get(`SELECT u.*, t.first_name AS tutor_first, t.last_name AS tutor_last FROM users u LEFT JOIN users t ON t.id = u.tutor_id WHERE u.id = ? AND u.role = 'student'`, id);
  if (!student || !canSeeStudent(req.user, id)) return res.status(404).send(page(req, { title: 'Not found', body: html`<h1>Not found</h1>` }));
  const at = new Date();
  const subs = submissionsFor(id).map((s) => ({ ...s, d: derive(s, at) }));
  const tickets = ticketsFor(id);
  const plans = plansFor(id);
  const followups = all(`SELECT f.*, o.first_name AS owner_first FROM followups f JOIN users o ON o.id = f.owner_id WHERE f.student_id = ? AND f.status = 'open' ORDER BY f.due_at`, id);
  const notices = all(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 12`, id);
  const tutors = req.user.role === 'lead' ? all(`SELECT * FROM users WHERE role = 'tutor' AND active = 1 ORDER BY first_name`) : [];
  const overdue = subs.filter((s) => s.d.overdue);

  res.send(page(req, {
    title: studentName(student), active: '/students', body: html`
    <p><a href="/students">← Students</a></p>
    <div class="row" style="justify-content:space-between"><div><h1>${studentName(student)}</h1>
      <p class="sub">${student.email} · Tutor: ${student.tutor_first ? `${student.tutor_first} ${student.tutor_last}` : 'not assigned'}</p></div>
      <div class="row">${overdue.length ? html`<a class="btn warn" href="/students/${id}/plan">Propose catch-up plan</a>` : ''}</div></div>

    ${followups.length ? html`<div class="card" style="border-color:#fecaca"><h2>Open follow-ups</h2><table>${followups.map((f) => html`<tr><td>${f.next_action}</td><td>${f.owner_first}</td><td>${due(f.due_at, at)}</td></tr>`)}</table></div>` : ''}

    <div class="split">
      <div class="card"><h2>Submission status</h2>
        <table><tr><th>Item</th><th>Deadline</th><th>Status</th></tr>${subs.filter((s) => s.required).map((s) => html`<tr>
          <td><a href="/progress/${s.id}">${s.title}</a>${s.kind === 'project' ? html` <span class="tag">Project</span>` : ''}</td>
          <td>${fmt(s.d.due)}${s.due_override_at ? html`<br><small>${s.override_reason}</small>` : ''}</td><td>${pill(s.d.tone, s.d.staff)}</td></tr>`)}</table></div>
      <div>
        <div class="card"><h2>Support status</h2>${tickets.length ? html`<table>${tickets.map((t) => html`<tr><td><a href="/support/${t.id}">#${t.id} ${t.skill}</a>${t.assignment_title ? html`<br><small>${t.assignment_title}</small>` : ''}</td><td>${ticketPill(t)}</td></tr>`)}</table>` : empty('No tickets.')}</div>
        <div class="card"><h2>Catch-up plans</h2>${plans.length ? plans.map((p) => html`<p><a href="/plans/${p.id}">${fmt(p.created_at)}</a> ${pill(p.status === 'proposed' ? 'info' : 'good', p.status)}<br><small>Check-in ${fmt(p.check_in_at)}</small></p>`) : empty('None.')}</div>
        ${tutors.length ? html`<form class="card stack" method="post" action="/students/${id}/tutor">${csrf(req)}<h2>Assigned tutor</h2>
          <div class="row"><select name="tutor_id" style="max-width:220px"><option value="">—</option>${tutors.map((t) => html`<option value="${t.id}" ${t.id === student.tutor_id ? 'selected' : ''}>${t.first_name} ${t.last_name}</option>`)}</select><button class="btn sm">Save</button></div></form>` : ''}
        <div class="card"><h2>Recent notices</h2>${notices.length ? html`<table>${notices.map((n) => html`<tr><td><small>${fmt(n.created_at)}</small><br>${n.title}<br><small>Email: ${n.email_status || '—'}</small></td></tr>`)}</table>` : empty('None sent.')}</div>
      </div>
    </div>`,
  }));
});

r.post('/students/:id/tutor', (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).end();
  const tutorId = Number(req.body.tutor_id) || null;
  if (tutorId && !get(`SELECT 1 FROM users WHERE id = ? AND role = 'tutor'`, tutorId)) return res.status(400).end();
  run('UPDATE users SET tutor_id = ? WHERE id = ? AND role = ?', tutorId, Number(req.params.id), 'student');
  req.setFlash('ok', 'Tutor updated.');
  res.redirect(`/students/${req.params.id}`);
});

// ── Catch-up plan ─────────────────────────────────────────────────────────────────────
r.get('/students/:id/plan', (req, res) => {
  const id = Number(req.params.id);
  const student = get(`SELECT * FROM users WHERE id = ? AND role = 'student'`, id);
  if (!student || !canSeeStudent(req.user, id)) return res.status(404).end();
  const at = new Date();
  const owing = submissionsFor(id).filter((s) => s.required).map((s) => ({ ...s, d: derive(s, at) })).filter((s) => s.d.overdue || s.d.needsConfirm || s.status === 'revision_requested');
  const checkIn = toLocalInput(addWorkingDays(at, 3).toISOString());
  res.send(page(req, {
    title: 'Propose catch-up plan', active: '/students', body: html`
    <p><a href="/students/${id}">← ${studentName(student)}</a></p>
    <h1>Catch-up plan for ${student.first_name}</h1>
    <p class="sub">Agree what happens next. ${student.first_name} gets this as a private message from you, with the check-in date.</p>
    <form class="card stack" method="post" action="/students/${id}/plan" style="max-width:820px">${csrf(req)}
      <label>Plan <small>(written to ${student.first_name})</small><textarea name="plan" required rows="6">Let’s get you back on track. Focus on one item at a time, starting with the oldest. If anything technical blocks you, open a ticket straight away rather than waiting.</textarea></label>
      ${owing.length ? html`<h3 style="margin-top:1.25rem">New deadlines <small class="muted">(leave blank to keep current)</small></h3>
        <table>${owing.map((s) => html`<tr><td>${s.title}<br><small>${s.d.staff} · was ${fmt(s.d.due)}</small></td><td style="width:260px"><input type="datetime-local" name="due_${s.id}"></td></tr>`)}</table>` : ''}
      <label>Check-in date (EAT)<input type="datetime-local" name="check_in" required value="${checkIn}"></label>
      <div class="form-actions"><button class="btn">Send plan to ${student.first_name}</button></div>
    </form>`,
  }));
});

r.post('/students/:id/plan', async (req, res) => {
  const id = Number(req.params.id);
  const student = get(`SELECT * FROM users WHERE id = ? AND role = 'student'`, id);
  if (!student || !canSeeStudent(req.user, id)) return res.status(404).end();
  const checkIn = fromLocalInput(req.body.check_in);
  const planText = String(req.body.plan || '').trim();
  if (!checkIn || !planText) { req.setFlash('error', 'Add the plan and a check-in date.'); return res.redirect(`/students/${id}/plan`); }
  const now = nowIso();
  const items = [];
  const planId = tx(() => {
    const pid = Number(run(`INSERT INTO catchup_plans (student_id, tutor_id, plan, check_in_at, created_at) VALUES (?, ?, ?, ?, ?)`, id, req.user.id, planText, checkIn, now).lastInsertRowid);
    for (const [k, v] of Object.entries(req.body)) {
      if (!k.startsWith('due_') || !v) continue;
      const newDue = fromLocalInput(v);
      const s = get(`SELECT s.*, a.title FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ? AND s.student_id = ?`, Number(k.slice(4)), id);
      if (!s || !newDue) continue;
      run(`UPDATE submissions SET due_override_at = ?, override_reason = 'catch_up', status = CASE WHEN status = 'not_checked' THEN 'outstanding' ELSE status END, updated_at = ? WHERE id = ?`, newDue, now, s.id);
      run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`, s.id, req.user.id, s.status, s.status === 'not_checked' ? 'outstanding' : s.status, `Catch-up deadline ${fmt(newDue)}`, now);
      items.push({ title: s.title, due: newDue });
    }
    closeFollowups(`kind = 'catch_up' AND student_id = ?`, [id], `Plan proposed by ${req.user.first_name}`);
    createFollowup({ kind: 'check_in', ownerId: req.user.id, studentId: id, planId: pid, ruleKey: `checkin:${pid}`, nextAction: `Catch-up check-in with ${studentName(student)}`, dueAt: checkIn });
    return pid;
  });
  await msg.catchUpProposed(get('SELECT * FROM catchup_plans WHERE id = ?', planId), student, req.user, items);
  req.setFlash('ok', `Plan sent to ${student.first_name}. A check-in follow-up is in your queue.`);
  res.redirect(`/students/${id}`);
});

// ── Assignments & verification from Squad ─────────────────────────────────────────────
r.get('/assignments', (req, res) => {
  const at = new Date();
  const list = all(`SELECT a.*, c.name AS cohort FROM assignments a JOIN cohorts c ON c.id = a.cohort_id ORDER BY a.due_at DESC`);
  const subs = scopedSubmissions(req.user);
  res.send(page(req, {
    title: 'Assignments', active: '/assignments', body: html`
    <h1>Assignments & projects</h1><p class="sub">Open one to confirm submission and review status from Squad for ${req.user.role === 'lead' ? 'every student' : 'your students'}.</p>
    <div class="card"><table><tr><th>Item</th><th>Skill</th><th>Deadline</th><th>Submitted</th><th>To verify</th><th>Overdue</th></tr>
      ${list.map((a) => {
        const mine = subs.filter((s) => s.assignment_id === a.id);
        const submitted = mine.filter((s) => ['approved', 'awaiting_review', 'student_claimed'].includes(s.status)).length;
        return html`<tr><td><a href="/assignments/${a.id}">${a.title}</a> ${a.kind === 'project' ? html`<span class="tag">Project</span>` : ''} ${a.required ? '' : html`<span class="tag">Optional</span>`}<br><small>${a.cohort} · ${a.code}</small></td>
          <td>${a.skill}</td><td>${due(a.due_at, at)}</td><td>${bar(submitted, mine.length)}<small>${submitted}/${mine.length}</small></td>
          <td>${mine.filter((s) => s.d.needsConfirm || s.status === 'student_claimed').length || ''}</td><td>${mine.filter((s) => s.d.overdue).length || ''}</td></tr>`;
      })}</table></div>`,
  }));
});

r.get('/assignments/:id', (req, res) => {
  const a = get('SELECT * FROM assignments WHERE id = ?', Number(req.params.id));
  if (!a) return res.status(404).end();
  const at = new Date();
  const subs = scopedSubmissions(req.user).filter((s) => s.assignment_id === a.id);
  res.send(page(req, {
    title: a.title, active: '/assignments', body: html`
    <p><a href="/assignments">← Assignments</a></p>
    <h1>${a.title}</h1>
    <p class="sub">${a.kind === 'project' ? 'Project' : 'Assignment'} · ${a.skill} · Due ${fmt(a.due_at)} · Deliverables: ${a.deliverables || '—'} ${a.squad_url ? html`· <a href="${a.squad_url}" target="_blank" rel="noopener">Open in Squad ↗</a>` : ''}</p>
    <form class="card" method="post" action="/assignments/${a.id}/bulk">${csrf(req)}
      <div class="row" style="justify-content:space-between;margin-bottom:.75rem"><h2 style="margin:0">Confirm status from Squad</h2>
        <div class="row"><select name="status" style="width:auto">${['awaiting_review', 'outstanding', 'approved', 'not_checked'].map((s) => html`<option value="${s}">${SUBMISSION_STATUSES[s]}</option>`)}</select>
        <button class="btn sm">Apply to selected</button></div></div>
      <table><tr><th><input type="checkbox" onclick="document.querySelectorAll('.pick').forEach(c=>c.checked=this.checked)"></th><th>Student</th><th>Deadline</th><th>Status</th><th>Last checked</th></tr>
        ${subs.map((s) => html`<tr><td><input class="pick" type="checkbox" name="ids" value="${s.id}"></td>
          <td><a href="/progress/${s.id}">${s.first_name} ${s.last_name}</a>${s.student_note ? html`<br><small>“${s.student_note}”</small>` : ''}</td>
          <td>${fmt(s.d.due)}${s.due_override_at ? html`<br><small>${s.override_reason}</small>` : ''}</td><td>${pill(s.d.tone, s.d.staff)}</td>
          <td><small>${s.verified_at ? relative(s.verified_at, at) : 'never'}</small></td></tr>`)}</table>
      ${subs.length ? '' : empty('No students in scope.')}
    </form>`,
  }));
});

/** Apply a verified status change. Returns the previous row. */
function setStatus(subId, status, actor, note = null, source = 'tutor') {
  const s = get(`SELECT s.*, u.tutor_id FROM submissions s JOIN users u ON u.id = s.student_id WHERE s.id = ?`, subId);
  if (!s || !canSeeStudent(actor, s.student_id) || !(status in SUBMISSION_STATUSES)) return null;
  if (s.status === status) return s;
  const now = nowIso();
  run(`UPDATE submissions SET status = ?, verified_by = ?, verified_at = ?, status_source = ?, updated_at = ?,
       revision_items = CASE WHEN ? = 'revision_requested' THEN revision_items ELSE NULL END,
       due_override_at = CASE WHEN ? IN ('approved','awaiting_review') AND override_reason = 'resubmission' THEN NULL ELSE due_override_at END,
       override_reason = CASE WHEN ? IN ('approved','awaiting_review') AND override_reason = 'resubmission' THEN NULL ELSE override_reason END
       WHERE id = ?`, status, actor.id, now, source, now, status, status, status, s.id);
  run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`, s.id, actor.id, s.status, status, note, now);
  if (['awaiting_review', 'approved', 'outstanding'].includes(status)) {
    closeFollowups(`kind = 'verify' AND student_id = ? AND rule_key LIKE ?`, [s.student_id, `verify:${s.id}:%`], `Verified by ${actor.first_name}`);
  }
  return s;
}

r.post('/submissions/:id/status', async (req, res) => {
  const ok = setStatus(Number(req.params.id), String(req.body.status), req.user);
  if (!ok) return res.status(404).end();
  await runRules();
  req.setFlash('ok', `Marked “${SUBMISSION_STATUSES[req.body.status]}”.`);
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : `/progress/${req.params.id}`);
});

r.post('/assignments/:id/bulk', async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const status = String(req.body.status);
  let n = 0;
  tx(() => { for (const id of ids) if (setStatus(id, status, req.user)) n++; });
  await runRules();
  req.setFlash('ok', `Updated ${n} record${n === 1 ? '' : 's'} to “${SUBMISSION_STATUSES[status]}”. Notices were sent where a rule applies.`);
  res.redirect(`/assignments/${req.params.id}`);
});

function loadSub(id, user) {
  const s = get(`SELECT s.*, a.title, a.deliverables, a.due_at, u.first_name, u.last_name FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id WHERE s.id = ?`, id);
  return s && canSeeStudent(user, s.student_id) ? s : null;
}

r.post('/submissions/:id/revision', async (req, res) => {
  const s = loadSub(Number(req.params.id), req.user);
  const items = String(req.body.items || '').trim();
  const resubDue = fromLocalInput(req.body.due);
  if (!s || !items || !resubDue) { req.setFlash('error', 'List the missing deliverables and a resubmission deadline.'); return res.redirect(`/progress/${req.params.id}`); }
  const now = nowIso();
  run(`UPDATE submissions SET status = 'revision_requested', revision_items = ?, due_override_at = ?, override_reason = 'resubmission', verified_by = ?, verified_at = ?, status_source = 'tutor', updated_at = ? WHERE id = ?`,
    items, resubDue, req.user.id, now, now, s.id);
  run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, 'revision_requested', ?, ?)`, s.id, req.user.id, s.status, `Missing: ${items.replace(/\n/g, '; ')} · resubmit by ${fmt(resubDue)}`, now);
  closeFollowups(`kind = 'verify' AND rule_key LIKE ?`, [`verify:${s.id}:%`], `Reviewed by ${req.user.first_name}`);
  await msg.revisionRequested(s, items.replace(/\n/g, '; '), resubDue, `${req.user.first_name} ${req.user.last_name}`.trim());
  req.setFlash('ok', `Revision request sent to ${s.first_name}.`);
  res.redirect(`/progress/${s.id}`);
});

r.post('/submissions/:id/extension', async (req, res) => {
  const s = loadSub(Number(req.params.id), req.user);
  const newDue = fromLocalInput(req.body.due);
  if (!s || !newDue) { req.setFlash('error', 'Pick a new deadline.'); return res.redirect(`/progress/${req.params.id}`); }
  const now = nowIso();
  const note = String(req.body.note || '').trim();
  const reason = s.status === 'revision_requested' ? 'resubmission' : 'extension';
  run(`UPDATE submissions SET due_override_at = ?, override_reason = ?, updated_at = ? WHERE id = ?`, newDue, reason, now, s.id);
  run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`, s.id, req.user.id, s.status, s.status, `Extension to ${fmt(newDue)}${note ? ` — ${note}` : ''}`, now);
  await msg.extensionGranted(s, newDue, note);
  req.setFlash('ok', `Extension approved. Reminders now use ${fmt(newDue)}.`);
  res.redirect(`/progress/${s.id}`);
});

export { setStatus, effectiveDue };
export default r;
