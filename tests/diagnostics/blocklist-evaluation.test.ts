// @vitest-environment node
// 22-00 T2 IMP-8: blocklist-evaluation surface tests.
// AC-3 contract: payload.blocklist = {totalEntries, recentEvaluations[≤50], patternCachedAt}.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockTail, mockBlocklistRepo, mockGetTs } = vi.hoisted(() => ({
  mockTail: vi.fn<(n: number) => { lines: string[]; totalLines: number; totalBytes: number }>(),
  mockBlocklistRepo: { count: vi.fn() },
  mockGetTs: vi.fn<() => string | null>(),
}));

vi.mock('@/src/lib/log/ring-buffer', () => ({
  tail: mockTail,
  pushLine: vi.fn(),
  _resetForTesting: vi.fn(),
  RING_BUFFER_LIMITS: { MAX_LINES: 1000, MAX_BYTES: 5 * 1024 * 1024 },
}));

vi.mock('@/src/lib/db', () => ({
  blocklistRepo: () => mockBlocklistRepo,
}));

vi.mock('@/src/lib/skip/pipeline', () => ({
  getPatternsCacheTimestamp: mockGetTs,
}));

import { assembleBlocklistEvaluation } from '@/src/lib/diagnostics/blocklist-evaluation';

function bufferOf(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return { lines, totalLines: lines.length, totalBytes: lines.reduce((n, l) => n + l.length, 0) };
}

describe('22-00 T2: assembleBlocklistEvaluation', () => {
  beforeEach(() => {
    mockTail.mockReset();
    mockBlocklistRepo.count.mockReset();
    mockGetTs.mockReset();
  });

  it('empty: empty log-ring + zero blocklist entries → totalEntries=0, recentEvaluations=[], patternCachedAt=null', () => {
    mockTail.mockReturnValue(bufferOf([]));
    mockBlocklistRepo.count.mockReturnValue(0);
    mockGetTs.mockReturnValue(null);

    const result = assembleBlocklistEvaluation();

    expect(result).toEqual({
      totalEntries: 0,
      recentEvaluations: [],
      patternCachedAt: null,
    });
  });

  it('happy: 3 mocked log entries + 5 blocklist entries → recentEvaluations.length=3 newest-first, totalEntries=5', () => {
    mockTail.mockReturnValue(
      bufferOf([
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 1000,
          path: '/m/a.mkv',
          matchedEntry: null,
        }),
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 2000,
          path: '/m/b.mkv',
          matchedEntry: { id: 1, kind: 'path_pattern', pattern: '*.srt' },
        }),
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 3000,
          path: '/m/c.mkv',
          matchedEntry: { id: 7, kind: 'file_id' },
        }),
      ]),
    );
    mockBlocklistRepo.count.mockReturnValue(5);
    mockGetTs.mockReturnValue('2026-05-23T10:00:00.000Z');

    const result = assembleBlocklistEvaluation();

    expect(result.totalEntries).toBe(5);
    expect(result.patternCachedAt).toBe('2026-05-23T10:00:00.000Z');
    expect(result.recentEvaluations).toHaveLength(3);
    // Newest-first (reverse of ring-buffer FIFO order)
    expect(result.recentEvaluations[0].path).toBe('/m/c.mkv');
    expect(result.recentEvaluations[0].matchedEntry).toEqual({ id: 7, kind: 'file_id' });
    expect(result.recentEvaluations[1].path).toBe('/m/b.mkv');
    expect(result.recentEvaluations[1].matchedEntry).toEqual({
      id: 1,
      kind: 'path_pattern',
      pattern: '*.srt',
    });
    expect(result.recentEvaluations[2].path).toBe('/m/a.mkv');
    expect(result.recentEvaluations[2].matchedEntry).toBeNull();
    // matchedAt ISO-format derived from pino `time`
    expect(result.recentEvaluations[0].matchedAt).toBe(new Date(3000).toISOString());
  });

  it('log-ring overflow: 75 mocked log entries → recentEvaluations.length=50 (capped, newest 50)', () => {
    const lines = Array.from({ length: 75 }, (_, i) =>
      JSON.stringify({
        msg: 'blocklist_evaluation',
        time: i * 1000,
        path: `/m/${i}.mkv`,
        matchedEntry: null,
      }),
    );
    mockTail.mockReturnValue(bufferOf(lines));
    mockBlocklistRepo.count.mockReturnValue(0);
    mockGetTs.mockReturnValue(null);

    const result = assembleBlocklistEvaluation();

    expect(result.recentEvaluations).toHaveLength(50);
    // Newest-first: entry index 74 → 25
    expect(result.recentEvaluations[0].path).toBe('/m/74.mkv');
    expect(result.recentEvaluations[49].path).toBe('/m/25.mkv');
  });

  it('mixed match types: file_id + path_pattern + null-match all decode correctly', () => {
    mockTail.mockReturnValue(
      bufferOf([
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 1000,
          path: '/m/file-id-match.mkv',
          matchedEntry: { id: 42, kind: 'file_id' },
        }),
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 2000,
          path: '/m/pattern-match.mkv',
          matchedEntry: { id: 7, kind: 'path_pattern', pattern: '*/Trailers/*' },
        }),
        JSON.stringify({
          msg: 'blocklist_evaluation',
          time: 3000,
          path: '/m/no-match.mkv',
          matchedEntry: null,
        }),
        // Non-blocklist line — must be skipped
        JSON.stringify({ msg: 'other_event', time: 4000, foo: 'bar' }),
        // Malformed line — must be silently dropped
        'NOT JSON',
      ]),
    );
    mockBlocklistRepo.count.mockReturnValue(3);
    mockGetTs.mockReturnValue('2026-05-23T11:00:00.000Z');

    const result = assembleBlocklistEvaluation();

    expect(result.recentEvaluations).toHaveLength(3);
    const fileIdMatch = result.recentEvaluations.find((e) => e.path === '/m/file-id-match.mkv');
    const patternMatch = result.recentEvaluations.find((e) => e.path === '/m/pattern-match.mkv');
    const noMatch = result.recentEvaluations.find((e) => e.path === '/m/no-match.mkv');

    expect(fileIdMatch?.matchedEntry).toEqual({ id: 42, kind: 'file_id' });
    expect(patternMatch?.matchedEntry).toEqual({
      id: 7,
      kind: 'path_pattern',
      pattern: '*/Trailers/*',
    });
    expect(noMatch?.matchedEntry).toBeNull();
  });

  it('survives tail()-throw: returns empty recentEvaluations but retains totalEntries + patternCachedAt', () => {
    mockTail.mockImplementation(() => {
      throw new Error('ring-buffer corrupt');
    });
    mockBlocklistRepo.count.mockReturnValue(2);
    mockGetTs.mockReturnValue('2026-05-23T12:00:00.000Z');

    const result = assembleBlocklistEvaluation();

    expect(result.totalEntries).toBe(2);
    expect(result.recentEvaluations).toEqual([]);
    expect(result.patternCachedAt).toBe('2026-05-23T12:00:00.000Z');
  });
});
