export const statusSQL = `CASE
  WHEN t.receiver_status='complete' THEN 'complete'
  WHEN t.sender_status='error' OR t.receiver_status='error' THEN 'error'
  WHEN t.sender_status='cancelled' OR t.receiver_status='cancelled' THEN 'cancelled'
  WHEN t.expires_at < ? THEN 'interrupted'
  WHEN NOT EXISTS (SELECT 1 FROM connections c WHERE c.transfer_id=t.id AND c.role='receive') AND t.started_at < ? THEN 'expired'
  WHEN t.sender_status='transferring' OR t.receiver_status='transferring' OR t.sender_status='complete' THEN 'transferring'
  ELSE 'waiting' END`;
