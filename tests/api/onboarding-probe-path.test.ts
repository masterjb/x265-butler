import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OutputPathProbe } from '@/src/lib/onboarding/probe-output-path';

// 23-03 Task 2 — POST /api/onboarding/probe-path. probeOutputPath + logger are
// mocked (no real fs); mirrors the onboarding-complete route-test harness.

const {
  mockProbeOutputPath,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockProbeOutputPath: vi.fn<(path: string) => Promise<OutputPathProbe>>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/onboarding/probe-output-path', () => ({
  probeOutputPath: mockProbeOutputPath,
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

import { POST, runtime } from '@/app/api/onboarding/probe-path/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE_URL = 'http://test/api/onboarding/probe-path';

function jsonRequest(payload: unknown): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function rawRequest(body: string | undefined): Request {
  return new Request(ROUTE_URL, { method: 'POST', body });
}

function warnAction(action: string): unknown {
  return mockLoggerWarn.mock.calls
    .map((c) => c[0])
    .find((c) => (c as { action?: string }).action === action);
}

describe('POST /api/onboarding/probe-path', () => {
  beforeEach(() => {
    mockProbeOutputPath.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    delete process.env.NEXT_PHASE;
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_writable_path_then_200_writable_true', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: true,
    });
    const res = await POST(jsonRequest({ path: '/media' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.writable).toBe(true);
    expect(body.path).toBe('/media');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockProbeOutputPath).toHaveBeenCalledWith('/media');
  });

  it('test_POST_when_non_writable_path_then_200_writable_false_and_warn_emitted', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: false,
      error: 'EACCES',
    });
    const res = await POST(jsonRequest({ path: '/media' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.writable).toBe(false);
    expect(body.error).toBe('EACCES');
    expect(warnAction('onboarding_output_path_not_writable')).toBeDefined();
  });

  it('test_POST_when_acknowledged_true_then_override_acknowledged_warn_emitted', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: false,
      error: 'EACCES',
    });
    const res = await POST(jsonRequest({ path: '/media', acknowledged: true }));
    expect(res.status).toBe(200);
    expect(warnAction('onboarding_output_path_override_acknowledged')).toBeDefined();
    // ack path still runs the (idempotent) probe.
    expect(mockProbeOutputPath).toHaveBeenCalledWith('/media');
  });

  it('test_POST_response_body_has_exactly_six_keys_no_fs_inspection_leak', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: false,
      error: 'EACCES',
    });
    const res = await POST(jsonRequest({ path: '/media' }));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['error', 'exists', 'path', 'readable', 'requestId', 'writable'].sort(),
    );
    for (const forbidden of ['mode', 'uid', 'gid', 'stat', 'contents', 'entries']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('test_POST_when_writable_true_then_error_key_omitted_five_keys', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: true,
    });
    const res = await POST(jsonRequest({ path: '/media' }));
    const body = await res.json();
    expect(body).not.toHaveProperty('error');
    expect(Object.keys(body).sort()).toEqual(
      ['exists', 'path', 'readable', 'requestId', 'writable'].sort(),
    );
  });

  it('test_POST_when_path_missing_then_400_probe_not_called', async () => {
    const res = await POST(jsonRequest({ acknowledged: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_path_non_absolute_then_400_probe_not_called', async () => {
    const res = await POST(jsonRequest({ path: 'media/relative' }));
    expect(res.status).toBe(400);
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_path_too_long_then_400_probe_not_called', async () => {
    const res = await POST(jsonRequest({ path: '/' + 'a'.repeat(5000) }));
    expect(res.status).toBe(400);
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_acknowledged_non_boolean_then_400_probe_not_called', async () => {
    const res = await POST(jsonRequest({ path: '/media', acknowledged: 'yes' }));
    expect(res.status).toBe(400);
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_unknown_key_then_400_strict', async () => {
    const res = await POST(jsonRequest({ path: '/media', foo: 'bar' }));
    expect(res.status).toBe(400);
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_malformed_json_then_400', async () => {
    const res = await POST(rawRequest('{not json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
  });

  it('test_POST_when_build_phase_then_skip_stub_probe_not_called', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await POST(jsonRequest({ path: '/media' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockProbeOutputPath).not.toHaveBeenCalled();
    expect(mockEnsureServerInit).not.toHaveBeenCalled();
  });

  it('test_POST_when_probe_throws_then_500_internal_error', async () => {
    mockProbeOutputPath.mockRejectedValue(new Error('boom'));
    const res = await POST(jsonRequest({ path: '/media' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('test_POST_when_called_then_cache_control_no_store', async () => {
    mockProbeOutputPath.mockResolvedValue({
      path: '/media',
      exists: true,
      readable: true,
      writable: true,
    });
    const res = await POST(jsonRequest({ path: '/media' }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
