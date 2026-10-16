CREATE INDEX IF NOT EXISTS connections_time ON connections(connected_at);
CREATE INDEX IF NOT EXISTS connections_role_time ON connections(transfer_id,role,connected_at,id);
