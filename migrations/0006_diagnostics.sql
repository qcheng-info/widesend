-- Diagnostics: why each connection ended, and attempts refused before they started.
-- closed_by is server, browser or lost. close_code is the WebSocket close code.
ALTER TABLE connections ADD COLUMN closed_by TEXT;
ALTER TABLE connections ADD COLUMN close_code INTEGER;
ALTER TABLE connections ADD COLUMN close_reason TEXT;
ALTER TABLE share_connections ADD COLUMN closed_by TEXT;
ALTER TABLE share_connections ADD COLUMN close_code INTEGER;
ALTER TABLE share_connections ADD COLUMN close_reason TEXT;
-- The opaque lookup hash lets a room's page show attempts refused before reaching it.
ALTER TABLE share_rooms ADD COLUMN locator TEXT;
CREATE INDEX share_rooms_locator ON share_rooms(locator);
-- room_id is the activity ID when the room or transfer exists. target is the hash
-- from the request. code is a WebSocket close code or HTTP status.
CREATE TABLE refusals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  room_id TEXT,
  target TEXT,
  role TEXT,
  ip TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  code INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX refusals_at ON refusals(at);
CREATE INDEX refusals_ip ON refusals(ip, at);
CREATE INDEX refusals_room ON refusals(room_id, at);
CREATE INDEX refusals_target ON refusals(target, at);
