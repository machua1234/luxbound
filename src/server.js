import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadUser, checkCsrf } from './auth.js';
import { runRules } from './rules.js';
import authRoutes from './routes/auth.js';
import studentRoutes from './routes/student.js';
import supportRoutes from './routes/support.js';
import staffRoutes from './routes/staff.js';
import leadRoutes from './routes/lead.js';

fs.mkdirSync(path.resolve(process.env.UPLOAD_DIR || 'uploads'), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});
app.use('/static', express.static(path.resolve('public'), { maxAge: '1h' }));
app.use('/static/samples', express.static(path.resolve('samples')));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

// One-shot flash messages carried in a short-lived cookie.
app.use((req, res, next) => {
  const m = /(?:^|;\s*)lp_flash=([^;]+)/.exec(req.headers.cookie || '');
  if (m) {
    try { req.flash = JSON.parse(decodeURIComponent(m[1])); } catch { /* ignore */ }
    res.clearCookie('lp_flash');
  }
  req.setFlash = (type, text) => res.cookie('lp_flash', JSON.stringify({ type, text }), { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  next();
});

app.use(loadUser);
// Multipart forms are checked inside their routes, after the upload is parsed.
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : checkCsrf(req, res, next)));

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.redirect({ student: '/progress', tutor: '/queue', lead: '/overview' }[req.user.role]);
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(authRoutes);
app.use(leadRoutes);
app.use(staffRoutes);
app.use(supportRoutes);
app.use(studentRoutes);

app.use((req, res) => res.status(404).send('<p style="font-family:sans-serif;padding:2rem">Page not found. <a href="/">Go home</a></p>'));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).send('<p style="font-family:sans-serif;padding:2rem">Something went wrong. <a href="/">Go home</a></p>');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`LuxDevHQ Progress & Support → http://localhost:${port}`));

// Early-warning rules on a schedule (and after every status change).
const everyMin = Number(process.env.RULES_INTERVAL_MIN || 15);
const tick = () => runRules().then((s) => console.log('[rules]', JSON.stringify(s))).catch((e) => console.error('[rules] failed', e));
setTimeout(tick, 3000);
setInterval(tick, everyMin * 60 * 1000);
