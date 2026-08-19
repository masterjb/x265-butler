// 05-14 audit-added (G3): audio-compat — identifies audio stream codecs that
// cannot be muxed into a given output container under the existing
// `-c:a copy` Decision (2026-04-24, preserved). Pure module: zero side
// effects, zero logger import, zero filesystem access.
//
// MP4 muxer accepts a narrower audio codec set than Matroska. Source codecs
// frequent on Blu-ray rips (TrueHD, DTS-HD-MA), lossless audio archives
// (FLAC, Opus), and broadcast captures (raw PCM variants) cannot land in MP4
// without re-encoding. 05-14 chooses fail-fast pre-flight (AC-12) over silent
// transcode-to-AAC, because re-encoding without operator consent degrades
// audio fidelity and contradicts the preserved 2026-04-24 `-c:a copy`
// Decision. Operator-controllable audio-fallback is available via 10-02
// `audio_auto_transcode_mp4` setting (default true).
//
// `eac3` is intentionally NOT in the incompatibility set: modern ffmpeg
// (≥4.0; node:22-bookworm-slim base image satisfies this) accepts E-AC-3 in
// the mp4 muxer without `-strict experimental`. `dts` (regular DTS Core) is
// muxable in some toolchains but ffmpeg's mp4 muxer rejects it without
// `-strict experimental`; treat as incompatible to fail fast rather than
// rely on the experimental flag.

import type { OutputContainer } from './output-container';
import type { ProbeResult, ProbeStream } from '../scan/ffprobe';

export const MP4_INCOMPATIBLE_AUDIO_CODECS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    'truehd',
    'dts',
    'flac',
    'opus',
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_f32le',
    'mlp',
  ]),
);

const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

export function incompatibleAudioCodecsFor(c: OutputContainer): ReadonlySet<string> {
  switch (c) {
    case 'mkv':
      return EMPTY_SET;
    case 'mp4':
      return MP4_INCOMPATIBLE_AUDIO_CODECS;
    default:
      return assertNever(c);
  }
}

// 10-02 E-D3: per-stream AAC-transcode target (SR1: channel-aware bitrate;
// SR2: channel-layout preserved via ffmpeg-default, no `-ac` arg emitted).
export type AudioAutoTranscodeTarget = Readonly<{
  sourceStreamIndex: number; // audio-stream index (0=first audio, 1=second…)
  action: 'aac' | 'copy';
  bitrate?: number; // present when action='aac' (192000 ≤2ch, 256000 >2ch)
  fromCodec: string;
}>;

// 10-02 E-D3: discriminated union replacing flat AudioAnalysis. Each outcome
// carries exactly the data the orchestrator needs for the corresponding branch.
export type AudioAnalysisOutcome = Readonly<
  | { outcome: 'compatible' }
  | { outcome: 'fail_fast'; incompatibleStreams: number[]; droppedCodecs: string[] }
  | { outcome: 'auto_transcode'; perStreamTargets: AudioAutoTranscodeTarget[] }
  | { outcome: 'fallback_to_mkv'; droppedCodecs: string[] }
>;

export function analyzeAudioStreams(
  probe: ProbeResult,
  container: OutputContainer,
  opts?: {
    // When false (default for backward compat): incompatible MP4 audio → fail_fast
    // When true (orchestrator passes from audio_auto_transcode_mp4 setting): → auto_transcode
    autoTranscode?: boolean;
    // When true: incompatible MP4 audio → fallback_to_mkv (match-source semantics)
    isMatchSource?: boolean;
  },
): AudioAnalysisOutcome {
  const incompatSet = incompatibleAudioCodecsFor(container);
  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];

  // Fast-path for MKV or empty stream list — no incompatibility possible.
  if (incompatSet.size === 0) return Object.freeze({ outcome: 'compatible' });

  const incompatibleStreamIndices: number[] = [];
  const droppedCodecsSet = new Set<string>();
  const perStreamTargets: AudioAutoTranscodeTarget[] = [];

  let audioIdx = 0; // audio-specific index (0 = first audio stream in container)
  for (const s of streams) {
    if (s.codec_type !== 'audio') continue;
    const codec = s.codec_name;
    const currentAudioIdx = audioIdx;
    audioIdx++;

    if (typeof codec !== 'string' || codec.length === 0) continue;

    if (incompatSet.has(codec)) {
      incompatibleStreamIndices.push(currentAudioIdx);
      droppedCodecsSet.add(codec);
      // SR1: channel-aware bitrate (≤2ch → 192k, >2ch → 256k)
      const channels = typeof s.channels === 'number' ? s.channels : 2;
      perStreamTargets.push(
        Object.freeze({
          sourceStreamIndex: currentAudioIdx,
          action: 'aac',
          bitrate: channels > 2 ? 256000 : 192000,
          fromCodec: codec,
        }),
      );
    } else {
      // Compatible stream — copy
      perStreamTargets.push(
        Object.freeze({
          sourceStreamIndex: currentAudioIdx,
          action: 'copy',
          fromCodec: codec,
        }),
      );
    }
  }

  if (incompatibleStreamIndices.length === 0) {
    return Object.freeze({ outcome: 'compatible' });
  }

  const droppedCodecs = [...droppedCodecsSet].sort();

  if (opts?.isMatchSource) {
    return Object.freeze({ outcome: 'fallback_to_mkv', droppedCodecs });
  }

  if (opts?.autoTranscode) {
    return Object.freeze({
      outcome: 'auto_transcode',
      perStreamTargets: Object.freeze(perStreamTargets) as AudioAutoTranscodeTarget[],
    });
  }

  return Object.freeze({
    outcome: 'fail_fast',
    incompatibleStreams: incompatibleStreamIndices,
    droppedCodecs,
  });
}

function assertNever(x: never): never {
  throw new Error(`unreachable container value: ${String(x)}`);
}
