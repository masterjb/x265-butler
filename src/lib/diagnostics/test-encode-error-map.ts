// Phase 23 Plan 23-01 — pure stderr→diagnosis dictionary for failed test-encodes.
//
// Maps cryptic ffmpeg HW-init stderr (e.g. `Error creating a MFX session: -9`)
// to a closed-set { code, severity } the UI renders as a human "Likely cause"
// callout and the route emits as the server-side `testEncodeErrorMapped` event.
//
// Pure: no I/O, no process state, never throws. Keyed to ffmpeg-7.x stderr —
// older/divergent formats fall through to genericHwInitFailed (HW) or null.
//
// VOCAB NOTE (23-01 audit-M1): the 3rd arg is body.encoderPicked, which is the
// ffmpeg CODEC string ('hevc_qsv' | 'hevc_nvenc' | 'hevc_vaapi' | 'libx265'),
// NOT an EncoderId. The software codec string IS 'libx265' (codec ≡ EncoderId
// only for software). Vendor is derived from the codec prefix.

import type { MappedTestEncodeError } from './types';

type Vendor = 'qsv' | 'nvenc' | 'vaapi' | 'software';

interface PatternEntry {
  code: string;
  severity: 'error' | 'warning';
  // null = applies to any HW vendor; otherwise gated to the listed vendors so a
  // wrong-vendor token never mislabels (audit-SR2).
  vendors: readonly Vendor[] | null;
  // receives the lowercased, trimmed stderr.
  test: (lc: string) => boolean;
}

export function vendorFromCodec(encoderPicked: string): Vendor {
  if (encoderPicked === 'hevc_qsv') return 'qsv';
  if (encoderPicked === 'hevc_nvenc') return 'nvenc';
  if (encoderPicked === 'hevc_vaapi') return 'vaapi';
  return 'software'; // libx265 (or anything non-HW)
}

// Ordered most-specific → least-specific. The generic HW catch-all is NOT in
// this table — it is applied in mapTestEncodeError() only after every specific
// pattern misses (and never for a timeout/software encoder).
export const TEST_ENCODE_ERROR_PATTERNS: readonly PatternEntry[] = [
  {
    code: 'qsvMfxSessionUnsupported',
    severity: 'warning',
    vendors: ['qsv'],
    test: (lc) => lc.includes('mfx session: -9'),
  },
  {
    code: 'qsvMfxGenUnsupported',
    severity: 'warning',
    vendors: ['qsv'],
    test: (lc) => lc.includes('mfx session: -3'),
  },
  {
    code: 'qsvRuntimeMissing',
    severity: 'error',
    vendors: ['qsv'],
    test: (lc) =>
      lc.includes('cannot load libmfx') ||
      lc.includes('cannot load libvpl') ||
      lc.includes('mfx implementation'),
  },
  {
    code: 'qsvMfxSessionGeneric',
    severity: 'error',
    vendors: ['qsv'],
    test: (lc) =>
      lc.includes('initializing an internal mfx session') || /mfx session:\s*-\d+/.test(lc),
  },
  {
    code: 'qsvDeviceCreationFailed',
    severity: 'error',
    vendors: ['qsv'],
    test: (lc) => lc.includes('device creation failed'),
  },
  {
    code: 'nvencLibMissing',
    severity: 'error',
    vendors: ['nvenc'],
    test: (lc) => lc.includes('cannot load libnvidia-encode') || lc.includes('cannot load nvcuda'),
  },
  {
    code: 'nvencNoCapableDevice',
    severity: 'error',
    vendors: ['nvenc'],
    test: (lc) =>
      lc.includes('no capable devices') ||
      lc.includes('no nvenc capable') ||
      lc.includes('no cuda-capable device'),
  },
  {
    code: 'nvencSessionFailed',
    severity: 'error',
    vendors: ['nvenc'],
    test: (lc) =>
      lc.includes('openencodesessionex failed') || lc.includes('cannot open encode session'),
  },
  {
    code: 'nvencDriverMismatch',
    severity: 'warning',
    vendors: ['nvenc'],
    test: (lc) =>
      lc.includes('driver does not support') || lc.includes('minimum required nvidia driver'),
  },
  {
    code: 'vaapiNoDisplay',
    severity: 'error',
    vendors: ['vaapi'],
    test: (lc) =>
      lc.includes('failed to initialise vaapi') ||
      lc.includes('failed to initialize vaapi') ||
      lc.includes('no va display'),
  },
  {
    code: 'vaapiDeviceMissing',
    severity: 'error',
    vendors: ['vaapi', 'qsv'],
    test: (lc) =>
      lc.includes('/dev/dri') && (lc.includes('no such file') || lc.includes('cannot open')),
  },
  {
    code: 'permRenderNodeEacces',
    severity: 'warning',
    vendors: ['qsv', 'vaapi'],
    test: (lc) =>
      lc.includes('permission denied') &&
      (lc.includes('/dev/dri') || lc.includes('renderd128') || lc.includes('render node')),
  },
  {
    code: 'qsvOptionRejected',
    severity: 'warning',
    vendors: ['qsv'],
    // libvpl/oneVPL hevc_qsv rejects a legacy/incompatible AVOption (e.g. the
    // MSDK-only look_ahead family removed in 25-02). ffmpeg surfaces this as an
    // AVOption set-failure and/or a trailing "(Invalid argument)". An option
    // problem — NOT a hardware fault — so severity is warning. Catch-net AFTER
    // every specific qsv pattern, before the generic HW fallback.
    // audit-M1: the two precise AVOption-setter phrases fire unconditionally —
    // ffmpeg ALWAYS prints one for a real option rejection. The bare errno
    // "(invalid argument)" (EINVAL) is too broad alone: it ALSO trails genuine
    // device/hwaccel-init faults, so on its own it would mislabel a real HW
    // fault as a recoverable option-warning AND downgrade severity error→warning
    // (AC-6). It therefore counts ONLY when an "option" context word co-occurs.
    test: (lc) =>
      lc.includes('error setting option') ||
      lc.includes('unrecognized option') ||
      (lc.includes('(invalid argument)') && lc.includes('option')),
  },
];

/**
 * Map a failed/killed test-encode's stderr to a diagnosis, or null.
 *
 * @param stderr        ffmpeg stderr (already 4 KB FIFO-tail-capped upstream).
 * @param exitCode      process exit code; null = killed at timeout (hang).
 * @param encoderPicked ffmpeg CODEC string (see VOCAB NOTE above).
 */
export function mapTestEncodeError(
  stderr: string,
  exitCode: number | null,
  encoderPicked: string,
): MappedTestEncodeError | null {
  if (exitCode === 0) return null;
  const lc = (stderr ?? '').trim().toLowerCase();
  if (!lc) return null;

  const vendor = vendorFromCodec(encoderPicked);

  for (const p of TEST_ENCODE_ERROR_PATTERNS) {
    if (p.vendors !== null && !p.vendors.includes(vendor)) continue; // vendor-gate (SR2)
    if (p.test(lc)) return { code: p.code, severity: p.severity };
  }

  // No specific pattern matched.
  if (exitCode === null) return null; // timeout/hang → never generic (SR1)
  if (vendor === 'software') return null; // software no-match → no misleading HW hint
  return { code: 'genericHwInitFailed', severity: 'error' };
}
