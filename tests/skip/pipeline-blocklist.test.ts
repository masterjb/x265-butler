/*
 * 04-02: skip-pipeline step 7 (blocklist) — additive, backwards-compatible.
 * Tests the BLOCKLIST step ONLY; existing 6-step coverage lives in pipeline.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReadSidecar, mockLogger } = vi.hoisted(() => ({
  mockReadSidecar: vi.fn(),
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/encode/sidecar', () => ({
  readSidecar: mockReadSidecar,
  writeSidecar: vi.fn(),
  sweepSidecarTmpFiles: vi.fn(),
  sidecarPathFor: (p: string): string => `${p}.x265-butler.json`,
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import { runSkipPipeline, type PipelineDeps, type PipelineInput } from '@/src/lib/skip/pipeline';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';
import type { BlocklistRow, FileRow } from '@/src/lib/db/schema';

function makeProbe(): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 3600,
    width: 1920,
    height: 1080,
    container: 'matroska,webm',
    tags: {},
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
  };
}

function makeFileRepo(rows: Map<string, FileRow> = new Map()): PipelineDeps['fileRepo'] {
  return { findByContentHash: (h: string) => rows.get(h) } as unknown as PipelineDeps['fileRepo'];
}

function makeBlocklistRepo(opts: {
  matchResult?: boolean;
  pinnedRow?: BlocklistRow;
}): BlocklistRepo {
  return {
    add: vi.fn(),
    remove: vi.fn(),
    findById: vi.fn(),
    findByFileId: vi.fn().mockReturnValue(opts.pinnedRow),
    findByPattern: vi.fn(),
    list: vi.fn(),
    listAllPatterns: vi.fn().mockReturnValue([]),
    matchByFileIdOrPath: vi.fn().mockReturnValue(opts.matchResult ?? false),
    count: vi.fn().mockReturnValue(0),
  } as unknown as BlocklistRepo;
}

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    filePath: '/movies/Foo.mkv',
    probe: makeProbe(),
    diskContentHash: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => {
  mockReadSidecar.mockReset();
  mockReadSidecar.mockResolvedValue(null);
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runSkipPipeline — Step 7 BLOCKLIST (04-02)', () => {
  it('test_runSkipPipeline_when_blocklistRepo_undefined_AND_patternsCache_undefined_then_step_7_no_op_byte_identical_to_04_01', async () => {
    const result = await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo() });
    expect(result).toEqual({ skip: false });
  });

  it('test_runSkipPipeline_when_blocklistRepo_provided_AND_match_then_returns_skipped_blocklist', async () => {
    const blocklistRepo = makeBlocklistRepo({ matchResult: true });
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo,
    });
    expect(result).toEqual({
      skip: true,
      reason: 'skipped-blocklist',
      source: 'blocklist',
    });
  });

  it('test_runSkipPipeline_when_blocklistRepo_provided_AND_no_match_then_returns_skip_false', async () => {
    const blocklistRepo = makeBlocklistRepo({ matchResult: false });
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo,
    });
    expect(result.skip).toBe(false);
  });

  it('test_runSkipPipeline_when_patternsCache_match_then_returns_skipped_blocklist_NO_DB_call', async () => {
    const patternsCache: BlocklistRow[] = [
      {
        id: 1,
        file_id: null,
        path_pattern: '/movies/*',
        reason: 'operator',
        created_at: 0,
      },
    ];
    const blocklistRepo = makeBlocklistRepo({ matchResult: false }); // would return false if called
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Foo.mkv' }), {
      fileRepo: makeFileRepo(),
      blocklistRepo,
      patternsCache,
    });
    expect(result.skip).toBe(true);
    if (result.skip) expect(result.source).toBe('blocklist');
    // matchByFileIdOrPath NOT called when cache hits
    expect(blocklistRepo.matchByFileIdOrPath).not.toHaveBeenCalled();
  });

  it('test_runSkipPipeline_when_patternsCache_no_match_AND_fileId_pinned_then_findByFileId_called', async () => {
    const patternsCache: BlocklistRow[] = []; // empty cache
    const pinned: BlocklistRow = {
      id: 7,
      file_id: 5,
      path_pattern: null,
      reason: 'operator',
      created_at: 0,
    };
    const blocklistRepo = makeBlocklistRepo({ pinnedRow: pinned });
    const fileRepo = makeFileRepo(new Map([['hash1', { id: 5 } as FileRow]]));
    const result = await runSkipPipeline(makeInput({ diskContentHash: 'hash1' }), {
      fileRepo,
      blocklistRepo,
      patternsCache,
    });
    expect(result.skip).toBe(true);
    if (result.skip) expect(result.source).toBe('blocklist');
    expect(blocklistRepo.findByFileId).toHaveBeenCalledWith(5);
  });

  // 10-01: suffix step removed — blocklist now checked for all paths.
  it('test_runSkipPipeline_when_x265_mkv_path_and_blocklist_match_then_skipped_blocklist', async () => {
    const blocklistRepo = makeBlocklistRepo({ matchResult: true });
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Foo.x265.mkv' }), {
      fileRepo: makeFileRepo(),
      blocklistRepo,
    });
    expect(result).toEqual({
      skip: true,
      reason: 'skipped-blocklist',
      source: 'blocklist',
    });
  });

  it('test_runSkipPipeline_when_blocklist_match_then_pino_info_skip_pipeline_decision_with_source_blocklist', async () => {
    const blocklistRepo = makeBlocklistRepo({ matchResult: true });
    await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo(), blocklistRepo });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skip_pipeline_decision',
        reason: 'skipped-blocklist',
        source: 'blocklist',
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });

  // 13-05: mid-path wildcard end-to-end through skip-pipeline (carry-forward P10 bug-fix).
  it('test_runSkipPipeline_when_pattern_cache_has_mid_path_wildcard_then_skipped', async () => {
    const patternsCache: BlocklistRow[] = [
      {
        id: 1,
        file_id: null,
        path_pattern: '*/Samples/*',
        reason: 'operator',
        created_at: 0,
      },
    ];
    const blocklistRepo = makeBlocklistRepo({ matchResult: false });
    const result = await runSkipPipeline(
      makeInput({ filePath: '/movies/Movie A/Samples/sample.mkv' }),
      { fileRepo: makeFileRepo(), blocklistRepo, patternsCache },
    );
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });

  it('test_runSkipPipeline_when_pattern_cache_mid_path_no_match_then_falls_through', async () => {
    const patternsCache: BlocklistRow[] = [
      {
        id: 1,
        file_id: null,
        path_pattern: '*/Samples/*',
        reason: 'operator',
        created_at: 0,
      },
    ];
    const blocklistRepo = makeBlocklistRepo({ matchResult: false });
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Movie A/feature.mkv' }), {
      fileRepo: makeFileRepo(),
      blocklistRepo,
      patternsCache,
    });
    expect(result.skip).toBe(false);
  });
});
