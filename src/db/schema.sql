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
  task_type TEXT NOT NULL DEFAULT 'coding',
  slack_workspace_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  slack_source_ts TEXT,
  slack_source_user_id TEXT,
  slack_request_index INTEGER,
  slack_request TEXT,
  slack_quote TEXT,
  slack_delegate_to_bear_metal INTEGER CHECK (slack_delegate_to_bear_metal IN (0, 1)),
  slack_state TEXT,
  slack_reply_ts TEXT,
  slack_ack_state TEXT,
  coordinated_at TEXT,
  superseded_by TEXT,
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
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'coding';
ALTER TABLE tasks ADD COLUMN slack_workspace_id TEXT;
ALTER TABLE tasks ADD COLUMN slack_channel_id TEXT;
ALTER TABLE tasks ADD COLUMN slack_thread_ts TEXT;
ALTER TABLE tasks ADD COLUMN slack_source_ts TEXT;
ALTER TABLE tasks ADD COLUMN slack_source_user_id TEXT;
ALTER TABLE tasks ADD COLUMN slack_request_index INTEGER;
ALTER TABLE tasks ADD COLUMN slack_request TEXT;
ALTER TABLE tasks ADD COLUMN slack_quote TEXT;
ALTER TABLE tasks ADD COLUMN slack_delegate_to_bear_metal INTEGER CHECK (slack_delegate_to_bear_metal IN (0, 1));

UPDATE tasks SET slack_delegate_to_bear_metal = 1
WHERE task_type = 'coding' AND slack_workspace_id IS NOT NULL AND slack_delegate_to_bear_metal IS NULL;
ALTER TABLE tasks ADD COLUMN slack_state TEXT;
ALTER TABLE tasks ADD COLUMN slack_reply_ts TEXT;
ALTER TABLE tasks ADD COLUMN slack_ack_state TEXT;
ALTER TABLE tasks ADD COLUMN coordinated_at TEXT;
ALTER TABLE tasks ADD COLUMN superseded_by TEXT;
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

CREATE TABLE IF NOT EXISTS agent_trace_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_events_run ON agent_trace_events (run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_agent_trace_events_retention ON agent_trace_events (created_at);

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
-- status: in_progress | validating | waiting_for_human | failed | completed
-- notify: 1 = PR Slack notification pending, cleared only after Slack accepts it
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_statuses (
  ticket_id  TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  notify     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- pr_notification_deliveries
-- Per completed task and PR: the Slack PR notification is being sent (state
-- 'sending', owned by claim_token until claimed_at + lease) or was accepted
-- ('delivered'). Lets overlapping polls, restarts, and other manager instances
-- send each task's PR notification at most once per successful delivery.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pr_notification_deliveries (
  task_id      TEXT NOT NULL,
  pr_id        TEXT NOT NULL,
  state        TEXT NOT NULL,
  claim_token  TEXT NOT NULL,
  claimed_at   TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (task_id, pr_id)
);

CREATE TABLE IF NOT EXISTS slack_threads (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  first_message_ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, thread_ts)
);
ALTER TABLE slack_threads ADD COLUMN following INTEGER NOT NULL DEFAULT 1;
ALTER TABLE slack_threads ADD COLUMN unsubscribed_message_ts TEXT;
ALTER TABLE slack_threads ADD COLUMN latest_mention_ts TEXT;
UPDATE slack_threads SET latest_mention_ts = first_message_ts WHERE latest_mention_ts IS NULL;
ALTER TABLE slack_threads ADD COLUMN direct_message INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS slack_thread_mentions (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, thread_ts, message_ts)
);
INSERT INTO slack_thread_mentions (workspace_id, channel_id, thread_ts, message_ts)
  SELECT workspace_id, channel_id, thread_ts, first_message_ts FROM slack_threads WHERE 1 = 1
  ON CONFLICT (workspace_id, channel_id, thread_ts, message_ts) DO NOTHING;
INSERT INTO slack_thread_mentions (workspace_id, channel_id, thread_ts, message_ts)
  SELECT workspace_id, channel_id, thread_ts, latest_mention_ts FROM slack_threads WHERE latest_mention_ts IS NOT NULL
  ON CONFLICT (workspace_id, channel_id, thread_ts, message_ts) DO NOTHING;

CREATE TABLE IF NOT EXISTS slack_direct_answers (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  request_index INTEGER NOT NULL,
  answer TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'posting', 'posted')),
  reply_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, thread_ts, source_ts, request_index)
);

CREATE TABLE IF NOT EXISTS slack_coordination_replies (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  request_index INTEGER NOT NULL,
  reply_text TEXT NOT NULL,
  reply_kind TEXT NOT NULL,
  task_id TEXT,
  direct INTEGER NOT NULL,
  group_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'posting', 'posted')),
  reply_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, thread_ts, source_ts, request_index, reply_kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_reply_action ON slack_coordination_replies
  (workspace_id, channel_id, thread_ts, source_ts, request_index) WHERE reply_kind != 'task_cancel';
INSERT INTO slack_coordination_replies
  (workspace_id, channel_id, thread_ts, source_ts, request_index, reply_text, reply_kind, direct, state, reply_ts, error, created_at, updated_at)
  SELECT workspace_id, channel_id, thread_ts, source_ts, request_index, answer, 'answer', 1, state, reply_ts, error, created_at, updated_at
  FROM slack_direct_answers WHERE 1 = 1
  ON CONFLICT (workspace_id, channel_id, thread_ts, source_ts, request_index, reply_kind) DO NOTHING;
DROP TABLE slack_direct_answers;

CREATE TABLE IF NOT EXISTS slack_reply_deliveries (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  reply_key TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  request_index INTEGER NOT NULL,
  reply_text TEXT NOT NULL,
  reply_kind TEXT NOT NULL,
  task_id TEXT,
  direct INTEGER NOT NULL,
  group_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'posting', 'posted')),
  reply_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, thread_ts, reply_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_delivery_action ON slack_reply_deliveries
  (workspace_id, channel_id, thread_ts, source_ts, request_index) WHERE reply_kind != 'task_cancel';
INSERT INTO slack_reply_deliveries
  (workspace_id, channel_id, thread_ts, reply_key, source_ts, request_index, reply_text, reply_kind, task_id, direct, group_key, state, reply_ts, error, created_at, updated_at)
  SELECT workspace_id, channel_id, thread_ts,
    CASE WHEN reply_kind = 'task_cancel' THEN source_ts || '/task_cancel/' || task_id
      ELSE source_ts || '/' || reply_kind || '/' || request_index END,
    source_ts, request_index, reply_text, reply_kind, task_id, direct, group_key, state, reply_ts, error, created_at, updated_at
  FROM slack_coordination_replies WHERE 1 = 1
  ON CONFLICT (workspace_id, channel_id, thread_ts, reply_key) DO NOTHING;
DROP TABLE slack_coordination_replies;

CREATE TABLE IF NOT EXISTS slack_processed_messages (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, message_ts)
);
ALTER TABLE slack_processed_messages ADD COLUMN original_message_ts TEXT;
ALTER TABLE slack_processed_messages ADD COLUMN edited_text TEXT;
ALTER TABLE slack_processed_messages ADD COLUMN edited_user TEXT;

CREATE INDEX IF NOT EXISTS slack_messages_pending ON slack_processed_messages
  (workspace_id, channel_id, thread_ts, processed_at);
CREATE UNIQUE INDEX IF NOT EXISTS slack_task_request ON tasks
  (slack_workspace_id, slack_channel_id, slack_source_ts, slack_request_index);

ALTER TABLE tasks ADD COLUMN slack_replaces_task_id TEXT;
CREATE TABLE IF NOT EXISTS slack_unsubscribe_reactions (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0 CHECK (posted IN (0, 1)),
  PRIMARY KEY (workspace_id, channel_id, thread_ts, source_ts)
);

ALTER TABLE slack_unsubscribe_reactions ADD COLUMN state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'posted', 'failed'));
ALTER TABLE slack_unsubscribe_reactions ADD COLUMN error TEXT;
UPDATE slack_unsubscribe_reactions SET state = 'posted' WHERE posted = 1 AND state = 'queued';
