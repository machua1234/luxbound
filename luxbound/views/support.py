import os
import secrets

from flask import Blueprint, abort, flash, g, redirect, render_template, request, send_from_directory

from .. import messages as msg
from .. import upload_dir
from ..auth import can_see_ticket, is_staff, login_required
from ..db import all_, get, leads_for, run
from ..rules import close_followups, create_followup
from ..status import DEFAULT_SKILLS, TICKET_STATUSES
from ..timeutil import add_working_days, fmt, now_iso, utcnow
from . import form

bp = Blueprint("support", __name__)

IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
MAX_SCREENSHOT = 5 * 1024 * 1024


def skills_for(cohort_id):
    from_assignments = [r["skill"] for r in all_("SELECT DISTINCT skill FROM assignments WHERE cohort_id = ? AND skill != ''", cohort_id)]
    seen, out = set(), []
    for s in [*(x for x in DEFAULT_SKILLS if x != "Other"), *from_assignments, "Other"]:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def visible_tickets(user, status):
    where, params = [], []
    if user["role"] == "student":
        where.append("t.student_id = ?")
        params.append(user["id"])
    if user["role"] == "tutor":
        where.append("(t.assignee_id = ? OR s.tutor_id = ?)")
        params += [user["id"], user["id"]]
    if status == "open":
        where.append("t.status != 'resolved'")
    elif status in TICKET_STATUSES:
        where.append("t.status = ?")
        params.append(status)
    return all_(f"""
        SELECT t.*, s.first_name, s.last_name, a.title AS assignment_title, au.first_name AS assignee_name
        FROM tickets t JOIN users s ON s.id = t.student_id LEFT JOIN assignments a ON a.id = t.assignment_id
        LEFT JOIN users au ON au.id = t.assignee_id
        {'WHERE ' + ' AND '.join(where) if where else ''}
        ORDER BY t.status = 'resolved', t.status = 'awaiting_student', t.awaiting_since""", *params)


@bp.get("/support")
@login_required
def support_list():
    status = request.args.get("status", "open")
    return render_template("support_list.html", active="/support", status=status, at=utcnow(),
                           tickets=visible_tickets(g.user, status), staff=is_staff(g.user),
                           filters=[("open", "Open"), *TICKET_STATUSES.items(), ("all", "All")])


@bp.get("/support/new")
@login_required
def support_new():
    if g.user["role"] != "student":
        return redirect("/support")
    pre = request.args.get("assignment", type=int)
    pre_skill = (get("SELECT skill FROM assignments WHERE id = ?", pre) or {}).get("skill", "") if pre else ""
    return render_template(
        "support_new.html", active="/support", pre=pre, pre_skill=pre_skill, skills=skills_for(g.user["cohort_id"]),
        assignments=all_("SELECT id, title FROM assignments WHERE cohort_id = ? ORDER BY due_at DESC", g.user["cohort_id"]),
    )


def save_screenshot(file):
    if not file or not file.filename:
        return None
    ext = IMAGE_TYPES.get(file.mimetype)
    if not ext:
        return None
    data = file.read(MAX_SCREENSHOT + 1)
    if len(data) > MAX_SCREENSHOT:
        return None
    name = secrets.token_hex(12) + ext
    with open(os.path.join(upload_dir(), name), "wb") as fh:
        fh.write(data)
    return name


@bp.post("/support")
@login_required
def support_create():
    if g.user["role"] != "student":
        abort(403)
    trying, tried = form("trying_to_do"), form("tried")
    if not trying or not tried:
        flash("Please describe what you were trying to do and what you tried.", "error")
        return redirect("/support/new")
    assignment_id = request.form.get("assignment_id", type=int)
    if assignment_id and not get("SELECT 1 FROM assignments WHERE id = ? AND cohort_id = ?", assignment_id, g.user["cohort_id"]):
        abort(400)
    skill = (form("skill") or "Other")[:80]
    now = now_iso()
    leads = leads_for(g.user["cohort_id"])
    assignee = g.user["tutor_id"] or (leads[0]["id"] if leads else None)
    cur = run("""INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, error_text, tried, screenshot,
                 assignment_id, assignee_id, created_at, awaiting_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
              g.user["id"], g.user["cohort_id"], skill, trying, request.form.get("error_text", ""), tried,
              save_screenshot(request.files.get("screenshot")), assignment_id, assignee, now, now)
    tid = cur.lastrowid
    if assignee:
        msg.staff_alert(assignee, f"New ticket #{tid}: {skill}",
                        f"{g.user['first_name']} {g.user['last_name']}: {trying[:160]}", f"/support/{tid}")
    flash("Sent. Your tutor will reply within one working day — you’ll get an email and a notification here.", "ok")
    return redirect(f"/support/{tid}")


def load_ticket(tid):
    return get("""SELECT t.*, s.first_name, s.last_name, s.email, s.tutor_id, a.title AS assignment_title, a.id AS a_id
                  FROM tickets t JOIN users s ON s.id = t.student_id LEFT JOIN assignments a ON a.id = t.assignment_id
                  WHERE t.id = ?""", tid)


def visible_ticket(tid):
    t = load_ticket(tid)
    if not t or not can_see_ticket(g.user, t):
        abort(404)
    return t


@bp.get("/support/<int:tid>")
@login_required
def ticket(tid):
    t = visible_ticket(tid)
    sub = None
    if t["a_id"]:
        sub = get("SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?", t["a_id"], t["student_id"])
    return render_template(
        "ticket.html", active="/support", t=t, sub=sub, staff=is_staff(g.user), is_owner=g.user["id"] == t["student_id"],
        messages=all_("""SELECT m.*, u.first_name, u.last_name, u.role FROM ticket_messages m JOIN users u ON u.id = m.author_id
                         WHERE ticket_id = ? ORDER BY m.created_at, m.id""", t["id"]),
        issue=get("SELECT * FROM issues WHERE id = ?", t["issue_id"]) if t["issue_id"] else None,
        assignee=get("SELECT * FROM users WHERE id = ?", t["assignee_id"]) if t["assignee_id"] else None,
        tutors=all_("SELECT * FROM users WHERE role IN ('tutor','lead') AND active = 1 ORDER BY first_name")
               if g.user["role"] == "lead" else [],
    )


@bp.post("/support/<int:tid>/reply")
@login_required
def reply(tid):
    t = visible_ticket(tid)
    body = form("body")
    if not body:
        return redirect(f"/support/{tid}")
    now = now_iso()
    run("INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)", tid, g.user["id"], body, now)
    if is_staff(g.user):
        run("""UPDATE tickets SET status = 'awaiting_student', first_reply_at = COALESCE(first_reply_at, ?),
               awaiting_since = ? WHERE id = ?""", now, now, tid)
        close_followups("kind = 'ticket_sla' AND ticket_id = ?", [tid], f"{g.user['first_name']} replied")
        msg.ticket_reply(t, g.user, t["student_id"])
    else:
        run("UPDATE tickets SET status = 'awaiting_tutor', awaiting_since = ?, escalated_at = NULL WHERE id = ?", now, tid)
        if t["assignee_id"]:
            msg.staff_alert(t["assignee_id"], f"Student replied on ticket #{tid}", body[:160], f"/support/{tid}")
    return redirect(f"/support/{tid}")


def maybe_close_proceed_check(issue_id):
    if not issue_id:
        return
    pending = get("SELECT COUNT(*) AS n FROM tickets WHERE issue_id = ? AND status != 'resolved' AND can_proceed IS NULL", issue_id)["n"]
    if pending == 0:
        close_followups("kind = 'proceed_check' AND issue_id = ?", [issue_id], "All affected students answered")


@bp.post("/support/<int:tid>/resolve")
@login_required
def resolve(tid):
    t = visible_ticket(tid)
    run("UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?", now_iso(), tid)
    close_followups("kind = 'ticket_sla' AND ticket_id = ?", [tid], "Ticket resolved")
    maybe_close_proceed_check(t["issue_id"])
    flash("Ticket closed.", "ok")
    return redirect(f"/support/{tid}")


@bp.post("/support/<int:tid>/proceed")
@login_required
def proceed(tid):
    t = load_ticket(tid)
    if not t or t["student_id"] != g.user["id"] or not t["issue_id"]:
        abort(404)
    now = now_iso()
    if request.form.get("answer") == "yes":
        run("UPDATE tickets SET can_proceed = 'yes', status = 'resolved', resolved_at = ? WHERE id = ?", now, tid)
        flash("Great — ticket closed. Keep going!", "ok")
    else:
        run("UPDATE tickets SET can_proceed = 'no', status = 'awaiting_tutor', awaiting_since = ? WHERE id = ?", now, tid)
        run("INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)",
            tid, g.user["id"], "The shared fix didn’t unblock me — I’m still stuck.", now)
        if t["assignee_id"]:
            msg.staff_alert(t["assignee_id"], f"Still blocked after shared fix: #{tid}",
                            f"{t['first_name']} {t['last_name']} can’t proceed yet.", f"/support/{tid}")
        flash("Thanks — your tutor will follow up with you directly.", "ok")
    maybe_close_proceed_check(t["issue_id"])
    return redirect(f"/support/{tid}")


@bp.post("/support/<int:tid>/assign")
@login_required
def assign(tid):
    if g.user["role"] != "lead":
        abort(403)
    t = load_ticket(tid)
    to = get("SELECT * FROM users WHERE id = ? AND role IN ('tutor','lead')", request.form.get("assignee_id", type=int))
    if not t or not to:
        abort(404)
    run("UPDATE tickets SET assignee_id = ? WHERE id = ?", to["id"], tid)
    close_followups("kind = 'ticket_sla' AND ticket_id = ?", [tid], f"Reassigned to {to['first_name']}")
    msg.staff_alert(to["id"], f"Ticket #{tid} reassigned to you",
                    f"{t['skill']} — {t['first_name']} {t['last_name']} has been waiting since {fmt(t['awaiting_since'])}.",
                    f"/support/{tid}")
    flash(f"Reassigned to {to['first_name']}.", "ok")
    return redirect(f"/support/{tid}")


# ── Recurring issues ────────────────────────────────────────────────────────────────────
def load_issue(issue_id):
    if not is_staff(g.user):
        abort(403)
    issue = get("SELECT i.*, u.first_name AS owner_first FROM issues i LEFT JOIN users u ON u.id = i.owner_id WHERE i.id = ?", issue_id)
    if not issue:
        abort(404)
    return issue


@bp.get("/issues/<int:issue_id>")
@login_required
def issue(issue_id):
    i = load_issue(issue_id)
    tickets = [t for t in all_("""SELECT t.*, s.first_name, s.last_name, s.tutor_id FROM tickets t JOIN users s ON s.id = t.student_id
                                  WHERE t.issue_id = ? ORDER BY t.created_at""", i["id"])
               if can_see_ticket(g.user, t) or i["owner_id"] == g.user["id"]]
    return render_template("issue.html", active="/support", issue=i, tickets=tickets,
                           answered=sum(1 for t in tickets if t["can_proceed"]),
                           open_count=sum(1 for t in tickets if t["status"] != "resolved"))


@bp.post("/issues/<int:issue_id>/fix")
@login_required
def issue_fix(issue_id):
    i = load_issue(issue_id)
    fix = form("fix_text")
    if not fix:
        abort(400)
    now = now_iso()
    run("UPDATE issues SET status = 'fix_shared', fix_text = ?, fix_shared_at = ? WHERE id = ?", fix, now, i["id"])
    updated = get("SELECT * FROM issues WHERE id = ?", i["id"])
    tickets = all_("SELECT * FROM tickets WHERE issue_id = ? AND status != 'resolved'", i["id"])
    for t in tickets:
        run("""UPDATE tickets SET status = 'awaiting_student', first_reply_at = COALESCE(first_reply_at, ?),
               awaiting_since = ?, can_proceed = NULL WHERE id = ?""", now, now, t["id"])
        run("INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)",
            t["id"], g.user["id"], f"Shared fix for everyone affected:\n\n{fix}", now)
        # Fresh dedupe key per fix version, so an updated fix reaches students too.
        run("UPDATE notifications SET dedupe_key = dedupe_key || ':' || id WHERE dedupe_key = ?", f"fix:{i['id']}:{t['id']}")
        msg.fix_shared(t, updated, get("SELECT * FROM users WHERE id = ?", t["student_id"]))
        close_followups("kind = 'ticket_sla' AND ticket_id = ?", [t["id"]], "Fix shared")
    close_followups("kind = 'shared_fix' AND issue_id = ?", [i["id"]], f"Fix shared by {g.user['first_name']}")
    create_followup("proceed_check", i["owner_id"] or g.user["id"],
                    f"Check that the {len(tickets)} students affected by the {i['skill']} issue can proceed.",
                    add_working_days(utcnow(), 1), issue_id=i["id"], rule_key=f"proceed:{i['id']}:{now}")
    flash(f"Fix sent to {len(tickets)} students.", "ok")
    return redirect(f"/issues/{i['id']}")


@bp.post("/issues/<int:issue_id>/resolve")
@login_required
def issue_resolve(issue_id):
    i = load_issue(issue_id)
    run("UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ?", now_iso(), i["id"])
    close_followups("issue_id = ?", [i["id"]], "Issue closed")
    flash("Issue closed. New tickets on this skill will start a fresh count.", "ok")
    return redirect(f"/issues/{i['id']}")


@bp.get("/uploads/<path:name>")
@login_required
def upload(name):
    """Screenshots are only served to people who can see the ticket."""
    t = get("SELECT * FROM tickets WHERE screenshot = ?", os.path.basename(name))
    if not t or not can_see_ticket(g.user, t):
        abort(404)
    return send_from_directory(upload_dir(), t["screenshot"])
