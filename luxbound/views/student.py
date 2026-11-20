from flask import Blueprint, abort, flash, g, redirect, render_template, request

from .. import messages as msg
from ..auth import can_see_student, is_staff, login_required
from ..db import all_, get, run
from ..rules import close_followups, create_followup
from ..status import (SUBMISSION_STATUSES, deliverables_phrase, derive, split_items, staff_next_step,
                      student_next_step)
from ..timeutil import add_working_days, fmt, now_iso, utcnow

bp = Blueprint("student", __name__)


def submissions_for(student_id):
    return all_("""
        SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.required, a.code
        FROM submissions s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.student_id = ? ORDER BY COALESCE(s.due_override_at, a.due_at)""", student_id)


def tickets_for(student_id):
    return all_("""
        SELECT t.*, a.title AS assignment_title, u.first_name AS assignee_name
        FROM tickets t LEFT JOIN assignments a ON a.id = t.assignment_id LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.student_id = ? ORDER BY t.status = 'resolved', t.created_at DESC""", student_id)


def plans_for(student_id):
    return all_("""SELECT p.*, u.first_name AS tutor_first, u.last_name AS tutor_last
                   FROM catchup_plans p JOIN users u ON u.id = p.tutor_id
                   WHERE p.student_id = ? ORDER BY p.created_at DESC""", student_id)


def with_status(rows, at):
    for r in rows:
        r["d"] = derive(r, at)
        r["what"] = deliverables_phrase(r["deliverables"])
    return rows


@bp.get("/progress")
@login_required
def progress():
    if g.user["role"] != "student":
        return redirect("/")
    at = utcnow()
    subs = with_status([s for s in submissions_for(g.user["id"]) if s["required"]], at)
    groups = {"action": [], "upcoming": [], "waiting": [], "done": []}
    for s in subs:
        d = s["d"]
        if d["done"]:
            groups["done"].append(s)
        elif s["status"] in ("awaiting_review", "student_claimed"):
            groups["waiting"].append(s)
        elif d["overdue"] or d["needs_confirm"] or d["soon"] or s["status"] == "revision_requested":
            groups["action"].append(s)
        else:
            groups["upcoming"].append(s)
    tickets = tickets_for(g.user["id"])
    tutor = get("SELECT first_name, last_name FROM users WHERE id = ?", g.user["tutor_id"]) if g.user["tutor_id"] else None
    return render_template(
        "progress.html", active="/progress", at=at, groups=groups, total=len(subs),
        submitted=len(groups["done"]) + len(groups["waiting"]),
        any_overdue=any(s["d"]["overdue"] for s in groups["action"]),
        open_tickets=[t for t in tickets if t["status"] != "resolved"],
        plans=[p for p in plans_for(g.user["id"]) if p["status"] != "completed"], tutor=tutor,
    )


def load_submission(sub_id):
    return get("""SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.required,
                         a.cohort_id
                  FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?""", sub_id)


@bp.get("/progress/<int:sub_id>")
@login_required
def record(sub_id):
    s = load_submission(sub_id)
    if not s or not can_see_student(g.user, s["student_id"]):
        abort(404)
    at = utcnow()
    d = derive(s, at)
    is_owner = g.user["id"] == s["student_id"]
    return render_template(
        "record.html", active="/progress" if is_owner else "/students", s=s, d=d, at=at, is_owner=is_owner,
        staff=is_staff(g.user), student=get("SELECT * FROM users WHERE id = ?", s["student_id"]),
        next_step=student_next_step(s, d) if is_owner else staff_next_step(s, d),
        what=deliverables_phrase(s["deliverables"]), missing=split_items(s["revision_items"]),
        can_claim=is_owner and s["status"] in ("not_checked", "outstanding", "revision_requested")
                  and (d["past"] or s["status"] == "outstanding"),
        events=all_("""SELECT e.*, u.first_name FROM submission_events e LEFT JOIN users u ON u.id = e.actor_id
                       WHERE submission_id = ? ORDER BY e.created_at DESC, e.id DESC""", s["id"]),
        notices=all_("SELECT * FROM notifications WHERE user_id = ? AND link = ? ORDER BY created_at DESC",
                     s["student_id"], f"/progress/{s['id']}"),
        tickets=all_("SELECT * FROM tickets WHERE student_id = ? AND assignment_id = ? ORDER BY created_at DESC",
                     s["student_id"], s["assignment_id"]),
        statuses=SUBMISSION_STATUSES,
    )


@bp.post("/progress/<int:sub_id>/claim")
@login_required
def claim(sub_id):
    s = load_submission(sub_id)
    if not s or s["student_id"] != g.user["id"]:
        abort(404)
    if s["status"] in ("not_checked", "outstanding", "revision_requested"):
        now = now_iso()
        note = (request.form.get("note") or "").strip()[:500] or None
        run("UPDATE submissions SET status = 'student_claimed', student_note = ?, status_source = 'student', updated_at = ? WHERE id = ?",
            note, now, s["id"])
        run("""INSERT INTO submission_events (submission_id, actor_id, from_status, to_status, note, created_at)
               VALUES (?, ?, ?, 'student_claimed', 'Student selected “I already submitted”', ?)""",
            s["id"], g.user["id"], s["status"], now)
        if g.user["tutor_id"]:
            create_followup("verify", g.user["tutor_id"],
                            f"{g.user['first_name']} says they submitted {s['title']}. Check Squad and update the status.",
                            add_working_days(utcnow(), 1), student_id=g.user["id"], rule_key=f"verify:{s['id']}:{now}")
            msg.staff_alert(g.user["tutor_id"], f"Please verify: {s['title']}",
                            f"{g.user['first_name']} {g.user['last_name']} selected “I already submitted”.",
                            f"/progress/{s['id']}")
    flash("Thanks — your tutor will check Squad and update your record.", "ok")
    return redirect(f"/progress/{s['id']}")


def load_plan(plan_id):
    return get("""SELECT p.*, u.first_name AS tutor_first, u.last_name AS tutor_last
                  FROM catchup_plans p JOIN users u ON u.id = p.tutor_id WHERE p.id = ?""", plan_id)


@bp.get("/plans/<int:plan_id>")
@login_required
def plan(plan_id):
    p = load_plan(plan_id)
    if not p or not can_see_student(g.user, p["student_id"]):
        abort(404)
    is_owner = g.user["id"] == p["student_id"]
    return render_template("plan.html", active="/progress" if is_owner else "/students", p=p, is_owner=is_owner)


@bp.post("/plans/<int:plan_id>/agree")
@login_required
def plan_agree(plan_id):
    p = load_plan(plan_id)
    if not p or p["student_id"] != g.user["id"]:
        abort(404)
    if p["status"] == "proposed":
        run("UPDATE catchup_plans SET status = 'agreed', agreed_at = ? WHERE id = ?", now_iso(), p["id"])
        msg.staff_alert(p["tutor_id"], f"{g.user['first_name']} agreed to the catch-up plan",
                        f"Check-in on {fmt(p['check_in_at'])}.", f"/plans/{p['id']}")
    flash("Plan agreed. Your tutor has been notified.", "ok")
    return redirect("/progress")


@bp.post("/plans/<int:plan_id>/complete")
@login_required
def plan_complete(plan_id):
    p = load_plan(plan_id)
    if not p or not is_staff(g.user) or not can_see_student(g.user, p["student_id"]):
        abort(404)
    run("UPDATE catchup_plans SET status = 'completed', completed_at = ? WHERE id = ?", now_iso(), p["id"])
    close_followups("plan_id = ?", [p["id"]], "Plan completed")
    flash("Plan marked complete.", "ok")
    return redirect(f"/students/{p['student_id']}")
