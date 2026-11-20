"""Small HTML helpers available in every template. All values are escaped."""
from markupsafe import Markup, escape

from .auth import csrf_token
from .timeutil import fmt, relative, waited


def csrf_field():
    return Markup('<input type="hidden" name="_csrf" value="{}">').format(csrf_token())


def pill(tone, label):
    return Markup('<span class="pill {}">{}</span>').format(tone, label)


def due(value, at=None):
    return Markup('<span class="due" title="{0}">{0} <small>({1})</small></span>').format(fmt(value), relative(value, at))


def ticket_pill(t):
    if t["status"] == "resolved":
        return pill("good", "Resolved")
    if t["status"] == "awaiting_student":
        return pill("info", "Waiting on student")
    if t.get("escalated_at"):
        return pill("bad", "Waiting on tutor · flagged")
    return pill("warn", "Waiting on tutor")


def empty(text):
    return Markup('<p class="empty">{}</p>').format(text)


def stat(label, value, tone="", sub=""):
    sub_html = Markup('<div class="s">{}</div>').format(sub) if sub else ""
    return Markup('<div class="stat {}"><div class="v">{}</div><div class="l">{}</div>{}</div>').format(tone, value, label, sub_html)


def bar(n, total):
    pct = round(n / total * 100) if total else 100
    cls = "low" if pct < 50 else "mid" if pct < 80 else ""
    return Markup('<div class="bar {0}" title="{1}%"><i style="width:{1}%"></i></div>').format(cls, pct)


def nl2br(value):
    if not value:
        return ""
    return escape(value).replace("\n", Markup("<br>"))


def cap(value):
    return str(value)[:1].upper() + str(value)[1:]


GLOBALS = dict(csrf_field=csrf_field, pill=pill, due=due, ticket_pill=ticket_pill, empty=empty, stat=stat, bar=bar,
               fmt=fmt, relative=relative, waited=waited)
FILTERS = dict(nl2br=nl2br, fmt=fmt, cap=cap)
