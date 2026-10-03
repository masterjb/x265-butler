// 50-02 Task 2 — the MKV cover branch of buildArgs, asserted as ARGV TOKENS.
//
// WHY THIS FILE RUNS IN CI AND THE REAL-FFMPEG PROOF DOES NOT (AC-27):
// the pipeline's `test` job runs on `node:22-trixie-slim` and has NO ffmpeg, so
// the whole `describe.skipIf(!ffmpegAvailable)` block in real-ffmpeg-smoke never
// executes there. The single most dangerous thing in this plan — the
// `-metadata:s:t:<n>` INDEX ARITHMETIC — is also the one thing that is fully
// checkable without ffmpeg, because it is pure string building. So it is frozen
// here as a K×C matrix that spawns NOTHING: a mistake in `base = K`, or in the
// ORDER of the `-attach` blocks, fails in the pipeline instead of only on a
// developer machine that happens to have ffmpeg.
//
// The stakes, measured: a WRONG index is exit 234 with a 0-byte output (M-H);
// the UNINDEXED form renames the source fonts and produces phantom video
// streams (M-F); a missing mimetype is exit 234 again (M-G).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildArgs } from '@/src/lib/encode/ffmpeg';
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';
import { __forTests_resetX265PoolsCache } from '@/src/lib/encode/profiles';
import { logger } from '@/src/lib/logger';
import type { CoverAttachment } from '@/src/lib/encode/cover-extract';

const base = { input: '/i', output: '/o', crf: 24, preset: 'slow' } as const;

function attachment(over: Partial<CoverAttachment> = {}): CoverAttachment {
  return { path: '/work/cover0.jpg', mimetype: 'image/jpeg', filename: 'cover.jpg', ...over };
}

/** Every `-metadata:s:t*` specifier in the argv, in order. */
function metadataStreamSpecifiers(args: string[]): string[] {
  return args.filter((t) => t.startsWith('-metadata:s:t'));
}

beforeEach(() => {
  delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
  delete process.env.ENCODE_CLOSED_GOP_DISABLED;
  __forTests_resetKeyframeCache();
  __forTests_resetX265PoolsCache();
});

afterEach(() => {
  __forTests_resetKeyframeCache();
  __forTests_resetX265PoolsCache();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 / AC-27 — the index arithmetic, as a matrix
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-3/AC-27 — the -metadata:s:t index is computed, never guessed', () => {
  const covers = (c: number): CoverAttachment[] =>
    Array.from({ length: c }, (_, i) =>
      attachment({
        path: `/work/cover${i}.${i === 0 ? 'jpg' : 'png'}`,
        mimetype: i === 0 ? 'image/jpeg' : 'image/png',
        filename: i === 0 ? 'cover.jpg' : 'small.png',
      }),
    );

  const matrix: Array<{ K: number; C: number; note: string }> = [
    { K: 0, C: 1, note: 'no source attachments (M-I)' },
    { K: 0, C: 2, note: 'no source attachments, two covers' },
    { K: 1, C: 1, note: 'one font' },
    { K: 1, C: 2, note: 'one font, two covers (M-K/M-L)' },
    { K: 2, C: 1, note: 'two fonts, one cover (M-E)' },
    { K: 2, C: 2, note: 'two fonts, two covers' },
  ];

  it.each(matrix)('K=$K attachments × C=$C covers — $note', ({ K, C }) => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: Array.from({ length: C }, (_, i) => i + 1),
      encodedVideoOrdinals: [0],
      coverAttachments: covers(C),
      sourceAttachmentCount: K,
    });

    // Every cover carries its index TWICE (mimetype + filename), consecutively
    // from the base, in cover order.
    const expected: string[] = [];
    for (let i = 0; i < C; i += 1) {
      expected.push(`-metadata:s:t:${K + i}`, `-metadata:s:t:${K + i}`);
    }
    expect(metadataStreamSpecifiers(args)).toEqual(expected);

    // M-F: the UNINDEXED form must NEVER appear — it renames the source fonts.
    expect(args).not.toContain('-metadata:s:t');

    // M-G: every -attach is followed by a path and carries a mimetype.
    expect(args.filter((t) => t === '-attach')).toHaveLength(C);
    for (let i = 0; i < C; i += 1) {
      const idx = args.indexOf(`-metadata:s:t:${K + i}`);
      expect(args[idx + 1]).toMatch(/^mimetype=image\//);
      expect(args[idx + 3]).toMatch(/^filename=/);
    }
  });

  it('the -attach blocks appear in COVER ORDER, values paired to their index', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1, 2],
      encodedVideoOrdinals: [0],
      coverAttachments: [
        attachment({ path: '/work/cover0.jpg', mimetype: 'image/jpeg', filename: 'cover.jpg' }),
        attachment({ path: '/work/cover1.png', mimetype: 'image/png', filename: 'small.png' }),
      ],
      sourceAttachmentCount: 1,
    });
    const start = args.indexOf('-attach');
    expect(args.slice(start, start + 12)).toEqual([
      '-attach',
      '/work/cover0.jpg',
      '-metadata:s:t:1',
      'mimetype=image/jpeg',
      '-metadata:s:t:1',
      'filename=cover.jpg',
      '-attach',
      '/work/cover1.png',
      '-metadata:s:t:2',
      'mimetype=image/png',
      '-metadata:s:t:2',
      'filename=small.png',
    ]);
  });

  it('M-E: the attach block sits after -map_metadata 0 and before the muxer tail', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      metadata: [['PROCESSED_BY', 'x265-butler']],
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 2,
    });
    const mapMeta = args.indexOf('-map_metadata');
    const tag = args.indexOf('-metadata');
    const attach = args.indexOf('-attach');
    const progress = args.indexOf('-progress');
    expect(mapMeta).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(mapMeta);
    expect(attach).toBeGreaterThan(tag);
    expect(progress).toBeGreaterThan(attach);
  });

  it('AC-12: the filename tag is whatever the caller resolved (source name or fallback)', () => {
    const fromSource = buildArgs({
      ...base,
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      coverAttachments: [attachment({ filename: 'Folder.jpg' })],
      sourceAttachmentCount: 0,
    });
    expect(fromSource).toContain('filename=Folder.jpg');

    const fallback = buildArgs({
      ...base,
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      coverAttachments: [attachment({ filename: 'cover0.jpg' })],
      sourceAttachmentCount: 0,
    });
    expect(fallback).toContain('filename=cover0.jpg');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 argv half / AC-28 — the mapping
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 — the cover leaves the video mapping (-map -0:v:N)', () => {
  it('excludes the cover ordinal right after the -map 0:v include', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    const mapIdx = args.indexOf('-map');
    expect(args.slice(mapIdx, mapIdx + 12)).toEqual([
      '-map',
      '0:v',
      '-map',
      '-0:v:1',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-map_metadata',
      '0',
    ]);
    // The copy form is GONE on this path — that is the whole point.
    expect(args.some((t) => t.startsWith('-c:v:'))).toBe(false);
  });

  it('AC-28: a cover at video ordinal 0 is unmapped and narrows NOTHING', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      crop: '1920:800:0:140',
      attachedPicVideoOrdinals: [0],
      // The complement is passed exactly as the orchestrator passes it — and is
      // deliberately ignored on this path (E3): after `-map -0:v:0` the output
      // ordinals shift, so `-filter:v:1` would silently address nothing.
      encodedVideoOrdinals: [1],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    expect(args).toContain('-0:v:0');
    expect(args.some((t) => /^-filter:v:\d+$/.test(t))).toBe(false);
    expect(args.some((t) => /^-force_key_frames:v:\d+$/.test(t))).toBe(false);
    expect(args).toContain('-vf');
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=1920:800:0:140');
  });

  it('AC-24 companion: covers beyond the attach cap stay UNMAPPED (dropped, not copied)', () => {
    // The orchestrator passes ALL cover ordinals but only the extracted subset as
    // attachments. The surplus must still leave the video set.
    const args = buildArgs({
      ...base,
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1, 2, 3, 4, 5],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    for (const n of [1, 2, 3, 4, 5]) expect(args).toContain(`-0:v:${n}`);
    expect(args.filter((t) => t === '-attach')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 — the ordinal narrowing is gone in the MKV cover branch (E3 / M-O)
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-10 — bare video specifiers in the MKV cover branch', () => {
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    '%s: no -c:v:<n>, no -filter:v:<n>, no -force_key_frames:v:<n> — the bare forms stand',
    (encoder) => {
      const args = buildArgs({
        ...base,
        encoder,
        outputContainer: 'mkv',
        crop: '1920:800:0:140',
        attachedPicVideoOrdinals: [1],
        encodedVideoOrdinals: [0],
        coverAttachments: [attachment()],
        sourceAttachmentCount: 0,
      });
      expect(args.some((t) => /^-c:v:\d+$/.test(t))).toBe(false);
      expect(args.some((t) => /^-filter:v:\d+$/.test(t))).toBe(false);
      expect(args.some((t) => /^-force_key_frames:v:\d+$/.test(t))).toBe(false);
      expect(args).toContain('-vf');
      expect(args).toContain('-force_key_frames');
    },
  );

  it('the bare crop really carries the geometry (not an empty leftover token)', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      crop: '200:100:0:0',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=200:100:0:0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-23 — a missing attachment count DROPS, it never guesses 0 (E9)
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-23 — attachment_count_unknown', () => {
  it('undefined count ⇒ no -attach, no -metadata:s:t, cover still unmapped, one warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      jobId: 4711,
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment()],
      // sourceAttachmentCount deliberately absent — the wiring-bug shape.
    });
    expect(args).not.toContain('-attach');
    expect(metadataStreamSpecifiers(args)).toEqual([]);
    // The D4/Opt-B state: the cover is out of the video set, just not re-attached.
    expect(args).toContain('-0:v:1');

    const calls = warnSpy.mock.calls.filter(
      (c) => (c[0] as { reason?: string }).reason === 'attachment_count_unknown',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      action: 'cover_attach_skipped',
      jobId: 4711,
      coverCount: 1,
    });
  });

  it('a count of ZERO is a VALID value and attaches at base 0 (never truthiness)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    const args = buildArgs({
      ...base,
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    expect(args).toContain('-metadata:s:t:0');
    expect(
      warnSpy.mock.calls.filter(
        (c) => (c[0] as { reason?: string }).reason === 'attachment_count_unknown',
      ),
    ).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN])('a non-integer/negative count (%s) drops too', (bad) => {
    const args = buildArgs({
      ...base,
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      coverAttachments: [attachment()],
      sourceAttachmentCount: bad,
    });
    expect(args).not.toContain('-attach');
    expect(metadataStreamSpecifiers(args)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 argv half — the kill-switch state and the failed-extraction state are
// the SAME argv. That is why buildArgs never reads the env (E6).
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-7 — no attachments ⇒ cover dropped, never copied back', () => {
  it.each([
    ['coverAttachments undefined (kill-switch / no extraction attempted)', undefined],
    ['coverAttachments empty (every extraction failed)', [] as CoverAttachment[]],
  ])('%s', (_name, coverAttachments) => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments,
      sourceAttachmentCount: 1,
    });
    expect(args).not.toContain('-attach');
    expect(metadataStreamSpecifiers(args)).toEqual([]);
    expect(args).toContain('-0:v:1');
    // THE point of E1=B: no fallback to the 49-01 copy form, which is measured
    // broken on mkv (M-C), not a safe harbour.
    expect(args.some((t) => t.startsWith('-c:v:'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 / AC-9 — nothing changes where nothing should change
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-8 — a source without a cover is byte-identical', () => {
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    '%s: the new fields are absent from the argv in both containers',
    (encoder) => {
      for (const outputContainer of ['mkv', 'mp4'] as const) {
        for (const crop of [undefined, '1920:800:0:140']) {
          const baseline = buildArgs({ ...base, encoder, outputContainer, crop });
          // Same call, with the 50-02 fields explicitly at their neutral values.
          const withNeutral = buildArgs({
            ...base,
            encoder,
            outputContainer,
            crop,
            attachedPicVideoOrdinals: [],
            encodedVideoOrdinals: [],
            coverAttachments: [],
            sourceAttachmentCount: 0,
          });
          expect(withNeutral).toEqual(baseline);
          expect(baseline).not.toContain('-attach');
          expect(baseline.some((t) => t.startsWith('-metadata:s:t'))).toBe(false);
          expect(baseline.some((t) => t.startsWith('-0:v:'))).toBe(false);
        }
      }
    },
  );
});

describe('50-02 AC-9 — the MP4 path is untouched 49-01', () => {
  it('mp4 with a cover keeps -c:v:N copy AND the ordinal narrowing', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mp4',
      crop: '1920:800:0:140',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args).toContain('-c:v:1');
    expect(args[args.indexOf('-c:v:1') + 1]).toBe('copy');
    expect(args).toContain('-filter:v:0');
    expect(args).toContain('-force_key_frames:v:0');
    expect(args).toContain('-tag:v:0');
    expect(args).not.toContain('-vf');
  });

  it('mp4 emits NO 50-02 token even when cover attachments are handed to it', () => {
    // Defensive: the orchestrator does not extract on the mp4 path (AC-29), but
    // if a future caller passed attachments anyway they must not leak into mp4 —
    // there the cover is already in the file via the copy.
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mp4',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment()],
      sourceAttachmentCount: 0,
    });
    expect(args).not.toContain('-attach');
    expect(args.some((t) => t.startsWith('-metadata:s:t'))).toBe(false);
    expect(args.some((t) => t.startsWith('-0:v:'))).toBe(false);
    expect(args).toContain('-c:v:1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the audit trail
// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 — the warn says what actually happened', () => {
  it('mkv emits attached_pic_streams_attached ONCE, and never the copy warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mkv',
      jobId: 4711,
      attachedPicVideoOrdinals: [1, 2],
      encodedVideoOrdinals: [0],
      coverAttachments: [attachment(), attachment({ path: '/work/cover1.png' })],
      sourceAttachmentCount: 2,
    });
    const attached = warnSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_attached',
    );
    expect(attached).toHaveLength(1);
    expect(attached[0][0]).toMatchObject({
      jobId: 4711,
      coverCount: 2,
      baseIndex: 2,
      droppedOrdinals: [1, 2],
      container: 'mkv',
    });
    expect(
      warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_copied',
      ),
    ).toHaveLength(0);
  });

  it('mp4 keeps emitting the COPY warn and never the attach warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mp4',
      jobId: 42,
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(
      warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_copied',
      ),
    ).toHaveLength(1);
    expect(
      warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_attached',
      ),
    ).toHaveLength(0);
  });

  it('no cover ⇒ neither warn fires (no noise in the regular case)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    buildArgs({ ...base, encoder: 'libx265', outputContainer: 'mkv', jobId: 1 });
    expect(
      warnSpy.mock.calls.filter((c) =>
        String((c[0] as { action?: string }).action ?? '').startsWith('attached_pic_streams_'),
      ),
    ).toHaveLength(0);
  });
});
