// Phase 16-02 (audit-added M4): single-source-of-truth range-spec consumed by
// the settings zod-schema (app/api/settings/route.ts), the AutoScanAdvanced UI
// (components/settings/auto-scan-advanced.tsx) min/max attrs, and i18n
// error-text formatting. Prevents drift across enforcement layers.
//
// DO NOT duplicate these literals anywhere else. The T6 verification gate
// `grep -rn "1000.*60000|500.*30000|0\.05.*72" src/ app/` MUST list ONLY this
// file.

export const AUTOSCAN_RANGES = {
  stabilityThreshold: { min: 1000, max: 60000, kind: 'int', unit: 'ms' },
  batchWindow: { min: 500, max: 30000, kind: 'int', unit: 'ms' },
  reconcileIntervalH: { min: 0.05, max: 72, kind: 'decimal', unit: 'h' },
} as const;

export type AutoScanRangeKey = keyof typeof AUTOSCAN_RANGES;
