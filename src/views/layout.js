import { html, raw } from '../html.js';
import { csrfToken } from '../auth.js';
import { fmt, relative } from '../time.js';

const NAV = {
  student: [['/progress', 'My Progress'], ['/support', 'Technical Support']],
  tutor: [['/queue', 'Tutor Queue'], ['/students', 'Students'], ['/assignments', 'Assignments'], ['/support', 'Tickets']],
  lead: [['/overview', 'Cohort Overview'], ['/queue', 'Tutor Queue'], ['/students', 'Students'], ['/assignments', 'Assignments'], ['/support', 'Tickets'], ['/admin', 'Admin']],
};

export function page(req, { title, body, active = '' }) {
  const u = req.user;
  const flash = req.flash;
  return `<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · LuxDevHQ Progress & Support</title>
<link rel="stylesheet" href="/static/app.css">
</head><body>
${u ? html`<header class="top">
  <a class="brand" href="/"><span class="logo">L</span><span>LuxDevHQ <b>Progress & Support</b></span></a>
  <nav>${NAV[u.role].map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}</nav>
  <div class="me">
    <a href="/notifications" class="bell ${req.unread ? 'has' : ''}" title="Notifications">🔔${req.unread ? html`<span>${req.unread}</span>` : ''}</a>
    <span class="who">${u.first_name} · ${u.role === 'lead' ? 'Cohort lead' : u.role === 'tutor' ? 'Tutor' : 'Student'}</span>
    <form method="post" action="/logout">${csrf(req)}<button class="link">Sign out</button></form>
  </div>
</header>` : ''}
<main class="${u ? '' : 'bare'}">
${flash ? html`<div class="flash ${flash.type || ''}">${flash.text}</div>` : ''}
${body}
</main>
${u ? html`<footer>Submissions, briefs and recordings stay in Squad. This portal tracks what’s owed, what’s blocking, and who acts next. Times shown in EAT.</footer>` : ''}
</body></html>`}`;
}

export const csrf = (req) => html`<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;

export const pill = (tone, label) => html`<span class="pill ${tone}">${label}</span>`;

export function due(iso, at = new Date()) {
  return html`<span class="due" title="${fmt(iso)}">${fmt(iso)} <small>(${relative(iso, at)})</small></span>`;
}

export function ticketPill(t) {
  if (t.status === 'resolved') return pill('good', 'Resolved');
  if (t.status === 'awaiting_student') return pill('info', 'Waiting on student');
  return pill(t.escalated_at ? 'bad' : 'warn', t.escalated_at ? 'Waiting on tutor · flagged' : 'Waiting on tutor');
}

export function empty(textStr) {
  return html`<p class="empty">${textStr}</p>`;
}

export function stat(label, value, tone = '', sub = '') {
  return html`<div class="stat ${tone}"><div class="v">${value}</div><div class="l">${label}</div>${sub ? html`<div class="s">${sub}</div>` : ''}</div>`;
}

export { raw };
