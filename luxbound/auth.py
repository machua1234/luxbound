"""Sessions, passwords, CSRF and who-can-see-what."""
import hashlib
import hmac
import secrets
from datetime import timedelta
from functools import wraps
from urllib.parse import quote

from flask import abort, current_app, g, redirect, request
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get, run
from .timeutil import iso, now_iso, utcnow

COOKIE = "lp_session"


def _to_login():
    return redirect("/login?next=" + quote(request.full_path.rstrip("?"), safe=""))
SESSION_DAYS = 14


def hash_password(pw: str) -> str:
    return generate_password_hash(pw)


def verify_password(pw: str, stored: str | None) -> bool:
    return bool(stored) and check_password_hash(stored, pw)


def start_session(response, user_id: int):
    token = secrets.token_hex(32)
    run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        token, user_id, iso(utcnow() + timedelta(days=SESSION_DAYS)))
    response.set_cookie(COOKIE, token, httponly=True, samesite="Lax",
                        secure=current_app.config.get("COOKIE_SECURE", False), max_age=SESSION_DAYS * 86400)


def end_session(response):
    token = request.cookies.get(COOKIE)
    if token:
        run("DELETE FROM sessions WHERE token = ?", token)
    response.delete_cookie(COOKIE)


def load_user():
    g.user = None
    g.unread = 0
    token = request.cookies.get(COOKIE)
    if not token:
        return
    row = get("""SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token = ? AND s.expires_at > ? AND u.active = 1""", token, now_iso())
    if row:
        row.pop("password_hash", None)
        g.user = row
        g.unread = get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", row["id"])["n"]


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not g.user:
            return _to_login()
        return view(*args, **kwargs)
    return wrapped


def role_required(*roles):
    def deco(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not g.user:
                return _to_login()
            if g.user["role"] not in roles:
                abort(403)
            return view(*args, **kwargs)
        return wrapped
    return deco


def is_staff(u) -> bool:
    return bool(u) and u["role"] in ("tutor", "lead")


def can_see_student(user, student_id: int) -> bool:
    """Visible to the student, their assigned tutor, tutors handling their tickets, and the cohort lead."""
    if not user:
        return False
    if user["id"] == student_id or user["role"] == "lead":
        return True
    if user["role"] != "tutor":
        return False
    s = get("SELECT tutor_id FROM users WHERE id = ?", student_id)
    if s and s["tutor_id"] == user["id"]:
        return True
    return bool(get("SELECT 1 FROM tickets WHERE student_id = ? AND assignee_id = ?", student_id, user["id"]))


def can_see_ticket(user, t) -> bool:
    if not user or not t:
        return False
    if user["role"] == "lead" or t["student_id"] == user["id"] or t["assignee_id"] == user["id"]:
        return True
    if user["role"] != "tutor":
        return False
    s = get("SELECT tutor_id FROM users WHERE id = ?", t["student_id"])
    if s and s["tutor_id"] == user["id"]:
        return True
    return bool(t["issue_id"] and get("SELECT 1 FROM issues WHERE id = ? AND owner_id = ?", t["issue_id"], user["id"]))


def issue_token(user_id: int, purpose: str, days: int = 7) -> str:
    token = secrets.token_hex(24)
    run("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
        token, user_id, purpose, iso(utcnow() + timedelta(days=days)))
    return token


def consume_token(token: str):
    return get("SELECT * FROM tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?", token, now_iso())


def csrf_token() -> str:
    """Per-session token derived from the session cookie."""
    base = request.cookies.get(COOKIE) or "anon"
    key = current_app.config["SECRET_KEY"].encode()
    return hmac.new(key, base.encode(), hashlib.sha256).hexdigest()[:32]


def check_csrf():
    if request.method != "POST":
        return None
    sent = request.form.get("_csrf") or request.headers.get("X-CSRF-Token")
    if not sent or not hmac.compare_digest(sent, csrf_token()):
        abort(403, "Your form expired. Go back and try again.")
    return None
