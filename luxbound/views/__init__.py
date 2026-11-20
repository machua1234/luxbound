"""Blueprints for each area of the portal."""
from flask import request


def safe_back(value: str | None, default: str) -> str:
    """Only allow same-site relative redirects."""
    v = value or ""
    return v if v.startswith("/") and not v.startswith("//") else default


def form(name: str, default: str = "") -> str:
    return (request.form.get(name) or default).strip()
