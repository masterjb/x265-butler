/*
 * 14-04 Task 3 tests — GET + POST /api/shares.
 *
 * Pattern: real :memory: DB via __forTests_setDb so the TX wrap (AC-21) and
 * FK SET NULL semantics (AC-7, see shares-id.test.ts) are exercised end-to-end.
 * Logger mocked via vi.hoisted so AC-26 log-line assertions are deterministic.
 *
 * ACs covered: AC-2, AC-3, AC-4, AC-9 (GET+POST half), AC-21, AC-26 (create),
 * AC-27 (zod hardening: path/extensions/name).
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
import { GET, POST } from '@/app/api/shares/route';

type Db = InstanceType<typeof Database>;

let db: Db;

function jsonPostInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function sampleCreate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: 'Movies',
    path: '/media/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv,mp4',
    max_depth: 8,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // 0001 seeds 'Library' share via 0026 backfill — wipe for predictable id=1.
  db.prepare('DELETE FROM shares').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='shares'").run();
  __forTests_setDb(db);
  invalidateAuthSettingsCache();
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
});

afterEach(() => {
  __forTests_resetDb();
  invalidateAuthSettingsCache();
});

describe('GET /api/shares', () => {
  it('test_get_when_3_shares_then_returns_id_asc_sorted_count_3', async () => {
    shareRepo().create({
      name: 'Z',
      path: '/z',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shareRepo().create({
      name: 'A',
      path: '/a',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shareRepo().create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });

    const res = await GET(new Request('http://test/api/shares'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: Array<{ id: number }>; count: number };
    expect(body.count).toBe(3);
    expect(body.shares.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it('test_get_when_no_shares_then_returns_empty_array_count_0', async () => {
    const res = await GET(new Request('http://test/api/shares'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: unknown[]; count: number };
    expect(body.count).toBe(0);
    expect(body.shares).toEqual([]);
  });

  it('test_get_when_auth_enabled_and_no_cookie_then_401', async () => {
    settingRepo().set('auth_enabled', 'true');
    settingRepo().set('session_secret', 'x'.repeat(48));
    invalidateAuthSettingsCache();
    const res = await GET(new Request('http://test/api/shares'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('auth_required');
  });
});

describe('POST /api/shares — happy + repo errors', () => {
  it('test_post_when_valid_input_then_201_and_persisted', async () => {
    const res = await POST(new Request('http://test/api/shares', jsonPostInit(sampleCreate())));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      share: { id: number; name: string; path: string };
    };
    expect(body.share.id).toBe(1);
    expect(body.share.name).toBe('Movies');
    expect(body.share.path).toBe('/media/movies');
    expect(shareRepo().listAll()).toHaveLength(1);
  });

  it('test_post_when_nested_under_existing_then_409_share_path_nested', async () => {
    shareRepo().create({
      name: 'Movies',
      path: '/media/movies',
      min_size_mb: 50,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ name: 'Shows', path: '/media/movies/sub' })),
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      conflictingShareName: string;
      direction: string;
    };
    expect(body.error).toBe('share_path_nested');
    expect(body.conflictingShareName).toBe('Movies');
    expect(body.direction).toBe('new-nested-under-existing');
    expect(shareRepo().listAll()).toHaveLength(1);
  });

  it('test_post_when_validation_fails_then_400_with_fieldErrors_for_all_bad_fields', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit({
          name: '',
          path: 'relative/no/slash',
          min_size_mb: -1,
          extensions_csv: '',
          max_depth: -5,
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors).toHaveProperty('name');
    expect(body.fieldErrors).toHaveProperty('path');
    expect(body.fieldErrors).toHaveProperty('min_size_mb');
    expect(body.fieldErrors).toHaveProperty('extensions_csv');
    expect(body.fieldErrors).toHaveProperty('max_depth');
  });

  it('test_post_when_wrong_content_type_then_415', async () => {
    const res = await POST(
      new Request('http://test/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'plain',
      }),
    );
    expect(res.status).toBe(415);
  });

  it('test_post_when_invalid_json_then_400', async () => {
    const res = await POST(
      new Request('http://test/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('test_post_when_auth_enabled_and_no_cookie_then_401_and_no_share_created', async () => {
    settingRepo().set('auth_enabled', 'true');
    settingRepo().set('session_secret', 'x'.repeat(48));
    invalidateAuthSettingsCache();
    const res = await POST(new Request('http://test/api/shares', jsonPostInit(sampleCreate())));
    expect(res.status).toBe(401);
    expect(shareRepo().listAll()).toHaveLength(0);
  });
});

describe('POST /api/shares — AC-21 concurrent-POST race', () => {
  it('test_post_when_two_concurrent_nesting_posts_then_exactly_one_201_one_409', async () => {
    const reqA = new Request(
      'http://test/api/shares',
      jsonPostInit(sampleCreate({ name: 'A', path: '/media/movies' })),
    );
    const reqB = new Request(
      'http://test/api/shares',
      jsonPostInit(sampleCreate({ name: 'B', path: '/media/movies/sub' })),
    );
    const [resA, resB] = await Promise.all([POST(reqA), POST(reqB)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(shareRepo().listAll()).toHaveLength(1);
  });
});

describe('POST /api/shares — AC-26 audit-log enrichment', () => {
  it('test_post_when_create_succeeds_then_pino_emits_share_created_with_all_fields_and_actor', async () => {
    await POST(new Request('http://test/api/shares', jsonPostInit(sampleCreate())));
    const createdCall = mockLogInfo.mock.calls.find(
      (call) => (call[0] as { action?: string })?.action === 'share_created',
    );
    expect(createdCall).toBeDefined();
    const payload = createdCall![0] as Record<string, unknown>;
    expect(payload.shareId).toBe(1);
    expect(payload.name).toBe('Movies');
    expect(payload.path).toBe('/media/movies');
    expect(payload.min_size_mb).toBe(50);
    expect(payload.extensions_csv).toBe('mkv,mp4');
    expect(payload.max_depth).toBe(8);
    expect(payload.actor).toBe('anonymous'); // auth disabled by default
  });
});

describe('POST /api/shares — AC-27 zod hardening (SR1+SR2+SR3)', () => {
  it('test_post_when_path_contains_dotdot_then_400_path_traversal_rejected', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ path: '/media/../etc/passwd' })),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.path).toBe('path_traversal_rejected');
  });

  it('test_post_when_path_contains_nul_byte_then_400_path_nul_byte_rejected', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ path: '/media\x00injected' })),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.path).toBe('path_nul_byte_rejected');
  });

  it('test_post_when_path_has_double_slashes_then_201_and_path_collapsed', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ path: '/media//movies///sub' })),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { share: { path: string } };
    expect(body.share.path).toBe('/media/movies/sub');
  });

  it('test_post_when_extensions_csv_contains_dupes_and_caps_then_201_and_dedupe_lowercase', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ extensions_csv: 'mkv,MKV,mkv, ,mp4' })),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { share: { extensions_csv: string } };
    expect(body.share.extensions_csv).toBe('mkv,mp4');
  });

  it('test_post_when_extensions_csv_empty_after_normalize_then_400_extensions_csv_empty_after_normalization', async () => {
    const res = await POST(
      new Request('http://test/api/shares', jsonPostInit(sampleCreate({ extensions_csv: ' , ,' }))),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.extensions_csv).toBe('extensions_csv_empty_after_normalization');
  });

  it('test_post_when_name_has_control_chars_then_400_name_invalid_chars', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ name: 'Bad\n[ACTION] fake_delete' })),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.name).toBe('name_invalid_chars');
  });

  it('test_post_when_name_has_unicode_letter_and_safe_punct_then_201', async () => {
    const res = await POST(
      new Request(
        'http://test/api/shares',
        jsonPostInit(sampleCreate({ name: 'Filme (Familie)', path: '/media/filme' })),
      ),
    );
    expect(res.status).toBe(201);
  });
});
