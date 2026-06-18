import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockGetAll,
  mockGet,
  mockSet,
  mockDelete,
  mockTransaction,
  mockShareListAll,
  loggerInfoSpy,
} = vi.hoisted(() => {
  const mockSet = vi.fn<(key: string, value: string) => void>();
  return {
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockGet: vi.fn<(key: string) => string | undefined>(),
    mockSet,
    // 24-03: clear-to-unset deletes the cache_pool_path row.
    mockDelete: vi.fn<(key: string) => void>(),
    mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      // Reproduce better-sqlite3's transaction wrapper: returns a callable that
      // invokes `fn` with whatever args were passed. Lets us assert atomic
      // semantics by overriding `fn` in tests.
      return (...args: T) => fn(...args);
    }),
    // 14-04 (Plan 14-04 Task 5, AC-24): cache_pool_path collision check now
    // targets shareRepo().listAll() instead of setting.get('scan_root').
    mockShareListAll: vi.fn<
      () => Array<{
        id: number;
        name: string;
        path: string;
        min_size_mb: number;
        extensions_csv: string;
        max_depth: number | null;
        created_at: number;
        updated_at: number;
      }>
    >(),
    loggerInfoSpy: vi.fn(),
  };
});

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: mockGetAll, get: mockGet, set: mockSet, delete: mockDelete }),
  shareRepo: () => ({ listAll: mockShareListAll }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({
    info: loggerInfoSpy,
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    logger: { child, info: loggerInfoSpy, warn: vi.fn(), error: vi.fn() },
    default: { logger: { child } },
  };
});

// 22-02 B (audit-revised): probeCachePoolWritable runs at the PUT-validation
// boundary. The existing happy-path tests submit non-existent paths (e.g.
// `/home/user/x265`); mock the helper to default-succeed so carry-forward
// tests continue to pass. Failure-mode coverage lives in
// tests/api/settings-cache-pool-writability.test.ts (new T2.2 file).
vi.mock('@/src/lib/encode/staging', () => {
  class CachePoolUnavailableError extends Error {
    readonly code: string;
    constructor(code: string, message: string, opts?: { cause?: unknown }) {
      super(message, opts);
      this.code = code;
      this.name = 'CachePoolUnavailableError';
    }
  }
  return {
    probeCachePoolWritable: vi.fn(() => undefined),
    CachePoolUnavailableError,
  };
});

import { GET, PUT } from '@/app/api/settings/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// 14-04 (Plan 14-04 Task 5): seedDefaults no longer carries the 4 retired
// legacy keys. Those settings.* keys are dropped by migration 0027; tests
// that need a baseline scalar value substitute `language` (zod enum) or
// `output_container` (zod enum) below.
const seedDefaults = {
  language: 'en',
  output_container: 'mkv',
};

describe('GET /api/settings', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockGetAll.mockReturnValue({ ...seedDefaults });
  });

  it('test_GET_when_called_then_200_with_settings_and_requestId', async () => {
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.settings.language).toBe('en');
    expect(body.requestId).toMatch(UUID_V4);
  });
});

describe('PUT /api/settings', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockGet.mockReset();
    mockSet.mockReset();
    mockDelete.mockReset();
    mockTransaction.mockReset();
    mockShareListAll.mockReset();
    loggerInfoSpy.mockReset();
    mockGetAll.mockReturnValue({ ...seedDefaults });
    mockGet.mockImplementation((k: string) => seedDefaults[k as keyof typeof seedDefaults]);
    mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      return (...args: T) => fn(...args);
    });
    // Default: no shares → cache_pool_path collision check is a no-op.
    mockShareListAll.mockReturnValue([]);
  });

  it('test_PUT_when_partial_update_then_200_merged_settings', async () => {
    mockGetAll.mockReturnValue({ ...seedDefaults, language: 'de' });
    const res = await PUT(jsonReq({ settings: { language: 'de' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.settings.language).toBe('de');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockSet).toHaveBeenCalledWith('language', 'de');
  });

  it('test_PUT_when_unknown_key_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { hacked: 'x' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.requestId).toMatch(UUID_V4);
  });

  // 14-04: retired legacy single-share keys → zod strict 400.
  it('test_PUT_when_legacy_scan_root_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { scan_root: '/media/x' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PUT_when_legacy_min_size_mb_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { min_size_mb: '50' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_legacy_extensions_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { extensions: 'mkv,mp4' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_legacy_max_depth_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { max_depth: '12' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_invalid_value_then_400_invalid_body_with_details', async () => {
    const res = await PUT(jsonReq({ settings: { min_savings_percent: '99' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.details).toBeDefined();
  });

  // 26-02 (F5): output_mode enum contract (AC-2). Mirrors sidecar_mode.
  it('test_PUT_when_output_mode_out_of_enum_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { output_mode: 'inplace' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PUT_when_output_mode_suffix_then_200_persists', async () => {
    const res = await PUT(jsonReq({ settings: { output_mode: 'suffix' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('output_mode', 'suffix');
  });

  it('test_PUT_when_output_mode_replace_then_200_persists', async () => {
    const res = await PUT(jsonReq({ settings: { output_mode: 'replace' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('output_mode', 'replace');
  });

  // 26-01 (F3): sidecar_mode enum + sidecar_central_path contract (AC-4 / M2 / S2).
  it('test_PUT_when_sidecar_mode_out_of_enum_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { sidecar_mode: 'elsewhere' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PUT_when_valid_sidecar_mode_and_absolute_central_path_then_200_persists', async () => {
    const res = await PUT(
      jsonReq({
        settings: {
          sidecar_mode: 'central',
          sidecar_central_path: '/config/x265-butler/sidecars/',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('sidecar_mode', 'central');
    expect(mockSet).toHaveBeenCalledWith('sidecar_central_path', '/config/x265-butler/sidecars/');
  });

  it('test_PUT_when_sidecar_central_path_empty_then_400_invalid_body (M2)', async () => {
    // Critical M2: empty string must NOT be accepted (unlike cache_pool_path's
    // empty-is-auto escape) — `.min(1)` rejects → zod 400.
    const res = await PUT(jsonReq({ settings: { sidecar_central_path: '' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PUT_when_sidecar_central_path_non_absolute_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { sidecar_central_path: 'relative/dir' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PUT_when_sidecar_central_path_system_root_then_400_forbidden (S2)', async () => {
    const res = await PUT(jsonReq({ settings: { sidecar_central_path: '/etc' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_sidecar_central_path');
  });

  it('test_PUT_when_sidecar_central_path_under_etc_then_400_forbidden (S2)', async () => {
    const res = await PUT(jsonReq({ settings: { sidecar_central_path: '/etc/x265' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_sidecar_central_path');
  });

  it('test_PUT_when_wrong_content_type_then_415', async () => {
    const res = await PUT(
      new Request('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe('unsupported_media_type');
  });

  it('test_PUT_when_oversized_cache_pool_path_then_400_invalid_body', async () => {
    const huge = '/' + 'a'.repeat(5000);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: huge } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  // audit-added M6: structured pino info per changed key with action='settings_change'
  it('test_PUT_when_keys_change_then_emits_settings_change_log_per_key', async () => {
    mockGet.mockImplementation((k: string) => {
      if (k === 'language') return 'en';
      if (k === 'encoder') return 'auto';
      return undefined;
    });
    const res = await PUT(jsonReq({ settings: { language: 'de', encoder: 'nvenc' } }));
    expect(res.status).toBe(200);
    const calls = loggerInfoSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'settings_change',
    );
    expect(calls).toHaveLength(2);
    const langCall = calls.find((c) => (c[0] as { key?: string }).key === 'language');
    expect(langCall).toBeDefined();
    expect((langCall![0] as { oldValue: string }).oldValue).toBe('en');
    expect((langCall![0] as { newValue: string }).newValue).toBe('de');
  });

  // audit-added: atomic transaction — partial failure rolls back
  it('test_PUT_when_transaction_throws_mid_write_then_500_no_partial_persist', async () => {
    mockTransaction.mockImplementation(() => {
      return () => {
        throw new Error('mid-write boom');
      };
    });
    const res = await PUT(jsonReq({ settings: { language: 'de', encoder: 'nvenc' } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  // 14-04 AC-24: cache_pool_path must not equal nor nest within any share.path.
  function sampleShare(overrides: Partial<{ id: number; name: string; path: string }> = {}) {
    return {
      id: 1,
      name: 'Library',
      path: '/media',
      min_size_mb: 50,
      extensions_csv: 'mkv',
      max_depth: null as number | null,
      created_at: 1,
      updated_at: 1,
      ...overrides,
    };
  }

  it('test_PUT_when_cache_pool_path_nested_under_share_then_400_validation_failed', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/media/cache' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.cache_pool_path).toBe('cache_pool_path_nested_under_share');
    expect(body.conflictingShareName).toBe('Library');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('test_PUT_when_cache_pool_path_equals_share_path_then_400_validation_failed', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/media' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.cache_pool_path).toBe('cache_pool_path_nested_under_share');
  });

  it('test_PUT_when_cache_pool_path_non_nested_against_shares_then_200', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    mockGetAll
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: '/mnt/cache' })
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: '/var/cache' });
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/var/cache' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('cache_pool_path', '/var/cache');
  });

  it('test_PUT_when_cache_pool_path_collides_via_partial_update_against_shares_then_400', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    mockGetAll.mockReturnValue({ ...seedDefaults, cache_pool_path: '/media/cache' });
    // Partial PUT without cache_pool_path — merged state still nested → 400.
    const res = await PUT(jsonReq({ settings: { language: 'de' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('test_PUT_when_cache_pool_path_starts_with_etc_then_400_forbidden', async () => {
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/etc/cache' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_cache_path');
  });

  it('test_PUT_when_cache_pool_path_is_root_slash_then_400_forbidden', async () => {
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_cache_path');
  });

  it('test_PUT_when_cache_pool_path_valid_writable_then_200_persisted', async () => {
    mockGetAll
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: '/mnt/cache' })
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: '/home/user/x265' });
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/home/user/x265' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('cache_pool_path', '/home/user/x265');
  });

  // 33-02: trash_path validation contract (AC-4 / AC-8).
  it('test_PUT_when_trash_path_non_absolute_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { trash_path: 'media-trash' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockSet).not.toHaveBeenCalledWith('trash_path', expect.anything());
  });

  it('test_PUT_when_trash_path_forbidden_etc_then_400_forbidden_trash_path', async () => {
    const res = await PUT(jsonReq({ settings: { trash_path: '/etc' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_trash_path');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('test_PUT_when_trash_path_root_slash_then_400_forbidden_trash_path', async () => {
    const res = await PUT(jsonReq({ settings: { trash_path: '/' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_trash_path');
  });

  it('test_PUT_when_trash_path_empty_then_200_persists_as_auto', async () => {
    const res = await PUT(jsonReq({ settings: { trash_path: '' } }));
    expect(res.status).toBe(200);
    // empty = auto (revert to cache stageRoot); persisted as '' (NOT deleted).
    expect(mockSet).toHaveBeenCalledWith('trash_path', '');
  });

  it('test_PUT_when_trash_path_valid_absolute_then_200_persisted', async () => {
    const res = await PUT(jsonReq({ settings: { trash_path: '/mnt/user/media-trash' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('trash_path', '/mnt/user/media-trash');
  });

  // AC-8: trash nested UNDER a scanned share → walker re-ingest loop → reject.
  it('test_PUT_when_trash_path_nested_under_share_then_400_validation_failed', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    const res = await PUT(jsonReq({ settings: { trash_path: '/media/trash-bin' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.trash_path).toBe('trash_path_nested_under_share');
    expect(body.conflictingShareName).toBe('Library');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('test_PUT_when_trash_path_equals_share_path_then_400_validation_failed', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    const res = await PUT(jsonReq({ settings: { trash_path: '/media' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.trash_path).toBe('trash_path_nested_under_share');
  });

  // AC-8 bidirectional: a share nested UNDER the trash root → walker descends
  // from the share-root INTO the trash subtree → reject (the direction the
  // one-directional cache_pool_path guard does NOT cover).
  it('test_PUT_when_share_nested_under_trash_path_then_400_validation_failed', async () => {
    mockShareListAll.mockReturnValue([
      sampleShare({ name: 'Sub', path: '/mnt/user/trash/movies' }),
    ]);
    const res = await PUT(jsonReq({ settings: { trash_path: '/mnt/user/trash' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.trash_path).toBe('trash_path_nested_under_share');
  });

  it('test_PUT_when_trash_path_non_nested_against_shares_then_200', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ name: 'Library', path: '/media' })]);
    const res = await PUT(jsonReq({ settings: { trash_path: '/mnt/user/media-trash' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('trash_path', '/mnt/user/media-trash');
  });

  // 03-03 audit M4 + S5: encoder + concurrency + crf_* zod whitelist extension.

  it('test_PUT_when_encoder_nvenc_then_200_persisted', async () => {
    const res = await PUT(jsonReq({ settings: { encoder: 'nvenc' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('encoder', 'nvenc');
  });

  it('test_PUT_when_concurrency_4_then_200_persisted', async () => {
    const res = await PUT(jsonReq({ settings: { concurrency: '4' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('concurrency', '4');
  });

  it('test_PUT_when_crf_libx265_23_then_200_persisted', async () => {
    const res = await PUT(jsonReq({ settings: { crf_libx265: '23' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('crf_libx265', '23');
  });

  it('test_PUT_when_encoder_gibberish_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { encoder: 'gibberish' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_encoder_av1_nvenc_then_400_invalid_body', async () => {
    // Future Milestone 2 encoder NOT yet allowed in v1.0 enum.
    const res = await PUT(jsonReq({ settings: { encoder: 'av1_nvenc' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_concurrency_9_then_400_invalid_body', async () => {
    // Discovery typical range 1-8 + 'auto'; >8 deferred D7.
    const res = await PUT(jsonReq({ settings: { concurrency: '9' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_crf_libx265_52_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { crf_libx265: '52' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_crf_libx265_negative_then_400_invalid_body', async () => {
    const res = await PUT(jsonReq({ settings: { crf_libx265: '-1' } }));
    expect(res.status).toBe(400);
  });

  it('test_PUT_when_encoder_pinned_unavailable_value_qsv_then_200_no_block', async () => {
    // Audit S5 client zod parity: server accepts ANY ENCODER_IDS value, not
    // just detected[] subset. Operator may deliberately pin in anticipation
    // of GPU swap. Orchestrator handles fallback at dispatch via 03-01
    // ENCODER_IDS validation.
    const res = await PUT(jsonReq({ settings: { encoder: 'qsv' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('encoder', 'qsv');
  });

  it('test_PUT_when_encoder_concurrency_crf_qsv_all_change_then_emits_settings_change_log_per_key', async () => {
    // Audit M4: existing 01-04 settings_change audit log per key flows through
    // for the 6 new keys via `Object.keys(updates)` iteration in the route.
    await PUT(
      jsonReq({
        settings: { encoder: 'nvenc', concurrency: '4', crf_qsv: '20' },
      }),
    );
    const changeKeys = loggerInfoSpy.mock.calls
      .map((c) => c[0])
      .filter((c) => (c as { action?: string }).action === 'settings_change')
      .map((c) => (c as { key: string }).key);
    expect(changeKeys).toEqual(expect.arrayContaining(['encoder', 'concurrency', 'crf_qsv']));
    expect(changeKeys).toHaveLength(3);
  });

  // 05-13: min_savings_percent zod whitelist (range 0..50 integer-as-string).
  describe('PUT /api/settings — min_savings_percent (05-13)', () => {
    it('test_PUT_when_min_savings_percent_0_then_200_persists_value', async () => {
      const res = await PUT(jsonReq({ settings: { min_savings_percent: '0' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('min_savings_percent', '0');
    });

    it('test_PUT_when_min_savings_percent_50_then_200_persists_value', async () => {
      const res = await PUT(jsonReq({ settings: { min_savings_percent: '50' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('min_savings_percent', '50');
    });

    it('test_PUT_when_min_savings_percent_51_then_400_out_of_range', async () => {
      const res = await PUT(jsonReq({ settings: { min_savings_percent: '51' } }));
      expect(res.status).toBe(400);
    });

    it('test_PUT_when_min_savings_percent_negative_then_400_invalid_format', async () => {
      // negative numbers fail the regex `/^\d+$/` (no minus sign accepted)
      const res = await PUT(jsonReq({ settings: { min_savings_percent: '-5' } }));
      expect(res.status).toBe(400);
    });

    it('test_PUT_when_min_savings_percent_non_numeric_then_400_invalid_format', async () => {
      const res = await PUT(jsonReq({ settings: { min_savings_percent: 'abc' } }));
      expect(res.status).toBe(400);
    });
  });

  // 05-14: output_container zod whitelist + setting_changed pino emit (G2).
  describe('PUT /api/settings — output_container (05-14)', () => {
    it('test_PUT_when_output_container_mkv_then_200_persists_value', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'mkv' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('output_container', 'mkv');
    });

    it('test_PUT_when_output_container_mp4_then_200_persists_value', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'mp4' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('output_container', 'mp4');
    });

    it('test_PUT_when_output_container_webm_then_400_invalid_value', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'webm' } }));
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalledWith('output_container', expect.anything());
    });

    it('test_PUT_when_output_container_uppercase_MKV_then_400_case_sensitive', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'MKV' } }));
      expect(res.status).toBe(400);
    });

    it('test_PUT_when_output_container_empty_string_then_400', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: '' } }));
      expect(res.status).toBe(400);
    });

    it('test_PUT_when_output_container_AND_output_suffix_simultaneous_then_200_both_persist', async () => {
      const res = await PUT(
        jsonReq({ settings: { output_container: 'mp4', output_suffix: '.x265.legacy' } }),
      );
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('output_container', 'mp4');
      expect(mockSet).toHaveBeenCalledWith('output_suffix', '.x265.legacy');
    });

    // G2 audit-trail: pino setting_changed event.
    it('test_PUT_when_output_container_changes_mkv_to_mp4_then_pino_setting_changed_fires_once', async () => {
      mockGet.mockImplementation((k: string) => (k === 'output_container' ? 'mkv' : undefined));
      const res = await PUT(jsonReq({ settings: { output_container: 'mp4' } }));
      expect(res.status).toBe(200);
      const settingChangedCalls = loggerInfoSpy.mock.calls.filter(
        ([first]) =>
          typeof first === 'object' &&
          first !== null &&
          (first as { action?: string }).action === 'setting_changed',
      );
      expect(settingChangedCalls).toHaveLength(1);
      expect(settingChangedCalls[0][0]).toMatchObject({
        action: 'setting_changed',
        key: 'output_container',
        oldValue: 'mkv',
        newValue: 'mp4',
      });
    });

    it('test_PUT_when_output_container_idempotent_resave_mp4_then_pino_setting_changed_does_NOT_fire', async () => {
      mockGet.mockImplementation((k: string) => (k === 'output_container' ? 'mp4' : undefined));
      const res = await PUT(jsonReq({ settings: { output_container: 'mp4' } }));
      expect(res.status).toBe(200);
      const settingChangedCalls = loggerInfoSpy.mock.calls.filter(
        ([first]) =>
          typeof first === 'object' &&
          first !== null &&
          (first as { action?: string }).action === 'setting_changed',
      );
      expect(settingChangedCalls).toHaveLength(0);
    });

    it('test_PUT_when_output_container_webm_rejected_then_pino_setting_changed_does_NOT_fire', async () => {
      mockGet.mockImplementation((k: string) => (k === 'output_container' ? 'mkv' : undefined));
      const res = await PUT(jsonReq({ settings: { output_container: 'webm' } }));
      expect(res.status).toBe(400);
      const settingChangedCalls = loggerInfoSpy.mock.calls.filter(
        ([first]) =>
          typeof first === 'object' &&
          first !== null &&
          (first as { action?: string }).action === 'setting_changed',
      );
      expect(settingChangedCalls).toHaveLength(0);
    });

    // 05-15: third enum value `match-source` (DWIM directive).
    it('test_PUT_when_output_container_match_source_then_200_persists_value', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'match-source' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('output_container', 'match-source');
    });

    it('test_PUT_when_output_container_match_source_audit_trail_oldValue_mkv_newValue_match_source', async () => {
      mockGet.mockImplementation((k: string) => (k === 'output_container' ? 'mkv' : undefined));
      const res = await PUT(jsonReq({ settings: { output_container: 'match-source' } }));
      expect(res.status).toBe(200);
      const settingChangedCalls = loggerInfoSpy.mock.calls.filter(
        ([first]) =>
          typeof first === 'object' &&
          first !== null &&
          (first as { action?: string }).action === 'setting_changed',
      );
      expect(settingChangedCalls).toHaveLength(1);
      expect(settingChangedCalls[0][0]).toMatchObject({
        action: 'setting_changed',
        key: 'output_container',
        oldValue: 'mkv',
        newValue: 'match-source',
      });
    });

    it('test_PUT_when_output_container_match_source_uppercase_then_400_case_sensitive', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'Match-Source' } }));
      expect(res.status).toBe(400);
    });

    it('test_PUT_when_output_container_match_underscore_source_then_400_zod_strict_literal', async () => {
      const res = await PUT(jsonReq({ settings: { output_container: 'match_source' } }));
      expect(res.status).toBe(400);
    });
  });

  // 12-03: per-encoder preset_<encoder> zod-enum validation + atomic-failure
  // SR4 (mixed-validity payload → 400 + ZERO db writes).
  describe('PUT /api/settings — 12-03 preset_<encoder>', () => {
    it('test_PUT_when_preset_libx265_slow_then_200_and_set_called', async () => {
      mockGetAll.mockReturnValue({ ...seedDefaults, preset_libx265: 'slow' });
      const res = await PUT(jsonReq({ settings: { preset_libx265: 'slow' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('preset_libx265', 'slow');
    });

    it('test_PUT_when_preset_nvenc_p7_then_200_and_set_called', async () => {
      const res = await PUT(jsonReq({ settings: { preset_nvenc: 'p7' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('preset_nvenc', 'p7');
    });

    it('test_PUT_when_preset_qsv_veryslow_then_200_and_set_called', async () => {
      const res = await PUT(jsonReq({ settings: { preset_qsv: 'veryslow' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('preset_qsv', 'veryslow');
    });

    it('test_PUT_when_preset_vaapi_fast_then_200_and_set_called', async () => {
      const res = await PUT(jsonReq({ settings: { preset_vaapi: 'fast' } }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith('preset_vaapi', 'fast');
    });

    it('test_PUT_when_preset_libx265_out_of_Catalog_lightspeed_then_400_invalid_body', async () => {
      const res = await PUT(jsonReq({ settings: { preset_libx265: 'lightspeed' } }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_body');
      expect(body.details).toBeDefined();
    });

    it('test_PUT_when_preset_nvenc_invalid_p9_then_400_invalid_body', async () => {
      const res = await PUT(jsonReq({ settings: { preset_nvenc: 'p9' } }));
      expect(res.status).toBe(400);
    });

    // 12-03 audit SR4: atomic-failure rollback — mixed-validity payload
    // {crf_libx265: 21 valid, preset_libx265: 'lightspeed' invalid} → 400 +
    // ZERO mockSet calls. zod-parse fails BEFORE any write reaches settingRepo.
    it('test_PUT_when_mixed_validity_payload_invalid_preset_then_400_AND_zero_db_writes_SR4', async () => {
      const res = await PUT(
        jsonReq({ settings: { crf_libx265: '21', preset_libx265: 'lightspeed' } }),
      );
      expect(res.status).toBe(400);
      // Atomic-failure invariant: no individual key writes occurred.
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('test_PUT_when_preset_libx265_uppercase_MEDIUM_then_400_zod_case_sensitive', async () => {
      const res = await PUT(jsonReq({ settings: { preset_libx265: 'MEDIUM' } }));
      expect(res.status).toBe(400);
    });
  });

  // 24-03 (F2, AC-7): clear-to-unset cache_pool_path → delete the row (revert to
  // DC-B auto-resolve), NEVER store the empty string; skip the writability gate.
  describe('PUT /api/settings — cache_pool_path clear-to-unset (24-03)', () => {
    it('test_PUT_when_cache_pool_path_empty_then_row_deleted_not_set', async () => {
      mockGet.mockImplementation((k: string) =>
        k === 'cache_pool_path'
          ? '/mnt/disks/nvme/cache'
          : seedDefaults[k as keyof typeof seedDefaults],
      );
      const res = await PUT(jsonReq({ settings: { cache_pool_path: '' } }));
      expect(res.status).toBe(200);
      expect(mockDelete).toHaveBeenCalledWith('cache_pool_path');
      // never persisted as the empty string
      expect(mockSet).not.toHaveBeenCalledWith('cache_pool_path', '');
    });

    it('test_PUT_when_cache_pool_path_whitespace_then_treated_as_clear', async () => {
      const res = await PUT(jsonReq({ settings: { cache_pool_path: '   ' } }));
      expect(res.status).toBe(200);
      expect(mockDelete).toHaveBeenCalledWith('cache_pool_path');
    });

    it('test_PUT_when_cache_pool_path_empty_then_audit_trail_emitted', async () => {
      mockGet.mockImplementation((k: string) =>
        k === 'cache_pool_path'
          ? '/mnt/disks/nvme/cache'
          : seedDefaults[k as keyof typeof seedDefaults],
      );
      await PUT(jsonReq({ settings: { cache_pool_path: '' } }));
      const cleared = loggerInfoSpy.mock.calls.find(
        ([meta]) =>
          meta &&
          typeof meta === 'object' &&
          (meta as Record<string, unknown>).key === 'cache_pool_path' &&
          (meta as Record<string, unknown>).action === 'settings_change' &&
          (meta as Record<string, unknown>).newValue === null,
      );
      expect(cleared).toBeTruthy();
    });

    it('test_PUT_when_cache_pool_path_relative_then_400_zod_reject', async () => {
      const res = await PUT(jsonReq({ settings: { cache_pool_path: 'relative/path' } }));
      expect(res.status).toBe(400);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    // 28-03 (R9 / AC-4): the cache_pool_path row-delete is folded INTO the
    // writeAll transaction so a clear+update PUT commits atomically. Prove the
    // delete fires INSIDE the transaction callback (txnDepth > 0) alongside the
    // key-sets — previously it ran post-commit (a partial-write window).
    it('test_PUT_when_clear_and_update_then_delete_runs_inside_writeAll_txn', async () => {
      let txnDepth = 0;
      let deleteInsideTxn: boolean | null = null;
      const setInsideTxn: boolean[] = [];
      mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
        return (...args: T) => {
          txnDepth++;
          try {
            return fn(...args);
          } finally {
            txnDepth--;
          }
        };
      });
      mockSet.mockImplementation(() => {
        setInsideTxn.push(txnDepth > 0);
      });
      mockDelete.mockImplementation((k: string) => {
        if (k === 'cache_pool_path') deleteInsideTxn = txnDepth > 0;
      });
      mockGet.mockImplementation((k: string) =>
        k === 'cache_pool_path'
          ? '/mnt/disks/nvme/cache'
          : seedDefaults[k as keyof typeof seedDefaults],
      );

      const res = await PUT(jsonReq({ settings: { cache_pool_path: '', language: 'de' } }));
      expect(res.status).toBe(200);
      // the row-delete happened inside the transaction callback
      expect(deleteInsideTxn).toBe(true);
      // and the sibling key-update set also ran inside the same txn
      expect(setInsideTxn.length).toBeGreaterThan(0);
      expect(setInsideTxn.every((v) => v === true)).toBe(true);
    });
  });
});
