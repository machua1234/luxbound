from flask import Blueprint, abort, flash, g, redirect, render_template, request

from .. import messages as msg
from ..auth import can_see_student, role_required
from ..db import all_, get, run, tx
from ..rules import close_followups, create_followup, run_rules, student_name
from ..status import SUBMITTED, SUBMISSION_STATUSES, derive
from ..timeutil import add_working_days, fmt, from_local_input, now_iso, parse, to_local_input, utcnow
from . import form, safe_back
from .student import plans_for, submissions_for, tickets_for

bp = Blueprint("staff", __name__)
staff_only = role_required("tutor", "lead")


def my_students(user):
    base = """SELECT u.*, t.first_name AS tutor_first FROM users u LEFT JOIN users t ON t.id = u.tutor_id
              WHERE u.role = 'student' AND u.active = 1"""
    if user["role"] == "lead":
        return all_(base + " ORDER BY u.first_name")
    return all_(base + " AND u.tutor_id = ? ORDER BY u.first_name", user["id"])


def scoped_submissions(user, at=None):
    at = at or utcnow()
    tutor_only = user["role"] == "tutor"
    rows = all_(f"""
        SELECT s.*, a.title, a.kind, a.due_at, a.deliverables, a.required, u.first_name, u.last_name, u.tutor_id
        FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
        WHERE a.required = 1 AND u.active = 1 {'AND u.tutor_id = ?' if tutor_only else ''}
        ORDER BY COALESCE(s.due_override_at, a.due_at)""", *([user["id"]] if tutor_only else []))
    for r in rows:
        r["d"] = derive(r, at)
    return rows


# ── Tutor Queue ─────────────────────────────────────────────────────────────────────────
@bp.get("/queue")
@staff_only
def queue():
    at = utcnow()
    owner = request.args.get("owner", "me") if g.user["role"] == "lead" else "me"
    mine = owner == "me"
    followups = all_(f"""
        SELECT f.*, o.first_name AS owner_first, s.first_name AS s_first, s.last_name AS s_last
        FROM followups f JOIN users o ON o.id = f.owner_id LEFT JOIN users s ON s.id = f.student_id
        WHERE f.status = 'open' {'AND f.owner_id = ?' if mine else ''} ORDER BY f.due_at""", *([g.user["id"]] if mine else []))
    for f in followups:
        f["late"] = parse(f["due_at"]) < at
    subs = scoped_submissions(g.user, at)
    tutor_only = g.user["role"] == "tutor"
    tickets = all_(f"""
        SELECT t.*, s.first_name, s.last_name FROM tickets t JOIN users s ON s.id = t.student_id
        WHERE t.status = 'awaiting_tutor' {'AND (t.assignee_id = ? OR s.tutor_id = ?)' if tutor_only else ''}
        ORDER BY t.awaiting_since""", *([g.user["id"], g.user["id"]] if tutor_only else []))
    return render_template(
        "queue.html", active="/queue", at=at, owner=owner, followups=followups, tickets=tickets,
        verify=[s for s in subs if s["status"] == "student_claimed" or s["d"]["needs_confirm"]],
        review=[s for s in subs if s["status"] == "awaiting_review"],
        overdue=[s for s in subs if s["d"]["overdue"]],
    )


@bp.post("/followups/<int:fid>/done")
@staff_only
def followup_done(fid):
    f = get("SELECT * FROM followups WHERE id = ?", fid)
    if not f or (f["owner_id"] != g.user["id"] and g.user["role"] != "lead"):
        abort(404)
    close_followups("id = ?", [fid], f"Marked done by {g.user['first_name']}")
    flash("Follow-up closed.", "ok")
    return redirect(safe_back(request.form.get("back"), "/queue"))


# ── Students ────────────────────────────────────────────────────────────────────────────
@bp.get("/students")
@staff_only
def students():
    at = utcnow()
    subs = scoped_submissions(g.user, at)
    open_tickets = {r["student_id"]: r for r in all_(
        """SELECT student_id, COUNT(*) AS n, SUM(status = 'awaiting_tutor') AS waiting FROM tickets
           WHERE status != 'resolved' GROUP BY student_id""")}
    rows = []
    for u in my_students(g.user):
        mine = [s for s in subs if s["student_id"] == u["id"]]
        past_due = [s for s in mine if s["d"]["past"]]
        rows.append(dict(
            u=u, t=open_tickets.get(u["id"]), past_due=len(past_due),
            done=sum(1 for s in past_due if s["status"] in SUBMITTED),
            overdue=sum(1 for s in mine if s["d"]["overdue"]),
            unchecked=sum(1 for s in mine if s["d"]["needs_confirm"]),
        ))
    rows.sort(key=lambda r: (-r["overdue"], -r["unchecked"]))
    return render_template("students.html", active="/students", rows=rows)


def load_student(student_id):
    s = get("""SELECT u.*, t.first_name AS tutor_first, t.last_name AS tutor_last FROM users u
               LEFT JOIN users t ON t.id = u.tutor_id WHERE u.id = ? AND u.role = 'student'""", student_id)
    if not s or not can_see_student(g.user, student_id):
        abort(404)
    return s


@bp.get("/students/<int:student_id>")
@staff_only
def student(student_id):
    s = load_student(student_id)
    at = utcnow()
    subs = [x for x in submissions_for(student_id) if x["required"]]
    for x in subs:
        x["d"] = derive(x, at)
    return render_template(
        "student.html", active="/students", s=s, at=at, subs=subs, name=student_name(s),
        any_overdue=any(x["d"]["overdue"] for x in subs),
        tickets=tickets_for(student_id), plans=plans_for(student_id),
        followups=all_("""SELECT f.*, o.first_name AS owner_first FROM followups f JOIN users o ON o.id = f.owner_id
                          WHERE f.student_id = ? AND f.status = 'open' ORDER BY f.due_at""", student_id),
        notices=all_("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 12", student_id),
        tutors=all_("SELECT * FROM users WHERE role = 'tutor' AND active = 1 ORDER BY first_name") if g.user["role"] == "lead" else [],
    )


@bp.post("/students/<int:student_id>/tutor")
@staff_only
def set_tutor(student_id):
    if g.user["role"] != "lead":
        abort(403)
    tutor_id = request.form.get("tutor_id", type=int)
    if tutor_id and not get("SELECT 1 FROM users WHERE id = ? AND role = 'tutor'", tutor_id):
        abort(400)
    run("UPDATE users SET tutor_id = ? WHERE id = ? AND role = 'student'", tutor_id, student_id)
    flash("Tutor updated.", "ok")
    return redirect(f"/students/{student_id}")


# ── Catch-up plan ───────────────────────────────────────────────────────────────────────
@bp.get("/students/<int:student_id>/plan")
@staff_only
def plan_new(student_id):
    s = load_student(student_id)
    at = utcnow()
    owing = []
    for x in submissions_for(student_id):
        if not x["required"]:
            continue
        x["d"] = derive(x, at)
        if x["d"]["overdue"] or x["d"]["needs_confirm"] or x["status"] == "revision_requested":
            owing.append(x)
    return render_template("plan_new.html", active="/students", s=s, name=student_name(s), owing=owing,
                           check_in=to_local_input(add_working_days(at, 3)))


@bp.post("/students/<int:student_id>/plan")
@staff_only
def plan_create(student_id):
    s = load_student(student_id)
    check_in = from_local_input(request.form.get("check_in"))
    plan_text = form("plan")
    if not check_in or not plan_text:
        flash("Add the plan and a check-in date.", "error")
        return redirect(f"/students/{student_id}/plan")
    now = now_iso()
    items = []
    with tx():
        pid = run("INSERT INTO catchup_plans (student_id, tutor_id, plan, check_in_at, created_at) VALUES (?, ?, ?, ?, ?)",
                  student_id, g.user["id"], plan_text, check_in, now).lastrowid
        for key, value in request.form.items():
            if not key.startswith("due_") or not value or not key[4:].isdigit():
                continue
            new_due = from_local_input(value)
            sub = get("""SELECT s.*, a.title FROM submissions s JOIN assignments a ON a.id = s.assignment_id
                         WHERE s.id = ? AND s.student_id = ?""", int(key[4:]), student_id)
            if not sub or not new_due:
                continue
            new_status = "outstanding" if sub["status"] == "not_checked" else sub["status"]
            run("UPDATE submissions SET due_override_at = ?, override_reason = 'catch_up', status = ?, updated_at = ? WHERE id = ?",
                new_due, new_status, now, sub["id"])
            run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""", sub["id"], g.user["id"], sub["status"], new_status, f"Catch-up deadline {fmt(new_due)}", now)
            items.append({"title": sub["title"], "due": new_due})
        close_followups("kind = 'catch_up' AND student_id = ?", [student_id], f"Plan proposed by {g.user['first_name']}")
        create_followup("check_in", g.user["id"], f"Catch-up check-in with {student_name(s)}", check_in,
                        student_id=student_id, plan_id=pid, rule_key=f"checkin:{pid}")
    msg.catch_up_proposed(get("SELECT * FROM catchup_plans WHERE id = ?", pid), s, g.user, items)
    flash(f"Plan sent to {s['first_name']}. A check-in follow-up is in your queue.", "ok")
    return redirect(f"/students/{student_id}")


# ── Assignments & verification from Squad ───────────────────────────────────────────────
@bp.get("/assignments")
@staff_only
def assignments():
    at = utcnow()
    subs = scoped_submissions(g.user, at)
    rows = []
    for a in all_("SELECT a.*, c.name AS cohort FROM assignments a JOIN cohorts c ON c.id = a.cohort_id ORDER BY a.due_at DESC"):
        mine = [s for s in subs if s["assignment_id"] == a["id"]]
        rows.append(dict(a=a, total=len(mine), submitted=sum(1 for s in mine if s["status"] in SUBMITTED),
                         verify=sum(1 for s in mine if s["d"]["needs_confirm"] or s["status"] == "student_claimed"),
                         overdue=sum(1 for s in mine if s["d"]["overdue"])))
    return render_template("assignments.html", active="/assignments", at=at, rows=rows)


@bp.get("/assignments/<int:aid>")
@staff_only
def assignment(aid):
    a = get("SELECT * FROM assignments WHERE id = ?", aid)
    if not a:
        abort(404)
    at = utcnow()
    return render_template("assignment.html", active="/assignments", a=a, at=at,
                           subs=[s for s in scoped_submissions(g.user, at) if s["assignment_id"] == aid],
                           statuses=SUBMISSION_STATUSES,
                           bulk_options=["awaiting_review", "outstanding", "approved", "not_checked"])


def set_status(sub_id, status, actor, note=None, source="tutor"):
    """Apply a verified status change. Returns the previous row, or None if not allowed."""
    s = get("SELECT s.*, u.tutor_id FROM submissions s JOIN users u ON u.id = s.student_id WHERE s.id = ?", sub_id)
    if not s or not can_see_student(actor, s["student_id"]) or status not in SUBMISSION_STATUSES:
        return None
    if s["status"] == status:
        return s
    now = now_iso()
    clears_resubmission = status in ("approved", "awaiting_review") and s["override_reason"] == "resubmission"
    run("""UPDATE submissions SET status = ?, verified_by = ?, verified_at = ?, status_source = ?, updated_at = ?,
           revision_items = ?, due_override_at = ?, override_reason = ? WHERE id = ?""",
        status, actor["id"], now, source, now,
        s["revision_items"] if status == "revision_requested" else None,
        None if clears_resubmission else s["due_override_at"],
        None if clears_resubmission else s["override_reason"], s["id"])
    run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""", s["id"], actor["id"], s["status"], status, note, now)
    if status in ("awaiting_review", "approved", "outstanding"):
        close_followups("kind = 'verify' AND rule_key LIKE ?", [f"verify:{s['id']}:%"], f"Verified by {actor['first_name']}")
    return s


@bp.post("/submissions/<int:sub_id>/status")
@staff_only
def submission_status(sub_id):
    status = request.form.get("status", "")
    if not set_status(sub_id, status, g.user):
        abort(404)
    run_rules()
    flash(f"Marked “{SUBMISSION_STATUSES[status]}”.", "ok")
    return redirect(safe_back(request.form.get("back"), f"/progress/{sub_id}"))


@bp.post("/assignments/<int:aid>/bulk")
@staff_only
def bulk(aid):
    status = request.form.get("status", "")
    if status not in SUBMISSION_STATUSES:
        abort(400)
    n = 0
    with tx():
        for sid in request.form.getlist("ids", type=int):
            if set_status(sid, status, g.user):
                n += 1
    run_rules()
    flash(f"Updated {n} record{'' if n == 1 else 's'} to “{SUBMISSION_STATUSES[status]}”. Notices were sent where a rule applies.", "ok")
    return redirect(f"/assignments/{aid}")


def load_sub(sub_id):
    s = get("""SELECT s.*, a.title, a.deliverables, a.due_at, u.first_name, u.last_name FROM submissions s
               JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id WHERE s.id = ?""", sub_id)
    return s if s and can_see_student(g.user, s["student_id"]) else None


@bp.post("/submissions/<int:sub_id>/revision")
@staff_only
def revision(sub_id):
    s = load_sub(sub_id)
    items = form("items")
    resub_due = from_local_input(request.form.get("due"))
    if not s or not items or not resub_due:
        flash("List the missing deliverables and a resubmission deadline.", "error")
        return redirect(f"/progress/{sub_id}")
    now = now_iso()
    one_line = "; ".join(x.strip() for x in items.splitlines() if x.strip())
    run("""UPDATE submissions SET status = 'revision_requested', revision_items = ?, due_override_at = ?,
           override_reason = 'resubmission', verified_by = ?, verified_at = ?, status_source = 'tutor', updated_at = ?
           WHERE id = ?""", items, resub_due, g.user["id"], now, now, s["id"])
    run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
           VALUES (?, ?, ?, 'revision_requested', ?, ?)""",
        s["id"], g.user["id"], s["status"], f"Missing: {one_line} · resubmit by {fmt(resub_due)}", now)
    close_followups("kind = 'verify' AND rule_key LIKE ?", [f"verify:{s['id']}:%"], f"Reviewed by {g.user['first_name']}")
    msg.revision_requested(s, one_line, resub_due, f"{g.user['first_name']} {g.user['last_name']}".strip())
    flash(f"Revision request sent to {s['first_name']}.", "ok")
    return redirect(f"/progress/{s['id']}")


@bp.post("/submissions/<int:sub_id>/extension")
@staff_only
def extension(sub_id):
    s = load_sub(sub_id)
    new_due = from_local_input(request.form.get("due"))
    if not s or not new_due:
        flash("Pick a new deadline.", "error")
        return redirect(f"/progress/{sub_id}")
    now = now_iso()
    note = form("note")
    reason = "resubmission" if s["status"] == "revision_requested" else "extension"
    run("UPDATE submissions SET due_override_at = ?, override_reason = ?, updated_at = ? WHERE id = ?", new_due, reason, now, s["id"])
    run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""", s["id"], g.user["id"], s["status"], s["status"],
        f"Extension to {fmt(new_due)}" + (f" — {note}" if note else ""), now)
    msg.extension_granted(s, new_due, note)
    flash(f"Extension approved. Reminders now use {fmt(new_due)}.", "ok")
    return redirect(f"/progress/{s['id']}")
