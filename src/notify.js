import { get, run, nowIso } from './db.js';
import { sendMail, transportName } from './mailer.js';

export const PORTAL_URL = (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

/**
 * Send a private in-portal notification and a matching email.
 * If `dedupeKey` was already used, nothing is sent (each notice goes out once).
 * Returns the notification id, or null when it was a duplicate.
 */
export async function notify({ userId, kind, title, body, link, dedupeKey = null, email = true, emailSubject, emailBody }) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || !user.active) return null;
  const created = nowIso();
  const res = run(
    `INSERT OR IGNORE INTO notifications (user_id, kind, title, body, link, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, kind, title, body, link || null, dedupeKey, created,
  );
  if (res.changes === 0) return null;
  const id = Number(res.lastInsertRowid);

  if (!email) {
    run(`UPDATE notifications SET email_status = 'skipped' WHERE id = ?`, id);
    return id;
  }

  const subject = emailSubject || title;
  const fullLink = link ? `${PORTAL_URL}${link}` : PORTAL_URL;
  const textBody = `${emailBody || `Hi ${user.first_name},\n\n${body}`}\n\n${linkLabel(kind)}: ${fullLink}\n\n— LuxDevHQ Progress & Support\nThis message is private to you.`;

  run(
    `INSERT INTO outbox (notification_id, to_email, subject, text, transport, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, user.email, subject, textBody, transportName, created,
  );
  try {
    const { status } = await sendMail({ to: user.email, subject, text: textBody });
    run(`UPDATE notifications SET email_status = ?, emailed_at = ? WHERE id = ?`, status, nowIso(), id);
  } catch (err) {
    run(`UPDATE notifications SET email_status = 'failed', email_error = ? WHERE id = ?`, String(err.message || err), id);
  }
  return id;
}

function linkLabel(kind) {
  if (kind.startsWith('ticket') || kind.startsWith('issue')) return 'View ticket';
  if (kind.startsWith('plan')) return 'View catch-up plan';
  if (kind.startsWith('staff')) return 'Open in portal';
  return 'View assignment status';
}
