"""Wording for every student- and staff-facing notice, in one place so it can be reviewed."""
from .notify import notify
from .status import deliverables_phrase, split_items
from .timeutil import fmt, fmt_date, fmt_time


def _record(sub_id):
    return f"/progress/{sub_id}"


def reminder_24h(r, due):
    what = deliverables_phrase(r["deliverables"])
    return notify(
        r["student_id"], "reminder_24h", dedupe_key=f"remind24:{r['id']}:{due}", link=_record(r["id"]),
        title=f"{r['title']} is due in less than 24 hours",
        body=f"Your {r['title']} is due {fmt(due)}. Our records show your {what} is still outstanding. "
             "Submit it in Squad’s Project Lab before the deadline.",
        email_subject=f"Reminder: {r['title']} is due {fmt_date(due)}",
        email_body=f"Hi {r['first_name']},\n\nYour {r['title']} is due on {fmt_date(due)} at {fmt_time(due)}. "
                   f"Our records show that your {what} is still outstanding.\n\n"
                   "Please submit it in Squad’s Project Lab before the deadline. If a technical issue is blocking "
                   "you, select Report a blocker in the portal so your tutor can help.",
    )


def overdue_notice(r, due):
    what = deliverables_phrase(r["deliverables"])
    return notify(
        r["student_id"], "overdue", dedupe_key=f"overdue:{r['id']}:{due}", link=_record(r["id"]),
        title=f"Your {r['title']} is overdue",
        body=f"It was due {fmt(due)} and your {what} is still outstanding. Submit in Squad’s Project Lab. "
             "Already submitted? Select “I already submitted”. Blocked? Select “Report a blocker”.",
        email_subject=f"Your {r['title']} is overdue",
        email_body=f"Hi {r['first_name']}, your {r['title']} was due on {fmt_date(due)} at {fmt_time(due)}. "
                   f"Our records show that your {what} is still outstanding.\n\n"
                   f"Please submit your {what} in Squad’s Project Lab. If you’ve already submitted it, select "
                   "I already submitted in the portal so your tutor can check. If a technical issue is blocking "
                   "you, select Report a blocker so your tutor can follow up.",
    )


def confirm_submission_notice(r, due):
    return notify(
        r["student_id"], "confirm_submission", dedupe_key=f"confirm:{r['id']}:{due}", link=_record(r["id"]),
        title=f"Did you submit your {r['title']}?",
        body=f"The deadline ({fmt(due)}) has passed and your tutor hasn’t checked Squad yet. If you submitted, "
             "select “I already submitted”. If not, submit in Squad’s Project Lab now, or report a blocker.",
        email_subject=f"Please confirm your {r['title']} submission",
        email_body=f"Hi {r['first_name']},\n\nYour {r['title']} was due on {fmt_date(due)} at {fmt_time(due)}. "
                   "Your tutor hasn’t confirmed your submission in Squad yet, so we haven’t marked anything as "
                   "overdue.\n\nIf you’ve submitted, select I already submitted in the portal so your tutor can "
                   "check. If you haven’t, please submit in Squad’s Project Lab now. If a technical issue is "
                   "blocking you, select Report a blocker.",
    )


def revision_requested(r, items, resub_due, tutor_name):
    bullets = "\n".join(f"  • {i}" for i in split_items(items))
    return notify(
        r["student_id"], "revision", dedupe_key=f"revision:{r['id']}:{resub_due}", link=_record(r["id"]),
        title=f"Revision requested: {r['title']}",
        body=f"{tutor_name} reviewed your {r['title']}. Still missing: {items}. Resubmit in Squad by {fmt(resub_due)}.",
        email_subject=f"Revision requested for your {r['title']}",
        email_body=f"Hi {r['first_name']},\n\n{tutor_name} reviewed your {r['title']} and needs a few things "
                   f"before it can be approved.\n\nStill missing:\n{bullets}\n\nPlease resubmit in Squad’s Project "
                   f"Lab by {fmt_date(resub_due)} at {fmt_time(resub_due)}. If something is blocking you, select "
                   "Report a blocker in the portal.",
    )


def extension_granted(r, new_due, note):
    return notify(
        r["student_id"], "extension", dedupe_key=f"extension:{r['id']}:{new_due}", link=_record(r["id"]),
        title=f"Extension approved: {r['title']}",
        body=f"Your new deadline is {fmt(new_due)}." + (f" Note from your tutor: {note}" if note else ""),
    )


def catch_up_proposed(plan, student, tutor, items):
    deadlines = ""
    if items:
        deadlines = "\nNew deadlines:\n" + "\n".join(f"  • {i['title']} — {fmt(i['due'])}" for i in items) + "\n"
    return notify(
        student["id"], "plan_proposed", dedupe_key=f"plan:{plan['id']}", link=f"/plans/{plan['id']}",
        title=f"{tutor['first_name']} has proposed a catch-up plan",
        body=f"{plan['plan']}\n\nCheck-in: {fmt(plan['check_in_at'])}.",
        email_subject=f"A catch-up plan from {tutor['first_name']} {tutor['last_name']}".strip(),
        email_body=f"Hi {student['first_name']},\n\nI noticed you’ve fallen behind on some required work, and "
                   f"I’d like to help you get back on track. Here’s what I propose:\n\n{plan['plan']}\n{deadlines}\n"
                   f"Let’s check in on {fmt_date(plan['check_in_at'])} at {fmt_time(plan['check_in_at'])}. Please "
                   "open the plan in the portal and select Agree, or reply on a support ticket if something needs "
                   f"to change.\n\n{tutor['first_name']}",
    )


def fix_shared(ticket, issue, student):
    return notify(
        student["id"], "issue_fix", dedupe_key=f"fix:{issue['id']}:{ticket['id']}", link=f"/support/{ticket['id']}",
        title=f"A fix for your {issue['skill']} issue",
        body=f"Several students reported the same problem, and your tutor has shared a fix:\n\n{issue['fix_text']}"
             "\n\nCan you continue now? Open your ticket and let us know.",
    )


def ticket_reply(ticket, author, recipient_id):
    return notify(
        recipient_id, "ticket_reply", link=f"/support/{ticket['id']}",
        title=f"New reply on your {ticket['skill']} ticket",
        body=f"{author['first_name']} replied to ticket #{ticket['id']}.",
    )


def staff_alert(user_id, title, body, link, dedupe_key=None):
    return notify(user_id, "staff_alert", title=title, body=body, link=link, dedupe_key=dedupe_key)
