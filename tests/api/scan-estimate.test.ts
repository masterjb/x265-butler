// Phase 13 Plan 13-04 Task 3 — POST /api/scan/estimate integration tests.
// Mirrors tests/api/bench-recommendation.test.ts harness pattern (vi.hoisted
// + vi.mock; NO in-memory better-sqlite3). 17 cases covering AC-1 through
// AC-7 + AC-15-bis (SOC2 logs) + AC-16 (abort) + M5 (encoder resolution).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EstimateResult } from '@/src/lib/scan/estimate-engine';
import type { DetectionResult } from '@/src/lib/encode/detection';

const {
  mockRunEstimate,
  mockDetectEncoders,
  mockSettingsGetAll,
  mockFsStat,
  mockRequireAuth,
  mockAuthGuard,
  mockAcquire,
  mockRelease,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockRunEstimate: vi.fn<(opts: unknown, deps: unknown) => Promise<EstimateResult>>(),
  mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
  mockSettingsGetAll: vi.fn<() => Record<string, string>>(),
  mockFsStat: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockAuthGuard: vi.fn(),
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/scan/estimate-engine', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/scan/estimate-engine')>(
    '@/src/lib/scan/estimate-engine',
  );
  return { ...actual, runEstimate: mockRunEstimate };
});

vi.mock('@/src/lib/encode/detection', () => ({
  detectEncoders: mockDetectEncoders,
  default: {},
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({}),
  blocklistRepo: () => ({}),
  benchRunRepo: () => ({}),
  benchComboRepo: () => ({}),
  settingRepo: () => ({ getAll: mockSettingsGetAll }),
  // 14-04 (Plan 14-04 Task 7): default empty shares → legacy hardcoded
  // defaults mirror pre-14-04 contract for tests that did not seed shares.
  shareRepo: () => ({ listAll: () => [] }),
  default: {},
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: mockFsStat },
  stat: mockFsStat,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
  withRenewCookie: (res: Response) => res,
  default: {},
}));

vi.mock('@/src/lib/scan/scan-progress-flag', () => ({
  acquireScanLock: mockAcquire,
  releaseScanLock: mockRelease,
  isScanInProgress: () => false,
  __resetScanLockForTests: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: vi.fn(),
    }),
  },
  default: {},
}));

import { POST } from '@/app/api/scan/estimate/route';

const URL_BASE = 'http://test/api/scan/estimate';

function jsonReq(body: unknown, opts: { contentType?: string } = {}): Request {
  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': opts.contentType ?? 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function fakeResult(over: Partial<EstimateResult> = {}): EstimateResult {
  return {
    filesScanned: 3,
    filesEligible: 1,
    skipBuckets: { sidecar: 1, blocklist: 1, eligible: 1, scanned: 3 },
    savings: {
      ratio: 0.5,
      projectedBytes: 500_000_000,
      totalBytes: 1_000_000_000,
      source: 'naive',
      runId: null,
      encoder: 'libx265',
    },
    encodeTime: {
      seconds: 1200,
      source: 'naive',
      runId: null,
      encoder: 'libx265',
      scaleFactor: 1,
      eligibleCount: 1,
      withDurationCount: 1,
    },
    durationMs: 42,
    truncated: false,
    aborted: false,
    ...over,
  };
}

describe('POST /api/scan/estimate (13-04 T3)', () => {
  beforeEach(() => {
    mockRunEstimate.mockReset();
    mockDetectEncoders.mockReset();
    mockSettingsGetAll.mockReset();
    mockFsStat.mockReset();
    mockRequireAuth.mockReset();
    mockAuthGuard.mockReset();
    mockAcquire.mockReset();
    mockRelease.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    // Defaults — happy-path.
    mockRequireAuth.mockResolvedValue({ ok: true, mode: 'authenticated', username: 'op' });
    mockAuthGuard.mockReturnValue(null);
    mockAcquire.mockReturnValue(true);
    mockSettingsGetAll.mockReturnValue({
      scan_root: '/media',
      extensions: 'mp4,mkv',
      min_size_mb: '50',
      max_depth: '12',
      encoder: 'libx265',
    });
    mockFsStat.mockResolvedValue({ isDirectory: () => true } as unknown);
    mockRunEstimate.mockResolvedValue(fakeResult());
  });

  it('case 1 (AC-1): 200 happy-path bench-augmented body shape', async () => {
    mockRunEstimate.mockResolvedValue(
      fakeResult({
        savings: {
          ratio: 0.45,
          projectedBytes: 450_000_000,
          totalBytes: 1_000_000_000,
          source: 'bench-augmented',
          runId: 42,
          encoder: 'libx265',
        },
      }),
    );
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(body.filesScanned).toBeDefined();
    expect(body.filesEligible).toBeDefined();
    expect(body.skipBuckets).toBeDefined();
    expect(body.savings.source).toBe('bench-augmented');
    expect(body.encodeTime).toBeDefined();
    expect(body.effectiveFilters.resolvedRootPath).toBe('/media');
    expect(body.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('case 2 (AC-6): 200 naive-fallback body shape', async () => {
    const res = await POST(jsonReq({}));
    const body = await res.json();
    expect(body.savings.source).toBe('naive');
    expect(body.savings.runId).toBeNull();
  });

  it('case 3: 401 when auth required', async () => {
    mockAuthGuard.mockReturnValue(
      new Response(JSON.stringify({ error_code: 'auth_required' }), { status: 401 }),
    );
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(401);
  });

  it('case 4 (AC-3): 409 when shared scan-lock held', async () => {
    mockAcquire.mockReturnValue(false);
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('scan_in_progress');
    expect(body.requestId).toBeDefined();
    // No engine call when lock denied.
    expect(mockRunEstimate).not.toHaveBeenCalled();
  });

  it('case 5 (AC-3): identical 409 error-code as /api/scan', async () => {
    mockAcquire.mockReturnValue(false);
    const res = await POST(jsonReq({}));
    const body = await res.json();
    expect(body.error).toBe('scan_in_progress');
  });

  it('case 6: 415 wrong content-type', async () => {
    const res = await POST(jsonReq({}, { contentType: 'text/plain' }));
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe('unsupported_media_type');
  });

  it('case 7: 400 invalid JSON body', async () => {
    const res = await POST(jsonReq('this-is-not-json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.details).toBe('malformed JSON');
  });

  it('case 8: 400 zod issues forwarded (negative minSizeMb)', async () => {
    const res = await POST(jsonReq({ minSizeMb: -10 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('case 9: 400 rootPath outside scan_root', async () => {
    const res = await POST(jsonReq({ rootPath: '/etc' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('root_outside_scope');
  });

  it('case 10: 400 rootPath not absolute', async () => {
    const res = await POST(jsonReq({ rootPath: 'relative/path' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('root_outside_scope');
  });

  it('case 11: 404 root_not_found when fs.stat throws', async () => {
    mockFsStat.mockRejectedValue(new Error('ENOENT'));
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('root_not_found');
  });

  it('case 12: 422 root_not_directory when target is a file', async () => {
    mockFsStat.mockResolvedValue({ isDirectory: () => false } as unknown);
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('root_not_directory');
  });

  it('case 13: 200 empty filesScanned=0', async () => {
    mockRunEstimate.mockResolvedValue(
      fakeResult({
        filesScanned: 0,
        filesEligible: 0,
        skipBuckets: { sidecar: 0, blocklist: 0, eligible: 0, scanned: 0 },
        savings: {
          ratio: 0.45,
          projectedBytes: 0,
          totalBytes: 0,
          source: 'naive',
          runId: null,
          encoder: 'libx265',
        },
      }),
    );
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filesScanned).toBe(0);
    expect(body.savings.totalBytes).toBe(0);
  });

  it('case 14: 500 internal_error on runEstimate-throw + lock released', async () => {
    mockRunEstimate.mockRejectedValue(new Error('walker exploded'));
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('case 15 (AC-15-bis SR1): logs estimate_started BEFORE engine + estimate_complete with required fields', async () => {
    await POST(jsonReq({}));
    const startCall = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' && (c[0] as { action?: string }).action === 'estimate_started',
    );
    expect(startCall).toBeDefined();
    expect((startCall![0] as { rootPath?: string }).rootPath).toBe('/media');
    expect((startCall![0] as { encoder?: string }).encoder).toBe('libx265');

    const completeCall = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' && (c[0] as { action?: string }).action === 'estimate_complete',
    );
    expect(completeCall).toBeDefined();
    const cArg = completeCall![0] as Record<string, unknown>;
    for (const k of [
      'rootPath',
      'filesScanned',
      'filesEligible',
      'skipBuckets',
      'savings',
      'encodeTime',
      'durationMs',
      'truncated',
    ]) {
      expect(cArg[k], `missing log field ${k}`).toBeDefined();
    }
  });

  it('case 16 (AC-16 SR4): request.signal threaded into engine + lock released in finally', async () => {
    // Route MUST forward request.signal into runEstimate so engine can break
    // its walker-loop on client-disconnect (engine-side test in
    // tests/lib/estimate-engine.test.ts case 14 covers actual abort behavior).
    mockRunEstimate.mockResolvedValue(fakeResult({ aborted: true }));
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalled();
    const opts = mockRunEstimate.mock.calls[0]![0] as { signal?: AbortSignal };
    expect(opts.signal).toBeDefined();
    expect(opts.signal!.aborted).toBe(false);
  });

  it('case 17 (M5): settings.encoder=auto → detectEncoders called + resolved EncoderId logged', async () => {
    mockSettingsGetAll.mockReturnValue({
      scan_root: '/media',
      extensions: 'mp4',
      min_size_mb: '50',
      max_depth: '12',
      encoder: 'auto',
    });
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
    } as unknown as DetectionResult);
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(mockDetectEncoders).toHaveBeenCalled();
    const startCall = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' && (c[0] as { action?: string }).action === 'estimate_started',
    );
    expect((startCall![0] as { encoder?: string }).encoder).toBe('nvenc');
    // Engine receives the resolved EncoderId, not the literal 'auto' string.
    const opts = mockRunEstimate.mock.calls[0]![0] as { encoder?: string };
    expect(opts.encoder).toBe('nvenc');
  });
});
