import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { html, text } from '../html.js';
import { page, csrf, pill, ticketPill, empty } from '../views/layout.js';
import { get, all, run, nowIso, leadsFor } from '../db.js';
import { requireLogin, canSeeTicket, isStaff, checkCsrf } from '../auth.js';
import { DEFAULT_SKILLS, TICKET_STATUSES } from '../status.js';
import { fmt, relative, addWorkingDays } from '../time.js';
import { closeFollowups, createFollowup, studentName } from '../rules.js';
import * as msg from '../messages.js';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)),
});

const r = Router();
r.use(requireLogin);

function skillsFor(cohortId) {
  const fromAssignments = all(`SELECT DISTINCT skill FROM assignments WHERE cohort_id = ? AND skill != ''`, cohortId).map((x) => x.skill);
  return [...new Set([...DEFAULT_SKILLS.filter((s) => s !== 'Other'), ...fromAssignments, 'Other'])];
}

function visibleTickets(user, { status } = {}) {
  const where = [];
  const params = [];
  if (user.role === 'student') { where.push('t.student_id = ?'); params.push(user.id); }
  if (user.role === 'tutor') { where.push('(t.assignee_id = ? OR s.tutor_id = ?)'); params.push(user.id, user.id); }
  if (status === 'open') where.push(`t.status != 'resolved'`);
  if (status && status !== 'open' && status !== 'all') { where.push('t.status = ?'); params.push(status); }
  return all(`
    SELECT t.*, s.first_name, s.last_name, a.title AS assignment_title, au.first_name AS assignee_name
    FROM tickets t JOIN users s ON s.id = t.student_id LEFT JOIN assignments a ON a.id = t.assignment_id LEFT JOIN users au ON au.id = t.assignee_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.status = 'resolved', t.status = 'awaiting_student', t.awaiting_since`, ...params);
}

r.get('/support', (req, res) => {
  const status = String(req.query.status || 'open');
  const list = visibleTickets(req.user, { status });
  const staff = isStaff(req.user);
  const at = new Date();
  res.send(page(req, {
    title: 'Technical Support', active: '/support', body: html`
    <div class="row" style="justify-content:space-between"><div><h1>${staff ? 'Support tickets' : 'Technical Support'}</h1>
      <p class="sub">${staff ? 'Tickets for your students and tickets assigned to you.' : 'Stuck on something technical? Tell us what you were trying to do and what happened. Your tutor will reply within one working day.'}</p></div>
      ${!staff ? html`<a class="btn" href="/support/new">Report a blocker</a>` : ''}</div>
    <div class="row" style="margin-bottom:1rem">${['open', 'awaiting_tutor', 'awaiting_student', 'resolved', 'all'].map((s) => html`<a class="btn sm ${status === s ? '' : 'ghost'}" href="?status=${s}">${s === 'open' ? 'Open' : s === 'all' ? 'All' : TICKET_STATUSES[s]}</a>`)}</div>
    <div class="card">${list.length ? html`<table><tr><th>#</th>${staff ? html`<th>Student</th>` : ''}<th>Skill</th><th>Trying to</th><th>Assignment</th><th>Status</th><th>Waiting</th></tr>
      ${list.map((t) => html`<tr><td><a href="/support/${t.id}">#${t.id}</a></td>${staff ? html`<td>${t.first_name} ${t.last_name}</td>` : ''}
        <td>${t.skill}${t.issue_id ? html` <a class="tag" href="/issues/${t.issue_id}">recurring</a>` : ''}</td>
        <td><a href="/support/${t.id}">${t.trying_to_do.slice(0, 80)}${t.trying_to_do.length > 80 ? '…' : ''}</a></td>
        <td>${t.assignment_title || html`<span class="muted">—</span>`}</td><td>${ticketPill(t)}</td>
        <td>${t.status === 'resolved' ? '' : relative(t.awaiting_since, at).replace(' ago', '')}</td></tr>`)}</table>` : empty('No tickets here.')}</div>`,
  }));
});

r.get('/support/new', (req, res) => {
  if (req.user.role !== 'student') return res.redirect('/support');
  const assignments = all(`SELECT a.id, a.title FROM assignments a WHERE a.cohort_id = ? ORDER BY a.due_at DESC`, req.user.cohort_id);
  const pre = Number(req.query.assignment) || null;
  const preSkill = pre ? get('SELECT skill FROM assignments WHERE id = ?', pre)?.skill : '';
  res.send(page(req, {
    title: 'Report a blocker', active: '/support', body: html`
    <p><a href="/support">← Technical Support</a></p>
    <h1>Report a blocker</h1><p class="sub">The more specific you are, the faster your tutor can help. Only you and the staff supporting you can see this.</p>
    <form class="card stack" method="post" action="/support" enctype="multipart/form-data" style="max-width:760px">
      ${csrf(req)}
      <label>Which skill is this about?<select name="skill" required>${skillsFor(req.user.cohort_id).map((s) => html`<option ${s === preSkill ? 'selected' : ''}>${s}</option>`)}</select></label>
      <label>Affected assignment <small>(if there is one)</small><select name="assignment_id"><option value="">None / not sure</option>${assignments.map((a) => html`<option value="${a.id}" ${a.id === pre ? 'selected' : ''}>${a.title}</option>`)}</select></label>
      <label>What were you trying to do?<textarea name="trying_to_do" required placeholder="e.g. Import the sales CSV into PostgreSQL with \\copy"></textarea></label>
      <label>Paste the error message <small>(exactly as shown)</small><textarea name="error_text" class="code" placeholder="ERROR:  invalid input syntax for type date: &quot;31/01/2024&quot;"></textarea></label>
      <label>Screenshot <small>(optional — PNG/JPG, max 5 MB)</small><input type="file" name="screenshot" accept="image/*"></label>
      <label>What have you tried so far?<textarea name="tried" required placeholder="e.g. Changed DateStyle, re-saved the CSV as UTF-8…"></textarea></label>
      <div class="form-actions"><button class="btn">Send to my tutor</button><a class="btn ghost" href="/support">Cancel</a></div>
    </form>`,
  }));
});

r.post('/support', upload.single('screenshot'), checkCsrf, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).end();
  const b = req.body;
  const tryingTo = String(b.trying_to_do || '').trim();
  if (!tryingTo || !String(b.tried || '').trim()) {
    req.setFlash('error', 'Please describe what you were trying to do and what you tried.');
    return res.redirect('/support/new');
  }
  const assignmentId = Number(b.assignment_id) || null;
  if (assignmentId && !get('SELECT 1 FROM assignments WHERE id = ? AND cohort_id = ?', assignmentId, req.user.cohort_id)) return res.status(400).end();
  const now = nowIso();
  const assignee = req.user.tutor_id || leadsFor(req.user.cohort_id)[0]?.id || null;
  const result = run(
    `INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, error_text, tried, screenshot, assignment_id, assignee_id, created_at, awaiting_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, req.user.cohort_id, String(b.skill || 'Other').slice(0, 80), tryingTo, String(b.error_text || ''), String(b.tried || ''),
    req.file ? req.file.filename : null, assignmentId, assignee, now, now,
  );
  const id = Number(result.lastInsertRowid);
  if (assignee) {
    await msg.staffAlert(assignee, { title: `New ticket #${id}: ${b.skill}`, body: `${req.user.first_name} ${req.user.last_name}: ${tryingTo.slice(0, 160)}`, link: `/support/${id}` });
  }
  req.setFlash('ok', 'Sent. Your tutor will reply within one working day — you’ll get an email and a notification here.');
  res.redirect(`/support/${id}`);
});

function loadTicket(id) {
  return get(`SELECT t.*, s.first_name, s.last_name, s.email, s.tutor_id, a.title AS assignment_title, a.id AS a_id
    FROM tickets t JOIN users s ON s.id = t.student_id LEFT JOIN assignments a ON a.id = t.assignment_id WHERE t.id = ?`, id);
}

r.get('/support/:id', (req, res) => {
  const t = loadTicket(Number(req.params.id));
  if (!t || !canSeeTicket(req.user, t)) return res.status(404).send(page(req, { title: 'Not found', body: html`<h1>Not found</h1>` }));
  const messages = all(`SELECT m.*, u.first_name, u.last_name, u.role FROM ticket_messages m JOIN users u ON u.id = m.author_id WHERE ticket_id = ? ORDER BY m.created_at`, t.id);
  const issue = t.issue_id ? get('SELECT * FROM issues WHERE id = ?', t.issue_id) : null;
  const assignee = t.assignee_id ? get('SELECT * FROM users WHERE id = ?', t.assignee_id) : null;
  const sub = t.a_id ? get(`SELECT s.id, s.status, s.due_override_at, a.due_at FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.assignment_id = ? AND s.student_id = ?`, t.a_id, t.student_id) : null;
  const staff = isStaff(req.user);
  const isOwner = req.user.id === t.student_id;
  const tutors = staff && req.user.role === 'lead' ? all(`SELECT * FROM users WHERE role IN ('tutor','lead') AND active = 1 ORDER BY first_name`) : [];

  res.send(page(req, {
    title: `Ticket #${t.id}`, active: '/support', body: html`
    <p><a href="/support">← Tickets</a></p>
    <h1>#${t.id} · ${t.skill} ${ticketPill(t)}</h1>
    <p class="sub">${staff ? html`<a href="/students/${t.student_id}">${t.first_name} ${t.last_name}</a> · ` : ''}Opened ${fmt(t.created_at)} · Handled by ${assignee ? `${assignee.first_name} ${assignee.last_name}` : 'unassigned'}${t.escalated_at ? html` · <b style="color:var(--bad)">flagged to cohort lead ${fmt(t.escalated_at)}</b>` : ''}</p>

    <div class="sbs">
      <div><h3>Support status</h3>${ticketPill(t)} <span class="muted">${t.status === 'awaiting_tutor' ? `waiting ${relative(t.awaiting_since).replace(' ago', '')}` : ''}</span></div>
      <div><h3>Submission status</h3>${t.assignment_title ? html`<a href="/progress/${sub?.id}">${t.assignment_title}</a>` : html`<span class="muted">Not linked to an assignment.</span>`}</div>
    </div>

    ${issue ? html`<div class="card" style="border-color:#fde68a;background:#fffbeb"><h2>Part of a recurring issue</h2>
      <p>Several students reported the same <b>${issue.skill}</b> problem. ${issue.status === 'open' ? 'A tutor is preparing a fix or walkthrough.' : ''}</p>
      ${issue.fix_text ? html`<div class="next info"><b>Shared fix · ${fmt(issue.fix_shared_at)}</b>${text(issue.fix_text)}</div>` : ''}
      ${isOwner && issue.fix_text && t.status !== 'resolved' ? html`<p><b>Can you continue now?</b></p><div class="row">
        <form method="post" action="/support/${t.id}/proceed" class="inline">${csrf(req)}<input type="hidden" name="answer" value="yes"><button class="btn good">Yes, I’m unblocked</button></form>
        <form method="post" action="/support/${t.id}/proceed" class="inline">${csrf(req)}<input type="hidden" name="answer" value="no"><button class="btn ghost">No, still stuck</button></form></div>` : ''}
      ${t.can_proceed ? html`<p class="muted">Student answered: ${t.can_proceed === 'yes' ? 'can proceed' : 'still blocked'}</p>` : ''}
      ${staff ? html`<a href="/issues/${issue.id}">Open the issue →</a>` : ''}</div>` : ''}

    <div class="thread">
      <div class="msg"><div class="meta">${t.first_name} ${t.last_name} · ${fmt(t.created_at)}</div>
        <h3>What I was trying to do</h3><p>${text(t.trying_to_do)}</p>
        ${t.error_text ? html`<h3>Error</h3><pre class="err">${t.error_text}</pre>` : ''}
        ${t.screenshot ? html`<h3>Screenshot</h3><a href="/uploads/${t.screenshot}" target="_blank"><img class="shot" src="/uploads/${t.screenshot}" alt="Screenshot attached by student"></a>` : ''}
        <h3>What I tried</h3><p>${text(t.tried)}</p></div>
      ${messages.map((m) => html`<div class="msg ${m.role !== 'student' ? 'staff' : ''}"><div class="meta">${m.first_name} ${m.last_name}${m.role !== 'student' ? ' (staff)' : ''} · ${fmt(m.created_at)}</div>${text(m.body)}</div>`)}
    </div>

    ${t.status !== 'resolved' ? html`<form class="card stack" method="post" action="/support/${t.id}/reply">${csrf(req)}
      <label>${staff ? 'Reply to student' : 'Add a reply'}<textarea name="body" required></textarea></label>
      <div class="form-actions"><button class="btn">Send reply</button></div></form>
      <form method="post" action="/support/${t.id}/resolve" class="inline">${csrf(req)}<button class="btn ghost">${isOwner ? 'My issue is solved — close ticket' : 'Mark resolved'}</button></form>`
      : html`<p class="muted">Resolved ${fmt(t.resolved_at)}. ${isOwner ? html`Still stuck? <a href="/support/new">Open a new ticket</a>.` : ''}</p>`}

    ${tutors.length ? html`<form method="post" action="/support/${t.id}/assign" class="card stack" style="margin-top:1.25rem">${csrf(req)}<h3>Reassign (cohort lead)</h3>
      <div class="row"><select name="assignee_id" style="max-width:300px">${tutors.map((u) => html`<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${u.first_name} ${u.last_name} (${u.role})</option>`)}</select><button class="btn sm">Reassign</button></div></form>` : ''}`,
  }));
});

r.post('/support/:id/reply', async (req, res) => {
  const t = loadTicket(Number(req.params.id));
  if (!t || !canSeeTicket(req.user, t)) return res.status(404).end();
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect(`/support/${t.id}`);
  const now = nowIso();
  run('INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', t.id, req.user.id, body, now);
  if (isStaff(req.user)) {
    run(`UPDATE tickets SET status = 'awaiting_student', first_reply_at = COALESCE(first_reply_at, ?), awaiting_since = ? WHERE id = ?`, now, now, t.id);
    closeFollowups(`kind = 'ticket_sla' AND ticket_id = ?`, [t.id], `${req.user.first_name} replied`);
    await msg.ticketReply(t, req.user, t.student_id);
  } else {
    run(`UPDATE tickets SET status = 'awaiting_tutor', awaiting_since = ?, escalated_at = NULL WHERE id = ?`, now, t.id);
    if (t.assignee_id) await msg.staffAlert(t.assignee_id, { title: `Student replied on ticket #${t.id}`, body: body.slice(0, 160), link: `/support/${t.id}` });
  }
  res.redirect(`/support/${t.id}`);
});

r.post('/support/:id/resolve', (req, res) => {
  const t = loadTicket(Number(req.params.id));
  if (!t || !canSeeTicket(req.user, t)) return res.status(404).end();
  run(`UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?`, nowIso(), t.id);
  closeFollowups(`kind = 'ticket_sla' AND ticket_id = ?`, [t.id], 'Ticket resolved');
  maybeCloseProceedCheck(t.issue_id);
  req.setFlash('ok', 'Ticket closed.');
  res.redirect(`/support/${t.id}`);
});

r.post('/support/:id/proceed', async (req, res) => {
  const t = loadTicket(Number(req.params.id));
  if (!t || t.student_id !== req.user.id || !t.issue_id) return res.status(404).end();
  const now = nowIso();
  if (req.body.answer === 'yes') {
    run(`UPDATE tickets SET can_proceed = 'yes', status = 'resolved', resolved_at = ? WHERE id = ?`, now, t.id);
    req.setFlash('ok', 'Great — ticket closed. Keep going!');
  } else {
    run(`UPDATE tickets SET can_proceed = 'no', status = 'awaiting_tutor', awaiting_since = ? WHERE id = ?`, now, t.id);
    run('INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', t.id, req.user.id, 'The shared fix didn’t unblock me — I’m still stuck.', now);
    if (t.assignee_id) await msg.staffAlert(t.assignee_id, { title: `Still blocked after shared fix: #${t.id}`, body: `${t.first_name} ${t.last_name} can’t proceed yet.`, link: `/support/${t.id}` });
    req.setFlash('ok', 'Thanks — your tutor will follow up with you directly.');
  }
  maybeCloseProceedCheck(t.issue_id);
  res.redirect(`/support/${t.id}`);
});

function maybeCloseProceedCheck(issueId) {
  if (!issueId) return;
  const pending = get(`SELECT COUNT(*) AS n FROM tickets WHERE issue_id = ? AND status != 'resolved' AND can_proceed IS NULL`, issueId).n;
  if (pending === 0) closeFollowups(`kind = 'proceed_check' AND issue_id = ?`, [issueId], 'All affected students answered');
}

r.post('/support/:id/assign', async (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).end();
  const t = loadTicket(Number(req.params.id));
  const to = get(`SELECT * FROM users WHERE id = ? AND role IN ('tutor','lead')`, Number(req.body.assignee_id));
  if (!t || !to) return res.status(404).end();
  run('UPDATE tickets SET assignee_id = ? WHERE id = ?', to.id, t.id);
  closeFollowups(`kind = 'ticket_sla' AND ticket_id = ?`, [t.id], `Reassigned to ${to.first_name}`);
  await msg.staffAlert(to.id, { title: `Ticket #${t.id} reassigned to you`, body: `${t.skill} — ${t.first_name} ${t.last_name} has been waiting since ${fmt(t.awaiting_since)}.`, link: `/support/${t.id}` });
  req.setFlash('ok', `Reassigned to ${to.first_name}.`);
  res.redirect(`/support/${t.id}`);
});

// ── Recurring issues ──────────────────────────────────────────────────────────────────
r.get('/issues/:id', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).end();
  const issue = get(`SELECT i.*, u.first_name AS owner_first FROM issues i LEFT JOIN users u ON u.id = i.owner_id WHERE i.id = ?`, Number(req.params.id));
  if (!issue) return res.status(404).end();
  const tickets = all(`SELECT t.*, s.first_name, s.last_name, s.tutor_id FROM tickets t JOIN users s ON s.id = t.student_id WHERE t.issue_id = ? ORDER BY t.created_at`, issue.id)
    .filter((t) => canSeeTicket(req.user, t) || issue.owner_id === req.user.id);
  const answered = tickets.filter((t) => t.can_proceed);
  res.send(page(req, {
    title: `Issue: ${issue.skill}`, active: '/support', body: html`
    <p><a href="/queue">← Queue</a></p>
    <h1>${issue.title} ${pill(issue.status === 'resolved' ? 'good' : issue.status === 'fix_shared' ? 'info' : 'warn', { open: 'Needs a fix', fix_shared: 'Fix shared', resolved: 'Resolved' }[issue.status])}</h1>
    <p class="sub">Owner: ${issue.owner_first || '—'} · Detected ${fmt(issue.created_at)}</p>
    <div class="split">
      <div class="card"><h2>Affected students (${tickets.length})</h2><table><tr><th>Ticket</th><th>Student</th><th>Status</th><th>Can proceed?</th></tr>
        ${tickets.map((t) => html`<tr><td><a href="/support/${t.id}">#${t.id}</a></td><td>${t.first_name} ${t.last_name}</td><td>${ticketPill(t)}</td>
          <td>${t.can_proceed === 'yes' ? pill('good', 'Yes') : t.can_proceed === 'no' ? pill('bad', 'Still blocked') : issue.fix_text ? pill('neutral', 'Not answered') : '—'}</td></tr>`)}</table>
        ${issue.fix_text ? html`<p class="muted">${answered.length} of ${tickets.length} have answered.</p>` : ''}</div>
      <div>
        ${issue.status !== 'resolved' ? html`<form class="card stack" method="post" action="/issues/${issue.id}/fix">${csrf(req)}
          <h2>${issue.fix_text ? 'Update the shared fix' : 'Share a fix or walkthrough'}</h2>
          <p class="muted">Every affected student gets it by email and in the portal, with a “Can you proceed?” check.</p>
          <label>Fix / walkthrough details<textarea name="fix_text" required rows="8" placeholder="Steps, a snippet, or the walkthrough time and link">${issue.fix_text || ''}</textarea></label>
          <div class="form-actions"><button class="btn">Send to ${tickets.filter((t) => t.status !== 'resolved').length} students</button></div></form>
          <form method="post" action="/issues/${issue.id}/resolve" class="inline">${csrf(req)}<button class="btn ghost">Close issue</button></form>`
          : html`<div class="card"><h2>Shared fix</h2><p>${text(issue.fix_text || '—')}</p></div>`}
      </div>
    </div>`,
  }));
});

r.post('/issues/:id/fix', async (req, res) => {
  if (!isStaff(req.user)) return res.status(403).end();
  const fix = String(req.body.fix_text || '').trim();
  const issue = get('SELECT * FROM issues WHERE id = ?', Number(req.params.id));
  if (!issue || !fix) return res.status(400).end();
  const now = nowIso();
  run(`UPDATE issues SET status = 'fix_shared', fix_text = ?, fix_shared_at = ? WHERE id = ?`, fix, now, issue.id);
  const updated = get('SELECT * FROM issues WHERE id = ?', issue.id);
  const tickets = all(`SELECT * FROM tickets WHERE issue_id = ? AND status != 'resolved'`, issue.id);
  for (const t of tickets) {
    run(`UPDATE tickets SET status = 'awaiting_student', first_reply_at = COALESCE(first_reply_at, ?), awaiting_since = ?, can_proceed = NULL WHERE id = ?`, now, now, t.id);
    run('INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', t.id, req.user.id, `Shared fix for everyone affected:\n\n${fix}`, now);
    // Use a fresh dedupe key per fix version so updated fixes reach students too.
    run(`UPDATE notifications SET dedupe_key = dedupe_key || ':' || id WHERE dedupe_key = ?`, `fix:${issue.id}:${t.id}`);
    await msg.fixShared(t, updated, get('SELECT * FROM users WHERE id = ?', t.student_id));
    closeFollowups(`kind = 'ticket_sla' AND ticket_id = ?`, [t.id], 'Fix shared');
  }
  closeFollowups(`kind = 'shared_fix' AND issue_id = ?`, [issue.id], `Fix shared by ${req.user.first_name}`);
  createFollowup({
    kind: 'proceed_check', ownerId: issue.owner_id || req.user.id, issueId: issue.id, ruleKey: `proceed:${issue.id}:${now}`,
    nextAction: `Check that the ${tickets.length} students affected by the ${issue.skill} issue can proceed.`,
    dueAt: addWorkingDays(new Date(), 1),
  });
  req.setFlash('ok', `Fix sent to ${tickets.length} students.`);
  res.redirect(`/issues/${issue.id}`);
});

r.post('/issues/:id/resolve', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).end();
  const id = Number(req.params.id);
  run(`UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ?`, nowIso(), id);
  closeFollowups('issue_id = ?', [id], 'Issue closed');
  req.setFlash('ok', 'Issue closed. New tickets on this skill will start a fresh count.');
  res.redirect(`/issues/${id}`);
});

// Screenshots are only served to people who can see the ticket.
r.get('/uploads/:file', (req, res) => {
  const t = get('SELECT * FROM tickets WHERE screenshot = ?', path.basename(req.params.file));
  if (!t || !canSeeTicket(req.user, t)) return res.status(404).end();
  res.sendFile(path.join(UPLOAD_DIR, t.screenshot));
});

export { studentName };
export default r;
