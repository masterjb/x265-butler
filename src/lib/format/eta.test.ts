import { describe, it, expect } from 'vitest';
import { computeEtaSeconds, formatEtaShort } from './eta';

describe('computeEtaSeconds (AC-3)', () => {
  it('derives remaining/speed for the happy path', () => {
    // durationSeconds=100, 20s done, speed=2.0 → (100 − 20) / 2 = 40
    expect(computeEtaSeconds(100, 20_000, 2.0)).toBe(40);
  });

  it('returns null when speed is null or <= 0', () => {
    expect(computeEtaSeconds(100, 20_000, null)).toBeNull();
    expect(computeEtaSeconds(100, 20_000, 0)).toBeNull();
    expect(computeEtaSeconds(100, 20_000, -1)).toBeNull();
  });

  it('returns null when durationSeconds is null or <= 0', () => {
    expect(computeEtaSeconds(null, 20_000, 2.0)).toBeNull();
    expect(computeEtaSeconds(0, 20_000, 2.0)).toBeNull();
    expect(computeEtaSeconds(-10, 20_000, 2.0)).toBeNull();
  });

  it('returns null when outTimeMs is null', () => {
    expect(computeEtaSeconds(100, null, 2.0)).toBeNull();
  });

  it('clamps to 0 when outTime is beyond duration (never negative)', () => {
    // 120s done on a 100s source → remaining negative → clamp 0
    expect(computeEtaSeconds(100, 120_000, 2.0)).toBe(0);
  });

  it('handles a fractional speed', () => {
    // (100 − 50) / 0.5 = 100
    expect(computeEtaSeconds(100, 50_000, 0.5)).toBe(100);
  });
});

describe('formatEtaShort (AC-4)', () => {
  it('null → null', () => {
    expect(formatEtaShort(null)).toBeNull();
  });

  it('seconds bucket (< 60)', () => {
    expect(formatEtaShort(45)).toBe('45s');
    expect(formatEtaShort(0)).toBe('0s');
    expect(formatEtaShort(59)).toBe('59s');
  });

  it('minutes bucket (< 3600), seconds zero-padded', () => {
    expect(formatEtaShort(60)).toBe('1m 00s'); // boundary
    expect(formatEtaShort(754)).toBe('12m 34s');
    expect(formatEtaShort(3599)).toBe('59m 59s');
  });

  it('hours bucket (>= 3600)', () => {
    expect(formatEtaShort(3600)).toBe('1h 0m'); // boundary
    expect(formatEtaShort(5025)).toBe('1h 23m');
  });

  it('rounds before bucketing', () => {
    expect(formatEtaShort(59.6)).toBe('1m 00s'); // rounds to 60
    expect(formatEtaShort(44.4)).toBe('44s');
  });
});
