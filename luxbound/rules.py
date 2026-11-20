"""Early-warning rules: each signal triggers one specific follow-up.

Safe to run repeatedly: every notice and follow-up is keyed, so each fires once.
"""
import json
import os
from collections import Counter, defaultdict
from datetime import datetime

from . import messages as msg
from .db import all_, get, leads_for, run
from .status import OWING, derive, effective_due
from .timeutil import HOUR, DAY, add_working_days, iso, parse, utcnow

RECURRING_WINDOW = 14 * DAY


def recurring_threshold() -> int:
    return int(os.environ.get("RECURRING_THRESHOLD") or 3)


def student_name(u) -> str:
    return f"{u['first_name']} {u['last_name']}".strip()


def create_followup(kind, owner_id, next_action, due_at, student_id=None, ticket_id=None, issue_id=None,
                    plan_id=None, rule_key=None, at: datetime | None = None):
    """Create a follow-up once per rule key. Returns the new id, or None if it already existed."""
    at = at or utcnow()
    due = due_at if isinstance(due_at, str) else iso(due_at)
    cur = run(
        """INSERT OR IGNORE INTO followups (kind, owner_id, student_id, ticket_id, issue_id, plan_id, next_action, due_at, rule_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        kind, owner_id, student_id, ticket_id, issue_id, plan_id, next_action, due, rule_key, iso(at),
    )
    return cur.lastrowid if cur.rowcount else None


def close_followups(where: str, params, note: str):
    run(f"UPDATE followups SET status = 'done', done_at = ?, done_note = ? WHERE status = 'open' AND {where}",
        iso(utcnow()), note, *params)


def _submission_rows():
    return all_("""
        SELECT s.*, a.title, a.week, a.kind, a.skill, a.due_at, a.squad_url, a.deliverables, a.cohort_id,
               u.first_name, u.last_name, u.email, u.tutor_id, u.created_at AS joined_at
        FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN users u ON u.id = s.student_id
        WHERE a.required = 1 AND u.role = 'student' AND u.active = 1""")


def run_rules(at: datetime | None = None) -> dict:
    at = at or utcnow()
    summary = dict(reminders=0, overdueNotices=0, confirmRequests=0, catchUpFlags=0, ticketFlags=0,
                   recurringIssues=0, attachedToIssues=0)
    rows = _submission_rows()

    # ── Student notices: 24h reminder, overdue notice, or "please confirm" ──────────────
    for r in rows:
        due = effective_due(r)
        # Students who join mid-cohort aren't chased for deadlines that passed before they joined
        # (unless a tutor has since set a new deadline or confirmed the status).
        if due < r["joined_at"] and r["status"] == "not_checked":
            continue
        left = parse(due) - at
        if r["status"] in OWING and left.total_seconds() > 0 and left <= 24 * HOUR:
            if msg.reminder_24h(r, due):
                summary["reminders"] += 1
        if left.total_seconds() <= 0:
            if r["status"] == "outstanding":
                # Confirmed by a tutor (or a reliable Squad export) → overdue notice.
                if msg.overdue_notice(r, due):
                    summary["overdueNotices"] += 1
            elif r["status"] in ("not_checked", "revision_requested"):
                # Not checked → ask the student to confirm instead of marking overdue.
                if msg.confirm_submission_notice(r, due):
                    summary["confirmRequests"] += 1

    # ── Signal: two required assignments overdue, or a required project overdue ─────────
    overdue_by_student = defaultdict(list)
    for r in rows:
        if derive(r, at)["overdue"]:
            overdue_by_student[r["student_id"]].append(r)
    for student_id, items in overdue_by_student.items():
        projects = sum(1 for i in items if i["kind"] == "project")
        if len(items) < 2 and projects < 1:
            continue
        active = get(
            """SELECT 1 FROM followups WHERE student_id = ? AND kind IN ('catch_up','check_in') AND status = 'open'
               UNION SELECT 1 FROM catchup_plans WHERE student_id = ? AND status IN ('proposed','agreed')""",
            student_id, student_id,
        )
        if active:
            continue
        s = items[0]
        leads = leads_for(s["cohort_id"])
        owner_id = s["tutor_id"] or (leads[0]["id"] if leads else None)
        if not owner_id:
            continue
        reason = (f"{projects} required project{'s' if projects > 1 else ''} overdue" if projects
                  else f"{len(items)} required assignments overdue")
        key = f"catchup:{student_id}:{','.join(str(i['id']) for i in sorted(items, key=lambda x: x['id']))}"
        fid = create_followup(
            "catch_up", owner_id, f"{reason}. Check {student_name(s)}’s record and agree a catch-up plan.",
            add_working_days(at, 2), student_id=student_id, rule_key=key, at=at,
        )
        if fid:
            summary["catchUpFlags"] += 1
            msg.staff_alert(owner_id, f"Catch-up needed: {student_name(s)}",
                            f"{reason}: {', '.join(i['title'] for i in items)}. Check the record and propose a catch-up plan.",
                            f"/students/{student_id}", dedupe_key=f"alert:{key}")

    # ── Signal: technical ticket with no tutor reply after one working day ──────────────
    waiting = all_("""SELECT t.*, u.first_name, u.last_name, u.cohort_id AS student_cohort
                      FROM tickets t JOIN users u ON u.id = t.student_id WHERE t.status = 'awaiting_tutor'""")
    for t in waiting:
        if add_working_days(t["awaiting_since"], 1) > at:
            continue
        leads = leads_for(t["student_cohort"])
        if not leads:
            continue
        assignee = get("SELECT * FROM users WHERE id = ?", t["assignee_id"]) if t["assignee_id"] else None
        key = f"ticket-sla:{t['id']}:{t['awaiting_since']}"
        tail = f" — follow up with {assignee['first_name']} or reassign" if assignee else " — assign a tutor"
        fid = create_followup(
            "ticket_sla", leads[0]["id"],
            f"Ticket #{t['id']} ({t['skill']}) has had no tutor reply for over a working day{tail}.",
            at + 4 * HOUR, student_id=t["student_id"], ticket_id=t["id"], rule_key=key, at=at,
        )
        if fid:
            summary["ticketFlags"] += 1
            run("UPDATE tickets SET escalated_at = ? WHERE id = ?", iso(at), t["id"])
            msg.staff_alert(leads[0]["id"], f"Unanswered ticket #{t['id']}: {t['skill']}",
                            f"{student_name(t)} has waited over one working day for a tutor reply.",
                            f"/support/{t['id']}", dedupe_key=f"alert:{key}")

    # ── Signal: several students report the same issue ─────────────────────────────────
    since = iso(at - RECURRING_WINDOW)
    unlinked = all_("SELECT * FROM tickets WHERE status != 'resolved' AND issue_id IS NULL AND created_at >= ?", since)
    groups = defaultdict(list)
    for t in unlinked:
        groups[(t["cohort_id"], t["skill"])].append(t)
    for (cohort_id, skill), tickets in groups.items():
        issue = get("SELECT * FROM issues WHERE cohort_id = ? AND skill = ? AND status != 'resolved' ORDER BY id DESC",
                    cohort_id, skill)
        if not issue:
            students = {t["student_id"] for t in tickets}
            if len(students) < recurring_threshold():
                continue
            assignees = Counter(t["assignee_id"] for t in tickets if t["assignee_id"])
            leads = leads_for(cohort_id)
            owner_id = assignees.most_common(1)[0][0] if assignees else (leads[0]["id"] if leads else None)
            if not owner_id:
                continue
            cur = run("INSERT INTO issues (cohort_id, skill, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
                      cohort_id, skill, f"{len(students)} students blocked on {skill}", owner_id, iso(at))
            issue = get("SELECT * FROM issues WHERE id = ?", cur.lastrowid)
            summary["recurringIssues"] += 1
            create_followup(
                "shared_fix", owner_id,
                f"{len(students)} students report the same {skill} problem. Share a fix or run a walkthrough, "
                "then check they can proceed.",
                add_working_days(at, 1), issue_id=issue["id"], rule_key=f"issue:{issue['id']}", at=at,
            )
            for uid in [owner_id, *(lead["id"] for lead in leads)]:
                msg.staff_alert(uid, f"Recurring issue: {skill}", f"{len(students)} students have open tickets about {skill}.",
                                f"/issues/{issue['id']}", dedupe_key=f"alert:issue:{issue['id']}:{uid}")
        for t in tickets:
            run("UPDATE tickets SET issue_id = ? WHERE id = ?", issue["id"], t["id"])
            summary["attachedToIssues"] += 1
            # If a fix was already shared, send it straight to students who report it later.
            if issue["status"] == "fix_shared":
                msg.fix_shared(t, issue, get("SELECT * FROM users WHERE id = ?", t["student_id"]))

    run("INSERT INTO rule_runs (started_at, summary) VALUES (?, ?)", iso(at), json.dumps(summary))
    return summary
