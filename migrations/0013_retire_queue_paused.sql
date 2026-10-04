-- 05-09: retire queue_paused setting. Pause/Stop affordance removed entirely;
-- new model is Skip (per-job) + Cancel-All-Queued. DELETE is naturally
-- idempotent — no-op when row absent.
DELETE FROM setting WHERE key = 'queue_paused';
