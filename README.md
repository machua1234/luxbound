# LuxDevHQ Progress & Support

A standalone portal, with its own login, that tracks **what each student owes, what's blocking them, and who needs to act next**. Squad stays the LMS for classes, recordings, briefs, and Project Lab submissions. Students still submit once, in Squad.

## Quick start

```bash
npm install
npm run seed      # resets the DB and loads a Cohort 9 demo with deadlines relative to now
npm start         # http://localhost:3000
npm test          # rules-engine tests
```

You need Node 22.13 or later. It uses the built-in `node:sqlite`, so nothing has to compile.

Demo password: `luxdev123`

| Role | Email |
|---|---|
| Cohort lead | `lead@luxdevhq.test` |
| Tutors | `brian@luxdevhq.test`, `wanjiru@luxdevhq.test` |
| Students | `achieng@students.test` (overdue item, open ticket), `kevin@…` (2 overdue → catch-up), `faith@…` (revision), `daniel@…` (project overdue), `grace@…`, `samuel@…`, `mercy@…`, `ian@students.test` |

## Portal areas

| Area | Who | Route |
|---|---|---|
| My Progress | Student | `/progress` and `/progress/:id`, the assignment record that every notice links to |
| Technical Support | Student | `/support/new`: skill, what they were trying to do, error, screenshot, what they tried, linked assignment |
| Tutor Queue | Tutor / lead | `/queue`: follow-ups (owner, next action, due date), items to verify, items awaiting review, overdue work, open tickets |
| Cohort Overview | Lead | `/overview`: completion rates, overdue work, unanswered tickets, recurring issues by skill |

Submission status and support status are kept separate and shown **side by side** on every student-facing record.

## Early-warning rules (`src/rules.js`)

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

The deadline used for reminders is `due_override_at` (approved extension, resubmission, or catch-up date) if one is set, otherwise the original. Students added mid-cohort aren't chased for deadlines that passed before they joined. All notice wording is in `src/messages.js`.

## Cohort 9 pilot workflow

1. **Admin → Weekly roster**: CSV `email, first_name, last_name, tutor_email, role`. New people get an invite email.
2. **Admin → Assignments**: CSV `code, title, week, kind, skill, required, due_at, squad_url, deliverables`. Dates are in EAT and rows are matched by `code`.
3. Tutors check Squad and confirm status per assignment (bulk) or per student. Once a submission is confirmed, it shows as *Awaiting tutor review*.
4. Later, if Squad provides a reliable export, use **Admin → Squad status export** (`email, assignment_code, status`) instead. It never overwrites a tutor's review.

Sample CSVs are in `samples/`.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `PORTAL_URL` | `http://localhost:$PORT` | Base URL used for links in emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM` | — | Without `SMTP_HOST`, emails are only recorded in **Admin → Outbox** |
| `DB_PATH` | `data/portal.db` | |
| `UPLOAD_DIR` | `uploads` | Screenshots, served only to people who can see the ticket |
| `SESSION_SECRET` | random per boot | Set it in production |
| `COOKIE_SECURE` | false | Set `true` behind HTTPS |
| `RULES_INTERVAL_MIN` | 15 | |
| `RECURRING_THRESHOLD` | 3 | |
| `NODE_ENV=production` | | Hides the demo accounts on the login page |

`npm run rules` runs the rules once, for use from an external cron.

## Privacy

Individual records are visible only to the student, their assigned tutor, a tutor handling one of their tickets, and the cohort lead. The Cohort Overview shows aggregates and links to records. All forms are CSRF-protected.
