"""Rules engine, with the clock fixed at Wednesday 11 Nov 2026, 10:00 EAT."""
from datetime import datetime, timedelta, timezone

import pytest

from luxbound import db
from luxbound.db import all_, ensure_submission_rows, get, run
from luxbound.rules import run_rules
from luxbound.status import derive
from luxbound.timeutil import add_working_days, iso

H, D = timedelta(hours=1), timedelta(days=1)
NOW = datetime(2026, 11, 11, 7, 0, tzinfo=timezone.utc)
ts = lambda delta: iso(NOW + delta)  # noqa: E731
S = {}


@pytest.fixture(scope="module", autouse=True)
def database(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setenv("DB_PATH", str(tmp_path_factory.mktemp("rules") / "portal.db"))
    mp.setenv("RECURRING_THRESHOLD", "3")
    cohort = run("INSERT INTO cohorts (name, created_at) VALUES ('Cohort 9', ?)", ts(0 * H)).lastrowid

    def user(email, role, tutor=None):
        return run("INSERT INTO users (email, first_name, role, cohort_id, tutor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                   email, email.split("@")[0], role, cohort, tutor, ts(-60 * D)).lastrowid

    S["cohort"] = cohort
    S["lead"] = user("lead@x.test", "lead")
    S["tutor"] = user("tutor@x.test", "tutor")
    S["students"] = [user(f"s{i}@x.test", "student", S["tutor"]) for i in range(4)]

    def assignment(code, kind, delta):
        return run("""INSERT INTO assignments (cohort_id, code, title, kind, due_at, deliverables, created_at)
                      VALUES (?, ?, ?, ?, ?, 'GitHub link', ?)""", cohort, code, f"Item {code}", kind, ts(delta), ts(0 * H)).lastrowid

    S["soon"] = assignment("SOON", "assignment", 10 * H)
    S["late1"] = assignment("LATE1", "assignment", -2 * D)
    S["late2"] = assignment("LATE2", "assignment", -1 * D)
    S["proj"] = assignment("PROJ", "project", -3 * H)
    ensure_submission_rows(cohort)
    # Student 1 already submitted the item due soon.
    set_status(S["students"][1], S["soon"], "awaiting_review")
    yield
    db.close()
    mp.undo()


def sub(student, a):
    return get("SELECT * FROM submissions WHERE student_id = ? AND assignment_id = ?", student, a)


def set_status(student, a, status):
    run("UPDATE submissions SET status = ? WHERE student_id = ? AND assignment_id = ?", status, student, a)


def notices(student, kind):
    return all_("SELECT * FROM notifications WHERE user_id = ? AND kind = ?", student, kind)


def test_working_days_skip_the_weekend():
    fri = datetime(2026, 11, 13, 14, 0, tzinfo=timezone.utc)  # Fri 17:00 EAT
    assert iso(add_working_days(fri, 1)) == "2026-11-16T14:00:00.000Z"  # Mon 17:00 EAT
    sat = datetime(2026, 11, 14, 9, 0, tzinfo=timezone.utc)
    assert iso(add_working_days(sat, 1)) == "2026-11-17T05:00:00.000Z"  # Mon 08:00 → Tue 08:00 EAT


def test_unchecked_past_deadline_asks_to_confirm_not_overdue():
    run_rules(NOW)
    s = S["students"][0]
    assert len(notices(s, "confirm_submission")) == 3
    assert notices(s, "overdue") == []
    assert derive({**sub(s, S["late1"]), "due_at": ts(-2 * D)}, NOW)["overdue"] is False


def test_24h_reminder_only_while_outstanding_and_once():
    run_rules(NOW)
    run_rules(NOW)
    assert len(notices(S["students"][0], "reminder_24h")) == 1
    assert notices(S["students"][1], "reminder_24h") == []


def test_confirmed_missing_work_gets_one_overdue_notice():
    s = S["students"][2]
    set_status(s, S["late1"], "outstanding")
    run_rules(NOW)
    run_rules(NOW)
    n = notices(s, "overdue")
    assert len(n) == 1
    assert "still outstanding" in n[0]["body"]
    assert get("SELECT * FROM outbox WHERE notification_id = ?", n[0]["id"]), "email recorded"
    # One overdue assignment is not enough for a catch-up flag.
    assert get("SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ?", s)["n"] == 0


def test_two_overdue_assignments_flag_tutor_with_owner_action_due():
    s = S["students"][2]
    set_status(s, S["late2"], "outstanding")
    run_rules(NOW)
    f = all_("SELECT * FROM followups WHERE kind = 'catch_up' AND student_id = ?", s)
    assert len(f) == 1
    assert f[0]["owner_id"] == S["tutor"]
    assert "catch-up plan" in f[0]["next_action"]
    assert f[0]["due_at"] > iso(NOW)


def test_one_overdue_project_alone_triggers_catch_up():
    set_status(S["students"][3], S["proj"], "outstanding")
    run_rules(NOW)
    assert get("SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ?", S["students"][3])["n"] == 1


def test_extension_moves_the_deadline_used_for_reminders():
    s3 = S["students"][3]
    run("UPDATE submissions SET due_override_at = ?, override_reason = 'extension' WHERE student_id = ? AND assignment_id = ?",
        ts(5 * H), s3, S["proj"])
    run_rules(NOW)
    s = {**sub(s3, S["proj"]), "due_at": ts(-3 * H)}
    assert derive(s, NOW)["overdue"] is False
    assert len(all_("SELECT * FROM notifications WHERE user_id = ? AND dedupe_key LIKE ?", s3, f"remind24:{s['id']}:%")) == 1


def test_unanswered_ticket_after_one_working_day_is_flagged_to_lead():
    def ticket(student, created):
        return run("""INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, assignee_id, created_at, awaiting_since)
                      VALUES (?, ?, 'CTEs', 'x', ?, ?, ?)""", student, S["cohort"], S["tutor"], created, created).lastrowid

    old = ticket(S["students"][0], ts(-26 * H))
    fresh = ticket(S["students"][1], ts(-3 * H))
    run_rules(NOW)
    f = all_("SELECT * FROM followups WHERE kind = 'ticket_sla'")
    assert [x["ticket_id"] for x in f] == [old]
    assert f[0]["owner_id"] == S["lead"]
    assert get("SELECT escalated_at FROM tickets WHERE id = ?", old)["escalated_at"]
    assert get("SELECT escalated_at FROM tickets WHERE id = ?", fresh)["escalated_at"] is None


def test_same_issue_from_several_students_creates_one_recurring_issue():
    for s in S["students"][:3]:
        run("""INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, assignee_id, created_at, awaiting_since)
               VALUES (?, ?, 'PostgreSQL imports', 'copy', ?, ?, ?)""", s, S["cohort"], S["tutor"], ts(-H), ts(-H))
    run_rules(NOW)
    run_rules(NOW)
    issues = all_("SELECT * FROM issues WHERE skill = 'PostgreSQL imports'")
    assert len(issues) == 1
    assert get("SELECT COUNT(*) n FROM tickets WHERE issue_id = ?", issues[0]["id"])["n"] == 3
    assert get("SELECT COUNT(*) n FROM followups WHERE kind = 'shared_fix' AND issue_id = ?", issues[0]["id"])["n"] == 1
    # CTEs has only two students → no issue.
    assert get("SELECT COUNT(*) n FROM issues WHERE skill = 'CTEs'")["n"] == 0


def test_student_joining_mid_cohort_is_not_chased_for_earlier_deadlines():
    late = run("""INSERT INTO users (email, first_name, role, cohort_id, tutor_id, created_at)
                  VALUES ('late@x.test', 'late', 'student', ?, ?, ?)""", S["cohort"], S["tutor"], ts(-H)).lastrowid
    ensure_submission_rows(S["cohort"])
    run_rules(NOW)
    assert notices(late, "confirm_submission") == []
    assert len(notices(late, "reminder_24h")) == 1
