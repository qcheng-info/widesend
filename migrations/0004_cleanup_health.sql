CREATE TABLE activity_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_started_at INTEGER,
  last_finished_at INTEGER,
  last_success_at INTEGER,
  last_error_at INTEGER,
  deleted_transfers INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
INSERT INTO activity_cleanup(id) VALUES (1);
