import crypto from 'node:crypto';
import { get, run, nowIso } from './db.js';
import { DAY } from './time.js';

const COOKIE = 'lp_session';
const SESSION_DAYS = 14;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, new Date(Date.now() + SESSION_DAYS * DAY).toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: SESSION_DAYS * DAY });
}
export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.clearCookie(COOKIE);
}

export function loadUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null;
  if (token) {
    const row = get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
      token, nowIso(),
    );
    if (row) {
      delete row.password_hash;
      req.user = row;
      req.unread = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', row.id).n;
    }
  }
  next();
}

export function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!roles.includes(req.user.role)) return res.status(403).send(forbidden());
  next();
};
const forbidden = () => '<p style="font-family:sans-serif;padding:2rem">You don’t have access to this page. <a href="/">Go home</a></p>';

export const isStaff = (u) => u && (u.role === 'tutor' || u.role === 'lead');

/** Individual records are visible to the student, their assigned tutor, tutors handling their tickets, and the cohort lead. */
export function canSeeStudent(user, studentId) {
  if (!user) return false;
  if (user.id === studentId || user.role === 'lead') return true;
  if (user.role !== 'tutor') return false;
  const s = get('SELECT tutor_id FROM users WHERE id = ?', studentId);
  if (s?.tutor_id === user.id) return true;
  return !!get('SELECT 1 FROM tickets WHERE student_id = ? AND assignee_id = ?', studentId, user.id);
}

export function canSeeTicket(user, t) {
  if (!user || !t) return false;
  if (user.role === 'lead' || t.student_id === user.id || t.assignee_id === user.id) return true;
  if (user.role !== 'tutor') return false;
  if (get('SELECT tutor_id FROM users WHERE id = ?', t.student_id)?.tutor_id === user.id) return true;
  return !!(t.issue_id && get('SELECT 1 FROM issues WHERE id = ? AND owner_id = ?', t.issue_id, user.id));
}

export function issueToken(userId, purpose, days = 7) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', token, userId, purpose, new Date(Date.now() + days * DAY).toISOString());
  return token;
}
export function consumeToken(token) {
  const row = get('SELECT * FROM tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?', token, nowIso());
  return row || null;
}

/** Minimal CSRF protection: per-session token derived from the session cookie. */
export function csrfToken(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE] || 'anon';
  return crypto.createHmac('sha256', SECRET).update(token).digest('hex').slice(0, 32);
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

export function checkCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = req.body?._csrf || req.headers['x-csrf-token'];
  if (sent !== csrfToken(req)) return res.status(403).send('<p style="font-family:sans-serif;padding:2rem">Your form expired. <a href="javascript:history.back()">Go back</a> and try again.</p>');
  next();
}
