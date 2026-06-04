// 11-01: Pareto frontier + Top-3 pure inline helpers.
// ZERO DB / ZERO FS / ZERO global state — pure functions only.
// Pareto: max VMAF + min sizeBytes. Tiebreak: encodeSec asc (faster wins).

export interface ParetoCandidate {
  vmaf: number;
  sizeBytes: number;
  encodeSec?: number;
}

export function computeParetoFrontier<T extends ParetoCandidate>(combos: T[]): T[] {
  if (combos.length === 0) return [];

  const dominated = new Set<number>();
  for (let i = 0; i < combos.length; i++) {
    for (let j = 0; j < combos.length; j++) {
      if (i === j) continue;
      const a = combos[i];
      const b = combos[j];
      // b dominates a if b.vmaf >= a.vmaf AND b.sizeBytes <= a.sizeBytes AND (strictly better in at least one)
      if (
        b.vmaf >= a.vmaf &&
        b.sizeBytes <= a.sizeBytes &&
        (b.vmaf > a.vmaf || b.sizeBytes < a.sizeBytes)
      ) {
        dominated.add(i);
        break;
      }
    }
  }

  const front = combos.filter((_, i) => !dominated.has(i));
  front.sort((a, b) => {
    if (a.sizeBytes !== b.sizeBytes) return a.sizeBytes - b.sizeBytes;
    return (a.encodeSec ?? 0) - (b.encodeSec ?? 0);
  });
  return front;
}

export function normalizeForBalance<T extends ParetoCandidate>(
  p: T,
  sizeExtremeMin: T,
  vmafExtremeMax: T,
): { nx: number; ny: number } {
  const sizeRange = vmafExtremeMax.sizeBytes - sizeExtremeMin.sizeBytes;
  const vmafRange = vmafExtremeMax.vmaf - sizeExtremeMin.vmaf;
  const nx = sizeRange === 0 ? 0 : (p.sizeBytes - sizeExtremeMin.sizeBytes) / sizeRange;
  const ny = vmafRange === 0 ? 0 : (p.vmaf - sizeExtremeMin.vmaf) / vmafRange;
  return { nx, ny };
}

export function pickTop3<T extends ParetoCandidate>(
  paretoFront: T[],
): { quality: T; balanced: T; size: T } | null {
  if (paretoFront.length === 0) return null;
  if (paretoFront.length === 1) {
    return { quality: paretoFront[0], balanced: paretoFront[0], size: paretoFront[0] };
  }
  if (paretoFront.length === 2) {
    // paretoFront sorted ASC by sizeBytes: front[0]=min-size, front[1]=max-vmaf
    return { quality: paretoFront[1], balanced: paretoFront[0], size: paretoFront[0] };
  }

  // N >= 3: extremes + perpendicular-distance knee
  const sizeExtreme = paretoFront[0]; // min sizeBytes (leftmost)
  const qualityExtreme = paretoFront[paretoFront.length - 1]; // max VMAF (rightmost)

  let balancedCandidate = paretoFront[0];
  let maxDist = -1;

  for (const p of paretoFront) {
    const { nx, ny } = normalizeForBalance(p, sizeExtreme, qualityExtreme);
    const dist = Math.abs(ny - nx);
    if (
      dist > maxDist ||
      (dist === maxDist && (p.encodeSec ?? Infinity) < (balancedCandidate.encodeSec ?? Infinity))
    ) {
      maxDist = dist;
      balancedCandidate = p;
    }
  }

  return { quality: qualityExtreme, balanced: balancedCandidate, size: sizeExtreme };
}
