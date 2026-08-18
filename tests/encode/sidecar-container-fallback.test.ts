// 10-03 E-D5: ContainerFallbackRecord — writeSidecar+readSidecar round-trip
// and malformed-rejection tests. Mirrors sidecar.test.ts vi.mock pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWriteFile, mockRename, mockStat, mockReadFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
  mockRename: vi.fn(),
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs', () => {
  const promises = {
    writeFile: mockWriteFile,
    rename: mockRename,
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: mockStat,
    readFile: mockReadFile,
    readdir: vi.fn().mockResolvedValue([]),
  };
  return { promises, default: { promises } };
});

vi.mock('@/src/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  writeSidecar,
  readSidecar,
  type SidecarV3,
  type ContainerFallbackRecord,
} from '@/src/lib/encode/sidecar';

const baseV3: SidecarV3 = {
  schema: 'x265-butler/v3',
  processedBy: 'x265-butler',
  version: '2.4.2',
  gitHash: 'abc1234',
  processedAt: '2026-05-11T10:00:00.000Z',
  durationSec: 30,
  source: {
    filename: 'A.mkv',
    contentHash: 'a'.repeat(64),
    sizeBytes: 1_000_000,
    codec: 'h264',
    width: 1920,
    height: 1080,
    durationSec: 30,
  },
  output: { filename: 'A.x265.mkv', contentHash: 'b'.repeat(64), sizeBytes: 600_000 },
  savings: { bytes: 400_000, ratio: 0.4, thresholdUsed: 5 },
  encoder: { name: 'libx265', preset: 'medium', ffmpegVersion: '7.1' },
  quality: { mode: 'crf', value: 28 },
  outcome: 'done-smaller',
};

const fallbackRecord: ContainerFallbackRecord = {
  reason: 'audio',
  from: 'mp4',
  to: 'mkv',
};

beforeEach(() => {
  mockWriteFile.mockReset().mockResolvedValue(undefined);
  mockRename.mockReset().mockResolvedValue(undefined);
  mockStat.mockReset();
  mockReadFile.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SidecarV3 containerFallback round-trip (10-03 E-D5)', () => {
  it('test_writeSidecar_when_v3_with_containerFallback_then_JSON_contains_containerFallback', async () => {
    const payload: SidecarV3 = { ...baseV3, containerFallback: fallbackRecord };
    await writeSidecar('/out/A.x265.mkv', payload);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as { containerFallback?: unknown };
    expect(parsed.containerFallback).toEqual({ reason: 'audio', from: 'mp4', to: 'mkv' });
  });

  it('test_readSidecar_when_v3_with_containerFallback_audio_then_returns_payload_with_field', async () => {
    const payload: SidecarV3 = {
      ...baseV3,
      containerFallback: { reason: 'audio', from: 'mp4', to: 'mkv' },
    };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(payload));
    const result = (await readSidecar('/out/A.x265.mkv')) as SidecarV3;
    expect(result).not.toBeNull();
    expect(result.containerFallback).toEqual({ reason: 'audio', from: 'mp4', to: 'mkv' });
  });

  it('test_readSidecar_when_v3_with_containerFallback_subtitle_then_returns_payload_with_field', async () => {
    const payload: SidecarV3 = {
      ...baseV3,
      containerFallback: { reason: 'subtitle', from: 'mp4', to: 'mkv' },
    };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(payload));
    const result = (await readSidecar('/out/A.x265.mkv')) as SidecarV3;
    expect(result?.containerFallback?.reason).toBe('subtitle');
  });

  it('test_readSidecar_when_v3_with_containerFallback_preflight_unavailable_then_returns_payload_with_field', async () => {
    const payload: SidecarV3 = {
      ...baseV3,
      containerFallback: { reason: 'preflight_unavailable', from: 'mp4', to: 'mkv' },
    };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(payload));
    const result = (await readSidecar('/out/A.x265.mkv')) as SidecarV3;
    expect(result?.containerFallback?.reason).toBe('preflight_unavailable');
  });

  it('test_readSidecar_when_v3_without_containerFallback_then_field_absent', async () => {
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(baseV3));
    const result = (await readSidecar('/out/A.x265.mkv')) as SidecarV3;
    expect(result).not.toBeNull();
    expect(result.containerFallback).toBeUndefined();
  });

  it('test_readSidecar_when_v3_containerFallback_reason_unknown_then_returns_null', async () => {
    const malformed = { ...baseV3, containerFallback: { reason: 'bogus', from: 'mp4', to: 'mkv' } };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_containerFallback_from_not_mp4_then_returns_null', async () => {
    const malformed = { ...baseV3, containerFallback: { reason: 'audio', from: 'mkv', to: 'mkv' } };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_containerFallback_to_not_mkv_then_returns_null', async () => {
    const malformed = { ...baseV3, containerFallback: { reason: 'audio', from: 'mp4', to: 'mp4' } };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });

  it('test_readSidecar_when_v3_containerFallback_is_null_then_returns_null', async () => {
    const malformed = { ...baseV3, containerFallback: null };
    mockStat.mockResolvedValue({ size: 500 });
    mockReadFile.mockResolvedValue(JSON.stringify(malformed));
    expect(await readSidecar('/out/A.x265.mkv')).toBeNull();
  });
});
