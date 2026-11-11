// Check your SMTP settings: npm run mail:test -- you@example.com
import { sendMail, transportName } from '../src/mailer.js';
const to = process.argv[2];
if (!to) { console.error('Usage: npm run mail:test -- you@example.com'); process.exit(1); }
if (transportName !== 'smtp') { console.error('SMTP_HOST is not set in .env — emails are only recorded in the outbox.'); process.exit(1); }
try {
  await sendMail({ to, subject: 'LuxDevHQ Progress & Support — test email', text: 'If you can read this, email sending works.' });
  console.log(`Sent to ${to}.`);
} catch (err) {
  console.error('Sending failed:', err.message);
  process.exit(1);
}
