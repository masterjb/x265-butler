// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  mapTestEncodeError,
  vendorFromCodec,
  TEST_ENCODE_ERROR_PATTERNS,
} from '@/src/lib/diagnostics/test-encode-error-map';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

// Codec strings produced by mapEncoderIdToFfmpegCodec() — the value the
// dictionary actually receives (audit-M1 vocab note).
const QSV = 'hevc_qsv';
const NVENC = 'hevc_nvenc';
const VAAPI = 'hevc_vaapi';
const SW = 'libx265';

describe('mapTestEncodeError — per-code coverage (≥13 incl. generic)', () => {
  // [code, stderr, codec, severity]
  const cases: Array<[string, string, string, 'error' | 'warning']> = [
    [
      'qsvMfxSessionUnsupported',
      '[hevc_qsv @ 0x55] Error creating a MFX session: -9',
      QSV,
      'warning',
    ],
    ['qsvMfxGenUnsupported', 'Error creating a MFX session: -3', QSV, 'warning'],
    ['qsvRuntimeMissing', 'Cannot load libmfx-gen.so.1.2', QSV, 'error'],
    ['qsvMfxSessionGeneric', 'Error initializing an internal MFX session', QSV, 'error'],
    ['qsvDeviceCreationFailed', 'Device creation failed: -1', QSV, 'error'],
    ['nvencLibMissing', 'Cannot load libnvidia-encode.so.1', NVENC, 'error'],
    ['nvencNoCapableDevice', 'No capable devices found', NVENC, 'error'],
    ['nvencSessionFailed', 'OpenEncodeSessionEx failed: out of memory (10)', NVENC, 'error'],
    [
      'nvencDriverMismatch',
      'This NVENC build requires the minimum required Nvidia driver',
      NVENC,
      'warning',
    ],
    [
      'vaapiNoDisplay',
      'Failed to initialise VAAPI connection: -1 (unknown libva error)',
      VAAPI,
      'error',
    ],
    [
      'vaapiDeviceMissing',
      'Cannot open the drm device /dev/dri/renderD128: No such file or directory',
      VAAPI,
      'error',
    ],
    [
      'permRenderNodeEacces',
      'Failed to open /dev/dri/renderD128: Permission denied',
      QSV,
      'warning',
    ],
    [
      'qsvOptionRejected',
      '[hevc_qsv @ 0x55] Error setting option look_ahead to value 1. (Invalid argument)',
      QSV,
      'warning',
    ],
  ];

  for (const [code, stderr, codec, severity] of cases) {
    it(`maps "${code}"`, () => {
      const r = mapTestEncodeError(stderr, 1, codec);
      expect(r).toEqual({ code, severity });
    });
  }

  it('maps the real captured -9 fixture to qsvMfxSessionUnsupported/warning', () => {
    const stderr = '[hevc_qsv @ 0x556] Error creating a MFX session: -9.';
    expect(mapTestEncodeError(stderr, 1, QSV)).toEqual({
      code: 'qsvMfxSessionUnsupported',
      severity: 'warning',
    });
  });

  it('HW codec + non-zero exit + no specific match → genericHwInitFailed/error', () => {
    expect(mapTestEncodeError('some unrecognised ffmpeg failure', 1, QSV)).toEqual({
      code: 'genericHwInitFailed',
      severity: 'error',
    });
  });
});

describe('mapTestEncodeError — null / edge semantics', () => {
  it('returns null on success (exitCode 0)', () => {
    expect(mapTestEncodeError('Error creating a MFX session: -9', 0, QSV)).toBeNull();
  });

  it('returns null on empty / whitespace stderr', () => {
    expect(mapTestEncodeError('', 1, QSV)).toBeNull();
    expect(mapTestEncodeError('   \n  ', 1, QSV)).toBeNull();
  });

  it('software fallback (libx265) with no match → null (no misleading HW hint)', () => {
    expect(mapTestEncodeError('x265 [error]: some software failure', 1, SW)).toBeNull();
  });

  it('SR2 vendor-gate: nvenc token while active codec is hevc_qsv → NOT an nvenc code', () => {
    // an nvenc-specific token must not fire for a qsv run; falls through to qsv-generic
    const r = mapTestEncodeError('Cannot load libnvidia-encode.so.1', 1, QSV);
    expect(r).toEqual({ code: 'genericHwInitFailed', severity: 'error' });
    expect(r?.code).not.toMatch(/^nvenc/);
  });

  it('SR1 timeout: exitCode null + vendor-specific token → that code', () => {
    expect(mapTestEncodeError('Error creating a MFX session: -9', null, QSV)).toEqual({
      code: 'qsvMfxSessionUnsupported',
      severity: 'warning',
    });
  });

  it('SR1 timeout: exitCode null + no specific token → null (NEVER genericHwInitFailed)', () => {
    expect(mapTestEncodeError('ffmpeg hung with no useful output', null, QSV)).toBeNull();
  });

  it('first-match-wins: -9 resolves before the generic mfx-session pattern', () => {
    // "-9" matches both entry 1 (specific) and entry 4 (generic /mfx session: -\d+/);
    // table order guarantees the specific code wins.
    expect(mapTestEncodeError('Error creating a MFX session: -9', 1, QSV)?.code).toBe(
      'qsvMfxSessionUnsupported',
    );
  });
});

describe('qsvOptionRejected — libvpl/oneVPL AVOption rejection class (25-03)', () => {
  it('maps the libvpl AVOption rejection class to qsvOptionRejected/warning', () => {
    // bare AVOption-setter phrase (no errno) — ffmpeg always prints this for a real reject
    expect(mapTestEncodeError('Error setting option look_ahead to value 1.', 1, QSV)).toEqual({
      code: 'qsvOptionRejected',
      severity: 'warning',
    });
    // setter phrase + trailing errno
    expect(
      mapTestEncodeError(
        '[hevc_qsv @ 0x556] Error setting option foo to value 1. (Invalid argument)',
        1,
        QSV,
      ),
    ).toEqual({ code: 'qsvOptionRejected', severity: 'warning' });
    // unrecognized-option phrase
    expect(mapTestEncodeError("Unrecognized option 'foo'.", 1, QSV)).toEqual({
      code: 'qsvOptionRejected',
      severity: 'warning',
    });
  });

  it('AC-2 precedence: MFX-session token + "(Invalid argument)" → qsvMfxSessionUnsupported, NOT qsvOptionRejected', () => {
    expect(
      mapTestEncodeError('Error creating a MFX session: -9 (Invalid argument)', 1, QSV),
    ).toEqual({ code: 'qsvMfxSessionUnsupported', severity: 'warning' });
  });

  it('AC-3 vendor-gate: option-reject errno under software → null; under nvenc → genericHwInitFailed', () => {
    // software (libx265): qsv-gated pattern skipped, no misleading HW hint
    expect(mapTestEncodeError('[libx265] some failure (invalid argument)', 1, SW)).toBeNull();
    // nvenc: qsv-gated pattern skipped → generic HW fallback, NOT qsvOptionRejected
    expect(
      mapTestEncodeError('[hevc_nvenc @ 0x55] init failed (invalid argument)', 1, NVENC),
    ).toEqual({ code: 'genericHwInitFailed', severity: 'error' });
  });

  it('AC-4 fallthrough: qsv failure with neither a specific token NOR an option-reject token → genericHwInitFailed', () => {
    expect(mapTestEncodeError('some unrecognised ffmpeg failure', 1, QSV)).toEqual({
      code: 'genericHwInitFailed',
      severity: 'error',
    });
  });

  it('AC-6 (audit-M1): bare "(Invalid argument)" w/o option-context under qsv → genericHwInitFailed/error, NOT a downgraded option-warning', () => {
    expect(
      mapTestEncodeError('[hevc_qsv @ 0x55] hwaccel init failed (Invalid argument)', 1, QSV),
    ).toEqual({ code: 'genericHwInitFailed', severity: 'error' });
  });

  it('audit-S1 structural invariant: qsvOptionRejected is indexed after every qsv-specific pattern (catch-net stays last)', () => {
    const idx = (code: string) => TEST_ENCODE_ERROR_PATTERNS.findIndex((p) => p.code === code);
    const catchNet = idx('qsvOptionRejected');
    expect(catchNet).toBeGreaterThanOrEqual(0);
    for (const specific of [
      'qsvMfxSessionUnsupported',
      'qsvMfxGenUnsupported',
      'qsvRuntimeMissing',
      'qsvMfxSessionGeneric',
      'qsvDeviceCreationFailed',
    ]) {
      expect(catchNet).toBeGreaterThan(idx(specific));
    }
    // ideally the LAST entry
    expect(catchNet).toBe(TEST_ENCODE_ERROR_PATTERNS.length - 1);
  });
});

describe('vendorFromCodec', () => {
  it('derives vendor from the ffmpeg codec string', () => {
    expect(vendorFromCodec('hevc_qsv')).toBe('qsv');
    expect(vendorFromCodec('hevc_nvenc')).toBe('nvenc');
    expect(vendorFromCodec('hevc_vaapi')).toBe('vaapi');
    expect(vendorFromCodec('libx265')).toBe('software');
  });
});

describe('dictionary integrity + i18n coverage (audit-M2)', () => {
  type HintMessages = { diagnostics: { testEncode: { hint: Record<string, string> } } };
  const enHints = (en as HintMessages).diagnostics.testEncode.hint;
  const deHints = (de as HintMessages).diagnostics.testEncode.hint;
  // every code the mapper can EVER return = table codes + the generic catch-all.
  const allCodes = [...TEST_ENCODE_ERROR_PATTERNS.map((p) => p.code), 'genericHwInitFailed'];

  it('every table code is unique', () => {
    const codes = TEST_ENCODE_ERROR_PATTERNS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('covers at least 13 distinct returnable codes', () => {
    expect(new Set(allCodes).size).toBeGreaterThanOrEqual(13);
  });

  it('every returnable code has an EN + DE hint key', () => {
    for (const code of allCodes) {
      expect(enHints[code], `missing en hint for ${code}`).toBeTypeOf('string');
      expect(deHints[code], `missing de hint for ${code}`).toBeTypeOf('string');
    }
  });

  it('no orphan hint key without a corresponding dictionary code', () => {
    const codeSet = new Set(allCodes);
    for (const key of Object.keys(enHints)) {
      expect(codeSet.has(key), `orphan en hint key: ${key}`).toBe(true);
    }
    for (const key of Object.keys(deHints)) {
      expect(codeSet.has(key), `orphan de hint key: ${key}`).toBe(true);
    }
  });
});
