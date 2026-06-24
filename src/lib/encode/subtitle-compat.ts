// 05-14: subtitle-compat — identifies subtitle stream codecs that cannot be
// muxed into a given output container without re-encoding. Pure module: zero
// side effects, zero logger import, zero filesystem access.
//
// MP4 subtitle support is narrower than MKV: only mov_text + tx3g land
// natively. Bitmap subs (PGS / VobSub / DVB / xsub), text-style subs
// (SRT / SSA / ASS / WebVTT) all require re-encoding or stream-drop. The
// 05-14 plan picks "drop incompatible streams + warn" (Q4=A) — operator
// chose MP4 for compatibility, dropping subs honors that choice without
// re-encoding cost.

import type { OutputContainer } from './output-container';
import type { ProbeResult, ProbeStream } from '../scan/ffprobe';

export const MP4_INCOMPATIBLE_SUBTITLE_CODECS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    'subrip',
    'ass',
    'ssa',
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
    'pgssub',
    'webvtt',
    'dvb_subtitle',
    'xsub',
  ]),
);

const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

export function incompatibleSubtitleCodecsFor(c: OutputContainer): ReadonlySet<string> {
  switch (c) {
    case 'mkv':
      return EMPTY_SET;
    case 'mp4':
      return MP4_INCOMPATIBLE_SUBTITLE_CODECS;
    default:
      return assertNever(c);
  }
}

export type SubtitleAnalysis = Readonly<{
  incompatibleSubtitleStreams: number[];
  hasIncompatibleSubs: boolean;
  droppedCodecs: string[];
}>;

export function analyzeStreams(probe: ProbeResult, container: OutputContainer): SubtitleAnalysis {
  const incompatSet = incompatibleSubtitleCodecsFor(container);
  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];

  const incompatibleSubtitleStreams: number[] = [];
  const droppedCodecsSet = new Set<string>();

  for (const s of streams) {
    if (s.codec_type !== 'subtitle') continue;
    const codec = s.codec_name;
    if (typeof codec !== 'string' || codec.length === 0) continue;
    if (incompatSet.has(codec)) {
      incompatibleSubtitleStreams.push(s.index);
      droppedCodecsSet.add(codec);
    }
  }

  return Object.freeze({
    incompatibleSubtitleStreams,
    hasIncompatibleSubs: incompatibleSubtitleStreams.length > 0,
    droppedCodecs: [...droppedCodecsSet].sort(),
  });
}

function assertNever(x: never): never {
  throw new Error(`unreachable container value: ${String(x)}`);
}
