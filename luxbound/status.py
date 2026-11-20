"""What a submission's status means right now, and what the student should do next."""
import re
from datetime import datetime

from .timeutil import HOUR, fmt, parse, utcnow

SUBMISSION_STATUSES = {
    "not_checked": "Not checked yet",
    "student_claimed": "Student says submitted",
    "outstanding": "Confirmed not submitted",
    "awaiting_review": "Awaiting tutor review",
    "revision_requested": "Revision requested",
    "approved": "Approved",
}

TICKET_STATUSES = {
    "awaiting_tutor": "Waiting on tutor",
    "awaiting_student": "Waiting on student",
    "resolved": "Resolved",
}

DEFAULT_SKILLS = [
    "PostgreSQL imports", "CTEs", "Joins", "Window functions", "Python", "pandas",
    "Git & GitHub", "Excel", "Power BI", "Environment setup", "Other",
]

# Statuses where the student still owes something.
OWING = ("not_checked", "outstanding", "revision_requested")
# Statuses that count as "submitted" for completion rates.
SUBMITTED = ("approved", "awaiting_review", "student_claimed")


def effective_due(row) -> str:
    """The deadline used for reminders: an approved extension / resubmission date wins."""
    return row.get("due_override_at") or row["due_at"]


def derive(row, at: datetime | None = None) -> dict:
    """
    overdue: deadline passed AND a tutor (or a reliable export) confirmed no submission.
    needs_confirm: deadline passed but nobody has checked — we ask, we don't accuse.
    """
    at = at or utcnow()
    due = effective_due(row)
    left = parse(due) - at
    past = left.total_seconds() <= 0
    soon = not past and left <= 24 * HOUR
    s = row["status"]
    d = dict(due=due, past=past, soon=soon, overdue=False, needs_confirm=False, done=False, owing=s in OWING)

    def out(tone, label, staff, **extra):
        return {**d, "tone": tone, "label": label, "staff": staff, **extra}

    if s == "approved":
        return out("good", "Approved", "Approved", done=True, owing=False)
    if s == "awaiting_review":
        return out("info", "Awaiting tutor review", "Awaiting review")
    if s == "student_claimed":
        return out("info", "Submitted — tutor checking", "Student says submitted — verify in Squad")
    if s == "outstanding" and past:
        return out("bad", "Overdue", "Overdue (confirmed)", overdue=True)
    if s == "revision_requested":
        if past:
            return out("warn", "Resubmission deadline passed — confirm", "Revision deadline passed — verify", needs_confirm=True)
        return out("warn", "Revision requested", "Revision requested")
    if past:
        return out("warn", "Please confirm your submission", "Past deadline — needs verification", needs_confirm=True)
    if soon:
        return out("warn", "Due within 24 hours", "Due soon")
    return out("neutral", "To do", "Not submitted" if s == "outstanding" else "Not due yet")


def split_items(text: str | None) -> list[str]:
    return [s.strip() for s in re.split(r"[;\n]", text or "") if s.strip()]


def deliverables_phrase(deliverables: str | None) -> str:
    items = split_items(deliverables)
    if not items:
        return "submission"
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} and {items[-1]}"


def student_next_step(row, d) -> str:
    what = deliverables_phrase(row.get("deliverables"))
    status = row["status"]
    if d["done"]:
        return "Nothing to do — this is approved."
    if status == "awaiting_review":
        return "Nothing to do right now — your tutor will review your submission."
    if status == "student_claimed":
        return "Your tutor is checking Squad for your submission. No action needed unless they contact you."
    if status == "revision_requested" and not d["past"]:
        return f"Resubmit in Squad’s Project Lab by {fmt(d['due'])} with: {row.get('revision_items') or what}."
    if d["overdue"]:
        return (f"Submit your {what} in Squad’s Project Lab, then select “I already submitted”. "
                "If something technical is blocking you, report a blocker.")
    if d["needs_confirm"]:
        return (f"The deadline has passed and your tutor hasn’t checked Squad yet. If you submitted, select "
                f"“I already submitted”. If not, submit your {what} in Squad now.")
    return f"Submit your {what} in Squad’s Project Lab by {fmt(d['due'])}."


def staff_next_step(row, d) -> str:
    if row["status"] == "student_claimed":
        return "The student says they submitted. Check Squad and mark it Awaiting review, or No submission."
    if d["needs_confirm"]:
        return "Deadline passed and nobody has checked Squad. Verify the submission so the right notice goes out."
    if row["status"] == "awaiting_review":
        return "Review the submission in Squad, then approve it or request a revision."
    if d["overdue"]:
        return "Confirmed overdue. The student has been sent an overdue notice. Consider an extension or a catch-up plan."
    if d["done"]:
        return "Approved. No action needed."
    return "Not due yet. The student gets a reminder 24 hours before the deadline."
