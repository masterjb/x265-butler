import { z } from 'zod';
import type { EncoderId, QsvRateControl } from '@/src/lib/encode';
import { isValidTrashRetentionDays } from '@/src/lib/encode/trash-defaults';

// Shared module-level constants + types for settings-form.tsx and its
// card/field sibling files. The sibling files
// import these from HERE (a leaf) — never from ./settings-form — so the barrel
// re-export in settings-form.tsx cannot form an ESM import cycle.

// 44px on mobile (touch-target floor) + 36px on lg (pointer-precise).
export const INPUT_HEIGHT_CLASSES = 'h-11 lg:h-9 text-base lg:text-sm';

// Client mirror of the API rule for trash_retention_days: whole days, 1 to 3650.
export const trashRetentionDaysSchema = z
  .number({ message: 'trashRetentionRange' })
  .refine(isValidTrashRetentionDays, { message: 'trashRetentionRange' });

// Encoder Detected pill row render order.
export const ENCODER_DISPLAY_ORDER: EncoderId[] = ['nvenc', 'qsv', 'vaapi', 'libx265'];

// Amber advisory style shared by the two OutputModeField advisories
// (replace one-way-door warning + off+replace anti-double-work hint).
export const AMBER_ADVISORY_CLASS =
  'flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100';

// Detection state passed in for the Detected pill row.
export type EncoderDetectionState = {
  detectedEncoders: EncoderId[];
  activeEncoder: EncoderId;
  encoderResolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  vaapiDevice?: string;
  // The boot-resolved QSV ratecontrol tier. undefined = both probe
  // tiers failed, qsv was never probed, or settings/page.tsx's detection
  // catch-branch fired. The CRF helper then names the FALLBACK the real encode
  // still emits instead of going silent.
  qsvRateControl?: QsvRateControl;
};
