// 52-04: master switch "Automatisch encodieren". Gates the three AUTOMATIC
// enqueue paths (watcher ingest, reconcile orphan sweep, auto-enqueue after
// POST /api/scan); manual enqueues never consult it.
//
// Read per call on purpose: the switch must take effect right after a
// settings PUT, and `get` is a single prepared statement. A missing row counts
// as OFF, matching the fresh-install seed in migration 0030.
import type { SettingRepo } from '../db/repos/setting';

export const AUTO_ENCODE_KEY = 'auto_encode';

export function isAutoEncodeEnabled(repo: Pick<SettingRepo, 'get'>): boolean {
  return repo.get(AUTO_ENCODE_KEY) === 'true';
}
