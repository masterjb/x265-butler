/*
 * Plan 20-01 Task 2-bis (AC-11) — server-side skip-completion audit log.
 *
 * Covers:
 *  - payload matches placeholderShare verbatim → wizard_completed_via_auto_skip_path
 *  - payload deviates from placeholderShare → wizard_completed_with_override
 *  - response shape unchanged from pre-audit baseline (regression guard)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShareRow } from '@/src/lib/db/schema';

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

import { POST } from '@/app/api/onboarding/complete/route';

const ROUTE_URL = 'http://test/api/onboarding/complete';

function jsonRequest(payload: unknown): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'en' },
    body: JSON.stringify(payload),
  });
}

function samplePlaceholder(overrides: Partial<ShareRow> = {}): ShareRow {
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

describe('POST /api/onboarding/complete — 20-01 skip-completion audit log (AC-11)', () => {
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
    delete process.env.NEXT_PHASE;
  });

  it('test_when_payload_matches_placeholder_then_wizard_completed_via_auto_skip_path_emitted', async () => {
    const placeholder = samplePlaceholder({ id: 1, path: '/media', min_size_mb: 50 });
    mockShareListAll.mockReturnValue([placeholder]);
    // AC-16b PATCH path satisfies: created_at===updated_at + path matches.
    mockShareUpdate.mockReturnValue(placeholder);
    const res = await POST(jsonRequest({ scan_root: '/media', min_size_mb: 50 }));
    expect(res.status).toBe(200);
    const auditLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_completed_via_auto_skip_path') as
      | { action: string; share_path: string; share_id: number; locale: string }
      | undefined;
    expect(auditLog).toBeDefined();
    expect(auditLog!.share_path).toBe('/media');
    expect(auditLog!.share_id).toBe(1);
    expect(auditLog!.locale).toBe('en');
    // Override branch did NOT fire.
    const overrideLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_completed_with_override');
    expect(overrideLog).toBeUndefined();
  });

  it('test_when_payload_deviates_from_placeholder_then_wizard_completed_with_override_emitted', async () => {
    const placeholder = samplePlaceholder({ id: 1, path: '/media', min_size_mb: 50 });
    mockShareListAll.mockReturnValue([placeholder]);
    mockShareUpdate.mockReturnValue({ ...placeholder, path: '/data/movies', min_size_mb: 100 });
    const res = await POST(jsonRequest({ scan_root: '/data/movies', min_size_mb: 100 }));
    expect(res.status).toBe(200);
    const overrideLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_completed_with_override') as
      | { action: string; payload_scan_root: string; placeholder_path: string }
      | undefined;
    expect(overrideLog).toBeDefined();
    expect(overrideLog!.payload_scan_root).toBe('/data/movies');
    expect(overrideLog!.placeholder_path).toBe('/media');
    // Auto-skip-path branch did NOT fire.
    const autoSkipLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_completed_via_auto_skip_path');
    expect(autoSkipLog).toBeUndefined();
  });

  it('test_when_no_placeholder_then_wizard_completed_with_override_emitted_placeholder_null', async () => {
    mockShareListAll.mockReturnValue([]);
    mockShareCreate.mockReturnValue(
      samplePlaceholder({ id: 5, path: '/library', min_size_mb: 25 }),
    );
    const res = await POST(jsonRequest({ scan_root: '/library', min_size_mb: 25 }));
    expect(res.status).toBe(200);
    const overrideLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_completed_with_override') as
      | { placeholder_path: string | null }
      | undefined;
    expect(overrideLog).toBeDefined();
    expect(overrideLog!.placeholder_path).toBeNull();
    // Response shape unchanged (regression guard).
    const body = await res.json();
    expect(body.completed).toBe(true);
    expect(body.shareAction).toBe('created');
    expect(body.shareId).toBe(5);
  });
});
