// @vitest-environment node
// 23-05 T1 — cpu-capability classifier + embedded gen-table sentinel coverage.
// AC-1 / AC-3 / AC-4 / AC-9. Deps-injected readFile; NO real /proc read.
//
// Every fixture is a REALISTIC FULL cpuinfo block carrying BOTH `model` and
// `model name` lines so the M1 numeric/display field disambiguation is actually
// exercised — a naive `model\s*:` misparse must make a fixture fail.

import { describe, it, expect, vi } from 'vitest';
import {
  probeCpuCapability,
  getCpuCapability,
  __forTests_resetCpuCapabilityCache,
  INTEL_IGPU_HEVC_QSV_MIN_GEN,
  INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN,
  type CpuCapabilityDeps,
} from '@/src/lib/diagnostics/cpu-capability';

// Build a realistic FULL /proc/cpuinfo processor-0 block. `model` (numeric) and
// `model name` (display) are emitted TOGETHER so the disambiguation is tested.
function cpuinfo(opts: {
  vendorId?: string;
  family?: number | string;
  model?: number | string;
  modelName?: string;
  extraProcessors?: number;
  arm?: boolean;
}): string {
  if (opts.arm) {
    // arm64: no x86 vendor_id / cpu family / model fields at all.
    return [
      'processor\t: 0',
      'BogoMIPS\t: 48.00',
      'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32',
      'CPU implementer\t: 0x41',
      'CPU architecture: 8',
      'CPU variant\t: 0x0',
      'CPU part\t: 0xd08',
      'CPU revision\t: 3',
      '',
    ].join('\n');
  }
  const block = [
    'processor\t: 0',
    `vendor_id\t: ${opts.vendorId ?? 'GenuineIntel'}`,
    `cpu family\t: ${opts.family ?? 6}`,
    `model\t\t: ${opts.model ?? 158}`,
    `model name\t: ${opts.modelName ?? 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz'}`,
    'stepping\t: 10',
    'microcode\t: 0xf0',
    'cpu MHz\t\t: 3200.000',
    'cache size\t: 12288 KB',
    'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr',
    '',
  ].join('\n');
  // Append additional processor blocks (must NOT change processor-0 parse).
  if (opts.extraProcessors && opts.extraProcessors > 0) {
    const extras = Array.from({ length: opts.extraProcessors }, (_unused, i) =>
      [
        `processor\t: ${i + 1}`,
        `vendor_id\t: ${opts.vendorId ?? 'GenuineIntel'}`,
        `cpu family\t: ${opts.family ?? 6}`,
        `model\t\t: ${opts.model ?? 158}`,
        `model name\t: ${opts.modelName ?? 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz'}`,
        '',
      ].join('\n'),
    ).join('\n');
    return block + extras;
  }
  return block;
}

function mkReadFile(content: string | Error): CpuCapabilityDeps['readFile'] {
  return vi.fn(async (path: unknown, enc: unknown) => {
    expect(path).toBe('/proc/cpuinfo');
    expect(enc).toBe('utf8');
    if (content instanceof Error) throw content;
    return content as never;
  }) as CpuCapabilityDeps['readFile'];
}

describe('cpu-capability — constants', () => {
  it('pins the Skylake/Kaby HEVC-QSV gen thresholds', () => {
    expect(INTEL_IGPU_HEVC_QSV_MIN_GEN).toBe(6);
    expect(INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN).toBe(7);
  });
});

describe('cpu-capability — Intel gen-table sentinel (AC-1, AC-9)', () => {
  const cases: Array<{
    name: string;
    model: number;
    expectGen: number | null;
    expectHevc: 'none' | '8bit' | '10bit' | 'unknown';
    minGen?: number;
  }> = [
    { name: 'Haswell', model: 60, expectGen: 5, expectHevc: 'none' },
    { name: 'Broadwell', model: 61, expectGen: 5, expectHevc: 'none' },
    { name: 'Skylake', model: 94, expectGen: 6, expectHevc: '8bit' },
    { name: 'Kaby/Coffee', model: 158, expectGen: 7, expectHevc: '10bit' },
    { name: 'Ice Lake', model: 126, expectGen: 11, expectHevc: '10bit' },
    { name: 'Tiger Lake', model: 140, expectGen: 12, expectHevc: '10bit' },
    { name: 'Rocket Lake', model: 167, expectGen: 12, expectHevc: '10bit' },
    { name: 'Alder Lake', model: 151, expectGen: 12, expectHevc: '10bit' },
    { name: 'Raptor Lake', model: 183, expectGen: 13, expectHevc: '10bit' },
  ];

  for (const c of cases) {
    it(`classifies ${c.name} (model ${c.model}) → gen ${c.expectGen}, hevc ${c.expectHevc}`, async () => {
      const cap = await probeCpuCapability({
        readFile: mkReadFile(cpuinfo({ model: c.model })),
      });
      expect(cap.isIntel).toBe(true);
      expect(cap.family).toBe(6);
      expect(cap.model).toBe(c.model);
      expect(cap.graphicsGen).toBe(c.expectGen);
      expect(cap.hevcQsv).toBe(c.expectHevc);
      // M1: numeric model must NOT have been polluted by the `model name` line.
      expect(cap.modelName).toMatch(/Intel/);
    });
  }

  it('captures modelName verbatim for display without basing gen on it (AC-1)', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(
        cpuinfo({ model: 158, modelName: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz' }),
      ),
    });
    expect(cap.modelName).toBe('Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz');
    expect(cap.graphicsGen).toBe(7);
  });

  it('multi-core cpuinfo parses ONLY processor-0 block (M1 first-block stop)', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(cpuinfo({ model: 94, extraProcessors: 7 })),
    });
    expect(cap.model).toBe(94);
    expect(cap.graphicsGen).toBe(6);
  });

  it('unknown Intel model → graphicsGen null, hevcQsv unknown', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(cpuinfo({ model: 9999 })),
    });
    expect(cap.isIntel).toBe(true);
    expect(cap.graphicsGen).toBeNull();
    expect(cap.hevcQsv).toBe('unknown');
  });

  it('Intel non-family-6 → no gen lookup', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(cpuinfo({ family: 15, model: 94 })),
    });
    expect(cap.isIntel).toBe(true);
    expect(cap.graphicsGen).toBeNull();
    expect(cap.hevcQsv).toBe('unknown');
  });
});

describe('cpu-capability — non-Intel inert (AC-3)', () => {
  it('AMD CPU → isIntel false, gen null, hevc unknown, fields captured', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(
        cpuinfo({
          vendorId: 'AuthenticAMD',
          family: 25,
          model: 33,
          modelName: 'AMD Ryzen 9 5950X 16-Core Processor',
        }),
      ),
    });
    expect(cap.isIntel).toBe(false);
    expect(cap.vendorId).toBe('AuthenticAMD');
    expect(cap.graphicsGen).toBeNull();
    expect(cap.hevcQsv).toBe('unknown');
    expect(cap.microarch).toBeNull();
    expect(cap.modelName).toBe('AMD Ryzen 9 5950X 16-Core Processor');
  });

  it('arm64 cpuinfo (no x86 fields) → null-filled-ish, isIntel false', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(cpuinfo({ arm: true })),
    });
    expect(cap.isIntel).toBe(false);
    expect(cap.vendorId).toBeNull();
    expect(cap.family).toBeNull();
    expect(cap.graphicsGen).toBeNull();
    expect(cap.hevcQsv).toBe('unknown');
  });
});

describe('cpu-capability — fail-safe (AC-4)', () => {
  it('readFile throws → null-filled, never throws', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile(new Error('EACCES /proc/cpuinfo')),
    });
    expect(cap).toEqual({
      isIntel: false,
      vendorId: null,
      modelName: null,
      family: null,
      model: null,
      microarch: null,
      graphicsGen: null,
      hevcQsv: 'unknown',
    });
  });

  it('garbage cpuinfo with no recognizable fields → null-filled', async () => {
    const cap = await probeCpuCapability({
      readFile: mkReadFile('garbage\nno fields here\n'),
    });
    expect(cap.isIntel).toBe(false);
    expect(cap.vendorId).toBeNull();
    expect(cap.graphicsGen).toBeNull();
    expect(cap.hevcQsv).toBe('unknown');
  });
});

describe('cpu-capability — boot-cache concurrency (S1)', () => {
  it('concurrent cold-cache callers trigger exactly ONE readFile', async () => {
    __forTests_resetCpuCapabilityCache();
    const readFile = mkReadFile(cpuinfo({ model: 158 }));
    const [a, b, c] = await Promise.all([
      getCpuCapability({ readFile }),
      getCpuCapability({ readFile }),
      getCpuCapability({ readFile }),
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(a.graphicsGen).toBe(7);
    expect(b).toBe(a); // same cached object
    expect(c).toBe(a);
    __forTests_resetCpuCapabilityCache();
  });

  it('reset clears the cache so a later call re-reads', async () => {
    __forTests_resetCpuCapabilityCache();
    const readFile1 = mkReadFile(cpuinfo({ model: 94 }));
    await getCpuCapability({ readFile: readFile1 });
    expect(readFile1).toHaveBeenCalledTimes(1);
    __forTests_resetCpuCapabilityCache();
    const readFile2 = mkReadFile(cpuinfo({ model: 158 }));
    const cap = await getCpuCapability({ readFile: readFile2 });
    expect(readFile2).toHaveBeenCalledTimes(1);
    expect(cap.graphicsGen).toBe(7);
    __forTests_resetCpuCapabilityCache();
  });
});
