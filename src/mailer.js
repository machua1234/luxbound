import nodemailer from 'nodemailer';

// With SMTP_HOST set, mail is really sent. Otherwise it is only recorded in the outbox
// (Admin → Outbox), which is enough to run and inspect the pilot locally.
let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

export const MAIL_FROM = process.env.MAIL_FROM || 'LuxDevHQ Progress & Support <progress@luxdevhq.test>';
export const transportName = transport ? 'smtp' : 'outbox-only';

export async function sendMail({ to, subject, text }) {
  if (!transport) return { status: 'logged' };
  await transport.sendMail({ from: MAIL_FROM, to, subject, text });
  return { status: 'sent' };
}
