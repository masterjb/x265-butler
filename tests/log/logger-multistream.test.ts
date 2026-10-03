// 05-03 T1.C: pino multistream retrofit verification.
// Phase 5 Plan 05-03 — audit S5 (both destinations receive each line).

import { describe, it, expect, beforeEach } from 'vitest';
import { logger } from '@/src/lib/logger';
import { tail, _resetForTesting } from '@/src/lib/log/ring-buffer';

describe('logger multistream — audit S5', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('logger.info() lands in ring buffer', async () => {
    logger.info({ probe: 'multistream-test' }, 'multistream-probe-msg');
    // pino multistream is async-ish; allow microtask flush.
    await new Promise((resolve) => setImmediate(resolve));
    const result = tail(10);
    const found = result.lines.some(
      (line) => line.includes('multistream-probe-msg') && line.includes('multistream-test'),
    );
    expect(found).toBe(true);
  });

  it('logger.warn() lands in ring buffer', async () => {
    logger.warn({ event: 'audit_S5_test' }, 'warn-line');
    await new Promise((resolve) => setImmediate(resolve));
    const result = tail(10);
    const found = result.lines.some((line) => line.includes('audit_S5_test'));
    expect(found).toBe(true);
  });

  it('multiple emits accumulate in buffer order', async () => {
    logger.info('first');
    logger.info('second');
    logger.info('third');
    await new Promise((resolve) => setImmediate(resolve));
    const result = tail(10);
    expect(result.totalLines).toBeGreaterThanOrEqual(3);
    const indices = ['first', 'second', 'third'].map((needle) =>
      result.lines.findIndex((line) => line.includes(needle)),
    );
    expect(indices[0]).toBeLessThan(indices[1]);
    expect(indices[1]).toBeLessThan(indices[2]);
  });
});
