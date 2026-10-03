// @vitest-environment node
// 46-02 T1 — nvidia-gpu probe: classifier + boot-cache + resolved-once log.
// AC-1 / AC-2 / AC-3 / AC-6 / AC-7 + MH-1 sentinel. Deps-injected execFile +
// logger; NO real nvidia-smi spawn (no local NVIDIA HW — classifier proven via
// fake-execFile stdout fixtures).

import { describe, it, expect, vi } from 'vitest';
import {
  probeNvidiaGpu,
  getNvidiaGpu,
  clearNvidiaGpuCache,
  __forTests_resetNvidiaGpuCache,
  NVIDIA_SMI_PROBE_TIMEOUT_MS,
  type NvidiaGpuDeps,
} from '@/src/lib/diagnostics/nvidia-gpu';

// A fake execFile that returns fixed stdout or throws a shaped error.
function okExec(stdout: string): NvidiaGpuDeps['execFile'] {
  return vi.fn(async () => ({ stdout, stderr: '' }));
}
function failExec(err: NodeJS.ErrnoException): NvidiaGpuDeps['execFile'] {
  return vi.fn(async () => {
    throw err;
  });
}
function fakeLogger() {
  return { info: vi.fn() };
}

describe('probeNvidiaGpu — parse (AC-1, SR-3)', () => {
  it('parses a two-GPU list, per-line comma split + trim', async () => {
    const logger = fakeLogger();
    const block = await probeNvidiaGpu({
      execFile: okExec('Tesla P4, 580.159.04\nNVIDIA GeForce GT 730, 470.256.02'),
      logger,
    });
    expect(block).toEqual({
      source: 'present',
      gpus: [
        { name: 'Tesla P4', driverVersion: '580.159.04' },
        { name: 'NVIDIA GeForce GT 730', driverVersion: '470.256.02' },
      ],
    });
  });

  it('skips a malformed line missing the driver field (not fatal)', async () => {
    const block = await probeNvidiaGpu({
      execFile: okExec('Tesla P4, 580.159.04\nBrokenLineNoComma\n'),
      logger: fakeLogger(),
    });
    expect(block.source).toBe('present');
    expect(block.gpus).toEqual([{ name: 'Tesla P4', driverVersion: '580.159.04' }]);
  });

  it('normalizes a CRLF line ending — no stray \\r in driverVersion (SR-3)', async () => {
    const block = await probeNvidiaGpu({
      execFile: okExec('Tesla P4, 580.159.04\r\nNVIDIA GeForce GT 730, 470.256.02\r\n'),
      logger: fakeLogger(),
    });
    expect(block.gpus).toEqual([
      { name: 'Tesla P4', driverVersion: '580.159.04' },
      { name: 'NVIDIA GeForce GT 730', driverVersion: '470.256.02' },
    ]);
  });
});

describe('probeNvidiaGpu — reject classification (AC-2, AC-3)', () => {
  it('ENOENT → binary_missing, never throws (AC-2)', async () => {
    const err: NodeJS.ErrnoException = new Error('spawn nvidia-smi ENOENT');
    err.code = 'ENOENT';
    const block = await probeNvidiaGpu({ execFile: failExec(err), logger: fakeLogger() });
    expect(block).toEqual({ source: 'binary_missing', gpus: [] });
  });

  it('exit 0 with empty stdout → no_gpu (AC-3a)', async () => {
    const block = await probeNvidiaGpu({ execFile: okExec('   \n\n'), logger: fakeLogger() });
    expect(block).toEqual({ source: 'no_gpu', gpus: [] });
  });

  it('killed by timeout → timeout (AC-3b)', async () => {
    const err: NodeJS.ErrnoException & { killed?: boolean; signal?: string } = Object.assign(
      new Error('Command failed: nvidia-smi'),
      { killed: true, signal: 'SIGTERM' },
    );
    const block = await probeNvidiaGpu({ execFile: failExec(err), logger: fakeLogger() });
    expect(block).toEqual({ source: 'timeout', gpus: [] });
  });

  it('exit nonzero → error (AC-3c)', async () => {
    const err: NodeJS.ErrnoException & { code?: string } = Object.assign(
      new Error('Command failed: nvidia-smi (exit 9)'),
      { code: '9' },
    );
    const block = await probeNvidiaGpu({ execFile: failExec(err), logger: fakeLogger() });
    expect(block).toEqual({ source: 'error', gpus: [] });
  });
});

describe('probeNvidiaGpu — resolved-once log (AC-7)', () => {
  it('emits exactly ONE name-free nvidia_gpu_probe_resolved per fresh probe', async () => {
    const logger = fakeLogger();
    await probeNvidiaGpu({
      execFile: okExec('Tesla P4, 580.159.04'),
      logger,
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.info.mock.calls[0];
    expect(msg).toBe('nvidia_gpu_probe_resolved');
    expect(payload).toEqual({ source: 'present', gpuCount: 1 });
    // NO GPU name in the log payload — name stays on the diagnostics surface.
    expect(JSON.stringify(payload)).not.toContain('Tesla P4');
  });
});

describe('getNvidiaGpu — boot-cache (AC-6)', () => {
  it('concurrent cold-cache callers spawn nvidia-smi exactly ONCE', async () => {
    __forTests_resetNvidiaGpuCache();
    const execFile = okExec('Tesla P4, 580.159.04');
    const logger = fakeLogger();
    const [a, b, c] = await Promise.all([
      getNvidiaGpu({ execFile, logger }),
      getNvidiaGpu({ execFile, logger }),
      getNvidiaGpu({ execFile, logger }),
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // one FRESH probe → one log line; the two cache-joiners stay silent.
    expect(logger.info).toHaveBeenCalledTimes(1);
    __forTests_resetNvidiaGpuCache();
  });

  it('a cached read emits NO further log line (one line per boot)', async () => {
    __forTests_resetNvidiaGpuCache();
    const execFile = okExec('Tesla P4, 580.159.04');
    const logger = fakeLogger();
    await getNvidiaGpu({ execFile, logger });
    await getNvidiaGpu({ execFile, logger });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    __forTests_resetNvidiaGpuCache();
  });

  it('clearNvidiaGpuCache re-probes fresh on the next call', async () => {
    __forTests_resetNvidiaGpuCache();
    const execFile = okExec('Tesla P4, 580.159.04');
    await getNvidiaGpu({ execFile, logger: fakeLogger() });
    clearNvidiaGpuCache();
    await getNvidiaGpu({ execFile, logger: fakeLogger() });
    expect(execFile).toHaveBeenCalledTimes(2);
    __forTests_resetNvidiaGpuCache();
  });
});

describe('MH-1 — probe timeout survives NVML cold-init', () => {
  it('PROBE_TIMEOUT_MS === 3000', () => {
    expect(NVIDIA_SMI_PROBE_TIMEOUT_MS).toBe(3000);
  });
});
