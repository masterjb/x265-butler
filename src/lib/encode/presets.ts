import type { EncoderId } from './profiles';

export const PRESETS_BY_ENCODER = Object.freeze({
  libx265: Object.freeze([
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
    'placebo',
  ]),
  nvenc: Object.freeze(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
  qsv: Object.freeze(['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  vaapi: Object.freeze(['fast', 'medium', 'slow']),
}) satisfies Readonly<Record<EncoderId, ReadonlyArray<string>>>;

export type PresetByEncoder = {
  [K in EncoderId]: (typeof PRESETS_BY_ENCODER)[K][number];
};

export function isValidPreset<K extends EncoderId>(
  encoder: K,
  preset: string,
): preset is PresetByEncoder[K] {
  return (PRESETS_BY_ENCODER[encoder] as ReadonlyArray<string>).includes(preset);
}
