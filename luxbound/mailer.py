"""Email over SMTP. With SMTP_HOST unset, mail is only recorded in the outbox (Admin → Outbox)."""
import os
import smtplib
from email.message import EmailMessage


def transport_name() -> str:
    return "smtp" if os.environ.get("SMTP_HOST") else "outbox-only"


def mail_from() -> str:
    return os.environ.get("MAIL_FROM") or "LuxDevHQ Progress & Support <progress@luxdevhq.test>"


def send_mail(to: str, subject: str, text: str) -> str:
    """Returns 'sent', or 'logged' when no SMTP server is configured. Raises on SMTP errors."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        return "logged"
    msg = EmailMessage()
    msg["From"] = mail_from()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)

    port = int(os.environ.get("SMTP_PORT") or 587)
    secure = os.environ.get("SMTP_SECURE", "").lower() == "true"
    user, password = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS")
    smtp_cls = smtplib.SMTP_SSL if secure else smtplib.SMTP
    with smtp_cls(host, port, timeout=20) as smtp:
        if not secure:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
        if user:
            smtp.login(user, password or "")
        smtp.send_message(msg)
    return "sent"
