"""LuxDevHQ Progress & Support — a standalone student accountability portal alongside Squad."""
import os
import secrets

from flask import Flask, g, redirect, render_template

from . import ui
from .auth import check_csrf, load_user


def upload_dir() -> str:
    return os.path.abspath(os.environ.get("UPLOAD_DIR") or "uploads")


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("SESSION_SECRET") or secrets.token_hex(32),
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_NAME="lp_flash",
        COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "").lower() == "true",
        SHOW_DEMO_LOGINS=os.environ.get("FLASK_ENV", os.environ.get("NODE_ENV", "")) != "production",
    )
    app.config["SESSION_COOKIE_SECURE"] = app.config["COOKIE_SECURE"]
    if test_config:
        app.config.update(test_config)
    os.makedirs(upload_dir(), exist_ok=True)

    app.jinja_env.globals.update(ui.GLOBALS)
    app.jinja_env.filters.update(ui.FILTERS)

    app.before_request(load_user)
    app.before_request(check_csrf)

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    from .views import auth as auth_views, lead, staff, student, support
    for bp in (auth_views.bp, lead.bp, staff.bp, support.bp, student.bp):
        app.register_blueprint(bp)

    @app.get("/")
    def home():
        if not g.user:
            return redirect("/login")
        return redirect({"student": "/progress", "tutor": "/queue", "lead": "/overview"}[g.user["role"]])

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    def message(title, text, code):
        return render_template("message.html", title=title, text=text), code

    app.register_error_handler(403, lambda e: message("No access", e.description if e.description and "expired" in e.description
                                                      else "You don’t have access to this page.", 403))
    app.register_error_handler(404, lambda e: message("Not found", "That page doesn’t exist, or you don’t have access to it.", 404))
    app.register_error_handler(413, lambda e: message("File too large", "Files must be under 5 MB.", 413))
    app.register_error_handler(500, lambda e: message("Something went wrong", "Please try again. If it keeps happening, tell your tutor.", 500))
    return app
