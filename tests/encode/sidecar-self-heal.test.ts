/*
 * 04-03: scan-time sidecar self-heal helper. Mirrors 04-01 sidecar.test.ts
 * vi.mock('node:fs') pattern — deterministic + CI-safe.
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

import { selfHealSidecar, type SidecarV1, type SidecarV2 } from '@/src/lib/encode/sidecar';

const validPayload: SidecarV1 = {
  schema: 'x265-butler/v1',
  processedBy: 'x265-butler',
  version: '1.4.0',
  gitHash: 'abc1234',
  processedAt: '2026-04-27T14:30:00.000Z',
  source: { filename: 'Foo.x265.mkv', contentHash: 'ab12cd34', sizeBytes: 1024 },
  output: { filename: 'Foo.x265.mkv', contentHash: 'ab12cd34', sizeBytes: 1024 },
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

describe('selfHealSidecar', () => {
  it('test_selfHealSidecar_when_sidecar_already_present_matching_hash_then_returns_already_present_no_writeSidecar', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(JSON.stringify(validPayload));
    const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(result).toEqual({ healed: false, reason: 'already_present' });
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('test_selfHealSidecar_when_sidecar_missing_ENOENT_then_writeSidecar_called_AND_returns_healed_true', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(enoent);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(result).toEqual({ healed: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockRename).toHaveBeenCalledOnce();
  });

  it('test_selfHealSidecar_when_sidecar_present_with_mismatching_hash_then_writeSidecar_overwrites', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        ...validPayload,
        source: { ...validPayload.source, contentHash: 'oldhash' },
      }),
    );
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(result).toEqual({ healed: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it('test_selfHealSidecar_when_writeSidecar_inner_caught_failure_then_returns_healed_true_AND_pino_info', async () => {
    // writeSidecar internally catches its own errors + warn-logs; never throws.
    // selfHealSidecar therefore returns healed=true regardless of underlying
    // write success (the warn log + DB content_hash authoritative pattern).
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(enoent);
    mockWriteFile.mockRejectedValue(new Error('EROFS'));
    mockUnlink.mockResolvedValue(undefined);
    const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(result).toEqual({ healed: true });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_write_failed' }),
      expect.any(String),
    );
  });

  it('test_selfHealSidecar_when_healed_then_pino_info_sidecar_self_healed_with_filePath_and_sourceContentHash', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(enoent);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sidecar_self_healed',
        filePath: '/out/Foo.x265.mkv',
        sourceContentHash: 'ab12cd34',
      }),
      expect.any(String),
    );
  });

  it('test_selfHealSidecar_when_no_op_already_present_then_NO_pino_info', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(JSON.stringify(validPayload));
    await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_self_healed' }),
      expect.any(String),
    );
  });

  it('test_selfHealSidecar_when_existing_hash_uppercase_then_treated_as_match_already_present', async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        ...validPayload,
        source: { ...validPayload.source, contentHash: 'AB12CD34' },
      }),
    );
    const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
    expect(result).toEqual({ healed: false, reason: 'already_present' });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // 05-08 B4 (AC-7): selfHealSidecar accepts V2 payloads from the post-0012
  // scan-orchestrator path AND degrades to V1 when the DB row lacks crf/encoder.
  describe('05-08 B4: V1 + V2 payload acceptance', () => {
    const v2Payload: SidecarV2 = {
      schema: 'x265-butler/v2',
      processedBy: 'x265-butler',
      version: '1.5.0',
      gitHash: 'def5678',
      processedAt: '2026-04-28T11:00:00.000Z',
      source: { filename: 'B.x265.mkv', contentHash: 'cc33dd44', sizeBytes: 1024 },
      output: { filename: 'B.x265.mkv', contentHash: 'cc33dd44', sizeBytes: 1024 },
      encoder: 'hevc_nvenc',
      quality: { mode: 'cq', value: 22 },
    };

    it('test_selfHealSidecar_when_v2_payload_then_writes_v2_sidecar_with_encoder_and_quality', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockStat.mockRejectedValue(enoent);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
      const result = await selfHealSidecar('/out/B.x265.mkv', v2Payload);
      expect(result).toEqual({ healed: true });
      const written = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.schema).toBe('x265-butler/v2');
      expect(parsed.encoder).toBe('hevc_nvenc');
      expect(parsed.quality).toEqual({ mode: 'cq', value: 22 });
    });

    it('test_selfHealSidecar_when_v1_legacy_payload_then_writes_v1_sidecar_no_encoder_field', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockStat.mockRejectedValue(enoent);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
      const result = await selfHealSidecar('/out/Foo.x265.mkv', validPayload);
      expect(result).toEqual({ healed: true });
      const written = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.schema).toBe('x265-butler/v1');
      expect(parsed.encoder).toBeUndefined();
      expect(parsed.quality).toBeUndefined();
    });
  });
});
