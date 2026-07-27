CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  record_data TEXT NOT NULL CHECK (json_valid(record_data)),
  feedback_type TEXT NOT NULL,
  proposed_value TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  as_name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS feedback_project_key_idx ON feedback(project_key);
CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback(status);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at);
