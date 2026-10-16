-- Share rooms. Server-observed rows (rooms, members, connections) are written by
-- the ShareRoom Durable Object, while offers and deliveries come from member reports.
CREATE TABLE share_rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (length(code) = 6 AND code NOT GLOB '*[^A-Z0-9]*'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('dismissed', 'expired'))
);
CREATE INDEX share_rooms_created ON share_rooms(created_at DESC, id);
CREATE INDEX share_rooms_code ON share_rooms(code, created_at DESC);
CREATE TABLE share_members (
  room_id TEXT NOT NULL REFERENCES share_rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  left_reason TEXT CHECK (left_reason IS NULL OR left_reason IN ('left', 'removed', 'dismissed', 'expired')),
  PRIMARY KEY (room_id, member_id)
);
CREATE INDEX share_members_name ON share_members(name, room_id);
CREATE TABLE share_connections (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES share_rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  country TEXT,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER
);
CREATE INDEX share_connections_room ON share_connections(room_id, connected_at);
CREATE INDEX share_connections_ip ON share_connections(ip, room_id);
-- Offer IDs are chosen by browsers, so they are only unique within a room.
CREATE TABLE share_offers (
  room_id TEXT NOT NULL REFERENCES share_rooms(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  total_size INTEGER NOT NULL,
  PRIMARY KEY (room_id, offer_id)
);
CREATE TABLE share_offer_files (
  room_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  md5 TEXT,
  sha256 TEXT,
  PRIMARY KEY (room_id, offer_id, file_id),
  FOREIGN KEY (room_id, offer_id) REFERENCES share_offers(room_id, offer_id) ON DELETE CASCADE
);
CREATE INDEX share_offer_files_sha256 ON share_offer_files(sha256, room_id);
CREATE INDEX share_offer_files_md5 ON share_offer_files(md5, room_id);
CREATE TABLE share_deliveries (
  room_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (
    status IN ('offered', 'accepted', 'declined', 'transferring', 'complete', 'failed', 'cancelled')
  ),
  route TEXT NOT NULL DEFAULT 'connecting' CHECK (route IN ('connecting', 'direct', 'relay')),
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (room_id, offer_id, recipient_id),
  FOREIGN KEY (room_id, offer_id) REFERENCES share_offers(room_id, offer_id) ON DELETE CASCADE
);
