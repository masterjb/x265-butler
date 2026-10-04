// 11-03 AC-5: POST /api/bench/[runId]/apply

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

interface InMemSettings {
  store: Map<string, string>;
}

const {
  mockRunFindById,
  mockComboFindById,
  mockSettings,
  mockGetDb,
  mockEnsureServerInit,
  mockRequireAuth,
  mockAuthGuard,
  mockLoggerInfo,
} = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    mockRunFindById: vi.fn<(id: number) => BenchRunRow | undefined>(),
    mockComboFindById: vi.fn<(id: number) => BenchComboRow | undefined>(),
    mockSettings: { store } as InMemSettings,
    mockGetDb: vi.fn(),
    mockEnsureServerInit: vi.fn(),
    mockRequireAuth: vi
      .fn()
      .mockResolvedValue({ ok: true, mode: 'disabled', username: null } as never),
    mockAuthGuard: vi.fn().mockReturnValue(null),
    mockLoggerInfo: vi.fn(),
  };
});

vi.mock('@/src/lib/db', () => ({
  benchRunRepo: () => ({ findById: mockRunFindById }),
  benchComboRepo: () => ({ findById: mockComboFindById }),
  settingRepo: () => ({
    get: (key: string) => mockSettings.store.get(key),
    set: (key: string, value: string) => {
      mockSettings.store.set(key, value);
    },
    delete: (key: string) => {
      mockSettings.store.delete(key);
    },
    getAll: () => Object.fromEntries(mockSettings.store),
  }),
  getDb: mockGetDb,
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    }),
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
  default: {},
}));

import { POST } from '@/app/api/bench/[runId]/apply/route';

function makeRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 1,
    status: 'complete',
    mode: 'native-sweep',
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    fileIds: [10],
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    version: 1,
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    error_reason: null,
    ...overrides,
  };
}

function makeComboRow(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 42,
    run_id: 1,
    file_id: 10,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 23,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 90,
    size_bytes: 1,
    encode_seconds: 1,
    source_sample_bytes: 1,
    pass2_vmaf: 92.5,
    pass2_size_bytes: 4_000_000_000,
    pass2_encode_seconds: 600,
    pass2_completed_at: 1700000000,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'balanced',
    created_at: 1,
    completed_at: 2,
    ...overrides,
  };
}

function postReq(body: unknown, runId = 1): Request {
  return new Request(`http://localhost/api/bench/${runId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callPOST(req: Request, runId = '1'): Promise<Response> {
  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.store.clear();
  mockRunFindById.mockReturnValue(makeRunRow());
  mockComboFindById.mockReturnValue(makeComboRow());
  mockRequireAuth.mockResolvedValue({ ok: true, mode: 'disabled', username: null } as never);
  mockAuthGuard.mockReturnValue(null);
  mockGetDb.mockReturnValue({
    transaction: (fn: () => void) => () => fn(),
  });
});

describe('POST /api/bench/[runId]/apply — happy path', () => {
  it('writes default_encoder + crf_<enc> + preset_<enc>, returns idempotent:false', async () => {
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultEncoder: string;
      crf: string;
      preset: string | null;
      idempotent: boolean;
    };
    expect(body.defaultEncoder).toBe('libx265');
    expect(body.crf).toBe('23');
    expect(body.preset).toBe('medium');
    expect(body.idempotent).toBe(false);

    expect(mockSettings.store.get('default_encoder')).toBe('libx265');
    expect(mockSettings.store.get('crf_libx265')).toBe('23');
    expect(mockSettings.store.get('preset_libx265')).toBe('medium');
  });

  it('M4 audit: pino emits audit row on write', async () => {
    await callPOST(postReq({ comboId: 42 }));
    const auditCall = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' && (c[0] as { audit?: string }).audit === 'bench.apply_defaults',
    );
    expect(auditCall).toBeDefined();
  });
});

describe('POST /api/bench/[runId]/apply — guards', () => {
  it('M2 audit: 401 when authGuard denies', async () => {
    mockAuthGuard.mockReturnValueOnce(
      new Response(JSON.stringify({ error_code: 'auth_required' }), { status: 401 }),
    );
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(401);
    expect(mockSettings.store.size).toBe(0);
  });

  it('not verified (pass2_completed_at IS NULL) → 409 not_verified', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ pass2_completed_at: null }));
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_verified');
  });

  it('combo not found → 404', async () => {
    mockComboFindById.mockReturnValueOnce(undefined);
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });

  it('combo belongs to another run → 404', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ run_id: 999 }));
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });

  it('run not found → 404', async () => {
    mockRunFindById.mockReturnValueOnce(undefined);
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });
});

describe('SR8 idempotency', () => {
  it('settings already match → 200 idempotent:true + ZERO audit row', async () => {
    mockSettings.store.set('default_encoder', 'libx265');
    mockSettings.store.set('crf_libx265', '23');
    mockSettings.store.set('preset_libx265', 'medium');

    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { idempotent: boolean };
    expect(body.idempotent).toBe(true);

    // No bench.apply_defaults audit row emitted
    const auditCall = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' && (c[0] as { audit?: string }).audit === 'bench.apply_defaults',
    );
    expect(auditCall).toBeUndefined();
  });

  it('partial match → idempotent:false + write happens', async () => {
    mockSettings.store.set('default_encoder', 'libx265');
    mockSettings.store.set('crf_libx265', '99'); // mismatched
    const res = await callPOST(postReq({ comboId: 42 }));
    const body = (await res.json()) as { idempotent: boolean };
    expect(body.idempotent).toBe(false);
    expect(mockSettings.store.get('crf_libx265')).toBe('23');
  });
});

describe('SR1 preset-null path', () => {
  it('combo.preset === null → settings.delete(preset_<enc>) executes', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ preset: null }));
    mockSettings.store.set('preset_libx265', 'medium'); // stale
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preset: string | null; idempotent: boolean };
    expect(body.preset).toBeNull();
    expect(mockSettings.store.has('preset_libx265')).toBe(false);
  });

  it('SR1 + SR8: combo.preset === null + no existing preset row + matching encoder+crf → idempotent', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ preset: null }));
    mockSettings.store.set('default_encoder', 'libx265');
    mockSettings.store.set('crf_libx265', '23');
    // preset_libx265 NOT set
    const res = await callPOST(postReq({ comboId: 42 }));
    const body = (await res.json()) as { idempotent: boolean };
    expect(body.idempotent).toBe(true);
  });
});

describe('atomicity', () => {
  it('all 3 settings written inside single transaction', async () => {
    const txSpy = vi.fn();
    mockGetDb.mockReturnValueOnce({
      transaction: (fn: () => void) => {
        return () => {
          txSpy();
          fn();
        };
      },
    });
    await callPOST(postReq({ comboId: 42 }));
    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 13-01b T5 (audit M2 + M3 + M6 + M7) ─────────────────────────────────────

describe('13-01b T5 — apply-mode priorValues snapshot (audit M2)', () => {
  it('200 response includes priorValues additively + preserves 5 existing fields', async () => {
    mockSettings.store.set('default_encoder', 'nvenc');
    mockSettings.store.set('crf_libx265', '20');
    mockSettings.store.set('preset_libx265', 'fast');
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultEncoder: string;
      crf: string;
      preset: string | null;
      idempotent: boolean;
      requestId: string;
      priorValues: Record<string, string>;
    };
    // Existing 5 fields preserved
    expect(body.defaultEncoder).toBe('libx265');
    expect(body.crf).toBe('23');
    expect(body.preset).toBe('medium');
    expect(body.idempotent).toBe(false);
    expect(typeof body.requestId).toBe('string');
    // Additive priorValues field
    expect(body.priorValues.default_encoder).toBe('nvenc');
    expect(body.priorValues.crf_libx265).toBe('20');
    expect(body.priorValues.preset_libx265).toBe('fast');
  });

  it('priorValues omits keys NOT present in DB pre-write (audit M7)', async () => {
    // Only default_encoder pre-set; no crf_* / preset_* rows.
    mockSettings.store.set('default_encoder', 'qsv');
    const res = await callPOST(postReq({ comboId: 42 }));
    const body = (await res.json()) as { priorValues: Record<string, string> };
    expect(body.priorValues.default_encoder).toBe('qsv');
    expect('crf_libx265' in body.priorValues).toBe(false);
    expect('preset_libx265' in body.priorValues).toBe(false);
  });

  it('idempotent fast-path still includes priorValues == current settings', async () => {
    mockSettings.store.set('default_encoder', 'libx265');
    mockSettings.store.set('crf_libx265', '23');
    mockSettings.store.set('preset_libx265', 'medium');
    const res = await callPOST(postReq({ comboId: 42 }));
    const body = (await res.json()) as {
      idempotent: boolean;
      priorValues: Record<string, string>;
    };
    expect(body.idempotent).toBe(true);
    expect(body.priorValues.default_encoder).toBe('libx265');
    expect(body.priorValues.crf_libx265).toBe('23');
  });
});

describe('13-01b T5 — restore-mode (audit M3 + M6)', () => {
  it('priorValues body writes settings + 200 { restored: true }', async () => {
    mockSettings.store.set('default_encoder', 'libx265');
    mockSettings.store.set('crf_libx265', '23');
    mockSettings.store.set('preset_libx265', 'medium');
    const res = await callPOST(
      postReq({
        priorValues: {
          default_encoder: 'nvenc',
          crf_libx265: '20',
          preset_libx265: 'fast',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restored: boolean;
      restoredKeys: number;
      requestId: string;
    };
    expect(body.restored).toBe(true);
    expect(body.restoredKeys).toBe(9);
    expect(typeof body.requestId).toBe('string');
    expect(mockSettings.store.get('default_encoder')).toBe('nvenc');
    expect(mockSettings.store.get('crf_libx265')).toBe('20');
    expect(mockSettings.store.get('preset_libx265')).toBe('fast');
  });

  it('absent-in-priorValues → delete the setting row (audit M7)', async () => {
    mockSettings.store.set('preset_libx265', 'fast');
    mockSettings.store.set('crf_libx265', '20');
    // priorValues mentions crf_libx265 but NOT preset_libx265 — restore must
    // delete preset_libx265 so the "no row existed pre-apply" state is restored.
    const res = await callPOST(
      postReq({
        priorValues: { crf_libx265: '20' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockSettings.store.get('crf_libx265')).toBe('20');
    expect(mockSettings.store.has('preset_libx265')).toBe(false);
  });

  it('emits bench.apply_defaults.undo audit-log (SR5)', async () => {
    await callPOST(
      postReq({
        priorValues: { default_encoder: 'libx265' },
      }),
    );
    const undoLog = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        (c[0] as { audit?: string }).audit === 'bench.apply_defaults.undo',
    );
    expect(undoLog).toBeDefined();
  });

  it('401 when authGuard denies in restore-mode', async () => {
    mockAuthGuard.mockReturnValueOnce(
      new Response(JSON.stringify({ error_code: 'auth_required' }), { status: 401 }),
    );
    const res = await callPOST(
      postReq({
        priorValues: { default_encoder: 'libx265' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('13-01b T5 — body-validation discriminated union', () => {
  it('400 when BOTH comboId and priorValues present', async () => {
    const res = await callPOST(
      postReq({ comboId: 42, priorValues: { default_encoder: 'libx265' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('400 when NEITHER comboId nor priorValues present', async () => {
    const res = await callPOST(postReq({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });
});
