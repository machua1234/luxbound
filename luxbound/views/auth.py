from flask import Blueprint, current_app, flash, g, make_response, redirect, render_template, request

from ..auth import consume_token, end_session, hash_password, issue_token, start_session, verify_password
from ..db import get, run
from ..notify import notify
from ..timeutil import now_iso
from . import form, safe_back

bp = Blueprint("auth", __name__)

SCENES = [
    ("A required assignment passes its deadline with no submission", "Private reminder with links to the task and the support form"),
    ("Two assignments overdue, or a project overdue", "Assigned tutor checks the record and agrees a catch-up plan"),
    ("A ticket has no tutor reply after one working day", "Flagged for the cohort lead to follow up or reassign"),
    ("Several students report the same issue", "Tutor shares a fix or runs a walkthrough, then checks everyone can proceed"),
]


def auth_page(mode, **ctx):
    return render_template("auth.html", mode=mode, scenes=SCENES,
                           show_demo=current_app.config["SHOW_DEMO_LOGINS"], **ctx)


@bp.get("/login")
def login():
    if g.user:
        return redirect("/")
    return auth_page("login", next=request.args.get("next", ""), email=request.args.get("email", ""))


@bp.post("/login")
def login_post():
    email = form("email")
    user = get("SELECT * FROM users WHERE email = ? AND active = 1", email)
    if not user or not verify_password(request.form.get("password", ""), user["password_hash"]):
        flash("That email and password don’t match. If you haven’t set a password yet, use the link in your invite email.", "error")
        return redirect(f"/login?email={email}")
    resp = make_response(redirect(safe_back(request.form.get("next"), "/")))
    start_session(resp, user["id"])
    return resp


@bp.post("/logout")
def logout():
    resp = make_response(redirect("/login"))
    end_session(resp)
    return resp


@bp.get("/set-password")
def set_password():
    tok = consume_token(request.args.get("token", ""))
    if not tok:
        return auth_page("expired")
    user = get("SELECT * FROM users WHERE id = ?", tok["user_id"])
    return auth_page("set_password", token=tok["token"], user=user)


@bp.post("/set-password")
def set_password_post():
    tok = consume_token(request.form.get("token", ""))
    pw = request.form.get("password", "")
    if not tok:
        return redirect("/forgot")
    if len(pw) < 8:
        flash("Use at least 8 characters.", "error")
        return redirect(f"/set-password?token={tok['token']}")
    run("UPDATE users SET password_hash = ? WHERE id = ?", hash_password(pw), tok["user_id"])
    run("UPDATE tokens SET used_at = ? WHERE token = ?", now_iso(), tok["token"])
    resp = make_response(redirect("/"))
    start_session(resp, tok["user_id"])
    return resp


@bp.get("/forgot")
def forgot():
    return auth_page("forgot")


@bp.post("/forgot")
def forgot_post():
    user = get("SELECT * FROM users WHERE email = ? AND active = 1", form("email"))
    if user:
        token = issue_token(user["id"], "reset", 1)
        notify(user["id"], "account", "Reset your password",
               "Use the link below to choose a new password. It expires in 24 hours.",
               link=f"/set-password?token={token}")
    flash("If that email is registered, a reset link is on its way.", "ok")
    return redirect("/login")
