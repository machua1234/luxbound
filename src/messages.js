// Wording for every student- and staff-facing notice, in one place so it can be reviewed.
import { notify } from './notify.js';
import { fmt, fmtDate, fmtTime } from './time.js';
import { deliverablesPhrase } from './status.js';

const recordLink = (subId) => `/progress/${subId}`;

export function reminder24h(r, due) {
  const what = deliverablesPhrase(r.deliverables);
  return notify({
    userId: r.student_id,
    kind: 'reminder_24h',
    dedupeKey: `remind24:${r.id}:${due}`,
    link: recordLink(r.id),
    title: `${r.title} is due in less than 24 hours`,
    body: `Your ${r.title} is due ${fmt(due)}. Our records show your ${what} is still outstanding. Submit it in Squad’s Project Lab before the deadline.`,
    emailSubject: `Reminder: ${r.title} is due ${fmtDate(due)}`,
    emailBody: `Hi ${r.first_name},\n\nYour ${r.title} is due on ${fmtDate(due)} at ${fmtTime(due)}. Our records show that your ${what} is still outstanding.\n\nPlease submit it in Squad’s Project Lab before the deadline. If a technical issue is blocking you, select Report a blocker in the portal so your tutor can help.`,
  });
}

export function overdueNotice(r, due) {
  const what = deliverablesPhrase(r.deliverables);
  return notify({
    userId: r.student_id,
    kind: 'overdue',
    dedupeKey: `overdue:${r.id}:${due}`,
    link: recordLink(r.id),
    title: `Your ${r.title} is overdue`,
    body: `It was due ${fmt(due)} and your ${what} is still outstanding. Submit in Squad’s Project Lab. Already submitted? Select “I already submitted”. Blocked? Select “Report a blocker”.`,
    emailSubject: `Your ${r.title} is overdue`,
    emailBody: `Hi ${r.first_name}, your ${r.title} was due on ${fmtDate(due)} at ${fmtTime(due)}. Our records show that your ${what} is still outstanding.\n\nPlease submit your ${what} in Squad’s Project Lab. If you’ve already submitted it, select I already submitted in the portal so your tutor can check. If a technical issue is blocking you, select Report a blocker so your tutor can follow up.`,
  });
}

export function confirmSubmissionNotice(r, due) {
  return notify({
    userId: r.student_id,
    kind: 'confirm_submission',
    dedupeKey: `confirm:${r.id}:${due}`,
    link: recordLink(r.id),
    title: `Did you submit your ${r.title}?`,
    body: `The deadline (${fmt(due)}) has passed and your tutor hasn’t checked Squad yet. If you submitted, select “I already submitted”. If not, submit in Squad’s Project Lab now, or report a blocker.`,
    emailSubject: `Please confirm your ${r.title} submission`,
    emailBody: `Hi ${r.first_name},\n\nYour ${r.title} was due on ${fmtDate(due)} at ${fmtTime(due)}. Your tutor hasn’t confirmed your submission in Squad yet, so we haven’t marked anything as overdue.\n\nIf you’ve submitted, select I already submitted in the portal so your tutor can check. If you haven’t, please submit in Squad’s Project Lab now. If a technical issue is blocking you, select Report a blocker.`,
  });
}

export function revisionRequested(r, items, resubDue, tutorName) {
  return notify({
    userId: r.student_id,
    kind: 'revision',
    dedupeKey: `revision:${r.id}:${resubDue}`,
    link: recordLink(r.id),
    title: `Revision requested: ${r.title}`,
    body: `${tutorName} reviewed your ${r.title}. Still missing: ${items}. Resubmit in Squad by ${fmt(resubDue)}.`,
    emailSubject: `Revision requested for your ${r.title}`,
    emailBody: `Hi ${r.first_name},\n\n${tutorName} reviewed your ${r.title} and needs a few things before it can be approved.\n\nStill missing:\n${items.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => `  • ${s}`).join('\n')}\n\nPlease resubmit in Squad’s Project Lab by ${fmtDate(resubDue)} at ${fmtTime(resubDue)}. If something is blocking you, select Report a blocker in the portal.`,
  });
}

export function extensionGranted(r, newDue, note) {
  return notify({
    userId: r.student_id,
    kind: 'extension',
    dedupeKey: `extension:${r.id}:${newDue}`,
    link: recordLink(r.id),
    title: `Extension approved: ${r.title}`,
    body: `Your new deadline is ${fmt(newDue)}.${note ? ` Note from your tutor: ${note}` : ''}`,
  });
}

export function catchUpProposed(plan, student, tutor, items) {
  return notify({
    userId: student.id,
    kind: 'plan_proposed',
    dedupeKey: `plan:${plan.id}`,
    link: `/plans/${plan.id}`,
    title: `${tutor.first_name} has proposed a catch-up plan`,
    body: `${plan.plan}\n\nCheck-in: ${fmt(plan.check_in_at)}.`,
    emailSubject: `A catch-up plan from ${tutor.first_name} ${tutor.last_name}`.trim(),
    emailBody: `Hi ${student.first_name},\n\nI noticed you’ve fallen behind on some required work, and I’d like to help you get back on track. Here’s what I propose:\n\n${plan.plan}\n${items.length ? `\nNew deadlines:\n${items.map((i) => `  • ${i.title} — ${fmt(i.due)}`).join('\n')}\n` : ''}\nLet’s check in on ${fmtDate(plan.check_in_at)} at ${fmtTime(plan.check_in_at)}. Please open the plan in the portal and select Agree, or reply on a support ticket if something needs to change.\n\n${tutor.first_name}`,
  });
}

export function fixShared(ticket, issue, student) {
  return notify({
    userId: student.id,
    kind: 'issue_fix',
    dedupeKey: `fix:${issue.id}:${ticket.id}`,
    link: `/support/${ticket.id}`,
    title: `A fix for your ${issue.skill} issue`,
    body: `Several students reported the same problem, and your tutor has shared a fix:\n\n${issue.fix_text}\n\nCan you continue now? Open your ticket and let us know.`,
  });
}

export function ticketReply(ticket, author, recipientId) {
  return notify({
    userId: recipientId,
    kind: 'ticket_reply',
    link: `/support/${ticket.id}`,
    title: `New reply on your ${ticket.skill} ticket`,
    body: `${author.first_name} replied to ticket #${ticket.id}.`,
  });
}

export function staffAlert(userId, { title, body, link, dedupeKey }) {
  return notify({ userId, kind: 'staff_alert', title, body, link, dedupeKey });
}
