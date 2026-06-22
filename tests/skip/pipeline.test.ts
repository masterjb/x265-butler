/*
 * 10-01: skip pipeline tests — runSkipPipeline 2-step decision tree.
 *
 * Step 1 SIDECAR: sibling JSON with matching contentHash. All schema versions
 * (V1/V2/V3) and all outcome values collapse uniformly to 'skipped-sidecar'
 * per discuss-2026-05-08 FileStatus-Union decision.
 *
 * Step 2 BLOCKLIST: pattern + file_id pin check. Only runs when blocklistRepo
 * OR patternsCache provided. 04-01 callers without either dep see skip:false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReadSidecar, mockReadSidecarResolved, mockLogger } = vi.hoisted(() => ({
  mockReadSidecar: vi.fn(),
  mockReadSidecarResolved: vi.fn(),
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/encode/sidecar', () => ({
  readSidecar: mockReadSidecar,
  readSidecarResolved: mockReadSidecarResolved,
  DEFAULT_SIDECAR_CENTRAL_PATH: '/config/x265-butler/sidecars/',
  writeSidecar: vi.fn(),
  sweepSidecarTmpFiles: vi.fn(),
  sidecarPathFor: (p: string): string => `${p}.x265-butler.json`,
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import { runSkipPipeline, type PipelineDeps, type PipelineInput } from '@/src/lib/skip/pipeline';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { FileRow, BlocklistRow } from '@/src/lib/db/schema';
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';

function makeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 3600,
    width: 1920,
    height: 1080,
    container: 'matroska,webm',
    tags: {},
    ...overrides,
  };
}

function makeFileRepo(rows: Map<string, FileRow> = new Map()): PipelineDeps['fileRepo'] {
  return {
    findByContentHash: (hash: string) => rows.get(hash),
  } as unknown as PipelineDeps['fileRepo'];
}

function makeBlocklistRepo(matchResult = false): BlocklistRepo {
  return {
    matchByFileIdOrPath: vi.fn().mockReturnValue(matchResult),
    findByFileId: vi.fn().mockReturnValue(undefined),
    listAllPatterns: vi.fn().mockReturnValue([]),
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

function makeBlocklistRow(pathPattern: string): BlocklistRow {
  return { id: 1, file_id: null, path_pattern: pathPattern, reason: 'operator', created_at: 0 };
}

const V1_SIDECAR_BASE = {
  schema: 'x265-butler/v1' as const,
  processedBy: 'x265-butler' as const,
  version: '1.0.0',
  gitHash: 'dev',
  processedAt: '2026-04-01T00:00:00Z',
  output: { filename: 'Foo.x265.mkv', contentHash: 'cc'.repeat(32), sizeBytes: 500 },
};

const V2_SIDECAR_BASE = {
  schema: 'x265-butler/v2' as const,
  processedBy: 'x265-butler' as const,
  version: '1.4.0',
  gitHash: 'dev',
  processedAt: '2026-04-27T14:30:00Z',
  output: { filename: 'Foo.x265.mkv', contentHash: 'cc'.repeat(32), sizeBytes: 500 },
  encoder: 'libx265' as const,
  quality: { mode: 'crf' as const, value: 23 },
};

const V3_SIDECAR_BASE = {
  schema: 'x265-butler/v3' as const,
  processedBy: 'x265-butler' as const,
  version: '2.3.0',
  gitHash: 'abc1234',
  processedAt: '2026-05-08T10:00:00Z',
  durationSec: 60,
  output: { filename: 'Foo.x265.mkv', contentHash: 'cc'.repeat(32), sizeBytes: 500 },
  encoder: { name: 'libx265' as const, preset: 'medium', ffmpegVersion: '7.0' },
  quality: { mode: 'crf' as const, value: 23 },
  savings: { bytes: 500, ratio: 0.5, thresholdUsed: 0.05 },
  outcome: 'done-smaller' as const,
};

beforeEach(() => {
  mockReadSidecar.mockReset();
  mockReadSidecarResolved.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.info.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Step 1: SIDECAR ─────────────────────────────────────────────────────────

describe('runSkipPipeline — Step 1 SIDECAR: uniform collapse', () => {
  it('test_pipeline_step1_v1_hash_match_returns_skipped_sidecar', async () => {
    const hash = 'b'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_v2_hash_match_no_outcome_returns_skipped_sidecar', async () => {
    const hash = 'c'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_v3_hash_match_returns_skipped_sidecar', async () => {
    const hash = 'd'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V3_SIDECAR_BASE,
      source: {
        filename: 'Foo.mkv',
        contentHash: hash,
        sizeBytes: 1000,
        codec: 'h264',
        width: 1920,
        height: 1080,
        durationSec: 3600,
      },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  // 10-01: 'done-already-evaluated' DROPPED — all sidecar-hash-matches → 'skipped-sidecar'
  it('test_pipeline_step1_v2_outcome_done_larger_returns_skipped_sidecar_not_done_already_evaluated', async () => {
    const hash = 'e1'.repeat(32);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
      outcome: 'done-larger',
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_v2_outcome_done_not_worth_returns_skipped_sidecar', async () => {
    const hash = 'e2'.repeat(32);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
      outcome: 'done-not-worth',
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_v2_outcome_done_smaller_returns_skipped_sidecar', async () => {
    const hash = 'e3'.repeat(32);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
      outcome: 'done-smaller',
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  // Output-file guard: sidecar sits at movie.x265.mkv.x265-butler.json for
  // done-smaller encodes. On re-scan the output file is a new 'pending' row —
  // source.contentHash never matches. output.contentHash must trigger skip to
  // prevent the re-encode loop.
  it('test_pipeline_step1_output_hash_match_v1_returns_skipped_sidecar', async () => {
    const outputHash = 'f1'.repeat(32);
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'aa'.repeat(32), sizeBytes: 1000 },
      output: { filename: 'Foo.x265.mkv', contentHash: outputHash, sizeBytes: 500 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: outputHash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('test_pipeline_step1_output_hash_match_v3_returns_skipped_sidecar', async () => {
    const outputHash = 'f2'.repeat(32);
    mockReadSidecar.mockResolvedValue({
      ...V3_SIDECAR_BASE,
      source: {
        filename: 'Foo.mkv',
        contentHash: 'bb'.repeat(32),
        sizeBytes: 1000,
        codec: 'h264',
        width: 1920,
        height: 1080,
        durationSec: 3600,
      },
      output: { filename: 'Foo.x265.mkv', contentHash: outputHash, sizeBytes: 500 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: outputHash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('test_pipeline_step1_output_hash_match_case_insensitive_returns_skipped_sidecar', async () => {
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'aa'.repeat(32), sizeBytes: 1000 },
      output: { filename: 'Foo.x265.mkv', contentHash: 'FF'.repeat(32), sizeBytes: 500 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: 'ff'.repeat(32) }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_neither_source_nor_output_hash_match_logs_warn_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'X'.repeat(64), sizeBytes: 1000 },
      output: { filename: 'Foo.x265.mkv', contentHash: 'cc'.repeat(32), sizeBytes: 500 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: 'Y'.repeat(64) }), {
      fileRepo: makeFileRepo(),
    });
    expect(result.skip).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_hash_mismatch_at_source' }),
      expect.any(String),
    );
  });

  it('test_pipeline_step1_hash_mismatch_logs_warn_action_sidecar_hash_mismatch_at_source', async () => {
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'X'.repeat(64), sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: 'Y'.repeat(64) }), {
      fileRepo: makeFileRepo(),
    });
    expect(result.skip).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_hash_mismatch_at_source' }),
      expect.any(String),
    );
  });

  it('test_pipeline_step1_case_insensitive_upper_sidecar_lower_disk_returns_skipped_sidecar', async () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: upper, sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: lower }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('test_pipeline_step1_case_insensitive_lower_sidecar_upper_disk_returns_skipped_sidecar', async () => {
    const lower = 'a'.repeat(64);
    const upper = 'A'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: lower, sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: upper }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('test_pipeline_step1_null_sidecar_falls_through', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo() });
    expect(result.skip).toBe(false);
  });
});

// ─── Step 2: BLOCKLIST ───────────────────────────────────────────────────────

describe('runSkipPipeline — Step 2 BLOCKLIST', () => {
  it('test_pipeline_step2_patternsCache_prefix_match_returns_skipped_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Foo.mkv' }), {
      fileRepo: makeFileRepo(),
      patternsCache: [makeBlocklistRow('/movies/*')],
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });

  it('test_pipeline_step2_patternsCache_suffix_match_returns_skipped_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput({ filePath: '/data/Foo.mkv' }), {
      fileRepo: makeFileRepo(),
      patternsCache: [makeBlocklistRow('*.mkv')],
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });

  it('test_pipeline_step2_patternsCache_no_match_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Foo.mkv' }), {
      fileRepo: makeFileRepo(),
      patternsCache: [makeBlocklistRow('/other/*')],
    });
    expect(result.skip).toBe(false);
  });

  it('test_pipeline_step2_patternsCache_no_match_fileId_pinned_via_findByFileId_returns_skipped_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const hash = 'f1'.repeat(32);
    const fileId = 42;
    const rows = new Map<string, FileRow>([
      [hash, { id: fileId, status: 'done-smaller', content_hash: hash } as FileRow],
    ]);
    const blocklistRepo = makeBlocklistRepo(false);
    (blocklistRepo.findByFileId as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 99,
      file_id: fileId,
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(rows),
      patternsCache: [],
      blocklistRepo,
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });

  it('test_pipeline_step2_blocklistRepo_matchByFileIdOrPath_true_returns_skipped_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const repo = makeBlocklistRepo(true);
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });

  it('test_pipeline_step2_blocklistRepo_matchByFileIdOrPath_false_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const repo = makeBlocklistRepo(false);
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result.skip).toBe(false);
  });

  it('test_pipeline_step2_no_deps_blocklist_skipped_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo() });
    expect(result.skip).toBe(false);
  });

  it('test_pipeline_step2_no_fileId_row_patternsCache_path_match_still_runs', async () => {
    mockReadSidecar.mockResolvedValue(null);
    // No file row → fileId=null; patternsCache path match still fires
    const result = await runSkipPipeline(makeInput({ filePath: '/blocked/Bar.mkv' }), {
      fileRepo: makeFileRepo(),
      patternsCache: [makeBlocklistRow('/blocked/*')],
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
  });
});

// ─── Ordering + short-circuit ────────────────────────────────────────────────

describe('runSkipPipeline — ordering', () => {
  it('test_pipeline_sidecar_match_short_circuits_blocklist_not_checked', async () => {
    const hash = 'g'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    const repo = makeBlocklistRepo(true);
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
    expect(repo.matchByFileIdOrPath).not.toHaveBeenCalled();
  });

  it('test_pipeline_sidecar_miss_falls_through_to_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const repo = makeBlocklistRepo(true);
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
    expect(repo.matchByFileIdOrPath).toHaveBeenCalledOnce();
  });

  it('test_pipeline_both_steps_miss_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const repo = makeBlocklistRepo(false);
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result).toEqual({ skip: false });
  });

  it('test_pipeline_probe_field_ignored_result_unaffected', async () => {
    mockReadSidecar.mockResolvedValue(null);
    // probe no longer read by pipeline; result must be identical regardless of codec
    const result = await runSkipPipeline(makeInput({ probe: makeProbe({ codec: 'hevc' }) }), {
      fileRepo: makeFileRepo(),
    });
    expect(result.skip).toBe(false);
  });
});

// ─── Audit-trail logging ─────────────────────────────────────────────────────

describe('runSkipPipeline — audit-trail logging', () => {
  it('test_pipeline_sidecar_decision_logs_skip_pipeline_decision_with_source_and_durationMs', async () => {
    const hash = 'h'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skip_pipeline_decision',
        reason: 'skipped-sidecar',
        source: 'sidecar',
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });

  it('test_pipeline_blocklist_decision_logs_skip_pipeline_decision_with_source_blocklist', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const repo = makeBlocklistRepo(true);
    await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
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

  it('test_pipeline_no_skip_does_not_log_info', async () => {
    mockReadSidecar.mockResolvedValue(null);
    await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo() });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  // SR10: source field always emitted — regression guard
  it('test_pipeline_source_field_always_present_on_all_skip_decisions', async () => {
    const hash = 'i'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    const call = mockLogger.info.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect(typeof call?.['source']).toBe('string');
  });
});

// ─── Extra edge cases ────────────────────────────────────────────────────────

describe('runSkipPipeline — edge cases', () => {
  // V3 schema with outcome=done-larger → still 'skipped-sidecar' (10-01 uniform collapse)
  it('test_pipeline_v3_outcome_done_larger_returns_skipped_sidecar', async () => {
    const hash = 'j'.repeat(64);
    mockReadSidecar.mockResolvedValue({
      ...V3_SIDECAR_BASE,
      source: {
        filename: 'Foo.mkv',
        contentHash: hash,
        sizeBytes: 1000,
        codec: 'h264',
        width: 1920,
        height: 1080,
        durationSec: 3600,
      },
      outcome: 'done-larger' as const,
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  // Sidecar mismatch → blocklist still checked (both steps execute independently)
  it('test_pipeline_sidecar_mismatch_then_blocklist_still_checked', async () => {
    mockReadSidecar.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'X'.repeat(64), sizeBytes: 1000 },
    });
    const repo = makeBlocklistRepo(true);
    const result = await runSkipPipeline(makeInput({ diskContentHash: 'Y'.repeat(64) }), {
      fileRepo: makeFileRepo(),
      blocklistRepo: repo,
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-blocklist', source: 'blocklist' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_hash_mismatch_at_source' }),
      expect.any(String),
    );
  });

  // Empty patternsCache + no blocklistRepo → step 2 short-circuits
  it('test_pipeline_empty_patternsCache_no_blocklistRepo_returns_skip_false', async () => {
    mockReadSidecar.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput({ filePath: '/movies/Foo.mkv' }), {
      fileRepo: makeFileRepo(),
      patternsCache: [],
    });
    expect(result.skip).toBe(false);
  });
});

// ─── 33-01: Step 1 mode-aware read (central / beside / off) ───────────────────

describe('runSkipPipeline — 33-01 sidecarMode-aware Step 1 read', () => {
  it('sidecarMode=central → reads via readSidecarResolved (source-hash match → skip)', async () => {
    const hash = 'k'.repeat(64);
    mockReadSidecarResolved.mockResolvedValue({
      ...V2_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: hash, sizeBytes: 1000 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: hash }), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'central',
      sidecarCentralPath: '/config/x265-butler/sidecars/',
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
    expect(mockReadSidecarResolved).toHaveBeenCalledWith(
      '/movies/Foo.mkv',
      'central',
      '/config/x265-butler/sidecars/',
    );
    expect(mockReadSidecar).not.toHaveBeenCalled();
  });

  it('sidecarMode=central → output-hash match also skips (AC-1)', async () => {
    const outputHash = 'l1'.repeat(32);
    mockReadSidecarResolved.mockResolvedValue({
      ...V1_SIDECAR_BASE,
      source: { filename: 'Foo.mkv', contentHash: 'aa'.repeat(32), sizeBytes: 1000 },
      output: { filename: 'Foo.x265.mkv', contentHash: outputHash, sizeBytes: 500 },
    });
    const result = await runSkipPipeline(makeInput({ diskContentHash: outputHash }), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'central',
    });
    expect(result).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('sidecarMode=central with NO sidecarCentralPath → defaults to DEFAULT_SIDECAR_CENTRAL_PATH (AC-7)', async () => {
    mockReadSidecarResolved.mockResolvedValue(null);
    await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'central',
    });
    expect(mockReadSidecarResolved).toHaveBeenCalledWith(
      '/movies/Foo.mkv',
      'central',
      '/config/x265-butler/sidecars/',
    );
  });

  it('sidecarMode=central + resolver returns null → falls through (skip false)', async () => {
    mockReadSidecarResolved.mockResolvedValue(null);
    const result = await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'central',
    });
    expect(result.skip).toBe(false);
  });

  it('sidecarMode=beside → reads via readSidecar, NEVER readSidecarResolved (AC-4)', async () => {
    mockReadSidecar.mockResolvedValue(null);
    await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'beside',
    });
    expect(mockReadSidecar).toHaveBeenCalledWith('/movies/Foo.mkv');
    expect(mockReadSidecarResolved).not.toHaveBeenCalled();
  });

  it('sidecarMode=off → reads via readSidecar (byte-identical, AC-4)', async () => {
    mockReadSidecar.mockResolvedValue(null);
    await runSkipPipeline(makeInput(), {
      fileRepo: makeFileRepo(),
      sidecarMode: 'off',
    });
    expect(mockReadSidecar).toHaveBeenCalledWith('/movies/Foo.mkv');
    expect(mockReadSidecarResolved).not.toHaveBeenCalled();
  });

  it('sidecarMode OMITTED → reads via readSidecar (legacy/04-01 byte-identical, AC-4)', async () => {
    mockReadSidecar.mockResolvedValue(null);
    await runSkipPipeline(makeInput(), { fileRepo: makeFileRepo() });
    expect(mockReadSidecar).toHaveBeenCalledWith('/movies/Foo.mkv');
    expect(mockReadSidecarResolved).not.toHaveBeenCalled();
  });
});
