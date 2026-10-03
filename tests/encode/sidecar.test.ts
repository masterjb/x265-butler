/*
 * 04-01: sidecar JSON helpers — writeSidecar (atomic tmp+rename) /
 * readSidecar (size-capped + schema-version-gated) / sweepSidecarTmpFiles
 * (boot orphan cleanup per audit M5).
 *
 * Mocks node:fs/promises via vi.mock to keep tests deterministic + CI-safe
 * (audit S3: replaces fs.stat polling loop with mock-based assertions).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWriteFile, mockRename, mockUnlink, mockStat, mockReadFile, mockReaddir, mockLogger } =
  vi.hoisted(() => ({
    mockWriteFile: vi.fn(),
    mockRename: vi.fn(),
    mockUnlink: vi.fn(),
    mockStat: vi.fn(),
    mockReadFile: vi.fn(),
    mockReaddir: vi.fn(),
    mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }));

vi.mock('node:fs', () => {
  const promises = {
    writeFile: mockWriteFile,
    rename: mockRename,
    unlink: mockUnlink,
    stat: mockStat,
    readFile: mockReadFile,
    readdir: mockReaddir,
  };
  return {
    promises,
    default: { promises },
  };
});

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import {
  writeSidecar,
  readSidecar,
  sweepSidecarTmpFiles,
  sidecarPathFor,
  sidecarPathForSource,
  qualityModeFor,
  encoderNameFor,
  type SidecarV1,
  type SidecarV2,
  type SidecarV3,
  type EncoderName,
  type SidecarOutcome,
} from '@/src/lib/encode/sidecar';

const validPayload: SidecarV1 = {
  schema: 'x265-butler/v1',
  processedBy: 'x265-butler',
  version: '1.4.0',
  gitHash: 'abc1234',
  processedAt: '2026-04-27T14:30:00.000Z',
  source: { filename: 'Foo.mkv', contentHash: 'ab12cd34', sizeBytes: 8589934592 },
  output: { filename: 'Foo.x265.mkv', contentHash: 'fe98ba76', sizeBytes: 4294967296 },
};

beforeEach(() => {
  mockWriteFile.mockReset();
  mockRename.mockReset();
  mockUnlink.mockReset();
  mockStat.mockReset();
  mockReadFile.mockReset();
  mockReaddir.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.info.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('writeSidecar', () => {
  it('test_writeSidecar_when_called_then_creates_file_at_outputPath_plus_x265butler_json', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', validPayload);
    const tmpPath = mockWriteFile.mock.calls[0][0];
    const finalPath = mockRename.mock.calls[0][1];
    expect(tmpPath).toBe('/out/Foo.x265.mkv.x265-butler.json.tmp');
    expect(finalPath).toBe('/out/Foo.x265.mkv.x265-butler.json');
  });

  it('test_writeSidecar_when_called_then_writes_valid_JSON_with_schema_v1', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', validPayload);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.schema).toBe('x265-butler/v1');
    expect(parsed.processedBy).toBe('x265-butler');
    expect(parsed.source.contentHash).toBe('ab12cd34');
  });

  // audit S3: deterministic mock-based atomic-write assertion (replaces flaky polling).
  it('test_writeSidecar_when_renames_atomically_then_consumer_observes_either_pre_write_absence_OR_post_rename_completeness', async () => {
    const order: string[] = [];
    mockWriteFile.mockImplementation(async () => {
      order.push('writeFile');
    });
    mockRename.mockImplementation(async () => {
      order.push('rename');
    });
    await writeSidecar('/out/Foo.x265.mkv', validPayload);
    expect(order).toEqual(['writeFile', 'rename']);
    const tmpPath = mockWriteFile.mock.calls[0][0];
    const finalPath = mockRename.mock.calls[0][1];
    expect(tmpPath).not.toBe(finalPath);
    expect(tmpPath).toMatch(/\.tmp$/);
  });

  it('test_writeSidecar_when_filesystem_throws_then_pino_warn_action_sidecar_write_failed', async () => {
    mockWriteFile.mockRejectedValue(new Error('EROFS: read-only file system'));
    mockUnlink.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', validPayload);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_write_failed' }),
      expect.any(String),
    );
  });

  it('test_writeSidecar_when_fs_throws_then_does_NOT_propagate_error_to_caller', async () => {
    mockWriteFile.mockRejectedValue(new Error('boom'));
    mockUnlink.mockResolvedValue(undefined);
    // Must not throw — DB content_hash authoritative.
    await expect(writeSidecar('/out/x.mkv', validPayload)).resolves.toBeUndefined();
  });

  it('test_writeSidecar_when_rename_throws_then_tmp_unlink_is_attempted_and_warn_log_fires', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockRejectedValue(new Error('EPERM'));
    mockUnlink.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', validPayload);
    expect(mockUnlink).toHaveBeenCalledWith('/out/Foo.x265.mkv.x265-butler.json.tmp');
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe('readSidecar', () => {
  it('test_readSidecar_when_file_missing_then_returns_null_AND_no_warn_log_for_ENOENT', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(err);
    const result = await readSidecar('/out/x.mkv');
    expect(result).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('test_readSidecar_when_file_unparseable_JSON_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue('not valid json {{{');
    const result = await readSidecar('/out/x.mkv');
    expect(result).toBeNull();
  });

  it('test_readSidecar_when_schema_version_mismatch_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(JSON.stringify({ schema: 'x265-butler/v999' }));
    const result = await readSidecar('/out/x.mkv');
    expect(result).toBeNull();
  });

  it('test_readSidecar_when_processedBy_field_wrong_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ schema: 'x265-butler/v1', processedBy: 'malicious-tool' }),
    );
    const result = await readSidecar('/out/x.mkv');
    expect(result).toBeNull();
  });

  it('test_readSidecar_when_v1_well_formed_then_returns_typed_payload', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(JSON.stringify(validPayload));
    const result = await readSidecar('/out/Foo.x265.mkv');
    expect(result).not.toBeNull();
    expect(result?.processedBy).toBe('x265-butler');
    expect(result?.source.contentHash).toBe('ab12cd34');
  });

  // audit M4: size cap
  it('test_readSidecar_when_size_exceeds_64KB_then_returns_null_with_action_sidecar_oversize_rejected_warn_log_AND_NO_fs_readFile_call', async () => {
    mockStat.mockResolvedValue({ size: 100 * 1024 });
    const result = await readSidecar('/out/Foo.x265.mkv');
    expect(result).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_oversize_rejected', sizeBytes: 100 * 1024 }),
      expect.any(String),
    );
  });

  it('test_readSidecar_when_size_at_64KB_exactly_then_proceeds_to_readFile', async () => {
    mockStat.mockResolvedValue({ size: 64 * 1024 });
    mockReadFile.mockResolvedValue(JSON.stringify(validPayload));
    const result = await readSidecar('/out/Foo.x265.mkv');
    expect(result).not.toBeNull();
    expect(mockReadFile).toHaveBeenCalledOnce();
  });

  it('test_readSidecar_when_fs_stat_throws_non_ENOENT_then_returns_null_with_action_sidecar_stat_failed_warn_log', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockStat.mockRejectedValue(err);
    const result = await readSidecar('/out/Foo.x265.mkv');
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_stat_failed' }),
      expect.any(String),
    );
  });

  it('test_sidecarPathFor_returns_outputPath_with_x265butler_json_suffix', () => {
    expect(sidecarPathFor('/foo/bar.x265.mkv')).toBe('/foo/bar.x265.mkv.x265-butler.json');
  });
});

// 05-08 B4: V2 schema round-trip + malformed-V2 rejection (AC-4 + AC-5 + AC-11).
describe('writeSidecar + readSidecar — V2 schema (05-08 B4)', () => {
  const validV2: SidecarV2 = {
    schema: 'x265-butler/v2',
    processedBy: 'x265-butler',
    version: '1.5.0',
    gitHash: 'def5678',
    processedAt: '2026-04-28T10:00:00.000Z',
    source: { filename: 'A.mkv', contentHash: 'aa11', sizeBytes: 1000 },
    output: { filename: 'A.x265.mkv', contentHash: 'bb22', sizeBytes: 500 },
    encoder: 'libx265',
    quality: { mode: 'crf', value: 23 },
  };

  it('test_writeSidecar_when_v2_payload_then_writes_schema_v2_with_encoder_and_quality', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/A.x265.mkv', validV2);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.schema).toBe('x265-butler/v2');
    expect(parsed.encoder).toBe('libx265');
    expect(parsed.quality).toEqual({ mode: 'crf', value: 23 });
  });

  it('test_readSidecar_when_v2_well_formed_then_returns_typed_payload_with_encoder_and_quality', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(JSON.stringify(validV2));
    const result = await readSidecar('/out/A.x265.mkv');
    expect(result).not.toBeNull();
    expect(result?.schema).toBe('x265-butler/v2');
    expect((result as SidecarV2).encoder).toBe('libx265');
    expect((result as SidecarV2).quality).toEqual({ mode: 'crf', value: 23 });
  });

  it('test_readSidecar_when_v2_missing_encoder_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    const malformed = { ...validV2 } as Partial<SidecarV2>;
    delete malformed.encoder;
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_missing_quality_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    const malformed = { ...validV2 } as Partial<SidecarV2>;
    delete malformed.quality;
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_quality_mode_unknown_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV2, quality: { mode: 'bogus', value: 23 } }),
    );
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_quality_value_below_zero_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV2, quality: { mode: 'crf', value: -1 } }),
    );
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_quality_value_above_51_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV2, quality: { mode: 'crf', value: 52 } }),
    );
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_quality_value_non_integer_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV2, quality: { mode: 'crf', value: 23.5 } }),
    );
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v2_encoder_outside_union_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(JSON.stringify({ ...validV2, encoder: 'hevc_unknown' }));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });
});

// 05-13: SidecarOutcome additive optional + sidecarPathForSource helper +
// soft-degrade malformed-outcome (S1 audit upgrade — accept payload, strip
// outcome to undefined, log warn). Required V2 fields STILL strict-reject
// (B4 audit S2 contract).
describe('SidecarV2 outcome field + sidecarPathForSource (05-13)', () => {
  const v2WithOutcome = (outcome: SidecarOutcome): SidecarV2 => ({
    schema: 'x265-butler/v2',
    processedBy: 'x265-butler',
    version: '1.4.0',
    gitHash: 'abc1234',
    processedAt: '2026-05-04T10:00:00.000Z',
    source: { filename: 'Foo.mkv', contentHash: 'aa11', sizeBytes: 1000 },
    output: { filename: 'Foo.x265.mkv', contentHash: 'bb22', sizeBytes: 500 },
    encoder: 'libx265',
    quality: { mode: 'crf', value: 23 },
    outcome,
  });

  it('test_sidecarPathForSource_returns_sourcePath_with_x265butler_json_suffix_identical_to_sidecarPathFor', () => {
    const p = '/movies/Foo.mkv';
    expect(sidecarPathForSource(p)).toBe('/movies/Foo.mkv.x265-butler.json');
    // Same suffix as sidecarPathFor — semantically distinct for grep clarity at orchestrator call site.
    expect(sidecarPathForSource(p)).toBe(sidecarPathFor(p));
  });

  it('test_writeSidecar_when_v2_with_outcome_done_smaller_then_round_trips_correctly', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', v2WithOutcome('done-smaller'));
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.outcome).toBe('done-smaller');
    expect(parsed.schema).toBe('x265-butler/v2');
  });

  it('test_writeSidecar_when_v2_with_outcome_done_larger_then_round_trips_correctly', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', v2WithOutcome('done-larger'));
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(JSON.parse(written).outcome).toBe('done-larger');
  });

  it('test_writeSidecar_when_v2_with_outcome_done_not_worth_then_round_trips_correctly', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Foo.x265.mkv', v2WithOutcome('done-not-worth'));
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(JSON.parse(written).outcome).toBe('done-not-worth');
  });

  it('test_readSidecar_when_v2_outcome_done_smaller_then_returns_payload_with_outcome', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(JSON.stringify(v2WithOutcome('done-smaller')));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result?.outcome).toBe('done-smaller');
  });

  it('test_readSidecar_when_v2_outcome_done_larger_then_returns_payload_with_outcome', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(JSON.stringify(v2WithOutcome('done-larger')));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result?.outcome).toBe('done-larger');
  });

  it('test_readSidecar_when_v2_outcome_done_not_worth_then_returns_payload_with_outcome', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(JSON.stringify(v2WithOutcome('done-not-worth')));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result?.outcome).toBe('done-not-worth');
  });

  it('test_readSidecar_when_v2_outcome_field_OMITTED_legacy_then_payload_accepted_with_outcome_undefined', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    const legacy = v2WithOutcome('done-smaller') as Partial<SidecarV2>;
    delete legacy.outcome;
    mockReadFile.mockResolvedValue(JSON.stringify(legacy));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result).not.toBeNull();
    expect(result?.outcome).toBeUndefined();
    // Backwards-compat: no warn — omitting outcome is legitimate legacy V2.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // 05-13 audit S1 soft-degrade: malformed outcome stripped, payload accepted.
  it('test_readSidecar_when_v2_outcome_string_outside_union_then_outcome_stripped_to_undefined_payload_accepted_warn_logged', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    const malformed = { ...v2WithOutcome('done-smaller'), outcome: 'maybe' };
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result).not.toBeNull();
    expect(result?.outcome).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sidecar_outcome_malformed',
        originalValue: 'maybe',
      }),
      expect.any(String),
    );
  });

  it('test_readSidecar_when_v2_outcome_non_string_42_then_outcome_stripped_payload_accepted', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    const malformed = { ...v2WithOutcome('done-smaller'), outcome: 42 };
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result).not.toBeNull();
    expect(result?.outcome).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_outcome_malformed' }),
      expect.any(String),
    );
  });

  it('test_readSidecar_when_v2_outcome_empty_string_then_outcome_stripped_payload_accepted', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    const malformed = { ...v2WithOutcome('done-smaller'), outcome: '' };
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    const result = (await readSidecar('/out/Foo.x265.mkv')) as SidecarV2;
    expect(result).not.toBeNull();
    expect(result?.outcome).toBeUndefined();
  });

  // 05-13 audit S1: REQUIRED V2 fields STILL strict-reject (B4 contract preserved)
  it('test_readSidecar_when_v2_required_field_encoder_malformed_then_returns_null_even_if_outcome_valid', async () => {
    mockStat.mockResolvedValue({ size: 300 });
    const malformed = { ...v2WithOutcome('done-smaller'), encoder: 'unknown_encoder' };
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/Foo.x265.mkv')).toBeNull();
  });
});

describe('qualityModeFor + encoderNameFor (05-08 B4)', () => {
  it('test_qualityModeFor_returns_crf_for_libx265', () => {
    expect(qualityModeFor('libx265')).toBe('crf');
  });
  it('test_qualityModeFor_returns_cq_for_hevc_nvenc', () => {
    expect(qualityModeFor('hevc_nvenc')).toBe('cq');
  });
  it('test_qualityModeFor_returns_qp_for_hevc_qsv', () => {
    expect(qualityModeFor('hevc_qsv')).toBe('qp');
  });
  it('test_qualityModeFor_returns_qp_for_hevc_vaapi', () => {
    expect(qualityModeFor('hevc_vaapi')).toBe('qp');
  });
  it('test_encoderNameFor_maps_internal_ids_to_ffmpeg_names', () => {
    expect(encoderNameFor('libx265')).toBe('libx265');
    expect(encoderNameFor('nvenc')).toBe('hevc_nvenc');
    expect(encoderNameFor('qsv')).toBe('hevc_qsv');
    expect(encoderNameFor('vaapi')).toBe('hevc_vaapi');
  });
  it('test_encoderNameFor_returns_null_for_unknown_id', () => {
    expect(encoderNameFor('av1')).toBeNull();
    expect(encoderNameFor('')).toBeNull();
  });
  it('test_qualityModeFor_covers_all_EncoderName_union_via_exhaustive_switch', () => {
    // audit S3: assertNever guard — adding a new EncoderName widens the union
    // and produces a TS compile error here, NOT a runtime surprise.
    const all: EncoderName[] = ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'];
    for (const e of all) {
      expect(qualityModeFor(e)).toMatch(/^(crf|cq|qp)$/);
    }
  });
});

describe('sweepSidecarTmpFiles (audit M5)', () => {
  it('test_sweepSidecarTmpFiles_when_x265_butler_tmp_files_present_then_unlinked', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'foo.x265.mkv', isDirectory: () => false, isFile: () => true },
      { name: 'foo.x265.mkv.x265-butler.json.tmp', isDirectory: () => false, isFile: () => true },
      { name: 'bar.x265.mkv.x265-butler.json.tmp', isDirectory: () => false, isFile: () => true },
    ]);
    mockUnlink.mockResolvedValue(undefined);
    const result = await sweepSidecarTmpFiles('/scan/root');
    expect(result.swept).toBe(2);
    expect(result.failed).toBe(0);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('test_sweepSidecarTmpFiles_when_unlink_throws_then_failed_count_increments_and_does_NOT_throw', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'foo.x265.mkv.x265-butler.json.tmp', isDirectory: () => false, isFile: () => true },
    ]);
    mockUnlink.mockRejectedValue(new Error('EPERM'));
    const result = await sweepSidecarTmpFiles('/scan/root');
    expect(result.swept).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_tmp_unlink_failed' }),
      expect.any(String),
    );
  });

  it('test_sweepSidecarTmpFiles_when_recursive_dirs_then_walks_into_subdirs', async () => {
    mockReaddir
      .mockResolvedValueOnce([
        { name: 'movies', isDirectory: () => true, isFile: () => false },
        { name: 'top.x265.mkv.x265-butler.json.tmp', isDirectory: () => false, isFile: () => true },
      ])
      .mockResolvedValueOnce([
        {
          name: 'nested.x265.mkv.x265-butler.json.tmp',
          isDirectory: () => false,
          isFile: () => true,
        },
      ]);
    mockUnlink.mockResolvedValue(undefined);
    const result = await sweepSidecarTmpFiles('/scan/root');
    expect(result.swept).toBe(2);
  });

  it('test_sweepSidecarTmpFiles_when_readdir_throws_ENOENT_then_returns_silent_zero', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReaddir.mockRejectedValue(err);
    const result = await sweepSidecarTmpFiles('/scan/root');
    expect(result).toEqual({ swept: 0, failed: 0 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('test_sweepSidecarTmpFiles_emits_sidecar_tmp_swept_info_log_when_count_gt_zero', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'foo.x265.mkv.x265-butler.json.tmp', isDirectory: () => false, isFile: () => true },
    ]);
    mockUnlink.mockResolvedValue(undefined);
    await sweepSidecarTmpFiles('/scan/root');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_tmp_swept', swept: 1, failed: 0 }),
      expect.any(String),
    );
  });
});

// 10-01: SidecarV3 schema — round-trip + strict-reject cases (AC-1 + AC-2 + SR3 + SR4).
describe('writeSidecar + readSidecar — V3 schema (10-01)', () => {
  const hash64 = 'a'.repeat(64);
  const outHash64 = 'b'.repeat(64);

  const validV3: SidecarV3 = {
    schema: 'x265-butler/v3',
    processedBy: 'x265-butler',
    version: '2.3.0',
    gitHash: 'abc1234',
    processedAt: '2026-05-08T10:00:00.000Z',
    durationSec: 45.2,
    source: {
      filename: 'Movie.mkv',
      contentHash: hash64,
      sizeBytes: 5_000_000,
      codec: 'h264',
      width: 1920,
      height: 1080,
      durationSec: 7200,
    },
    output: {
      filename: 'Movie.x265.mkv',
      contentHash: outHash64,
      sizeBytes: 3_000_000,
    },
    savings: { bytes: 2_000_000, ratio: 0.6, thresholdUsed: 0.05 },
    encoder: { name: 'libx265', preset: 'medium', ffmpegVersion: '6.1' },
    quality: { mode: 'crf', value: 23 },
    outcome: 'done-smaller',
  };

  it('test_writeSidecar_when_v3_payload_then_writes_schema_v3', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await writeSidecar('/out/Movie.x265.mkv', validV3);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.schema).toBe('x265-butler/v3');
    expect(parsed.outcome).toBe('done-smaller');
    expect(parsed.encoder).toEqual({ name: 'libx265', preset: 'medium', ffmpegVersion: '6.1' });
  });

  it('test_readSidecar_when_v3_well_formed_then_returns_v3_payload', async () => {
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(validV3));
    const result = await readSidecar('/out/Movie.x265.mkv');
    expect(result).not.toBeNull();
    expect(result?.schema).toBe('x265-butler/v3');
    expect((result as SidecarV3).outcome).toBe('done-smaller');
    expect((result as SidecarV3).durationSec).toBe(45.2);
    expect((result as SidecarV3).encoder.name).toBe('libx265');
  });

  it('test_readSidecar_when_v3_missing_outcome_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    const bad = { ...validV3 } as Partial<SidecarV3>;
    delete bad.outcome;
    mockReadFile.mockResolvedValue(JSON.stringify(bad));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_outcome_outside_bucket_set_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    mockReadFile.mockResolvedValue(JSON.stringify({ ...validV3, outcome: 'done-skipped' }));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_encoder_is_string_not_object_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    mockReadFile.mockResolvedValue(JSON.stringify({ ...validV3, encoder: 'libx265' }));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_quality_value_above_51_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV3, quality: { mode: 'crf', value: 52 } }),
    );
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_oversize_above_64kib_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 65 * 1024 + 1 });
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('test_readSidecar_when_v3_source_missing_codec_field_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    const bad: Record<string, unknown> = {
      ...validV3,
      source: { ...validV3.source, codec: undefined },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(bad));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  // SR3: contentHash must be 64 lowercase hex chars
  it('test_readSidecar_when_v3_source_contentHash_non_64hex_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    const bad = { ...validV3, source: { ...validV3.source, contentHash: 'abc' } };
    mockReadFile.mockResolvedValue(JSON.stringify(bad));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  // SR3: output.contentHash must also be 64 hex chars
  it('test_readSidecar_when_v3_output_contentHash_with_non_hex_chars_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    const bad = { ...validV3, output: { ...validV3.output, contentHash: 'Z'.repeat(64) } };
    mockReadFile.mockResolvedValue(JSON.stringify(bad));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  // SR4: processedAt must be parseable ISO-8601 UTC
  it('test_readSidecar_when_v3_processedAt_non_iso8601_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    mockReadFile.mockResolvedValue(JSON.stringify({ ...validV3, processedAt: 'yesterday' }));
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  // SR4: processedAt must be UTC (endsWith Z)
  it('test_readSidecar_when_v3_processedAt_non_utc_offset_then_returns_null', async () => {
    mockStat.mockResolvedValue({ size: 400 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...validV3, processedAt: '2026-05-08T10:00:00+02:00' }),
    );
    expect(await readSidecar('/out/Movie.x265.mkv')).toBeNull();
  });

  // V2 + V1 read paths byte-identical (SR9 backward-compat freeze)
  it('test_readSidecar_when_v2_payload_then_v2_read_path_unchanged_post_v3', async () => {
    const v2: SidecarV2 = {
      schema: 'x265-butler/v2',
      processedBy: 'x265-butler',
      version: '1.5.0',
      gitHash: 'def5678',
      processedAt: '2026-04-28T10:00:00.000Z',
      source: { filename: 'B.mkv', contentHash: 'cc33', sizeBytes: 2000 },
      output: { filename: 'B.x265.mkv', contentHash: 'dd44', sizeBytes: 1000 },
      encoder: 'libx265',
      quality: { mode: 'crf', value: 20 },
      outcome: 'done-smaller',
    };
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(JSON.stringify(v2));
    const result = await readSidecar('/out/B.x265.mkv');
    expect(result?.schema).toBe('x265-butler/v2');
    expect((result as SidecarV2).encoder).toBe('libx265');
    expect((result as SidecarV2).outcome).toBe('done-smaller');
  });
});
