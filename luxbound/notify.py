"""Private in-portal notification + matching email, sent once per dedupe key."""
import os

from .db import get, run
from .mailer import send_mail, transport_name
from .timeutil import now_iso


def portal_url() -> str:
    # RENDER_EXTERNAL_URL is set automatically on Render.
    url = os.environ.get("PORTAL_URL") or os.environ.get("RENDER_EXTERNAL_URL")
    return (url or f"http://localhost:{os.environ.get('PORT', '3000')}").rstrip("/")


def _link_label(kind: str) -> str:
    if kind.startswith(("ticket", "issue")):
        return "View ticket"
    if kind.startswith("plan"):
        return "View catch-up plan"
    if kind.startswith("staff"):
        return "Open in portal"
    return "View assignment status"


def notify(user_id, kind, title, body, link=None, dedupe_key=None, email=True, email_subject=None, email_body=None):
    """Returns the notification id, or None when this dedupe key was already used."""
    user = get("SELECT * FROM users WHERE id = ?", user_id)
    if not user or not user["active"]:
        return None
    created = now_iso()
    cur = run(
        """INSERT OR IGNORE INTO notifications (user_id, kind, title, body, link, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        user_id, kind, title, body, link, dedupe_key, created,
    )
    if cur.rowcount == 0:
        return None
    nid = cur.lastrowid

    if not email:
        run("UPDATE notifications SET email_status = 'skipped' WHERE id = ?", nid)
        return nid

    subject = email_subject or title
    full_link = f"{portal_url()}{link}" if link else portal_url()
    text = (
        f"{email_body or f'Hi {user['first_name']},\n\n{body}'}\n\n"
        f"{_link_label(kind)}: {full_link}\n\n"
        "— LuxDevHQ Progress & Support\nThis message is private to you."
    )
    run(
        "INSERT INTO outbox (notification_id, to_email, subject, text, transport, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        nid, user["email"], subject, text, transport_name(), created,
    )
    try:
        status = send_mail(user["email"], subject, text)
        run("UPDATE notifications SET email_status = ?, emailed_at = ? WHERE id = ?", status, now_iso(), nid)
    except Exception as err:  # noqa: BLE001 — record any SMTP failure, never break the request
        run("UPDATE notifications SET email_status = 'failed', email_error = ? WHERE id = ?", str(err), nid)
    return nid
