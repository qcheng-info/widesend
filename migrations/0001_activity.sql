CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sender_status TEXT NOT NULL DEFAULT 'waiting',
  receiver_status TEXT NOT NULL DEFAULT 'waiting',
  sender_route TEXT NOT NULL DEFAULT 'connecting',
  receiver_route TEXT NOT NULL DEFAULT 'connecting',
  sender_finished_at INTEGER,
  receiver_finished_at INTEGER
);
CREATE INDEX transfers_started ON transfers(started_at DESC, id);
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('send','receive')),
  ip TEXT NOT NULL,
  country TEXT,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER
);
CREATE INDEX connections_transfer ON connections(transfer_id, connected_at);
CREATE INDEX connections_ip ON connections(ip, transfer_id);
CREATE TABLE files (
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('send','receive')),
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  md5 TEXT,
  sha256 TEXT,
  reported_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (transfer_id, file_id, role)
);
CREATE INDEX files_md5 ON files(md5, transfer_id);
CREATE INDEX files_sha256 ON files(sha256, transfer_id);
