import { Router } from 'express';
import { html, text } from '../html.js';
import { page, csrf, pill, due, ticketPill, empty } from '../views/layout.js';
import { get, all, run, nowIso } from '../db.js';
import { requireLogin, canSeeStudent, isStaff } from '../auth.js';
import { derive, studentNextStep, deliverablesPhrase, SUBMISSION_STATUSES } from '../status.js';
import { fmt } from '../time.js';
import { closeFollowups, createFollowup } from '../rules.js';
import { staffAlert } from '../messages.js';
import { addWorkingDays } from '../time.js';

const r = Router();
r.use(requireLogin);

export function submissionsFor(studentId) {
  return all(`
    SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.required, a.code
    FROM submissions s JOIN assignments a ON a.id = s.assignment_id
    WHERE s.student_id = ? ORDER BY COALESCE(s.due_override_at, a.due_at)`, studentId);
}

export function ticketsFor(studentId) {
  return all(`
    SELECT t.*, a.title AS assignment_title, u.first_name AS assignee_name
    FROM tickets t LEFT JOIN assignments a ON a.id = t.assignment_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.student_id = ? ORDER BY t.status = 'resolved', t.created_at DESC`, studentId);
}

export function plansFor(studentId) {
  return all(`SELECT p.*, u.first_name AS tutor_first, u.last_name AS tutor_last FROM catchup_plans p JOIN users u ON u.id = p.tutor_id
    WHERE p.student_id = ? ORDER BY p.created_at DESC`, studentId);
}

function itemRow(s, at, { staffView = false } = {}) {
  const d = derive(s, at);
  return html`<div class="item">
    <div>
      <div class="t"><a href="/progress/${s.id}">${s.title}</a> ${s.kind === 'project' ? html`<span class="tag">Project</span>` : ''} ${s.required ? '' : html`<span class="tag">Optional</span>`}</div>
      <div class="m">Due ${due(d.due, at)}${s.override_reason ? html` · <b>${s.override_reason === 'resubmission' ? 'resubmission deadline' : 'extended'}</b>` : ''} · ${deliverablesPhrase(s.deliverables)}</div>
    </div>
    <div>${pill(d.tone, staffView ? d.staff : d.label)}</div>
  </div>`;
}

r.get('/progress', (req, res) => {
  if (req.user.role !== 'student') return res.redirect('/');
  const at = new Date();
  const subs = submissionsFor(req.user.id).filter((s) => s.required);
  const groups = { action: [], upcoming: [], waiting: [], done: [] };
  for (const s of subs) {
    const d = derive(s, at);
    if (d.done) groups.done.push(s);
    else if (['awaiting_review', 'student_claimed'].includes(s.status)) groups.waiting.push(s);
    else if (d.overdue || d.needsConfirm || d.soon || s.status === 'revision_requested') groups.action.push(s);
    else groups.upcoming.push(s);
  }
  const tickets = ticketsFor(req.user.id);
  const openTickets = tickets.filter((t) => t.status !== 'resolved');
  const plans = plansFor(req.user.id).filter((p) => p.status !== 'completed');
  const tutor = req.user.tutor_id ? get('SELECT first_name, last_name FROM users WHERE id = ?', req.user.tutor_id) : null;
  const doneCount = groups.done.length + groups.waiting.length;

  res.send(page(req, {
    title: 'My Progress', active: '/progress', body: html`
    <h1>Hi ${req.user.first_name}</h1>
    <p class="sub">Your required weekly assignments and projects. Submit everything in Squad — this page shows what’s still owed and what to do next.${tutor ? html` Your tutor is <b>${tutor.first_name} ${tutor.last_name}</b>.` : ''}</p>

    <div class="sbs">
      <div><h3>Submission status</h3>
        <div class="row">${pill(groups.action.some((s) => derive(s, at).overdue) ? 'bad' : groups.action.length ? 'warn' : 'good', groups.action.length ? `${groups.action.length} need${groups.action.length === 1 ? 's' : ''} your attention` : 'Nothing needs attention')}
        <span class="muted">${doneCount} of ${subs.length} submitted</span></div></div>
      <div><h3>Support status</h3>
        <div class="row">${openTickets.length ? openTickets.slice(0, 3).map((t) => html`<a href="/support/${t.id}">#${t.id} ${t.skill}</a> ${ticketPill(t)}`) : html`<span class="muted">No open tickets.</span>`}
        <a class="btn sm ghost" href="/support/new">Report a blocker</a></div></div>
    </div>

    ${plans.map((p) => html`<div class="card" style="border-color:#c7d2fe">
      <h2>Catch-up plan from ${p.tutor_first} ${pill(p.status === 'agreed' ? 'good' : 'info', p.status === 'agreed' ? 'Agreed' : 'Proposed — please review')}</h2>
      <p>${text(p.plan)}</p><p class="muted">Check-in: ${fmt(p.check_in_at)}</p>
      <a class="btn sm" href="/plans/${p.id}">${p.status === 'proposed' ? 'Review and agree' : 'View plan'}</a></div>`)}

    <div class="split">
      <div>
        <div class="card"><h2>Needs your attention</h2>${groups.action.length ? groups.action.map((s) => itemRow(s, at)) : empty('You’re all caught up.')}</div>
        <div class="card"><h2>Coming up</h2>${groups.upcoming.length ? groups.upcoming.map((s) => itemRow(s, at)) : empty('Nothing else scheduled yet.')}</div>
      </div>
      <div>
        <div class="card"><h2>With your tutor</h2>${groups.waiting.length ? groups.waiting.map((s) => itemRow(s, at)) : empty('Nothing waiting for review.')}</div>
        <div class="card"><h2>Approved</h2>${groups.done.length ? groups.done.map((s) => itemRow(s, at)) : empty('Nothing approved yet.')}</div>
      </div>
    </div>`,
  }));
});

/** The assignment record: what’s missing and what to do next. Notifications link here. */
r.get('/progress/:id', (req, res) => {
  const s = get(`SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.required, a.id AS assignment_id
    FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?`, Number(req.params.id));
  if (!s || !canSeeStudent(req.user, s.student_id)) return res.status(404).send(page(req, { title: 'Not found', body: html`<h1>Not found</h1>` }));
  const at = new Date();
  const d = derive(s, at);
  const student = get('SELECT * FROM users WHERE id = ?', s.student_id);
  const events = all(`SELECT e.*, u.first_name FROM submission_events e LEFT JOIN users u ON u.id = e.actor_id WHERE submission_id = ? ORDER BY e.created_at DESC`, s.id);
  const notices = all(`SELECT * FROM notifications WHERE user_id = ? AND link = ? ORDER BY created_at DESC`, s.student_id, `/progress/${s.id}`);
  const tickets = all(`SELECT * FROM tickets WHERE student_id = ? AND assignment_id = ? ORDER BY created_at DESC`, s.student_id, s.assignment_id);
  const isOwner = req.user.id === s.student_id;
  const canClaim = isOwner && ['not_checked', 'outstanding', 'revision_requested'].includes(s.status) && (d.past || s.status === 'outstanding');

  res.send(page(req, {
    title: s.title, active: isOwner ? '/progress' : '/students', body: html`
    <p><a href="${isOwner ? '/progress' : `/students/${s.student_id}`}">← ${isOwner ? 'My Progress' : `${student.first_name} ${student.last_name}`}</a></p>
    <h1>${s.title}</h1>
    <p class="sub">${s.kind === 'project' ? 'Required project' : 'Required assignment'}${s.week ? ` · Week ${s.week}` : ''}${s.skill ? ` · ${s.skill}` : ''}</p>

    <div class="sbs">
      <div><h3>Submission status</h3>${pill(d.tone, isOwner ? d.label : d.staff)}
        <p class="muted" style="margin:.5rem 0 0">Deadline used for reminders: <b>${fmt(d.due)}</b>${s.due_override_at ? html`<br>Original deadline: ${fmt(s.due_at)} (${s.override_reason})` : ''}</p></div>
      <div><h3>Support status</h3>${tickets.length ? tickets.map((t) => html`<div><a href="/support/${t.id}">#${t.id} ${t.skill}</a> ${ticketPill(t)}</div>`) : html`<span class="muted">No tickets linked to this assignment.</span>`}</div>
    </div>

    <div class="next ${d.tone}"><b>What to do next</b>${isOwner ? studentNextStep(s, d) : staffNext(s, d)}</div>

    ${s.status === 'revision_requested' && s.revision_items ? html`<div class="card"><h2>Still missing</h2><ul>${s.revision_items.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => html`<li>${x}</li>`)}</ul></div>` : ''}

    <div class="card">
      <div class="row">
        ${s.squad_url ? html`<a class="btn" href="${s.squad_url}" target="_blank" rel="noopener">Open in Squad ↗</a>` : ''}
        ${canClaim ? html`<form method="post" action="/progress/${s.id}/claim" class="inline">${csrf(req)}<input type="hidden" name="note" value=""><button class="btn ghost">I already submitted</button></form>` : ''}
        ${isOwner && !d.done ? html`<a class="btn ghost" href="/support/new?assignment=${s.assignment_id}">Report a blocker</a>` : ''}
      </div>
      <p class="muted" style="margin-bottom:0">Required: ${deliverablesPhrase(s.deliverables)}. Submit once, in Squad’s Project Lab.</p>
      ${s.student_note ? html`<p class="muted">Your note: “${s.student_note}”</p>` : ''}
    </div>

    ${isStaff(req.user) ? staffControls(req, s) : ''}

    <div class="grid g2">
      <div class="card"><h2>History</h2>${events.length ? html`<table>${events.map((e) => html`<tr><td>${fmt(e.created_at)}</td><td>${e.first_name || 'System'}: ${SUBMISSION_STATUSES[e.to_status] || e.to_status}${e.note ? html`<br><small>${e.note}</small>` : ''}</td></tr>`)}</table>` : empty('No changes recorded yet.')}</div>
      <div class="card"><h2>Notices sent</h2>${notices.length ? html`<table>${notices.map((n) => html`<tr><td>${fmt(n.created_at)}</td><td>${n.title}<br><small>Portal ✓ · Email: ${n.email_status || 'pending'}${n.emailed_at ? ` at ${fmt(n.emailed_at)}` : ''}</small></td></tr>`)}</table>` : empty('No notices sent for this item.')}</div>
    </div>`,
  }));
});

function staffNext(s, d) {
  if (s.status === 'student_claimed') return 'The student says they submitted. Check Squad and mark it Awaiting review, or No submission.';
  if (d.needsConfirm) return 'Deadline passed and nobody has checked Squad. Verify the submission so the right notice goes out.';
  if (s.status === 'awaiting_review') return 'Review the submission in Squad, then approve it or request a revision.';
  if (d.overdue) return 'Confirmed overdue. The student has been sent an overdue notice. Consider an extension or a catch-up plan.';
  if (d.done) return 'Approved. No action needed.';
  return 'Not due yet. The student gets a reminder 24 hours before the deadline.';
}

function staffControls(req, s) {
  return html`<div class="card"><h2>Update from Squad</h2>
    <div class="row">
      ${[['awaiting_review', 'Submitted — awaiting review'], ['outstanding', 'No submission'], ['approved', 'Approve']].map(([st, label]) =>
        html`<form method="post" action="/submissions/${s.id}/status" class="inline">${csrf(req)}<input type="hidden" name="status" value="${st}"><input type="hidden" name="back" value="/progress/${s.id}"><button class="btn sm ${st === 'outstanding' ? 'ghost' : st === 'approved' ? 'good' : ''}" ${s.status === st ? 'disabled' : ''}>${label}</button></form>`)}
    </div>
    <div class="grid g2" style="margin-top:1rem">
      <form method="post" action="/submissions/${s.id}/revision" class="stack">${csrf(req)}<h3>Request a revision</h3>
        <label>Deliverables still missing <small>(one per line)</small><textarea name="items" required placeholder="README with setup steps&#10;Query for question 4"></textarea></label>
        <label>Resubmission deadline (EAT)<input type="datetime-local" name="due" required></label>
        <div class="form-actions"><button class="btn sm warn">Send revision request</button></div></form>
      <form method="post" action="/submissions/${s.id}/extension" class="stack">${csrf(req)}<h3>Approve an extension</h3>
        <label>New deadline (EAT)<input type="datetime-local" name="due" required></label>
        <label>Note to student <small>(optional)</small><input type="text" name="note"></label>
        <div class="form-actions"><button class="btn sm ghost">Approve extension</button></div></form>
    </div></div>`;
}

r.post('/progress/:id/claim', async (req, res) => {
  const s = get(`SELECT s.*, a.title, a.cohort_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?`, Number(req.params.id));
  if (!s || s.student_id !== req.user.id) return res.status(404).end();
  if (['not_checked', 'outstanding', 'revision_requested'].includes(s.status)) {
    const now = nowIso();
    run(`UPDATE submissions SET status = 'student_claimed', student_note = ?, status_source = 'student', updated_at = ? WHERE id = ?`, String(req.body.note || '').slice(0, 500) || null, now, s.id);
    run(`INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, 'student_claimed', 'Student selected “I already submitted”', ?)`, s.id, req.user.id, s.status, now);
    if (req.user.tutor_id) {
      createFollowup({
        kind: 'verify', ownerId: req.user.tutor_id, studentId: req.user.id, ruleKey: `verify:${s.id}:${now}`,
        nextAction: `${req.user.first_name} says they submitted ${s.title}. Check Squad and update the status.`,
        dueAt: addWorkingDays(new Date(), 1),
      });
      await staffAlert(req.user.tutor_id, { title: `Please verify: ${s.title}`, body: `${req.user.first_name} ${req.user.last_name} selected “I already submitted”.`, link: `/progress/${s.id}` });
    }
  }
  req.setFlash('ok', 'Thanks — your tutor will check Squad and update your record.');
  res.redirect(`/progress/${s.id}`);
});

r.get('/plans/:id', (req, res) => {
  const p = get(`SELECT p.*, u.first_name AS tutor_first, u.last_name AS tutor_last FROM catchup_plans p JOIN users u ON u.id = p.tutor_id WHERE p.id = ?`, Number(req.params.id));
  if (!p || !canSeeStudent(req.user, p.student_id)) return res.status(404).send(page(req, { title: 'Not found', body: html`<h1>Not found</h1>` }));
  const isOwner = req.user.id === p.student_id;
  res.send(page(req, {
    title: 'Catch-up plan', active: isOwner ? '/progress' : '/students', body: html`
    <p><a href="${isOwner ? '/progress' : `/students/${p.student_id}`}">← Back</a></p>
    <h1>Catch-up plan ${pill(p.status === 'completed' ? 'good' : p.status === 'agreed' ? 'good' : 'info', p.status[0].toUpperCase() + p.status.slice(1))}</h1>
    <p class="sub">Proposed by ${p.tutor_first} ${p.tutor_last} on ${fmt(p.created_at)}</p>
    <div class="card"><p>${text(p.plan)}</p><p><b>Check-in:</b> ${fmt(p.check_in_at)}</p>
      ${p.agreed_at ? html`<p class="muted">Agreed ${fmt(p.agreed_at)}</p>` : ''}
      ${isOwner && p.status === 'proposed' ? html`<div class="row"><form method="post" action="/plans/${p.id}/agree" class="inline">${csrf(req)}<button class="btn good">Agree to this plan</button></form>
        <a class="btn ghost" href="/support/new">Something needs to change</a></div>` : ''}
      ${!isOwner && p.status !== 'completed' ? html`<form method="post" action="/plans/${p.id}/complete" class="inline">${csrf(req)}<button class="btn ghost">Mark check-in done / plan complete</button></form>` : ''}
    </div>`,
  }));
});

r.post('/plans/:id/agree', async (req, res) => {
  const p = get('SELECT * FROM catchup_plans WHERE id = ?', Number(req.params.id));
  if (!p || p.student_id !== req.user.id) return res.status(404).end();
  if (p.status === 'proposed') {
    run(`UPDATE catchup_plans SET status = 'agreed', agreed_at = ? WHERE id = ?`, nowIso(), p.id);
    await staffAlert(p.tutor_id, { title: `${req.user.first_name} agreed to the catch-up plan`, body: `Check-in on ${fmt(p.check_in_at)}.`, link: `/plans/${p.id}` });
  }
  req.setFlash('ok', 'Plan agreed. Your tutor has been notified.');
  res.redirect('/progress');
});

r.post('/plans/:id/complete', (req, res) => {
  const p = get('SELECT * FROM catchup_plans WHERE id = ?', Number(req.params.id));
  if (!p || !isStaff(req.user) || !canSeeStudent(req.user, p.student_id)) return res.status(404).end();
  run(`UPDATE catchup_plans SET status = 'completed', completed_at = ? WHERE id = ?`, nowIso(), p.id);
  closeFollowups('plan_id = ?', [p.id], 'Plan completed');
  req.setFlash('ok', 'Plan marked complete.');
  res.redirect(`/students/${p.student_id}`);
});

export default r;
