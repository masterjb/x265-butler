// @vitest-environment node
// 22-01 T1 IMP-1 audit-SR4 — error-path slow_request_failed emit tests.
// Contract: when Promise.all / repo-read throws inside a Server Component's
// timed block, page MUST emit pino-warn `slow_request_failed` with partial
// timing + errorName, THEN rethrow so the error-boundary contract is preserved.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLogger, mockFileRepo, mockShareRepo, mockSettingRepo } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFileRepo: {
    listPaginated: vi.fn(),
    countByStatus: vi.fn(),
    countOrphaned: vi.fn(),
  },
  mockShareRepo: { listAll: vi.fn() },
  mockSettingRepo: { get: vi.fn() },
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => mockFileRepo,
  shareRepo: () => mockShareRepo,
  settingRepo: () => mockSettingRepo,
}));

vi.mock('@/src/lib/api/library-query', async () => {
  const { z } = await import('zod');
  const schema = z.object({ page: z.number().default(1), size: z.number().default(50) });
  return {
    libraryQuerySchema: schema,
    toListOptions: (q: { page: number; size: number }) => ({ page: q.page, size: q.size }),
  };
});

vi.mock('./library-client', () => ({ LibraryClient: () => null }));
vi.mock('@/app/[locale]/library/library-client', () => ({ LibraryClient: () => null }));

describe('22-01 T1 audit-SR4: slow_request_failed emit on error-path', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockFileRepo.listPaginated.mockReset();
    mockFileRepo.countByStatus.mockReset();
    mockFileRepo.countOrphaned.mockReset();
    mockShareRepo.listAll.mockReset();
    mockSettingRepo.get.mockReset();
  });

  it('library page: repo throws → emit slow_request_failed, rethrow preserved', async () => {
    mockFileRepo.listPaginated.mockImplementation(() => {
      throw new Error('db unavailable');
    });

    const { default: LibraryPage } = await import('@/app/[locale]/library/page');

    await expect(
      LibraryPage({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({}),
      } as Parameters<typeof LibraryPage>[0]),
    ).rejects.toThrow('db unavailable');

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = mockLogger.warn.mock.calls[0];
    expect(payload).toMatchObject({
      action: 'slow_request_failed',
      route: '/library',
      errorName: 'Error',
    });
    expect(typeof payload.durationMs).toBe('number');
    expect(msg).toBe('slow_request_failed');
  });

  it('library page: happy path under threshold → no slow_request_failed, no slow_request emit', async () => {
    mockFileRepo.listPaginated.mockReturnValue({ rows: [], total: 0 });
    mockFileRepo.countByStatus.mockReturnValue({});
    mockFileRepo.countOrphaned.mockReturnValue(0);
    mockShareRepo.listAll.mockReturnValue([]);
    mockSettingRepo.get.mockReturnValue('mkv');

    const { default: LibraryPage } = await import('@/app/[locale]/library/page');
    await LibraryPage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve({}),
    } as Parameters<typeof LibraryPage>[0]);

    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'slow_request_failed' }),
      expect.anything(),
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'slow_request' }),
      expect.anything(),
    );
  });
});
