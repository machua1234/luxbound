"""Reset the database and load a realistic Cohort 9 pilot, with deadlines relative to now."""
import os
from datetime import timedelta

from . import db
from .auth import hash_password
from .db import ensure_submission_rows, run
from .rules import run_rules
from .timeutil import DAY, HOUR, iso, now_iso, utcnow

PASSWORD = "luxdev123"


def seed() -> dict:
    path = db.db_path()
    db.close()
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    db.forget(path)

    pw = hash_password(PASSWORD)
    now = utcnow()
    ago = lambda d: iso(now - d)  # noqa: E731
    ahead = lambda d: iso(now + d)  # noqa: E731

    cohort_id = run("INSERT INTO cohorts (name, created_at) VALUES (?, ?)", "Cohort 9", now_iso()).lastrowid

    def user(email, first, last, role, tutor_id=None):
        return run("""INSERT INTO users (email, first_name, last_name, role, cohort_id, tutor_id, password_hash, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                   email, first, last, role, cohort_id, tutor_id, pw, ago(60 * DAY)).lastrowid

    user("lead@luxdevhq.test", "Amina", "Otieno", "lead")
    brian = user("brian@luxdevhq.test", "Brian", "Kamau", "tutor")
    wanjiru = user("wanjiru@luxdevhq.test", "Wanjiru", "Njeri", "tutor")
    S = {
        "achieng": user("achieng@students.test", "Achieng", "Odhiambo", "student", brian),
        "kevin": user("kevin@students.test", "Kevin", "Mwangi", "student", brian),
        "faith": user("faith@students.test", "Faith", "Wambui", "student", brian),
        "daniel": user("daniel@students.test", "Daniel", "Kiprop", "student", brian),
        "grace": user("grace@students.test", "Grace", "Atieno", "student", wanjiru),
        "samuel": user("samuel@students.test", "Samuel", "Omondi", "student", wanjiru),
        "mercy": user("mercy@students.test", "Mercy", "Chebet", "student", wanjiru),
        "ian": user("ian@students.test", "Ian", "Mutua", "student", wanjiru),
    }

    A = {}
    for key, code, title, week, kind, skill, due, deliverables in [
        ("w08", "W08-SQL", "Week 8 SQL joins assignment", 8, "assignment", "Joins", ago(17 * DAY), "GitHub link"),
        ("w09", "W09-CTE", "Week 9 CTEs assignment", 9, "assignment", "CTEs", ago(10 * DAY), "GitHub link"),
        ("w10", "W10-SQL", "Week 10 SQL assignment", 10, "assignment", "PostgreSQL imports", ago(3 * DAY), "GitHub link"),
        ("p1", "P1", "Project 1: Sales data pipeline", 10, "project", "Python", ago(1 * DAY),
         "GitHub link; README with setup steps; dashboard screenshot"),
        ("w11", "W11-PY", "Week 11 Python assignment", 11, "assignment", "Python", ahead(18 * HOUR), "GitHub link"),
        ("w12", "W12-PD", "Week 12 pandas assignment", 12, "assignment", "pandas", ahead(6 * DAY), "GitHub link; notebook export"),
    ]:
        A[key] = run("""INSERT INTO assignments (cohort_id, code, title, week, kind, skill, due_at, squad_url, deliverables, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                     cohort_id, code, title, week, kind, skill, due,
                     f"https://squad.example.com/luxdevhq/cohort-9/project-lab/{code.lower()}", deliverables, now_iso()).lastrowid
    ensure_submission_rows(cohort_id)

    def set_(student, a, status, **extra):
        fields = {"status": status, "verified_by": brian, "verified_at": ago(2 * HOUR), "status_source": "tutor",
                  "updated_at": now_iso()} | extra
        cols = ", ".join(f"{k} = ?" for k in fields)
        run(f"UPDATE submissions SET {cols} WHERE student_id = ? AND assignment_id = ?", *fields.values(), student, A[a])

    unchecked = dict(verified_by=None, verified_at=None)
    # Default: everything past due is approved, the project awaits review, future work not checked yet.
    for sid in S.values():
        for a in ("w08", "w09", "w10"):
            set_(sid, a, "approved")
        set_(sid, "p1", "awaiting_review")
    # Achieng: one confirmed overdue assignment, project unchecked, Python due tomorrow, and a ticket open.
    set_(S["achieng"], "w10", "outstanding")
    set_(S["achieng"], "p1", "not_checked", **unchecked)
    # Kevin: two assignments overdue → catch-up flag for Brian.
    set_(S["kevin"], "w09", "outstanding")
    set_(S["kevin"], "w10", "outstanding")
    # Faith: revision requested with a resubmission deadline.
    set_(S["faith"], "w10", "revision_requested", revision_items="Query for question 4; README explaining the import steps",
         due_override_at=ahead(2 * DAY), override_reason="resubmission")
    # Daniel: project overdue → catch-up flag. Says he submitted Week 10.
    set_(S["daniel"], "p1", "outstanding")
    set_(S["daniel"], "w10", "student_claimed", student_note="Submitted on Sunday night, the link is in Project Lab.",
         status_source="student", **unchecked)
    # Grace & Mercy: Week 10 awaiting review / not yet checked.
    set_(S["grace"], "w10", "awaiting_review")
    set_(S["mercy"], "w10", "not_checked", **unchecked)
    # Ian has an extension on the project.
    set_(S["ian"], "p1", "outstanding", due_override_at=ahead(3 * DAY), override_reason="extension")

    def ticket(student, skill, a, created, trying, error, tried, assignee, status="awaiting_tutor"):
        return run("""INSERT INTO tickets (student_id, cohort_id, skill, trying_to_do, error_text, tried, assignment_id,
                      status, assignee_id, created_at, awaiting_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                   student, cohort_id, skill, trying, error, tried, A[a] if a else None, status, assignee, created, created).lastrowid

    copy_err = ('ERROR:  invalid input syntax for type date: "31/01/2024"\n'
                'CONTEXT:  COPY sales, line 2, column order_date: "31/01/2024"')
    ticket(S["achieng"], "PostgreSQL imports", "w10", ago(2 * HOUR), "Import sales.csv into the sales table with \\copy for the Week 10 assignment.",
           copy_err, "Re-saved the CSV as UTF-8 and checked the column order.", brian)
    ticket(S["grace"], "PostgreSQL imports", "w10", ago(4 * DAY), "Load the orders CSV into PostgreSQL using pgAdmin’s import tool.",
           copy_err, "Changed the column type to text — it imports but then I can’t filter by date.", wanjiru)
    ticket(S["samuel"], "PostgreSQL imports", None, ago(5 * HOUR), "Running COPY from the course dataset.",
           copy_err, "Searched the error, tried SET datestyle but not sure what value.", wanjiru)
    resolved = ticket(S["ian"], "CTEs", "w09", ago(9 * DAY), "Chain two CTEs to compute monthly revenue growth.",
                      'ERROR:  syntax error at or near "WITH"', "Checked commas.", wanjiru, status="resolved")
    replied = ago(9 * DAY - 3 * HOUR)
    run("INSERT INTO ticket_messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)", resolved, wanjiru,
        "You only need one WITH — separate CTEs with commas: WITH a AS (...), b AS (...) SELECT ...", replied)
    run("UPDATE tickets SET first_reply_at = ?, resolved_at = ? WHERE id = ?", replied, ago(8 * DAY), resolved)

    return run_rules()
