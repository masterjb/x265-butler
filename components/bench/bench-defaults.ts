// 11-06: shared shape für 8 Bench-Settings-Defaults zwischen
// settings/page.tsx + bench/page.tsx + BenchSettingsTab + BenchEnqueueForm.
// 16-04: vmafBuckets shape is now 3-csv (e.g. '95,92,88') — pre-16-04 4-csv
// legacy operator-settings are recovered via parseCsvBuckets returning null +
// banner per AC-4.

import type { BenchMode } from '@/src/lib/db/schema';

export interface BenchDefaults {
  mode: BenchMode;
  encoders: string[];
  presets: string[];
  nativeValues: string;
  sampleCount: number;
  sampleDurationSec: number;
  vmafModel: string;
  vmafBuckets: string;
}
