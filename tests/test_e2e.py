"""End-to-end: the real app on a temp DB with the demo seed, walking every feature as each role."""
import io
import re
from pathlib import Path

import pytest

from luxbound import create_app, db
from luxbound.db import all_, get
from luxbound.seed import seed

SAMPLES = Path(__file__).resolve().parent.parent / "luxbound" / "static" / "samples"
BASE = "http://portal.test"
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bb0000000049454e44ae426082")


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("e2e")
    mp = pytest.MonkeyPatch()
    for var in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS"):
        mp.delenv(var, raising=False)
    mp.setenv("DB_PATH", str(tmp / "portal.db"))
    mp.setenv("UPLOAD_DIR", str(tmp / "uploads"))
    mp.setenv("PORTAL_URL", BASE)
    seed()
    app = create_app({"TESTING": True})
    yield app
    db.close()
    mp.undo()


def q(sql, *p):
    return get(sql, *p)


def user_id(email):
    return q("SELECT id FROM users WHERE email = ?", email)["id"]


def sub_id(email, code):
    return q("""SELECT s.id FROM submissions s JOIN users u ON u.id = s.student_id JOIN assignments a ON a.id = s.assignment_id
                WHERE u.email = ? AND a.code = ?""", email, code)["id"]


class Client:
    def __init__(self, app):
        self.c = app.test_client()

    def get(self, path):
        return self.c.get(path)

    def csrf(self, path):
        m = re.search(r'name="_csrf" value="([^"]+)"', self.c.get(path).get_data(as_text=True))
        return m.group(1) if m else ""

    def post(self, path, data=None, frm=None):
        frm = frm or re.sub(r"/[a-z-]+$", "", path)
        payload = {"_csrf": self.csrf(frm), **(data or {})}
        return self.c.post(path, data=payload)

    def upload(self, path, fields, frm, files=None):
        data = {"_csrf": self.csrf(frm), **fields}
        for k, (content, name, ctype) in (files or {}).items():
            data[k] = (io.BytesIO(content), name, ctype)
        return self.c.post(path, data=data, content_type="multipart/form-data")

    def login(self, email, password="luxdev123"):
        r = self.post("/login", {"email": email, "password": password}, "/login")
        assert r.status_code == 302
        return r


def text(r):
    return r.get_data(as_text=True)


def ok(r, what):
    assert r.status_code in (200, 302), f"{what}: got {r.status_code}"


@pytest.fixture(scope="module")
def users(app):
    out = {}
    for name, email in [("lead", "lead@luxdevhq.test"), ("david", "david@luxdevhq.test"), ("wanjiru", "wanjiru@luxdevhq.test"),
                        ("achieng", "achieng@students.test"), ("kevin", "kevin@students.test"), ("grace", "grace@students.test")]:
        out[name] = Client(app)
        out[name].login(email)
    return out


def test_auth_bad_password_and_role_home_pages(app, users):
    anon = Client(app)
    assert anon.get("/progress").headers["Location"] == "/login?next=%2Fprogress"
    bad = anon.post("/login", {"email": "achieng@students.test", "password": "nope"}, "/login")
    assert bad.headers["Location"].startswith("/login")
    assert anon.c.get_cookie("lp_session") is None
    assert users["lead"].get("/").headers["Location"] == "/overview"
    assert users["david"].get("/").headers["Location"] == "/queue"
    assert users["achieng"].get("/").headers["Location"] == "/progress"


def test_forgot_password_email_link_sets_new_password(app):
    anon = Client(app)
    anon.post("/forgot", {"email": "mercy@students.test"}, "/forgot")
    mail = q("SELECT * FROM outbox WHERE to_email = 'mercy@students.test' AND subject = 'Reset your password'")
    assert mail, "reset email recorded"
    assert BASE in mail["text"], "email links use PORTAL_URL"
    link = re.search(r"/set-password\?token=[a-f0-9]+", mail["text"]).group(0)
    r = anon.post("/set-password", {"token": link.split("=")[1], "password": "newpass123"}, link)
    assert r.headers["Location"] == "/"
    again = Client(app)
    again.login("mercy@students.test", "newpass123")
    assert again.get("/").headers["Location"] == "/progress"
    assert "expired" in text(Client(app).get(link)), "token is single-use"


def test_sign_out_ends_the_session(app):
    c = Client(app)
    c.login("ian@students.test")
    c.post("/logout", {}, "/progress")
    assert c.get("/progress").headers["Location"].startswith("/login")


def test_every_page_renders_for_the_right_role(users):
    pages = {
        "lead": ["/overview", "/queue", "/queue?owner=all", "/students", "/assignments", "/support", "/support?status=all",
                 "/admin", "/admin/outbox", "/notifications", "/issues/1"],
        "david": ["/queue", "/students", "/assignments", "/support", "/notifications"],
        "achieng": ["/progress", "/support", "/support/new", "/notifications"],
    }
    for who, paths in pages.items():
        for p in paths:
            assert users[who].get(p).status_code == 200, f"{who} {p}"
    a = q("SELECT id FROM assignments LIMIT 1")["id"]
    assert users["david"].get(f"/assignments/{a}").status_code == 200
    assert users["david"].get(f"/students/{user_id('kevin@students.test')}").status_code == 200


def test_privacy_students_and_tutors_only_see_what_they_should(users):
    grace = user_id("grace@students.test")
    for p in ["/queue", "/overview", "/admin", f"/students/{grace}", "/assignments"]:
        assert users["achieng"].get(p).status_code == 403, f"student {p}"
    assert users["achieng"].get(f"/progress/{sub_id('grace@students.test', 'W10-SQL')}").status_code == 404
    grace_ticket = q("SELECT id FROM tickets WHERE student_id = ?", grace)["id"]
    assert users["achieng"].get(f"/support/{grace_ticket}").status_code == 404
    assert users["david"].get("/overview").status_code == 403
    assert users["david"].get("/admin").status_code == 403
    # David is not Grace's tutor and doesn't handle her tickets.
    assert users["david"].get(f"/students/{grace}").status_code == 404
    assert users["david"].get(f"/support/{grace_ticket}").status_code == 404
    assert "Grace" not in text(users["david"].get("/students"))


def test_post_without_csrf_token_is_refused(users):
    r = users["achieng"].c.post(f"/progress/{sub_id('achieng@students.test', 'W10-SQL')}/claim", data={})
    assert r.status_code == 403


def test_my_progress_shows_owed_work_side_by_side_and_next_step(users):
    page = text(users["achieng"].get("/progress"))
    for s in ("Submission status", "Support status", "Needs your attention", "Week 10 SQL assignment"):
        assert s in page
    rec = text(users["achieng"].get(f"/progress/{sub_id('achieng@students.test', 'W10-SQL')}"))
    for s in ("Overdue", "What to do next", "I already submitted", "Report a blocker", "squad.example.com", "Notices sent"):
        assert s in rec


def test_already_submitted_creates_verify_followup_then_tutor_confirms(users):
    sid = sub_id("achieng@students.test", "P1")
    ok(users["achieng"].post(f"/progress/{sid}/claim", {}, f"/progress/{sid}"), "claim")
    assert q("SELECT status FROM submissions WHERE id = ?", sid)["status"] == "student_claimed"
    assert q("SELECT 1 FROM followups WHERE kind = 'verify' AND status = 'open' AND rule_key LIKE ?", f"verify:{sid}:%")
    assert "Student says submitted" in text(users["david"].get("/queue"))
    ok(users["david"].post(f"/submissions/{sid}/status", {"status": "awaiting_review", "back": "/queue"}, "/queue"), "verify")
    assert q("SELECT status FROM submissions WHERE id = ?", sid)["status"] == "awaiting_review"
    assert q("SELECT COUNT(*) n FROM followups WHERE kind = 'verify' AND status = 'open' AND rule_key LIKE ?", f"verify:{sid}:%")["n"] == 0
    assert "Awaiting tutor review" in text(users["achieng"].get(f"/progress/{sid}"))


def test_report_blocker_with_private_screenshot_reply_and_resolve(users):
    aid = q("SELECT id FROM assignments WHERE code = 'W11-PY'")["id"]
    r = users["achieng"].upload("/support", {
        "skill": "Python", "assignment_id": str(aid), "trying_to_do": "Run the pipeline script",
        "error_text": "ModuleNotFoundError: No module named 'pandas'", "tried": "pip install pandas",
    }, f"/support/new?assignment={aid}", {"screenshot": (PNG, "err.png", "image/png")})
    assert r.status_code == 302
    tid = int(r.headers["Location"].rsplit("/", 1)[1])
    t = q("SELECT * FROM tickets WHERE id = ?", tid)
    assert t["assignee_id"] == user_id("david@luxdevhq.test")
    assert t["assignment_id"] == aid
    assert t["screenshot"]
    assert users["achieng"].get(f"/uploads/{t['screenshot']}").status_code == 200
    assert users["grace"].get(f"/uploads/{t['screenshot']}").status_code == 404
    assert q("SELECT 1 FROM notifications WHERE user_id = ? AND link = ?", t["assignee_id"], f"/support/{tid}"), "tutor alerted"
    bad = users["achieng"].upload("/support", {"skill": "Python", "trying_to_do": "", "tried": ""}, "/support/new")
    assert bad.headers["Location"] == "/support/new"

    ok(users["david"].post(f"/support/{tid}/reply", {"body": "Activate your venv first."}), "tutor reply")
    after = q("SELECT * FROM tickets WHERE id = ?", tid)
    assert after["status"] == "awaiting_student"
    assert after["first_reply_at"]
    assert q("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'ticket_reply'", user_id("achieng@students.test"))
    ok(users["achieng"].post(f"/support/{tid}/reply", {"body": "Still failing"}), "student reply")
    assert q("SELECT status FROM tickets WHERE id = ?", tid)["status"] == "awaiting_tutor"
    ok(users["achieng"].post(f"/support/{tid}/resolve"), "resolve")
    assert q("SELECT status FROM tickets WHERE id = ?", tid)["status"] == "resolved"
    assert "Resolved" in text(users["achieng"].get(f"/support/{tid}"))


def test_revision_request_lists_missing_deliverables_and_deadline(users):
    sid = sub_id("achieng@students.test", "P1")
    ok(users["david"].post(f"/submissions/{sid}/revision", {"items": "README with setup steps\nDashboard screenshot",
                                                           "due": "2026-12-20T23:59"}, f"/progress/{sid}"), "revision")
    s = q("SELECT * FROM submissions WHERE id = ?", sid)
    assert s["status"] == "revision_requested"
    assert s["override_reason"] == "resubmission"
    assert s["due_override_at"] == "2026-12-20T20:59:00.000Z"
    mail = q("SELECT * FROM outbox WHERE to_email = 'achieng@students.test' AND subject LIKE 'Revision requested%'")
    for s_ in ("README with setup steps", "Dashboard screenshot", "20 Dec 2026"):
        assert s_ in mail["text"]
    assert "Still missing" in text(users["achieng"].get(f"/progress/{sid}"))


def test_extension_changes_deadline_and_clears_overdue(users):
    sid = sub_id("achieng@students.test", "W10-SQL")
    ok(users["david"].post(f"/submissions/{sid}/extension", {"due": "2026-12-01T23:59", "note": "Family emergency"},
                           f"/progress/{sid}"), "extension")
    s = q("SELECT * FROM submissions WHERE id = ?", sid)
    assert s["override_reason"] == "extension"
    assert q("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'extension'", s["student_id"])
    assert 'pill bad">Overdue' not in text(users["achieng"].get(f"/progress/{sid}"))


def test_bulk_confirm_from_squad_and_approve(users):
    aid = q("SELECT id FROM assignments WHERE code = 'W10-SQL'")["id"]
    daniel, faith = sub_id("daniel@students.test", "W10-SQL"), sub_id("faith@students.test", "W10-SQL")
    b = users["david"]
    r = b.c.post(f"/assignments/{aid}/bulk", data={"_csrf": b.csrf(f"/assignments/{aid}"), "status": "awaiting_review",
                                                  "ids": [str(daniel), str(faith)]})
    ok(r, "bulk")
    assert q("SELECT status FROM submissions WHERE id = ?", daniel)["status"] == "awaiting_review"
    assert q("SELECT status FROM submissions WHERE id = ?", faith)["status"] == "awaiting_review"
    ok(b.post(f"/submissions/{daniel}/status", {"status": "approved", "back": "/queue"}, "/queue"), "approve")
    assert q("SELECT status FROM submissions WHERE id = ?", daniel)["status"] == "approved"
    grace_sub = sub_id("grace@students.test", "W10-SQL")
    assert b.post(f"/submissions/{grace_sub}/status", {"status": "approved"}, "/queue").status_code == 404


def test_confirming_no_submission_sends_the_overdue_email(users):
    sid = sub_id("mercy@students.test", "W10-SQL")
    ok(users["wanjiru"].post(f"/submissions/{sid}/status", {"status": "outstanding", "back": "/queue"}, "/queue"), "outstanding")
    mail = q("SELECT * FROM outbox WHERE to_email = 'mercy@students.test' AND subject = 'Your Week 10 SQL assignment is overdue'")
    assert mail, "overdue email sent"
    for s in ("Our records show that your GitHub link is still outstanding", "I already submitted", "Report a blocker",
              "View assignment status: http"):
        assert s in mail["text"]


def test_catch_up_plan_propose_agree_complete(users):
    kevin = user_id("kevin@students.test")
    assert q("SELECT 1 FROM followups WHERE kind = 'catch_up' AND student_id = ? AND status = 'open'", kevin), "flagged by rule"
    w09 = sub_id("kevin@students.test", "W09-CTE")
    ok(users["david"].post(f"/students/{kevin}/plan", {"plan": "Finish W09 first, then W10.", "check_in": "2026-11-16T10:00",
                                                      f"due_{w09}": "2026-11-15T23:59"}, f"/students/{kevin}/plan"), "propose")
    plan = q("SELECT * FROM catchup_plans WHERE student_id = ?", kevin)
    assert plan["status"] == "proposed"
    assert q("SELECT override_reason FROM submissions WHERE id = ?", w09)["override_reason"] == "catch_up"
    assert q("SELECT COUNT(*) n FROM followups WHERE kind = 'catch_up' AND student_id = ? AND status = 'open'", kevin)["n"] == 0
    assert q("SELECT 1 FROM followups WHERE kind = 'check_in' AND plan_id = ? AND status = 'open'", plan["id"])
    mail = q("SELECT * FROM outbox WHERE to_email = 'kevin@students.test' AND subject LIKE 'A catch-up plan from David%'")
    assert "Let’s check in on" in mail["text"] and "Week 9 CTEs assignment" in mail["text"]
    assert "Review and agree" in text(users["kevin"].get("/progress"))
    ok(users["kevin"].post(f"/plans/{plan['id']}/agree", {}, f"/plans/{plan['id']}"), "agree")
    assert q("SELECT status FROM catchup_plans WHERE id = ?", plan["id"])["status"] == "agreed"
    ok(users["david"].post(f"/plans/{plan['id']}/complete", {}, f"/plans/{plan['id']}"), "complete")
    assert q("SELECT status FROM catchup_plans WHERE id = ?", plan["id"])["status"] == "completed"
    assert q("SELECT status FROM followups WHERE kind = 'check_in' AND plan_id = ?", plan["id"])["status"] == "done"


def test_tutor_queue_followup_can_be_marked_done(users):
    f = q("SELECT * FROM followups WHERE kind = 'catch_up' AND status = 'open' AND owner_id = ?", user_id("david@luxdevhq.test"))
    assert f, "Daniel catch-up still open"
    page = text(users["david"].get("/queue"))
    assert "Next action" in page and "Propose plan" in page
    ok(users["david"].post(f"/followups/{f['id']}/done", {}, "/queue"), "done")
    assert q("SELECT status FROM followups WHERE id = ?", f["id"])["status"] == "done"


def test_lead_reassigns_flagged_ticket(users):
    t = q("SELECT * FROM tickets WHERE escalated_at IS NOT NULL")
    assert t, "seeded SLA breach was flagged"
    lead = user_id("lead@luxdevhq.test")
    assert q("SELECT 1 FROM followups WHERE kind = 'ticket_sla' AND ticket_id = ? AND status = 'open' AND owner_id = ?", t["id"], lead)
    assert "Unanswered tickets" in text(users["lead"].get("/overview"))
    david = user_id("david@luxdevhq.test")
    ok(users["lead"].post(f"/support/{t['id']}/assign", {"assignee_id": str(david)}), "reassign")
    assert q("SELECT assignee_id FROM tickets WHERE id = ?", t["id"])["assignee_id"] == david
    assert q("SELECT status FROM followups WHERE kind = 'ticket_sla' AND ticket_id = ?", t["id"])["status"] == "done"
    assert q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE ?", david, f"Ticket #{t['id']} reassigned%")


def test_recurring_issue_fix_then_can_you_proceed(users):
    issue = q("SELECT * FROM issues WHERE skill = 'PostgreSQL imports'")
    ok(users["lead"].post(f"/issues/{issue['id']}/fix", {"fix_text": "Run SET datestyle TO 'ISO, DMY'; before \\copy"}), "fix")
    assert q("SELECT status FROM issues WHERE id = ?", issue["id"])["status"] == "fix_shared"
    affected = all_("SELECT * FROM tickets WHERE issue_id = ?", issue["id"])
    for t in affected:
        assert q("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'issue_fix'", t["student_id"])
    assert q("SELECT 1 FROM followups WHERE kind = 'proceed_check' AND issue_id = ? AND status = 'open'", issue["id"])
    at = next(t for t in affected if t["student_id"] == user_id("achieng@students.test"))
    gt = next(t for t in affected if t["student_id"] == user_id("grace@students.test"))
    assert "Can you continue now" in text(users["achieng"].get(f"/support/{at['id']}"))
    ok(users["achieng"].post(f"/support/{at['id']}/proceed", {"answer": "yes"}), "yes")
    ok(users["grace"].post(f"/support/{gt['id']}/proceed", {"answer": "no"}), "no")
    assert q("SELECT status FROM tickets WHERE id = ?", at["id"])["status"] == "resolved"
    assert q("SELECT status FROM tickets WHERE id = ?", gt["id"])["status"] == "awaiting_tutor"
    assert "Still blocked" in text(users["lead"].get(f"/issues/{issue['id']}"))
    ok(users["lead"].post(f"/issues/{issue['id']}/resolve"), "close issue")
    assert q("SELECT status FROM issues WHERE id = ?", issue["id"])["status"] == "resolved"


def test_imports_and_invite_lets_new_user_set_password(app, users):
    lead = users["lead"]
    ok(lead.upload("/admin/import/roster", {"cohort_id": "1"}, "/admin",
                   {"file": ((SAMPLES / "roster.csv").read_bytes(), "roster.csv", "text/csv")}), "roster")
    neema = q("SELECT * FROM users WHERE email = 'new.student@students.test'")
    assert neema and neema["tutor_id"] == user_id("wanjiru@luxdevhq.test")
    invite = q("SELECT * FROM outbox WHERE to_email = 'new.student@students.test' AND subject LIKE 'Welcome%'")
    link = re.search(r"/set-password\?token=[a-f0-9]+", invite["text"]).group(0)
    n = Client(app)
    ok(n.post("/set-password", {"token": link.split("=")[1], "password": "neema12345"}, link), "set pw")
    assert n.get("/").headers["Location"] == "/progress"

    assignments_csv = (SAMPLES / "assignments.csv").read_bytes()
    ok(lead.upload("/admin/import/assignments", {"cohort_id": "1"}, "/admin", {"file": (assignments_csv, "a.csv", "text/csv")}), "assignments")
    p2 = q("SELECT * FROM assignments WHERE code = 'P2'")
    assert p2["kind"] == "project"
    assert q("SELECT 1 FROM submissions WHERE assignment_id = ? AND student_id = ?", p2["id"], neema["id"])
    lead.upload("/admin/import/assignments", {"cohort_id": "1"}, "/admin", {"file": (assignments_csv, "a.csv", "text/csv")})
    assert q("SELECT COUNT(*) n FROM assignments WHERE code = 'P2'")["n"] == 1, "re-import updates, never duplicates"

    ok(lead.upload("/admin/import/status", {"cohort_id": "1"}, "/admin",
                   {"file": ((SAMPLES / "status.csv").read_bytes(), "s.csv", "text/csv")}), "status")
    assert q("SELECT status_source FROM submissions WHERE id = ?", sub_id("mercy@students.test", "W10-SQL"))["status_source"] == "tutor"
    assert len(all_("SELECT * FROM imports")) == 4
    ok(lead.upload("/admin/import/assignments", {"cohort_id": "1"}, "/admin",
                   {"file": (b"code,title,due_at\nX,,nope\n", "bad.csv", "text/csv")}), "bad import")
    assert "row 2" in q("SELECT errors FROM imports ORDER BY id DESC")["errors"]


def test_add_staff_change_tutor_run_rules_outbox(users):
    lead = users["lead"]
    ok(lead.post("/admin/staff", {"first_name": "Otieno", "last_name": "Ouma", "email": "otieno@luxdevhq.test", "role": "tutor"}, "/admin"), "staff")
    otieno = user_id("otieno@luxdevhq.test")
    assert q("SELECT 1 FROM outbox WHERE to_email = 'otieno@luxdevhq.test'")
    ian = user_id("ian@students.test")
    ok(lead.post(f"/students/{ian}/tutor", {"tutor_id": str(otieno)}, f"/students/{ian}"), "set tutor")
    assert q("SELECT tutor_id FROM users WHERE id = ?", ian)["tutor_id"] == otieno
    runs = q("SELECT COUNT(*) n FROM rule_runs")["n"]
    ok(lead.post("/admin/rules/run", {}, "/admin"), "run rules")
    assert q("SELECT COUNT(*) n FROM rule_runs")["n"] == runs + 1
    assert "Your Week 10 SQL assignment is overdue" in text(lead.get("/admin/outbox"))


def test_notifications_open_marks_read_and_read_all(users):
    kevin = users["kevin"]
    me = user_id("kevin@students.test")
    n = q("SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL AND link IS NOT NULL", me)
    assert n["title"][:20] in text(kevin.get("/notifications"))
    assert kevin.get(f"/n/{n['id']}").headers["Location"] == n["link"]
    assert q("SELECT read_at FROM notifications WHERE id = ?", n["id"])["read_at"]
    other = q("SELECT id FROM notifications WHERE user_id != ? LIMIT 1", me)["id"]
    assert kevin.get(f"/n/{other}").headers["Location"] == "/notifications"
    ok(kevin.post("/notifications/read-all", {}, "/notifications"), "read all")
    assert q("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL", me)["n"] == 0


def test_every_notice_has_an_email_status():
    assert q("SELECT COUNT(*) n FROM notifications WHERE email_status IS NULL")["n"] == 0
    assert q("SELECT COUNT(*) n FROM notifications WHERE email_status = 'failed'")["n"] == 0
