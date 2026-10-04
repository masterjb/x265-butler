// 11-02-FIX-V2 UAT-003: pure savings calculator for Top3Cards emphasis-row.
// Operator-facing math: sample-derived ratio × full-file-size sum = projected savings.

export interface SavingsResult {
  ratio: number;
  pct: number;
  projectedFullFileBytes: number;
}

export function computeSavings(
  sourceSampleBytes: number | null,
  encodedSampleBytes: number,
  sourceFullFileBytesSum: number,
): SavingsResult | null {
  // audit SR3: encoded=0 yields ratio=1 (100% savings) — that's a broken-encode signature,
  // not a real result. Reject as input invariant; render compressionUnavailable instead.
  if (sourceSampleBytes === null || sourceSampleBytes <= 0) return null;
  if (encodedSampleBytes <= 0) return null;
  // audit SR4: do NOT clamp pct — operator must see catastrophic mis-configurations
  // (e.g. NVENC + CRF 14 producing 250% larger output) honestly as +X% worse.
  const ratio = 1 - encodedSampleBytes / sourceSampleBytes;
  const pct = Math.round(ratio * 100);
  const projectedFullFileBytes = Math.round(sourceFullFileBytesSum * ratio);
  return { ratio, pct, projectedFullFileBytes };
}

// Sum of file sizes for the run's fileIds. Missing entries silently ignored
// (legacy/orphaned files → contributes 0 to projection).
export function sumFileSizes(
  fileIds: readonly number[],
  fileSizeMap: Record<number, number>,
): number {
  let sum = 0;
  for (const id of fileIds) {
    const size = fileSizeMap[id];
    if (typeof size === 'number' && size > 0) sum += size;
  }
  return sum;
}
