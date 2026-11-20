import json
import os
from collections import Counter
from datetime import timedelta

from flask import Blueprint, abort, flash, g, redirect, render_template, request

from ..auth import login_required, role_required
from ..db import all_, get, run
from ..imports import import_assignments, import_roster, import_statuses, parse_csv, send_invite
from ..mailer import transport_name
from ..rules import recurring_threshold, run_rules
from ..status import SUBMITTED, derive
from ..timeutil import iso, now_iso, parse, utcnow
from . import form

bp = Blueprint("lead", __name__)
lead_only = role_required("lead")


# ── Notifications (everyone) ────────────────────────────────────────────────────────────
@bp.get("/notifications")
@login_required
def notifications():
    items = all_("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100", g.user["id"])
    return render_template("notifications.html", items=items)


@bp.get("/n/<int:nid>")
@login_required
def open_notification(nid):
    n = get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", nid, g.user["id"])
    if not n:
        return redirect("/notifications")
    run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", now_iso(), nid)
    link = n["link"] or ""
    return redirect(link if link.startswith("/") and not link.startswith("//") else "/notifications")


@bp.post("/notifications/read-all")
@login_required
def read_all():
    run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now_iso(), g.user["id"])
    return redirect("/notifications")


# ── Cohort Overview ─────────────────────────────────────────────────────────────────────
@bp.get("/overview")
@lead_only
def overview():
    at = utcnow()
    cohorts = all_("SELECT * FROM cohorts ORDER BY id DESC")
    cohort_id = request.args.get("cohort", type=int) or (cohorts[0]["id"] if cohorts else None)
    cohort = next((c for c in cohorts if c["id"] == cohort_id), None)
    if not cohort:
        return render_template("overview.html", active="/overview", cohort=None)

    subs = all_("""SELECT s.*, a.title, a.kind, a.due_at, a.required, a.id AS aid FROM submissions s
                   JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
                   WHERE a.cohort_id = ? AND a.required = 1 AND u.active = 1""", cohort_id)
    for s in subs:
        s["d"] = derive(s, at)
    past_due = [s for s in subs if s["d"]["past"] or s["status"] in ("approved", "awaiting_review")]
    completed = sum(1 for s in past_due if s["status"] in SUBMITTED)
    overdue = [s for s in subs if s["d"]["overdue"]]
    unverified = [s for s in subs if s["d"]["needs_confirm"] or s["status"] == "student_claimed"]
    unanswered = all_("""SELECT t.*, u.first_name, u.last_name, a.first_name AS assignee_first FROM tickets t
                         JOIN users u ON u.id = t.student_id LEFT JOIN users a ON a.id = t.assignee_id
                         WHERE t.cohort_id = ? AND t.status = 'awaiting_tutor' ORDER BY t.awaiting_since""", cohort_id)
    skills = all_("""SELECT skill, COUNT(*) AS total, COUNT(DISTINCT student_id) AS students, SUM(status != 'resolved') AS open,
                       AVG(CASE WHEN first_reply_at IS NOT NULL THEN (julianday(first_reply_at) - julianday(created_at)) * 24 END) AS avg_reply_h
                     FROM tickets WHERE cohort_id = ? AND created_at >= ? GROUP BY skill ORDER BY students DESC, total DESC""",
                  cohort_id, iso(at - timedelta(days=30)))
    issues = all_("""SELECT i.*, u.first_name AS owner_first, (SELECT COUNT(*) FROM tickets t WHERE t.issue_id = i.id) AS n
                     FROM issues i LEFT JOIN users u ON u.id = i.owner_id WHERE i.cohort_id = ? AND i.status != 'resolved'""", cohort_id)
    late_followups = all_("""SELECT f.*, u.first_name AS owner_first FROM followups f JOIN users u ON u.id = f.owner_id
                             WHERE f.status = 'open' AND f.due_at < ? ORDER BY f.due_at""", iso(at))

    per_assignment = []
    for a in all_("SELECT * FROM assignments WHERE cohort_id = ? AND required = 1 ORDER BY due_at", cohort_id):
        rows = [s for s in subs if s["aid"] == a["id"]]
        per_assignment.append(dict(
            a=a, total=len(rows), done=sum(1 for s in rows if s["status"] in SUBMITTED),
            approved=sum(1 for s in rows if s["status"] == "approved"),
            overdue=sum(1 for s in rows if s["d"]["overdue"]),
            unverified=sum(1 for s in rows if s["d"]["needs_confirm"]),
        ))
    by_student = Counter(s["student_id"] for s in overdue)
    at_risk = [{**get("SELECT id, first_name, last_name FROM users WHERE id = ?", sid), "n": n}
               for sid, n in by_student.most_common(8)]
    return render_template(
        "overview.html", active="/overview", at=at, cohort=cohort, cohorts=cohorts,
        students=get("SELECT COUNT(*) AS n FROM users WHERE cohort_id = ? AND role = 'student' AND active = 1", cohort_id)["n"],
        last_run=get("SELECT * FROM rule_runs ORDER BY id DESC LIMIT 1"),
        completion=f"{round(completed / len(past_due) * 100)}%" if past_due else "—", completed=completed,
        past_due=len(past_due), overdue=overdue, overdue_students=len(by_student), unverified=unverified,
        unanswered=unanswered, flagged=sum(1 for t in unanswered if t["escalated_at"]), skills=skills, issues=issues,
        late_followups=late_followups, per_assignment=per_assignment, at_risk=at_risk, threshold=recurring_threshold(),
    )


# ── Admin ───────────────────────────────────────────────────────────────────────────────
@bp.get("/admin")
@lead_only
def admin():
    runs = all_("SELECT * FROM rule_runs ORDER BY id DESC LIMIT 5")
    for r in runs:
        r["parts"] = " · ".join(f"{k}: {v}" for k, v in json.loads(r["summary"]).items() if v) or "no new actions"
    return render_template(
        "admin.html", active="/admin", runs=runs, transport=transport_name(),
        interval=os.environ.get("RULES_INTERVAL_MIN", "15"),
        cohorts=all_("SELECT * FROM cohorts ORDER BY id DESC"),
        imports=all_("SELECT i.*, u.first_name FROM imports i LEFT JOIN users u ON u.id = i.actor_id ORDER BY i.id DESC LIMIT 10"),
        staff=all_("SELECT * FROM users WHERE role IN ('tutor','lead') ORDER BY role, first_name"),
    )


@bp.post("/admin/rules/run")
@lead_only
def rules_now():
    s = run_rules()
    done = ", ".join(f"{k} {v}" for k, v in s.items() if v) or "nothing new to do"
    flash(f"Rules ran: {done}.", "ok")
    return redirect("/admin")


@bp.get("/admin/outbox")
@lead_only
def outbox():
    return render_template("outbox.html", active="/admin", transport=transport_name(),
                           mails=all_("SELECT * FROM outbox ORDER BY id DESC LIMIT 100"))


def cohort_from_form():
    name = form("new_cohort")
    if name:
        run("INSERT OR IGNORE INTO cohorts (name, created_at) VALUES (?, ?)", name, now_iso())
        return get("SELECT * FROM cohorts WHERE name = ?", name)
    return get("SELECT * FROM cohorts WHERE id = ?", request.form.get("cohort_id", type=int))


def uploaded_rows():
    f = request.files.get("file")
    if not f or not f.filename:
        return None, None
    return parse_csv(f.read(2 * 1024 * 1024)), f.filename


def log_import(kind, filename, created, updated, errors):
    run("INSERT INTO imports (kind, filename, actor_id, created, updated, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        kind, filename, g.user["id"], created, updated, " | ".join(errors[:5]) or None, now_iso())
    skipped = f", {len(errors)} rows skipped ({'; '.join(errors[:3])})" if errors else ""
    flash(f"{kind}: {created} added, {updated} updated{skipped}.", "error" if errors else "ok")


def handle_import(kind, fn, rules=False):
    cohort = cohort_from_form()
    rows, filename = uploaded_rows()
    if not cohort or rows is None:
        flash("Choose a cohort and a CSV file.", "error")
        return redirect("/admin")
    created, updated, errors = fn(rows, cohort)
    log_import(kind, filename, created, updated, errors)
    if rules:
        run_rules()
    return redirect("/admin")


@bp.post("/admin/import/roster")
@lead_only
def import_roster_view():
    return handle_import("Roster", lambda rows, c: import_roster(rows, c, request.form.get("deactivate_missing") == "1"))


@bp.post("/admin/import/assignments")
@lead_only
def import_assignments_view():
    return handle_import("Assignments", import_assignments, rules=True)


@bp.post("/admin/import/status")
@lead_only
def import_status_view():
    return handle_import("Squad status", lambda rows, c: import_statuses(rows, c, g.user["id"]), rules=True)


@bp.post("/admin/staff")
@lead_only
def add_staff():
    email = form("email").lower()
    first = form("first_name")
    role = "lead" if request.form.get("role") == "lead" else "tutor"
    if not email or not first or get("SELECT 1 FROM users WHERE email = ?", email):
        flash("Enter a name and an email that isn’t already registered.", "error")
        return redirect("/admin")
    uid = run("INSERT INTO users (email, first_name, last_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
              email, first, form("last_name"), role, now_iso()).lastrowid
    send_invite(uid)
    flash(f"Invited {first}.", "ok")
    return redirect("/admin")
