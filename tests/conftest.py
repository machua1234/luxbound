import pytest


@pytest.fixture(autouse=True)
def _no_real_email(monkeypatch):
    """Tests never send real email, even if a .env with SMTP settings exists."""
    for var in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS"):
        monkeypatch.delenv(var, raising=False)
