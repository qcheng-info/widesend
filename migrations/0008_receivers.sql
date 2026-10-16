-- One Send-files code can admit several receivers. Each receiver is its own
-- transfer row with the shared code. slot is 0-based and uses is the code's limit.
ALTER TABLE transfers ADD COLUMN uses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transfers ADD COLUMN slot INTEGER NOT NULL DEFAULT 0;
