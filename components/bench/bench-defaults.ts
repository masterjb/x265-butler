// Shared shape for the 8 bench settings defaults between
// settings/page.tsx + bench/page.tsx + BenchSettingsTab + BenchEnqueueForm.
// vmafBuckets shape is 3-csv (e.g. '95,92,88') — older 4-csv legacy
// operator-settings are recovered via parseCsvBuckets returning null + a banner.

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
