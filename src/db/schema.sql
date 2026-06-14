-- Bear-Metal unified schema
-- Idempotent: safe to run on a fresh DB or an existing DB (adds missing columns).
-- Dialect-compatible: TEXT timestamps, INTEGER booleans — works on both SQLite and Postgres.

-- ---------------------------------------------------------------------------
-- tasks
-- Absorbs: tickets, runs, run_tool_calls, workers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,

  -- ticket metadata (immutable after discovery)
  ticket_id TEXT,
  ticket_identifier TEXT,
  ticket_title TEXT,
  ticket_description TEXT,
  ticket_url TEXT,
  ticket_branch_name TEXT,
  ticket_linear_status_name TEXT,
  ticket_linear_status_type TEXT,
  ticket_labels_json TEXT NOT NULL DEFAULT '[]',

  -- ticket state (mutable)
  bm_status TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  ticket_completed_at TEXT,

  -- task queue columns
  dispatch_state TEXT,
  input_json TEXT,
  worker_id TEXT,
  result_status TEXT,
  result_json TEXT,
  slot_status TEXT NOT NULL DEFAULT 'active',
  iteration_number INTEGER NOT NULL DEFAULT 1,
  worker_heartbeat_at TEXT,
  reclaim_count INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 1,

  -- run data
  run_status TEXT,
  trigger TEXT,
  started_at TEXT,
  ended_at TEXT,
  stop_reason TEXT,
  error TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  model_name TEXT,
  provider TEXT,
  context_json TEXT,
  tool_calls_json TEXT,

  -- worker info
  worker_started_at TEXT,

  -- timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  released_at TEXT
);

ALTER TABLE tasks ADD COLUMN ticket_id TEXT;
ALTER TABLE tasks ADD COLUMN ticket_identifier TEXT;
ALTER TABLE tasks ADD COLUMN ticket_title TEXT;
ALTER TABLE tasks ADD COLUMN ticket_description TEXT;
ALTER TABLE tasks ADD COLUMN ticket_url TEXT;
ALTER TABLE tasks ADD COLUMN ticket_branch_name TEXT;
ALTER TABLE tasks ADD COLUMN ticket_linear_status_name TEXT;
ALTER TABLE tasks ADD COLUMN ticket_linear_status_type TEXT;
ALTER TABLE tasks ADD COLUMN ticket_labels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN bm_status TEXT;
ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN ticket_completed_at TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_state TEXT;
ALTER TABLE tasks ADD COLUMN input_json TEXT;
ALTER TABLE tasks ADD COLUMN worker_id TEXT;
ALTER TABLE tasks ADD COLUMN result_status TEXT;
ALTER TABLE tasks ADD COLUMN result_json TEXT;
ALTER TABLE tasks ADD COLUMN slot_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tasks ADD COLUMN iteration_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN worker_heartbeat_at TEXT;
ALTER TABLE tasks ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN run_status TEXT;
ALTER TABLE tasks ADD COLUMN trigger TEXT;
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN ended_at TEXT;
ALTER TABLE tasks ADD COLUMN stop_reason TEXT;
ALTER TABLE tasks ADD COLUMN error TEXT;
ALTER TABLE tasks ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE tasks ADD COLUMN completion_tokens INTEGER;
ALTER TABLE tasks ADD COLUMN model_name TEXT;
ALTER TABLE tasks ADD COLUMN provider TEXT;
ALTER TABLE tasks ADD COLUMN context_json TEXT;
ALTER TABLE tasks ADD COLUMN tool_calls_json TEXT;
ALTER TABLE tasks ADD COLUMN worker_started_at TEXT;
ALTER TABLE tasks ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN completed_at TEXT;
ALTER TABLE tasks ADD COLUMN released_at TEXT;

-- ---------------------------------------------------------------------------
-- pull_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  last_run_id TEXT,
  review_threads_json TEXT NOT NULL DEFAULT '[]',
  notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE pull_requests ADD COLUMN ticket_id TEXT NOT NULL DEFAULT '';
ALTER TABLE pull_requests ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE pull_requests ADD COLUMN head_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE pull_requests ADD COLUMN state TEXT NOT NULL DEFAULT '';
ALTER TABLE pull_requests ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN merged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN url TEXT NOT NULL DEFAULT '';
ALTER TABLE pull_requests ADD COLUMN last_run_id TEXT;
ALTER TABLE pull_requests ADD COLUMN review_threads_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pull_requests ADD COLUMN notified_at TEXT;
ALTER TABLE pull_requests ADD COLUMN created_at TEXT;
ALTER TABLE pull_requests ADD COLUMN updated_at TEXT;

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT,
  run_id TEXT,
  worker_id TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE events ADD COLUMN ticket_id TEXT;
ALTER TABLE events ADD COLUMN run_id TEXT;
ALTER TABLE events ADD COLUMN worker_id TEXT;
ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN type TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN payload_json TEXT;
ALTER TABLE events ADD COLUMN created_at TEXT;

-- ---------------------------------------------------------------------------
-- completed_issue_comments
-- Idempotency guard: tracks PR review comments the worker has already acted on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS completed_issue_comments (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr_number, comment_id)
);

ALTER TABLE completed_issue_comments ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE completed_issue_comments ADD COLUMN repo TEXT NOT NULL DEFAULT '';
ALTER TABLE completed_issue_comments ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE completed_issue_comments ADD COLUMN comment_id TEXT NOT NULL DEFAULT '';
ALTER TABLE completed_issue_comments ADD COLUMN completed_at TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- ticket_statuses
-- One row per ticket, tracking the 4-state lifecycle separate from tasks.
-- status: in_progress | validating | waiting_for_human | completed
-- notify: 1 = fire Slack DM when status transitions to waiting_for_human
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_statuses (
  ticket_id  TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  notify     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

