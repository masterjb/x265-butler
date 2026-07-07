// 11-06: shared bench-encoder + preset constants.
// Extracted aus bench-enqueue-form.tsx so settings-tab + API-validator + form
// teilen denselben whitelist. VALID_* aliases sind for API zod-refine-imports.

export const ENCODERS = ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'] as const;
export const VALID_ENCODERS = ENCODERS;

export const PRESET_GROUPS = [
  { key: 'groupFast' as const, presets: ['ultrafast', 'superfast', 'veryfast', 'faster'] },
  { key: 'groupBalanced' as const, presets: ['fast', 'medium'] },
  { key: 'groupSlow' as const, presets: ['slow', 'slower', 'veryslow', 'placebo'] },
];

export const VALID_PRESETS = [
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
] as const;
