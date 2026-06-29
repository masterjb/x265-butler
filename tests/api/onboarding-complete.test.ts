import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShareRow } from '@/src/lib/db/schema';

// 14-04 (Plan 14-04 Task 6): POST /api/onboarding/complete now performs
// share create / PATCH-placeholder / 409-already-customized in addition to
// flipping setting.onboarding_completed. Tests cover AC-16a/b/c.

const {
  mockSettingSet,
  mockEnsureServerInit,
  mockShareListAll,
  mockShareCreate,
  mockShareUpdate,
  mockShareGetById,
  mockShareAssertNonNested,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockSettingSet: vi.fn<(key: string, value: string) => void>(),
  mockEnsureServerInit: vi.fn(),
  mockShareListAll: vi.fn<() => ShareRow[]>(),
  mockShareCreate: vi.fn<(input: unknown) => ShareRow>(),
  mockShareUpdate: vi.fn<(id: number, patch: unknown) => ShareRow | undefined>(),
  mockShareGetById: vi.fn<(id: number) => ShareRow | undefined>(),
  mockShareAssertNonNested: vi.fn<(input: unknown) => void>(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ set: mockSettingSet }),
  shareRepo: () => ({
    listAll: mockShareListAll,
    create: mockShareCreate,
    update: mockShareUpdate,
    getById: mockShareGetById,
    assertNonNested: mockShareAssertNonNested,
  }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    }),
  },
  default: {},
}));

import { POST, runtime } from '@/app/api/onboarding/complete/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE_URL = 'http://test/api/onboarding/complete';

function makeRequest(body: string | undefined = undefined): Request {
  return new Request(ROUTE_URL, { method: 'POST', body });
}

function jsonRequest(payload: unknown): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function sampleShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    name: 'Library',
    path: '/media',
    min_size_mb: 50,
    extensions_csv: 'mp4,mkv',
    max_depth: 12,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

describe('POST /api/onboarding/complete', () => {
  beforeEach(() => {
    mockSettingSet.mockReset();
    mockEnsureServerInit.mockReset();
    mockShareListAll.mockReset();
    mockShareCreate.mockReset();
    mockShareUpdate.mockReset();
    mockShareGetById.mockReset();
    mockShareAssertNonNested.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockShareListAll.mockReturnValue([]);
    delete process.env.NEXT_PHASE;
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_called_empty_body_then_200_completed_true_shareAction_none', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(true);
    expect(body.shareAction).toBe('none');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockShareCreate).not.toHaveBeenCalled();
    expect(mockShareUpdate).not.toHaveBeenCalled();
  });

  it('test_POST_when_empty_body_then_settingRepo_set_called_with_onboarding_completed_true', async () => {
    await POST(makeRequest());
    expect(mockSettingSet).toHaveBeenCalledWith('onboarding_completed', 'true');
    expect(mockSettingSet).toHaveBeenCalledTimes(1);
  });

  it('test_POST_when_NEXT_PHASE_phase_production_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(false);
    expect(body.reason).toBe('build-time-skip');
    expect(mockSettingSet).not.toHaveBeenCalled();
    expect(mockEnsureServerInit).not.toHaveBeenCalled();
  });

  it('test_POST_when_called_then_cache_control_no_store', async () => {
    const res = await POST(makeRequest());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('test_POST_when_settingRepo_throws_then_returns_500_with_requestId', async () => {
    mockSettingSet.mockImplementation(() => {
      throw new Error('db locked');
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('test_POST_when_unknown_key_in_body_then_400_invalid_body', async () => {
    const res = await POST(jsonRequest({ foo: 'bar' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockSettingSet).not.toHaveBeenCalled();
    const warnCall = mockLoggerWarn.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_complete_validation_failed');
    expect(warnCall).toBeDefined();
  });

  it('test_POST_when_invalid_json_then_400_invalid_body', async () => {
    const res = await POST(makeRequest('{not json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_POST_when_whitespace_body_then_succeeds_200', async () => {
    const res = await POST(makeRequest('   \n\t  '));
    expect(res.status).toBe(200);
    expect(mockSettingSet).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/onboarding/complete — AC-16a fresh install creates Library share', () => {
  beforeEach(() => {
    mockSettingSet.mockReset();
    mockShareListAll.mockReset();
    mockShareCreate.mockReset();
    mockShareUpdate.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    delete process.env.NEXT_PHASE;
  });

  it('test_POST_when_shares_empty_then_create_share_named_Library', async () => {
    mockShareListAll.mockReturnValue([]);
    mockShareCreate.mockReturnValue(
      sampleShare({ id: 1, name: 'Library', path: '/media-array', min_size_mb: 75 }),
    );
    const res = await POST(jsonRequest({ scan_root: '/media-array', min_size_mb: 75 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shareAction).toBe('created');
    expect(body.shareId).toBe(1);
    expect(mockShareCreate).toHaveBeenCalledWith({
      name: 'Library',
      path: '/media-array',
      min_size_mb: 75,
      extensions_csv: 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv',
      max_depth: 12,
    });
    expect(mockSettingSet).toHaveBeenCalledWith('onboarding_completed', 'true');
    const createLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_share_created');
    expect(createLog).toBeDefined();
  });
});

describe('POST /api/onboarding/complete — AC-16b placeholder PATCH', () => {
  beforeEach(() => {
    mockSettingSet.mockReset();
    mockShareListAll.mockReset();
    mockShareCreate.mockReset();
    mockShareUpdate.mockReset();
    mockShareAssertNonNested.mockReset();
    mockLoggerInfo.mockReset();
    delete process.env.NEXT_PHASE;
  });

  it('test_POST_when_placeholder_share_then_PATCH_with_operator_values', async () => {
    const placeholder = sampleShare({
      id: 1,
      name: 'Library',
      path: '/media',
      created_at: 1700000000,
      updated_at: 1700000000, // created_at === updated_at heuristic
    });
    mockShareListAll.mockReturnValue([placeholder]);
    mockShareUpdate.mockReturnValue(
      sampleShare({
        ...placeholder,
        path: '/media-array',
        min_size_mb: 75,
        extensions_csv: 'mkv,mp4',
        max_depth: 10,
        updated_at: 1700000100,
      }),
    );

    const res = await POST(
      jsonRequest({
        scan_root: '/media-array',
        min_size_mb: 75,
        extensions_csv: 'mkv,mp4',
        max_depth: 10,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shareAction).toBe('updated');
    expect(body.shareId).toBe(1);
    expect(mockShareCreate).not.toHaveBeenCalled();
    expect(mockShareUpdate).toHaveBeenCalledWith(1, {
      name: 'Library',
      path: '/media-array',
      min_size_mb: 75,
      extensions_csv: 'mkv,mp4',
      max_depth: 10,
    });
    expect(mockShareAssertNonNested).toHaveBeenCalledWith({
      path: '/media-array',
      excludeId: 1,
    });
    const updLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_share_updated');
    expect(updLog).toBeDefined();
    expect((updLog as { before?: ShareRow }).before).toMatchObject({ id: 1, path: '/media' });
    expect((updLog as { after?: ShareRow }).after).toMatchObject({ path: '/media-array' });
  });
});

describe('POST /api/onboarding/complete — AC-16c already-customized 409', () => {
  beforeEach(() => {
    mockSettingSet.mockReset();
    mockShareListAll.mockReset();
    mockShareCreate.mockReset();
    mockShareUpdate.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    delete process.env.NEXT_PHASE;
  });

  it('test_POST_when_share_customized_then_409_onboarding_already_completed', async () => {
    const customized = sampleShare({
      id: 1,
      name: 'Custom Library',
      path: '/data/movies',
      created_at: 1700000000,
      updated_at: 1700000200, // updated_at > created_at
    });
    mockShareListAll.mockReturnValue([customized]);

    const res = await POST(jsonRequest({ scan_root: '/media-array', min_size_mb: 75 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('onboarding_already_completed');
    expect(body.knownShares).toEqual([{ id: 1, name: 'Custom Library' }]);
    expect(mockShareCreate).not.toHaveBeenCalled();
    expect(mockShareUpdate).not.toHaveBeenCalled();
    expect(mockSettingSet).not.toHaveBeenCalled();
    const warnLog = mockLoggerWarn.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_already_completed');
    expect(warnLog).toBeDefined();
  });

  it('test_POST_when_multiple_shares_exist_then_409_lists_all', async () => {
    mockShareListAll.mockReturnValue([
      sampleShare({ id: 1, name: 'Movies', path: '/media/movies' }),
      sampleShare({ id: 2, name: 'Music', path: '/media/music' }),
    ]);
    const res = await POST(jsonRequest({ scan_root: '/media-array', min_size_mb: 75 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.knownShares).toHaveLength(2);
  });
});
