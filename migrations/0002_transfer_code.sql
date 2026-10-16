-- Existing records keep NULL: their pairing codes were never recorded.
ALTER TABLE transfers ADD COLUMN code TEXT
  CHECK (code IS NULL OR (length(code) = 6 AND code NOT GLOB '*[^A-Z0-9]*'));
-- Codes can be reused by separate sessions. The random activity ID remains the identity.
CREATE INDEX transfers_code ON transfers(code, started_at DESC);
