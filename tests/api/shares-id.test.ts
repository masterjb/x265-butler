/*
 * 14-04 Task 3 tests — PATCH + DELETE /api/shares/[id].
 *
 * Real :memory: DB via __forTests_setDb so FK ON DELETE SET NULL on
 * file.share_id is honest (AC-7). Logger mocked for AC-26 capture.
 *
 * ACs covered: AC-5 (PATCH partial + path-change), AC-6 (PATCH 404),
 * AC-7 (DELETE soft-orphans), AC-8 (DELETE 404), AC-9 (auth half),
 * AC-14 (warnings.rescan_recommended), AC-22 (PATCH-during-scan),
 * AC-23 (DELETE-during-scan), AC-26 (audit-log).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLogInfo,
      warn: mockLogWarn,
      error: mockLogError,
      debug: vi.fn(),
    }),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
  },
}));

import { migrate } from '@/src/lib/db/migrate';
import { __forTests_setDb, __forTests_resetDb, shareRepo, settingRepo } from '@/src/lib/db';
import { invalidateAuthSettingsCache } from '@/src/lib/auth/settings-cache';
import {
  acquireScanLock,
  releaseScanLock,
  __resetScanLockForTests,
} from '@/src/lib/scan/scan-progress-flag';
import { PATCH, DELETE } from '@/app/api/shares/[id]/route';

type Db = InstanceType<typeof Database>;

let db: Db;

function jsonPatchInit(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function asyncParams(id: string | number): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: String(id) }) };
}

function createShare(overrides: Partial<Record<string, unknown>> = {}): {
  id: number;
} {
  const row = shareRepo().create({
    name: 'Movies',
    path: '/media/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv',
    max_depth: 8,
    ...overrides,
  });
  return { id: row.id };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('DELETE FROM shares').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='shares'").run();
  __forTests_setDb(db);
  invalidateAuthSettingsCache();
  __resetScanLockForTests();
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
});

afterEach(() => {
  __forTests_resetDb();
  invalidateAuthSettingsCache();
  __resetScanLockForTests();
});

describe('PATCH /api/shares/[id] — AC-5 partial + path-change', () => {
  it('test_patch_when_filters_only_then_200_and_path_unchanged', async () => {
    const { id } = createShare();
    const res = await PATCH(
      new Request('http://test/api/shares/1', jsonPatchInit({ min_size_mb: 100 })),
      asyncParams(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      share: { min_size_mb: number; path: string };
      warnings: string[];
    };
    expect(body.share.min_size_mb).toBe(100);
    expect(body.share.path).toBe('/media/movies');
    expect(body.warnings).toEqual([]);
  });

  it('test_patch_when_path_changed_non_nested_then_200_warning_rescan_recommended', async () => {
    const { id } = createShare();
    const res = await PATCH(
      new Request('http://test/api/shares/1', jsonPatchInit({ path: '/media/movies-v2' })),
      asyncParams(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      share: { path: string };
      warnings: string[];
    };
    expect(body.share.path).toBe('/media/movies-v2');
    expect(body.warnings).toContain('rescan_recommended');
  });

  it('test_patch_when_path_would_nest_under_other_share_then_409_share_path_nested', async () => {
    shareRepo().create({
      name: 'Movies',
      path: '/media/movies',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const second = shareRepo().create({
      name: 'Music',
      path: '/media/music',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const res = await PATCH(
      new Request(
        `http://test/api/shares/${second.id}`,
        jsonPatchInit({ path: '/media/movies/sub' }),
      ),
      asyncParams(second.id),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('share_path_nested');
    expect(shareRepo().getById(second.id)?.path).toBe('/media/music');
  });
});

describe('PATCH /api/shares/[id] — AC-6 404', () => {
  it('test_patch_when_id_missing_then_404_share_not_found', async () => {
    const res = await PATCH(
      new Request('http://test/api/shares/999', jsonPatchInit({ name: 'X' })),
      asyncParams(999),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('share_not_found');
  });

  it('test_patch_when_id_zero_or_negative_then_404', async () => {
    const res = await PATCH(
      new Request('http://test/api/shares/-3', jsonPatchInit({ name: 'X' })),
      asyncParams(-3),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/shares/[id] — AC-22 scan-lock gate', () => {
  it('test_patch_when_scan_active_then_409_share_mutating_during_scan_and_no_mutation', async () => {
    const { id } = createShare();
    acquireScanLock();
    try {
      const res = await PATCH(
        new Request(`http://test/api/shares/${id}`, jsonPatchInit({ name: 'Renamed' })),
        asyncParams(id),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        scanInProgress: boolean;
      };
      expect(body.error).toBe('share_mutating_during_scan');
      expect(body.scanInProgress).toBe(true);
      expect(shareRepo().getById(id)?.name).toBe('Movies');
      const warned = mockLogWarn.mock.calls.find(
        (c) => (c[0] as { action?: string })?.action === 'share_patch_rejected_scan_active',
      );
      expect(warned).toBeDefined();
    } finally {
      releaseScanLock();
    }
  });

  it('test_patch_when_no_scan_active_then_200_normal_path', async () => {
    const { id } = createShare();
    const res = await PATCH(
      new Request(`http://test/api/shares/${id}`, jsonPatchInit({ name: 'Renamed' })),
      asyncParams(id),
    );
    expect(res.status).toBe(200);
    expect(shareRepo().getById(id)?.name).toBe('Renamed');
  });
});

describe('PATCH /api/shares/[id] — AC-26 audit-log enrichment', () => {
  it('test_patch_when_succeeds_then_pino_emits_share_updated_with_before_and_after', async () => {
    const { id } = createShare();
    await PATCH(
      new Request(`http://test/api/shares/${id}`, jsonPatchInit({ min_size_mb: 200 })),
      asyncParams(id),
    );
    const call = mockLogInfo.mock.calls.find(
      (c) => (c[0] as { action?: string })?.action === 'share_updated',
    );
    expect(call).toBeDefined();
    const payload = call![0] as {
      shareId: number;
      before: { min_size_mb: number };
      after: { min_size_mb: number };
      actor: string;
    };
    expect(payload.shareId).toBe(id);
    expect(payload.before.min_size_mb).toBe(50);
    expect(payload.after.min_size_mb).toBe(200);
    expect(payload.actor).toBe('anonymous');
  });
});

describe('DELETE /api/shares/[id] — AC-7 soft-orphan + AC-8 404', () => {
  it('test_delete_when_share_has_files_then_FK_set_null_orphan_count_returned', async () => {
    const { id } = createShare();
    // Insert 3 file rows under the share.
    const insert = db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, share_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('/media/movies/a.mkv', 1024, 1, 'h1', 1, id);
    insert.run('/media/movies/b.mkv', 1024, 1, 'h2', 1, id);
    insert.run('/media/movies/c.mkv', 1024, 1, 'h3', 1, id);

    const res = await DELETE(
      new Request(`http://test/api/shares/${id}`, { method: 'DELETE' }),
      asyncParams(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; orphanedFileCount: number };
    expect(body.deleted).toBe(true);
    expect(body.orphanedFileCount).toBe(3);

    expect(shareRepo().getById(id)).toBeUndefined();
    const orphans = db.prepare('SELECT COUNT(*) AS c FROM file WHERE share_id IS NULL').get() as {
      c: number;
    };
    expect(orphans.c).toBe(3);
    const fileCount = db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number };
    expect(fileCount.c).toBe(3); // No hard-delete.
  });

  it('test_delete_when_id_missing_then_404_share_not_found', async () => {
    const res = await DELETE(
      new Request('http://test/api/shares/999', { method: 'DELETE' }),
      asyncParams(999),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/shares/[id] — AC-23 scan-lock gate', () => {
  it('test_delete_when_scan_active_then_409_no_mutation', async () => {
    const { id } = createShare();
    acquireScanLock();
    try {
      const res = await DELETE(
        new Request(`http://test/api/shares/${id}`, { method: 'DELETE' }),
        asyncParams(id),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('share_mutating_during_scan');
      expect(shareRepo().getById(id)).toBeDefined();
      const warned = mockLogWarn.mock.calls.find(
        (c) => (c[0] as { action?: string })?.action === 'share_delete_rejected_scan_active',
      );
      expect(warned).toBeDefined();
    } finally {
      releaseScanLock();
    }
  });
});

describe('DELETE /api/shares/[id] — AC-26 audit-log snapshot', () => {
  it('test_delete_when_succeeds_then_pino_emits_share_deleted_with_snapshot_and_orphan_count', async () => {
    const { id } = createShare({ name: 'GoneSoon', path: '/media/gone' });
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, share_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('/media/gone/x.mkv', 1024, 1, 'h', 1, id);

    await DELETE(
      new Request(`http://test/api/shares/${id}`, { method: 'DELETE' }),
      asyncParams(id),
    );
    const call = mockLogInfo.mock.calls.find(
      (c) => (c[0] as { action?: string })?.action === 'share_deleted',
    );
    expect(call).toBeDefined();
    const payload = call![0] as {
      shareId: number;
      snapshot: { name: string; path: string };
      orphanedFileCount: number;
      actor: string;
    };
    expect(payload.shareId).toBe(id);
    expect(payload.snapshot.name).toBe('GoneSoon');
    expect(payload.snapshot.path).toBe('/media/gone');
    expect(payload.orphanedFileCount).toBe(1);
    expect(payload.actor).toBe('anonymous');
  });
});

describe('PATCH + DELETE — AC-9 auth gate', () => {
  beforeEach(() => {
    settingRepo().set('auth_enabled', 'true');
    settingRepo().set('session_secret', 'x'.repeat(48));
    invalidateAuthSettingsCache();
  });

  it('test_patch_when_auth_enabled_no_cookie_then_401', async () => {
    const { id } = createShare();
    const res = await PATCH(
      new Request(`http://test/api/shares/${id}`, jsonPatchInit({ name: 'X' })),
      asyncParams(id),
    );
    expect(res.status).toBe(401);
    expect(shareRepo().getById(id)?.name).toBe('Movies');
  });

  it('test_delete_when_auth_enabled_no_cookie_then_401', async () => {
    const { id } = createShare();
    const res = await DELETE(
      new Request(`http://test/api/shares/${id}`, { method: 'DELETE' }),
      asyncParams(id),
    );
    expect(res.status).toBe(401);
    expect(shareRepo().getById(id)).toBeDefined();
  });
});
