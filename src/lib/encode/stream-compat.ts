// 41-01: stream-compat — identifies source streams whose codec_type cannot be
// muxed into a given output container. Pure module: zero side effects, zero
// logger import, zero filesystem access (mirrors subtitle-compat.ts).
//
// Matroska accepts video / audio / subtitle / attachment streams. The muxer
// raises `Only audio, video, and subtitles are supported for Matroska` for
// DATA + unknown codec_types (e.g. the iPhone `mebx` Apple timed-metadata Data
// streams, or a mov `tmcd` timecode track) — the mux header is refused BEFORE
// frame 1, so a blanket `-map 0` aborts the whole encode (exit 234, encoded 0
// frames). The fix maps only the matroska-compatible types; this analyzer
// computes the count + descriptors of the DROPPED streams for the audit warn.
//
// MH-1 (audit): attachment IS matroska-compatible — Matroska natively stores
// font AttachedFile elements (the canonical anime ASS-font case). Attachment is
// in the compatible set and is NEVER flagged; the dropped set is {data, unknown}
// ONLY. Reducing the whitelist to v/a/s would silently lose fonts.
//
// MP4 keeps data/timed-metadata streams (per D3), so the analysis is a no-op
// for the mp4 container and returns the empty result.

import type { OutputContainer } from './output-container';
import type { ProbeResult, ProbeStream } from '../scan/ffprobe';

// MH-1: attachment ∈ matroska-compatible. Incompatible = data + unknown ONLY.
export const MKV_COMPATIBLE_STREAM_TYPES: ReadonlySet<string> = Object.freeze(
  new Set<string>(['video', 'audio', 'subtitle', 'attachment']),
);

export type IncompatibleStreamAnalysis = Readonly<{
  incompatibleStreamIndices: number[];
  hasIncompatible: boolean;
  droppedDescriptors: string[];
}>;

const EMPTY_ANALYSIS: IncompatibleStreamAnalysis = Object.freeze({
  incompatibleStreamIndices: Object.freeze([]) as unknown as number[],
  hasIncompatible: false,
  droppedDescriptors: Object.freeze([]) as unknown as string[],
});

export function analyzeIncompatibleStreams(
  probe: ProbeResult,
  container: OutputContainer,
): IncompatibleStreamAnalysis {
  // MP4 keeps data/timed-metadata streams (D3) — nothing is dropped.
  if (container === 'mp4') return EMPTY_ANALYSIS;

  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];
  const incompatibleStreamIndices: number[] = [];
  const droppedDescriptorsSet = new Set<string>();

  for (const s of streams) {
    const type = s.codec_type;
    // Skip streams with a missing/empty codec_type (ffprobe normally maps an
    // unrecognized codec_type to 'unknown', but guard defensively).
    if (typeof type !== 'string' || type.length === 0) continue;
    if (MKV_COMPATIBLE_STREAM_TYPES.has(type)) continue;
    // Incompatible: data + unknown (anything outside the compatible set).
    incompatibleStreamIndices.push(s.index);
    const codec =
      typeof s.codec_name === 'string' && s.codec_name.length > 0 ? s.codec_name : 'none';
    droppedDescriptorsSet.add(`${type}:${codec}`);
  }

  return Object.freeze({
    incompatibleStreamIndices,
    hasIncompatible: incompatibleStreamIndices.length > 0,
    // Sort+dedupe (subtitle-compat parity).
    droppedDescriptors: [...droppedDescriptorsSet].sort(),
  });
}
