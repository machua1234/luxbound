import { Router } from 'express';
import { html } from '../html.js';
import { page, csrf } from '../views/layout.js';
import { get, run, nowIso } from '../db.js';
import { verifyPassword, hashPassword, startSession, endSession, consumeToken, issueToken } from '../auth.js';
import { notify } from '../notify.js';

const r = Router();

const SCENES = [
  ['A required assignment passes its deadline with no submission', 'Private reminder with links to the task and the support form'],
  ['Two assignments overdue, or a project overdue', 'Assigned tutor checks the record and agrees a catch-up plan'],
  ['A ticket has no tutor reply after one working day', 'Flagged for the cohort lead to follow up or reassign'],
  ['Several students report the same issue', 'Tutor shares a fix or runs a walkthrough, then checks everyone can proceed'],
];

function motion() {
  return html`<section class="motion" aria-label="How the portal works">
    <div class="orb a"></div><div class="orb b"></div>
    <h2>Know what each student owes, what’s blocking them, and who acts next.</h2>
    <p class="lede">Squad stays the LMS for classes, briefs and submissions. Progress & Support watches for early-warning signals and turns each one into a specific follow-up.</p>
    <div class="flow">
      ${SCENES.map(([sig, act]) => html`<div class="scene">
        <div class="box sig"><b>Signal</b>${sig}</div>
        <div class="arrow"></div>
        <div class="box act"><b>Follow-up</b>${act}</div>
      </div>`)}
    </div>
    <div class="lanes"><span>My Progress</span><span>Technical Support</span><span>Tutor Queue</span><span>Cohort Overview</span></div>
  </section>`;
}

function authPage(req, title, form) {
  return page(req, { title, body: html`<div class="auth">${motion()}<div class="panel">${form}</div></div>` });
}

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(authPage(req, 'Sign in', html`<form method="post" action="/login" class="stack">
    ${csrf(req)}<input type="hidden" name="next" value="${req.query.next || ''}">
    <h1>Sign in</h1><p class="sub">LuxDevHQ Progress & Support</p>
    <label>Email<input type="email" name="email" required autofocus value="${req.query.email || ''}"></label>
    <label>Password<input type="password" name="password" required></label>
    <div class="form-actions"><button class="btn">Sign in</button><a class="btn ghost" href="/forgot">Forgot password</a></div>
    ${process.env.NODE_ENV !== 'production' ? html`<div class="demo">Demo accounts (password <code>luxdev123</code>):<br>
      <code>lead@luxdevhq.test</code> · <code>brian@luxdevhq.test</code> (tutor) · <code>achieng@students.test</code> (student)</div>` : ''}
  </form>`));
});

r.post('/login', (req, res) => {
  const user = get('SELECT * FROM users WHERE email = ? AND active = 1', String(req.body.email || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    req.setFlash('error', 'That email and password don’t match. If you haven’t set a password yet, use the link in your invite email.');
    return res.redirect(`/login?email=${encodeURIComponent(req.body.email || '')}`);
  }
  startSession(res, user.id);
  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

r.post('/logout', (req, res) => {
  endSession(req, res);
  res.redirect('/login');
});

r.get('/set-password', (req, res) => {
  const tok = consumeToken(String(req.query.token || ''));
  if (!tok) return res.send(authPage(req, 'Link expired', html`<div><h1>This link has expired</h1><p class="sub">Ask for a new one.</p><a class="btn" href="/forgot">Send a new link</a></div>`));
  const user = get('SELECT * FROM users WHERE id = ?', tok.user_id);
  res.send(authPage(req, 'Set your password', html`<form method="post" action="/set-password" class="stack">
    ${csrf(req)}<input type="hidden" name="token" value="${tok.token}">
    <h1>Welcome, ${user.first_name}</h1><p class="sub">Choose a password for ${user.email}.</p>
    <label>New password <small>(at least 8 characters)</small><input type="password" name="password" minlength="8" required autofocus></label>
    <div class="form-actions"><button class="btn">Save and sign in</button></div>
  </form>`));
});

r.post('/set-password', (req, res) => {
  const tok = consumeToken(String(req.body.token || ''));
  const pw = String(req.body.password || '');
  if (!tok) return res.redirect('/forgot');
  if (pw.length < 8) {
    req.setFlash('error', 'Use at least 8 characters.');
    return res.redirect(`/set-password?token=${tok.token}`);
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), tok.user_id);
  run('UPDATE tokens SET used_at = ? WHERE token = ?', nowIso(), tok.token);
  startSession(res, tok.user_id);
  res.redirect('/');
});

r.get('/forgot', (req, res) => {
  res.send(authPage(req, 'Reset password', html`<form method="post" action="/forgot" class="stack">
    ${csrf(req)}<h1>Reset your password</h1><p class="sub">We’ll email you a link.</p>
    <label>Email<input type="email" name="email" required autofocus></label>
    <div class="form-actions"><button class="btn">Send link</button><a class="btn ghost" href="/login">Back</a></div>
  </form>`));
});

r.post('/forgot', async (req, res) => {
  const user = get('SELECT * FROM users WHERE email = ? AND active = 1', String(req.body.email || '').trim());
  if (user) {
    const token = issueToken(user.id, 'reset', 1);
    await notify({
      userId: user.id, kind: 'account', title: 'Reset your password', link: `/set-password?token=${token}`,
      body: 'Use the link below to choose a new password. It expires in 24 hours.',
    });
  }
  req.setFlash('ok', 'If that email is registered, a reset link is on its way.');
  res.redirect('/login');
});

export default r;
