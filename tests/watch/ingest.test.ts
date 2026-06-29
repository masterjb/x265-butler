// 28-05 R4: ffprobe-failure forensic trail in ingestSingleFile.
//
// No dedicated ingest unit-test existed before this plan — ingestSingleFile was
// only exercised indirectly via deps-stubs in watcher.test.ts. This pins the new
// `auto_scan_ingest_ffprobe_failed` warn (behavior-preserving null-degrade) and
// a control case proving the warn is failure-gated, not always-on.
//
// hash + ffprobe + skip + encode/events + node:fs are module-mocked (mirrors the
// vi.hoisted pattern in tests/scan/orchestrator.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHashFile, mockFfprobe, mockRunSkipPipeline, mockStat } = vi.hoisted(() => ({
  mockHashFile: vi.fn<(filePath: string) => Promise<string>>(),
  mockFfprobe: vi.fn(),
  mockRunSkipPipeline: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('@/src/lib/scan/hash', () => ({
  hashFile: mockHashFile,
  default: { hashFile: mockHashFile },
}));

vi.mock('@/src/lib/scan/ffprobe', () => ({
  ffprobe: mockFfprobe,
  default: { ffprobe: mockFfprobe },
}));

vi.mock('@/src/lib/skip', () => ({
  runSkipPipeline: mockRunSkipPipeline,
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: vi.fn() },
}));

vi.mock('node:fs', () => ({
  default: { promises: { stat: mockStat } },
  promises: { stat: mockStat },
}));

import { ingestSingleFile, type IngestDeps } from '@/src/lib/watch/ingest';

function makeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

// Deterministic repo stubs (SR2): the ffprobe-null path STILL reaches the
// enqueue gate (a newly-upserted row defaults to status:'pending'), so the
// return value depends on what `enqueue` returns — pin it, don't assume.
function makeDeps(opts: {
  log: ReturnType<typeof makeLog>;
  upsertRow?: { id: number; status: string; version: number };
  enqueueResult?: { id: number } | null;
  upsertSpy?: ReturnType<typeof vi.fn>;
  settings?: Record<string, string>;
}): IngestDeps {
  const row = opts.upsertRow ?? { id: 7, status: 'pending', version: 1 };
  const upsertByPath = opts.upsertSpy ?? vi.fn(() => row);
  const settings = opts.settings ?? {};
  return {
    fileRepo: () =>
      ({
        upsertByPath,
        setStatus: vi.fn(),
      }) as never,
    jobRepo: () =>
      ({
        enqueue: vi.fn(() => opts.enqueueResult ?? null),
        listActive: () => [],
        countByStatus: () => 0,
      }) as never,
    blocklistRepo: () => ({}) as never,
    // 33-01: settingRepo stub — get(key) reads the opts.settings map (absent → undefined).
    settingRepo: () => ({ get: (key: string) => settings[key] }) as never,
    log: opts.log as never,
    encoderResolver: () => 'libx265',
  };
}

function fileStat() {
  return { isFile: () => true, size: 1234, mtimeMs: 1_000_000 };
}

beforeEach(() => {
  mockHashFile.mockReset();
  mockFfprobe.mockReset();
  mockRunSkipPipeline.mockReset();
  mockStat.mockReset();
});

describe('28-05 R4: ingestSingleFile ffprobe-failure forensic warn', () => {
  it('AC-3: ffprobe rejects → warn auto_scan_ingest_ffprobe_failed, row still upserted (null metadata), skip-pipeline skipped, no throw', async () => {
    mockStat.mockResolvedValue(fileStat());
    mockHashFile.mockResolvedValue('deadbeef');
    mockFfprobe.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const log = makeLog();
    const upsertSpy = vi.fn(() => ({ id: 42, status: 'pending', version: 1 }));
    // enqueue pinned to null → deterministic return {enqueued:false,...,fileId:42}
    const deps = makeDeps({ log, enqueueResult: null, upsertSpy });

    const result = await ingestSingleFile('/mnt/media/x.mkv', 1, deps);

    // forensic warn fired with absPath + err
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auto_scan_ingest_ffprobe_failed',
        absPath: '/mnt/media/x.mkv',
        err: 'ENOENT',
      }),
      expect.any(String),
    );
    // row upserted once with null probe metadata (behavior preserved)
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codec: null, bitrate: null, duration_seconds: null }),
    );
    // probe-null → skip-pipeline branch skipped
    expect(mockRunSkipPipeline).not.toHaveBeenCalled();
    // return asserted AGAINST the pinned enqueue:null stub (NOT hard-coded)
    expect(result).toEqual({ enqueued: false, skipped: false, fileId: 42 });
  });

  it('control: ffprobe resolves → NO auto_scan_ingest_ffprobe_failed warn (failure-gated)', async () => {
    mockStat.mockResolvedValue(fileStat());
    mockHashFile.mockResolvedValue('deadbeef');
    mockFfprobe.mockResolvedValue({
      codec: 'h264',
      bitrate: 5000,
      durationSeconds: 60,
      width: 1920,
      height: 1080,
      container: 'matroska',
    });
    mockRunSkipPipeline.mockResolvedValue({ skip: false });

    const log = makeLog();
    const deps = makeDeps({ log, enqueueResult: { id: 99 } });

    const result = await ingestSingleFile('/mnt/media/ok.mkv', 1, deps);

    const ffprobeWarns = log.warn.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'auto_scan_ingest_ffprobe_failed',
    );
    expect(ffprobeWarns).toHaveLength(0);
    // probe present → skip-pipeline DID run
    expect(mockRunSkipPipeline).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ enqueued: true, skipped: false, fileId: 7, jobId: 99 });
  });
});

describe('33-01: ingestSingleFile threads sidecar_mode into the skip-pipeline (AC-6 watch side)', () => {
  function probeOk() {
    return {
      codec: 'h264',
      bitrate: 5000,
      durationSeconds: 60,
      width: 1920,
      height: 1080,
      container: 'matroska',
    };
  }

  it('sidecar_mode=central → runSkipPipeline receives sidecarMode=central + resolved central path', async () => {
    mockStat.mockResolvedValue(fileStat());
    mockHashFile.mockResolvedValue('deadbeef');
    mockFfprobe.mockResolvedValue(probeOk());
    mockRunSkipPipeline.mockResolvedValue({ skip: false });

    const log = makeLog();
    const deps = makeDeps({
      log,
      enqueueResult: { id: 1 },
      settings: { sidecar_mode: 'central', sidecar_central_path: '/custom/central/' },
    });

    await ingestSingleFile('/mnt/media/x.mkv', 1, deps);

    expect(mockRunSkipPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/mnt/media/x.mkv', diskContentHash: 'deadbeef' }),
      expect.objectContaining({ sidecarMode: 'central', sidecarCentralPath: '/custom/central/' }),
    );
  });

  it('sidecar_mode=central with NO sidecar_central_path → defaults to /config/x265-butler/sidecars/ (AC-7)', async () => {
    mockStat.mockResolvedValue(fileStat());
    mockHashFile.mockResolvedValue('deadbeef');
    mockFfprobe.mockResolvedValue(probeOk());
    mockRunSkipPipeline.mockResolvedValue({ skip: false });

    const log = makeLog();
    const deps = makeDeps({ log, enqueueResult: { id: 1 }, settings: { sidecar_mode: 'central' } });

    await ingestSingleFile('/mnt/media/x.mkv', 1, deps);

    expect(mockRunSkipPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sidecarMode: 'central',
        sidecarCentralPath: '/config/x265-butler/sidecars/',
      }),
    );
  });

  it('no sidecar settings → beside (byte-identical to pre-33-01, AC-4)', async () => {
    mockStat.mockResolvedValue(fileStat());
    mockHashFile.mockResolvedValue('deadbeef');
    mockFfprobe.mockResolvedValue(probeOk());
    mockRunSkipPipeline.mockResolvedValue({ skip: false });

    const log = makeLog();
    const deps = makeDeps({ log, enqueueResult: { id: 1 } });

    await ingestSingleFile('/mnt/media/x.mkv', 1, deps);

    expect(mockRunSkipPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sidecarMode: 'beside' }),
    );
  });
});
