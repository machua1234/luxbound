import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || path.resolve('data/portal.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS cohorts (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('student','tutor','lead')),
  cohort_id INTEGER REFERENCES cohorts(id),
  tutor_id INTEGER REFERENCES users(id),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Required weekly assignments and projects. The brief and submission live in Squad.
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  week INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('assignment','project')),
  skill TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  due_at TEXT NOT NULL,
  squad_url TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (cohort_id, code)
);

-- Submission status: what the student owes. Kept separate from support status.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'not_checked' CHECK (status IN
    ('not_checked','student_claimed','outstanding','awaiting_review','revision_requested','approved')),
  due_override_at TEXT,          -- approved extension or resubmission deadline; used for reminders
  override_reason TEXT,          -- extension | resubmission | catch_up
  revision_items TEXT,
  student_note TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  status_source TEXT,            -- tutor | student | squad_export
  updated_at TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS submission_events (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- Support status: what is blocking the student.
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id),
  cohort_id INTEGER REFERENCES cohorts(id),
  skill TEXT NOT NULL,
  trying_to_do TEXT NOT NULL,
  error_text TEXT NOT NULL DEFAULT '',
  tried TEXT NOT NULL DEFAULT '',
  screenshot TEXT,
  assignment_id INTEGER REFERENCES assignments(id),
  status TEXT NOT NULL DEFAULT 'awaiting_tutor' CHECK (status IN ('awaiting_tutor','awaiting_student','resolved')),
  assignee_id INTEGER REFERENCES users(id),
  issue_id INTEGER REFERENCES issues(id),
  can_proceed TEXT,              -- yes | no, answered after a shared fix
  created_at TEXT NOT NULL,
  awaiting_since TEXT NOT NULL,
  first_reply_at TEXT,
  escalated_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Recurring issues: several students reporting the same problem.
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  skill TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fix_shared','resolved')),
  owner_id INTEGER REFERENCES users(id),
  fix_text TEXT,
  fix_shared_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Every follow-up has an owner, a next action and a due date.
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- catch_up | check_in | ticket_sla | shared_fix | proceed_check | verify
  owner_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER REFERENCES users(id),
  ticket_id INTEGER REFERENCES tickets(id),
  issue_id INTEGER REFERENCES issues(id),
  plan_id INTEGER REFERENCES catchup_plans(id),
  next_action TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  rule_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_note TEXT
);

CREATE TABLE IF NOT EXISTS catchup_plans (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id),
  tutor_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  check_in_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','completed')),
  created_at TEXT NOT NULL,
  agreed_at TEXT,
  completed_at TEXT
);

-- In-portal notifications. The dedupe key guarantees each notice is sent once.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  email_status TEXT,             -- sent | logged | failed | skipped
  emailed_at TEXT,
  email_error TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  notification_id INTEGER REFERENCES notifications(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  transport TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  filename TEXT,
  actor_id INTEGER REFERENCES users(id),
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_ticket_student ON tickets(student_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_followup_owner ON followups(owner_id, status);
`);

export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const nowIso = () => new Date().toISOString();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Make sure every student in the cohort has a submission row for every assignment. */
export function ensureSubmissionRows(cohortId) {
  run(
    `INSERT OR IGNORE INTO submissions (assignment_id, student_id, status, updated_at)
     SELECT a.id, u.id, 'not_checked', ? FROM assignments a
     JOIN users u ON u.cohort_id = a.cohort_id AND u.role = 'student' AND u.active = 1
     WHERE a.cohort_id = ?`,
    nowIso(), cohortId,
  );
}

export function leadsFor(cohortId) {
  return all(`SELECT * FROM users WHERE role = 'lead' AND active = 1 AND (cohort_id = ? OR cohort_id IS NULL) ORDER BY id`, cohortId);
}
