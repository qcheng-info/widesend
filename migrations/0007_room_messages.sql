-- Room conversations: per-member totals of text messages, reported by browsers.
-- Message contents never reach the server.
ALTER TABLE share_members ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_members ADD COLUMN message_bytes INTEGER NOT NULL DEFAULT 0;
