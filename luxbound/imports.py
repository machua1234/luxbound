"""Weekly roster, assignment and (later) Squad status imports from CSV."""
import csv
import io
import re

from .auth import issue_token
from .db import all_, ensure_submission_rows, get, run, tx
from .notify import notify
from .timeutil import now_iso, parse_import_date

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
EXPORT_STATUS = {"submitted": "awaiting_review", "not_submitted": "outstanding", "missing": "outstanding",
                 "approved": "approved"}


def parse_csv(data: bytes | str) -> list[dict]:
    """Rows as dicts keyed by lower-cased, underscored header. Handles a UTF-8 BOM."""
    text = data.decode("utf-8-sig") if isinstance(data, bytes) else data.lstrip("﻿")
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return []
    header = [re.sub(r"\s+", "_", h.strip().lower()) for h in rows[0]]
    return [{h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(header)} for r in rows[1:]]


def send_invite(user_id: int):
    token = issue_token(user_id, "invite", 14)
    notify(user_id, "account", "Welcome to LuxDevHQ Progress & Support",
           "This portal shows your required assignments and projects, what’s still outstanding, and lets you report "
           "technical blockers to your tutor. You’ll keep submitting your work in Squad as usual.\n\n"
           "Set your password to sign in:",
           link=f"/set-password?token={token}")


def import_roster(rows, cohort, deactivate_missing=False):
    created = updated = 0
    errors, invites = [], []
    with tx():
        seen = set()
        for i, row in enumerate(rows, start=2):
            email = row.get("email", "").lower()
            if not EMAIL_RE.match(email) or not row.get("first_name"):
                errors.append(f"row {i}: email and first_name required")
                continue
            role = row.get("role") if row.get("role") in ("tutor", "lead") else "student"
            tutor = None
            if row.get("tutor_email"):
                tutor = get("SELECT id FROM users WHERE email = ? AND role IN ('tutor','lead')", row["tutor_email"])
                if not tutor:
                    errors.append(f"row {i}: tutor {row['tutor_email']} not found (import tutors first)")
            tutor_id = tutor["id"] if tutor else None
            seen.add(email)
            existing = get("SELECT * FROM users WHERE email = ?", email)
            if existing:
                run("""UPDATE users SET first_name = ?, last_name = ?, cohort_id = ?, tutor_id = COALESCE(?, tutor_id),
                       active = 1 WHERE id = ?""",
                    row["first_name"], row.get("last_name", ""), cohort["id"], tutor_id, existing["id"])
                updated += 1
            else:
                cur = run("""INSERT INTO users (email, first_name, last_name, role, cohort_id, tutor_id, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)""",
                          email, row["first_name"], row.get("last_name", ""), role, cohort["id"], tutor_id, now_iso())
                invites.append(cur.lastrowid)
                created += 1
        if deactivate_missing and seen:
            for u in all_("SELECT id, email FROM users WHERE cohort_id = ? AND role = 'student' AND active = 1", cohort["id"]):
                if u["email"].lower() not in seen:
                    run("UPDATE users SET active = 0 WHERE id = ?", u["id"])
        ensure_submission_rows(cohort["id"])
    for uid in invites:
        send_invite(uid)
    return created, updated, errors


def import_assignments(rows, cohort):
    created = updated = 0
    errors = []
    with tx():
        for i, row in enumerate(rows, start=2):
            due = parse_import_date(row.get("due_at"))
            if not row.get("code") or not row.get("title") or not due:
                errors.append(f"row {i}: code, title and a valid due_at required")
                continue
            kind = "project" if row.get("kind") == "project" else "assignment"
            required = 0 if row.get("required", "").lower() in ("0", "no", "false", "optional") else 1
            week = int(row["week"]) if row.get("week", "").isdigit() else None
            values = (row["title"], week, kind, row.get("skill", ""), required, due, row.get("squad_url", ""),
                      row.get("deliverables", ""))
            existing = get("SELECT id FROM assignments WHERE cohort_id = ? AND code = ?", cohort["id"], row["code"])
            if existing:
                run("""UPDATE assignments SET title = ?, week = ?, kind = ?, skill = ?, required = ?, due_at = ?,
                       squad_url = ?, deliverables = ? WHERE id = ?""", *values, existing["id"])
                updated += 1
            else:
                run("""INSERT INTO assignments (title, week, kind, skill, required, due_at, squad_url, deliverables,
                       cohort_id, code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    *values, cohort["id"], row["code"], now_iso())
                created += 1
        ensure_submission_rows(cohort["id"])
    return created, updated, errors


def import_statuses(rows, cohort, actor_id):
    """Squad export: email, assignment_code, status. Never downgrades something a tutor already reviewed."""
    updated = 0
    errors = []
    now = now_iso()
    with tx():
        for i, row in enumerate(rows, start=2):
            status = EXPORT_STATUS.get(row.get("status", "").lower())
            s = get("""SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id
                       JOIN users u ON u.id = s.student_id
                       WHERE u.email = ? AND a.code = ? AND a.cohort_id = ?""",
                    row.get("email", ""), row.get("assignment_code", ""), cohort["id"])
            if not s or not status:
                errors.append(f"row {i}: unknown student/assignment/status")
                continue
            if s["status"] in ("approved", "revision_requested") and status != "approved":
                continue
            if s["status"] == status:
                continue
            run("UPDATE submissions SET status = ?, status_source = 'squad_export', verified_at = ?, updated_at = ? WHERE id = ?",
                status, now, now, s["id"])
            run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
                   VALUES (?, ?, ?, ?, 'Squad export', ?)""", s["id"], actor_id, s["status"], status, now)
            updated += 1
    return 0, updated, errors
