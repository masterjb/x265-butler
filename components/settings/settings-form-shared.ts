import type { EncoderId } from '@/src/lib/encode';

// 28-10: shared module-level constants + types lifted out of settings-form.tsx
// during the L2 god-component split. The extracted card/field sibling files
// import these from HERE (a leaf) — never from ./settings-form — so the barrel
// re-export in settings-form.tsx cannot form an ESM import cycle (AC-8).

// 44px on mobile (touch-target floor) + 36px on lg (pointer-precise).
export const INPUT_HEIGHT_CLASSES = 'h-11 lg:h-9 text-base lg:text-sm';

// 03-03 audit S1: encoder Detected pill row render order.
export const ENCODER_DISPLAY_ORDER: EncoderId[] = ['nvenc', 'qsv', 'vaapi', 'libx265'];

// 26-02 (F5): amber advisory style shared by the two OutputModeField advisories
// (replace one-way-door warning + off+replace anti-double-work hint).
export const AMBER_ADVISORY_CLASS =
  'flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100';

// 03-03 audit S1: detection state passed in for the Detected pill row.
export type EncoderDetectionState = {
  detectedEncoders: EncoderId[];
  activeEncoder: EncoderId;
  encoderResolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  vaapiDevice?: string;
};
