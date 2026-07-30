// 10-02 E-D1: setContainerOverride — per-file container override persistence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo } from '@/src/lib/db/repos/file';

type Db = InstanceType<typeof Database>;

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

function seedFile(repo: ReturnType<typeof makeFileRepo>) {
  return repo.upsertByPath({
    path: '/media/movie.mkv',
    size_bytes: 1_000_000,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mkv',
    last_scanned_at: 1_700_000_500,

    share_id: null,
  });
}

describe('fileRepo.setContainerOverride (10-02 E-D1)', () => {
  it('test_setContainerOverride_when_mkv_then_returns_true_and_stored', () => {
    const repo = makeFileRepo(db);
    const file = seedFile(repo);
    const ok = repo.setContainerOverride(file.id, 'mkv');
    expect(ok).toBe(true);
    expect(repo.getById(file.id)?.container_override).toBe('mkv');
  });

  it('test_setContainerOverride_when_null_then_returns_true_and_clears', () => {
    const repo = makeFileRepo(db);
    const file = seedFile(repo);
    repo.setContainerOverride(file.id, 'mp4');
    const ok = repo.setContainerOverride(file.id, null);
    expect(ok).toBe(true);
    expect(repo.getById(file.id)?.container_override).toBeNull();
  });

  it('test_setContainerOverride_when_match_source_then_stored', () => {
    const repo = makeFileRepo(db);
    const file = seedFile(repo);
    repo.setContainerOverride(file.id, 'match-source');
    expect(repo.getById(file.id)?.container_override).toBe('match-source');
  });

  it('test_setContainerOverride_when_unknown_id_then_returns_false', () => {
    const repo = makeFileRepo(db);
    const ok = repo.setContainerOverride(99999, 'mkv');
    expect(ok).toBe(false);
  });
});
