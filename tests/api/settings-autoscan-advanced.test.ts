// Phase 16-02 T1 — settings PUT zod-schema + M5-hook generalization
// + audit-log M1 + AC-12 empty/partial-PUT semantics.
//
// Coverage: AC-3, AC-4, AC-5 (backend half), AC-6 (zod-range), AC-7 (hook +
// audit-log scope-discipline), AC-12 (empty-PUT no-op, partial-fail no-write).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockGetAll,
  mockGet,
  mockSet,
  mockTransaction,
  mockShareListAll,
  loggerInfoSpy,
  restartWatcherSpy,
} = vi.hoisted(() => {
  const mockSet = vi.fn<(key: string, value: string) => void>();
  return {
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockGet: vi.fn<(key: string) => string | undefined>(),
    mockSet,
    mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      return (...args: T) => fn(...args);
    }),
    mockShareListAll: vi.fn<() => Array<unknown>>(),
    loggerInfoSpy: vi.fn(),
    restartWatcherSpy: vi.fn(async () => {}),
  };
});

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: mockGetAll, get: mockGet, set: mockSet }),
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

vi.mock('@/src/lib/watch', () => ({
  restartWatcherService: restartWatcherSpy,
}));

import { PUT } from '@/app/api/settings/route';

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGetAll.mockReset();
  mockGet.mockReset();
  mockSet.mockReset();
  mockTransaction.mockReset();
  mockShareListAll.mockReset();
  loggerInfoSpy.mockReset();
  restartWatcherSpy.mockClear();
  mockGetAll.mockReturnValue({});
  mockGet.mockReturnValue(undefined);
  mockShareListAll.mockReturnValue([]);
  mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  });
});

function auditLogCalls(): unknown[][] {
  return loggerInfoSpy.mock.calls.filter((c) => {
    const payload = c[0] as { action?: string } | undefined;
    return payload?.action === 'auto_scan_setting_changed';
  });
}

describe('PUT /api/settings — 16-02 autoScan advanced keys', () => {
  it('autoScan.bootScanOnStart=false → 200 + setting persisted + restart fired', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.bootScanOnStart': 'false' } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('autoScan.bootScanOnStart', 'false');
    expect(restartWatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('autoScan.stabilityThreshold=15000 → 200 + restart spy called', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.stabilityThreshold': '15000' } }));
    expect(res.status).toBe(200);
    expect(restartWatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('autoScan.stabilityThreshold=500 (below floor 1000) → 400 + restart NOT called', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.stabilityThreshold': '500' } }));
    expect(res.status).toBe(400);
    expect(restartWatcherSpy).not.toHaveBeenCalled();
  });

  it('autoScan.stabilityThreshold=60001 (above ceiling) → 400', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.stabilityThreshold': '60001' } }));
    expect(res.status).toBe(400);
  });

  it('autoScan.batchWindow=5000 (in range) → 200', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.batchWindow': '5000' } }));
    expect(res.status).toBe(200);
  });

  it('autoScan.batchWindow=499 → 400', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.batchWindow': '499' } }));
    expect(res.status).toBe(400);
  });

  it('autoScan.batchWindow=30001 → 400', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.batchWindow': '30001' } }));
    expect(res.status).toBe(400);
  });

  it('autoScan.reconcileIntervalH=6 → 200', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.reconcileIntervalH': '6' } }));
    expect(res.status).toBe(200);
  });

  it('autoScan.reconcileIntervalH=0.04 (below floor 0.05) → 400', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.reconcileIntervalH': '0.04' } }));
    expect(res.status).toBe(400);
  });

  it('autoScan.reconcileIntervalH=72.5 (above ceiling 72) → 400', async () => {
    const res = await PUT(jsonReq({ settings: { 'autoScan.reconcileIntervalH': '72.5' } }));
    expect(res.status).toBe(400);
  });

  it('autoScan.reconcileIntervalH=6 + auth_enabled=true → 200 + restart fired EXACTLY ONCE', async () => {
    const res = await PUT(
      jsonReq({ settings: { 'autoScan.reconcileIntervalH': '6', auth_enabled: 'true' } }),
    );
    expect(res.status).toBe(200);
    expect(restartWatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('auth_enabled=true (no autoScan keys) → 200 + restart NOT called', async () => {
    const res = await PUT(jsonReq({ settings: { auth_enabled: 'true' } }));
    expect(res.status).toBe(200);
    expect(restartWatcherSpy).not.toHaveBeenCalled();
  });

  // AC-12: empty-body no-op
  it('PUT body {settings:{}} → 200 + restart NOT called + 0 DB writes + no audit-log', async () => {
    const res = await PUT(jsonReq({ settings: {} }));
    expect(res.status).toBe(200);
    expect(restartWatcherSpy).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(auditLogCalls()).toHaveLength(0);
  });

  // AC-12: partial-validation-fail all-or-nothing
  it('3 autoScan keys where 1 fails zod → 400 + 0 DB writes + no audit-log + no restart', async () => {
    const res = await PUT(
      jsonReq({
        settings: {
          'autoScan.stabilityThreshold': '15000',
          'autoScan.batchWindow': '499', // fails
          'autoScan.reconcileIntervalH': '6',
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
    expect(restartWatcherSpy).not.toHaveBeenCalled();
    expect(auditLogCalls()).toHaveLength(0);
  });

  // AC-7 audit-log shape: changes array with key/oldValue/newValue
  it('stabilityThreshold=15000 from prior 10000 → audit-log with changes=[{key,oldValue,newValue}]', async () => {
    mockGet.mockImplementation((k: string) =>
      k === 'autoScan.stabilityThreshold' ? '10000' : undefined,
    );
    const res = await PUT(jsonReq({ settings: { 'autoScan.stabilityThreshold': '15000' } }));
    expect(res.status).toBe(200);
    const audit = auditLogCalls();
    expect(audit).toHaveLength(1);
    expect((audit[0][0] as { changes: unknown }).changes).toEqual([
      { key: 'autoScan.stabilityThreshold', oldValue: '10000', newValue: '15000' },
    ]);
  });

  // AC-7 scope-discipline: non-autoScan keys NOT in audit-log payload
  it('autoScan.bootScanOnStart=false + auth_enabled=true → audit-log contains ONLY bootScanOnStart', async () => {
    const res = await PUT(
      jsonReq({
        settings: { 'autoScan.bootScanOnStart': 'false', auth_enabled: 'true' },
      }),
    );
    expect(res.status).toBe(200);
    const audit = auditLogCalls();
    expect(audit).toHaveLength(1);
    const changes = (audit[0][0] as { changes: Array<{ key: string }> }).changes;
    expect(changes.map((c) => c.key)).toEqual(['autoScan.bootScanOnStart']);
  });
});
