import { describe, it, expect } from 'vitest';
import { computeParetoFrontier, pickTop3, normalizeForBalance } from '@/src/lib/bench/pareto';

interface C {
  encoder: string;
  preset: string | null;
  native_quality_param: string;
  native_quality_value: number;
  vmaf_target: number | null;
  vmaf: number;
  sizeBytes: number;
  encodeSec: number;
  sampleIds: number[];
}

function makeCombo(vmaf: number, sizeBytes: number, encodeSec = 1, id = 0): C {
  return {
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 28,
    vmaf_target: null,
    vmaf,
    sizeBytes,
    encodeSec,
    sampleIds: [id],
  };
}

describe('computeParetoFrontier', () => {
  it('N=0 → empty', () => {
    expect(computeParetoFrontier([])).toEqual([]);
  });

  it('N=1 → single item is always pareto', () => {
    const c = makeCombo(80, 1000);
    expect(computeParetoFrontier([c])).toHaveLength(1);
  });

  it('N=2 non-dominated → both on frontier', () => {
    const a = makeCombo(90, 500); // high vmaf, small size
    const b = makeCombo(70, 1500); // low vmaf, large size — dominated? no: lower vmaf, higher size → dominated by a
    // a dominates b (higher vmaf AND lower sizeBytes)
    const result = computeParetoFrontier([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  it('N=2 non-dominated tradeoff → both on frontier', () => {
    const a = makeCombo(90, 1500); // high vmaf, large
    const b = makeCombo(70, 500); // low vmaf, small
    const result = computeParetoFrontier([a, b]);
    expect(result).toHaveLength(2);
  });

  it('N=3 one dominated → 2 on frontier', () => {
    const a = makeCombo(90, 500);
    const b = makeCombo(80, 1000); // dominated by a
    const c = makeCombo(70, 200); // tradeoff with a
    const result = computeParetoFrontier([a, b, c]);
    expect(result).toHaveLength(2);
    expect(result).not.toContain(b);
  });

  it('N=8 classic frontier', () => {
    const combos = [
      makeCombo(95, 5000), // pareto: highest vmaf
      makeCombo(90, 3000), // pareto
      makeCombo(85, 1500), // pareto
      makeCombo(75, 800), // pareto
      makeCombo(70, 400), // pareto: smallest size
      makeCombo(80, 3500), // dominated by 90/3000
      makeCombo(85, 4000), // dominated
      makeCombo(72, 900), // dominated by 75/800
    ];
    const result = computeParetoFrontier(combos);
    expect(result.length).toBeGreaterThanOrEqual(5);
    // Dominated items must not appear
    const dominated = [combos[5], combos[6], combos[7]];
    for (const d of dominated) {
      expect(result).not.toContain(d);
    }
  });

  it('all identical → all on frontier (no dominance)', () => {
    const combos = [
      makeCombo(80, 1000, 1, 1),
      makeCombo(80, 1000, 1, 2),
      makeCombo(80, 1000, 1, 3),
    ];
    const result = computeParetoFrontier(combos);
    expect(result).toHaveLength(3);
  });

  it('result sorted ASC by sizeBytes', () => {
    const a = makeCombo(90, 5000);
    const b = makeCombo(80, 2000);
    const c = makeCombo(70, 500);
    const result = computeParetoFrontier([a, b, c]);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].sizeBytes).toBeLessThanOrEqual(result[i + 1].sizeBytes);
    }
  });
});

describe('pickTop3', () => {
  it('N=0 → null', () => {
    expect(pickTop3([])).toBeNull();
  });

  it('N=1 → all roles point to same item', () => {
    const only = makeCombo(80, 1000);
    const result = pickTop3([only]);
    expect(result).not.toBeNull();
    expect(result!.quality).toBe(only);
    expect(result!.balanced).toBe(only);
    expect(result!.size).toBe(only);
  });

  it('N=2 → quality and size are extremes, balanced is one of them', () => {
    const small = makeCombo(70, 500);
    const hq = makeCombo(90, 5000);
    const result = pickTop3([small, hq]);
    expect(result).not.toBeNull();
    expect(result!.quality).toBe(hq);
    expect(result!.size).toBe(small);
    expect([small, hq]).toContain(result!.balanced);
  });

  it('N≥3 → distinct roles from frontier', () => {
    const combos = [makeCombo(70, 200, 1, 1), makeCombo(80, 1000, 1, 2), makeCombo(95, 6000, 1, 3)];
    const result = pickTop3(combos);
    expect(result).not.toBeNull();
    expect(result!.quality.vmaf).toBe(95);
    expect(result!.size.sizeBytes).toBe(200);
    expect(result!.balanced.vmaf).toBe(80);
  });

  it('tiebreak: encodeSec asc for balanced', () => {
    // Two combos equidistant from the ideal line — lower encodeSec wins
    const fast = makeCombo(80, 1000, 0.5, 1);
    const slow = makeCombo(80, 1000, 2.0, 2);
    const hq = makeCombo(95, 6000, 1, 3);
    const tiny = makeCombo(70, 200, 1, 4);
    const result = pickTop3([tiny, fast, slow, hq]);
    expect(result!.balanced).toBe(fast);
  });
});

describe('normalizeForBalance', () => {
  it('maps extreme corners to (0,0) and (1,1) when given as extremes', () => {
    const small = makeCombo(70, 200);
    const hq = makeCombo(95, 6000);

    const normSmall = normalizeForBalance(small, small, hq);
    expect(normSmall.nx).toBeCloseTo(0);
    expect(normSmall.ny).toBeCloseTo(0);

    const normHq = normalizeForBalance(hq, small, hq);
    expect(normHq.nx).toBeCloseTo(1);
    expect(normHq.ny).toBeCloseTo(1);
  });

  it('zero-range → returns 0', () => {
    const c = makeCombo(80, 1000);
    const result = normalizeForBalance(c, c, c);
    expect(result.nx).toBe(0);
    expect(result.ny).toBe(0);
  });
});
