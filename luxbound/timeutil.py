"""Time helpers. Timestamps are stored as UTC ISO strings and shown in EAT (UTC+3, no DST)."""
import re
from datetime import datetime, timedelta, timezone

EAT = timezone(timedelta(hours=3), "EAT")
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    """Canonical storage format, e.g. 2026-11-20T07:00:00.000Z (sorts correctly as text)."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return iso(utcnow())


def parse(value) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def fmt(value) -> str:
    if not value:
        return "—"
    d = parse(value).astimezone(EAT)
    return f"{d:%a} {d.day} {d:%b}, {d:%H:%M} EAT"


def fmt_date(value) -> str:
    if not value:
        return "—"
    d = parse(value).astimezone(EAT)
    return f"{d:%a}, {d.day} {d:%b} {d.year}"


def fmt_time(value) -> str:
    if not value:
        return "—"
    return f"{parse(value).astimezone(EAT):%H:%M} EAT"


def from_local_input(value: str | None) -> str | None:
    """'2026-11-12T23:59' from a datetime-local field, interpreted as EAT → UTC ISO."""
    if not value:
        return None
    v = value.strip()
    if len(v) == 10:
        v += "T23:59"
    try:
        return iso(datetime.strptime(v[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=EAT))
    except ValueError:
        return None


def to_local_input(value) -> str:
    return parse(value).astimezone(EAT).strftime("%Y-%m-%dT%H:%M") if value else ""


def parse_import_date(value: str | None) -> str | None:
    """ISO with an offset, or 'YYYY-MM-DD HH:MM' (treated as EAT)."""
    if not value:
        return None
    v = value.strip()
    if re.search(r"([zZ]|[+-]\d{2}:?\d{2})$", v):
        try:
            return iso(parse(v.replace("z", "Z")))
        except ValueError:
            return None
    return from_local_input(v.replace(" ", "T"))


def _is_weekend(d: datetime) -> bool:
    return d.astimezone(EAT).weekday() >= 5


def add_working_days(start, n: int) -> datetime:
    """Add Mon–Fri days in EAT. Something raised at the weekend starts the clock at 08:00 EAT Monday."""
    d = parse(start) if not isinstance(start, datetime) else start
    if _is_weekend(d):
        while _is_weekend(d):
            d += DAY
        d = d.astimezone(EAT).replace(hour=8, minute=0, second=0, microsecond=0)
    added = 0
    while added < n:
        d += DAY
        if not _is_weekend(d):
            added += 1
    return d.astimezone(timezone.utc)


def relative(value, at: datetime | None = None) -> str:
    if not value:
        return ""
    at = at or utcnow()
    diff = (parse(value) - at).total_seconds()
    a = abs(diff)
    if a < 3600:
        text = f"{max(1, round(a / 60))} min"
    elif a < 86400:
        text = f"{round(a / 3600)} h"
    else:
        days = round(a / 86400)
        text = f"{days} day{'' if days == 1 else 's'}"
    return f"in {text}" if diff >= 0 else f"{text} ago"


def waited(value, at: datetime | None = None) -> str:
    """'3 h' rather than '3 h ago'."""
    return relative(value, at).removesuffix(" ago")
