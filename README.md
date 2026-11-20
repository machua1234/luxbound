# LuxDevHQ Progress & Support

A standalone portal, with its own login, that tracks **what each student owes, what's blocking them, and who needs to act next**. Squad stays the LMS for classes, recordings, briefs, and Project Lab submissions. Students still submit once, in Squad.

Written in Python: Flask, SQLite, and the standard library for email and CSV.

## Deploy (free demo on Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/machua1234/luxbound)

Uses `render.yaml`. The free plan has no persistent disk: the app sleeps after 15 minutes idle (the next visit takes about a minute), and the database resets on every restart or deploy, so it reloads the Cohort 9 demo automatically (`SEED_DEMO_IF_EMPTY`). For the real pilot, switch to a paid instance, add a disk, and set `DB_PATH` and `UPLOAD_DIR` to paths on the disk.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

python -m luxbound seed            # resets the DB and loads a Cohort 9 demo with deadlines relative to now
python -m luxbound                 # http://localhost:3000
pytest                             # rules-engine + end-to-end tests (31)
```

You need Python 3.12 or later.

| Command | What it does |
|---|---|
| `python -m luxbound` | Start the portal (waitress server) with the rules scheduler |
| `python -m luxbound dev` | Same, with auto-reload when code changes |
| `python -m luxbound seed` | Reset the database and load the demo data |
| `python -m luxbound rules` | Run the early-warning rules once (for an external cron) |
| `python -m luxbound mail-test you@example.com` | Check your SMTP settings |

Demo password: `luxdev123`

| Role | Email |
|---|---|
| Cohort lead | `lead@luxdevhq.test` |
| Tutors | `brian@luxdevhq.test`, `wanjiru@luxdevhq.test` |
| Students | `achieng@students.test` (overdue item, open ticket), `kevin@…` (2 overdue → catch-up), `faith@…` (revision), `daniel@…` (project overdue), `grace@…`, `samuel@…`, `mercy@…`, `ian@students.test` |

## Portal areas

| Area | Who | Route |
|---|---|---|
| My Progress | Student | `/progress` and `/progress/<id>`, the assignment record that every notice links to |
| Technical Support | Student | `/support/new`: skill, what they were trying to do, error, screenshot, what they tried, linked assignment |
| Tutor Queue | Tutor / lead | `/queue`: follow-ups (owner, next action, due date), items to verify, items awaiting review, overdue work, open tickets |
| Cohort Overview | Lead | `/overview`: completion rates, overdue work, unanswered tickets, recurring issues by skill |

Submission status and support status are kept separate and shown **side by side** on every student-facing record.

## Early-warning rules (`luxbound/rules.py`)

Rules run every 15 minutes (`RULES_INTERVAL_MIN`) and after every status change. Every notice and follow-up has a dedupe key, so each one fires once.

| Signal | Follow-up |
|---|---|
| Required item due within 24h, still outstanding | 24h reminder (email + portal) |
| Deadline passed and a tutor or Squad export **confirmed** no submission | Overdue notice with links to the task and the support form |
| Deadline passed but **not checked** | Asks the student to confirm (“I already submitted” / “Report a blocker”). Nothing is marked overdue |
| 2 required assignments overdue, or 1 required project overdue | Catch-up follow-up for the assigned tutor. The tutor proposes a plan (with optional new deadlines and a check-in date), the student gets it as a message from the tutor and selects Agree |
| Ticket with no tutor reply after 1 working day (Mon–Fri, EAT) | Flagged to the cohort lead to follow up or reassign |
| ≥3 students (`RECURRING_THRESHOLD`) with open tickets on the same skill within 14 days | Recurring issue and a shared-fix follow-up. The fix goes to every affected student with a “Can you proceed?” check |
| Tutor requests a revision | Message listing the exact missing deliverables and the resubmission deadline |

The deadline used for reminders is `due_override_at` (approved extension, resubmission, or catch-up date) if one is set, otherwise the original. Students added mid-cohort aren't chased for deadlines that passed before they joined. All notice wording is in `luxbound/messages.py`.

## Cohort 9 pilot workflow

1. **Admin → Weekly roster**: CSV `email, first_name, last_name, tutor_email, role`. New people get an invite email.
2. **Admin → Assignments**: CSV `code, title, week, kind, skill, required, due_at, squad_url, deliverables`. Dates are in EAT and rows are matched by `code`.
3. Tutors check Squad and confirm status per assignment (bulk) or per student. Once a submission is confirmed, it shows as *Awaiting tutor review*.
4. Later, if Squad provides a reliable export, use **Admin → Squad status export** (`email, assignment_code, status`) instead. It never overwrites a tutor's review.

Sample CSVs are in `luxbound/static/samples/`.

## Configuration

Copy `.env.example` to `.env` and fill it in. `python -m luxbound` reads it automatically.

| Env var | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `HOST` | 127.0.0.1 | Set `0.0.0.0` to allow other devices on your network |
| `PORTAL_URL` | `http://localhost:$PORT` | Base URL used for links in emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM` | — | Without `SMTP_HOST`, emails are only recorded in **Admin → Outbox** |
| `DB_PATH` | `data/portal.db` | |
| `UPLOAD_DIR` | `uploads` | Screenshots, served only to people who can see the ticket |
| `SESSION_SECRET` | random per start | Set it so sign-in forms survive restarts |
| `COOKIE_SECURE` | false | Set `true` behind HTTPS |
| `RULES_INTERVAL_MIN` | 15 | |
| `RECURRING_THRESHOLD` | 3 | |
| `FLASK_ENV=production` | | Hides the demo accounts on the login page |

## Code layout

```
luxbound/
  __main__.py     command line (run, dev, seed, rules, mail-test) + rules scheduler
  __init__.py     app factory
  rules.py        early-warning rules
  messages.py     wording of every notice
  status.py       what a submission's status means; next steps
  notify.py       portal notification + email, once per dedupe key
  mailer.py       SMTP
  imports.py      roster / assignments / Squad status CSV imports
  auth.py         sessions, passwords, CSRF, who can see what
  db.py           SQLite schema and helpers
  views/          routes for each area
  templates/      Jinja pages
tests/            pytest: rules engine + end-to-end
```

## Privacy

Individual records are visible only to the student, their assigned tutor, a tutor handling one of their tickets, and the cohort lead. The Cohort Overview shows aggregates and links to records. All forms are CSRF-protected.
