// 05-03 T1.A: log-capture tests.
// Phase 5 Plan 05-03 — AC-1 + audit M3.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openJobLogStream } from '@/src/lib/encode/log-capture';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-log-test-'));
  // Reset the per-boot warn flag so each test gets a clean state.
  (
    globalThis as { __x265butler_log_capture_disabled_warned?: boolean }
  ).__x265butler_log_capture_disabled_warned = false;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('openJobLogStream — happy path', () => {
  it('writes string chunks to {cachePoolPath}/logs/{jobId}.log', async () => {
    const stream = await openJobLogStream('42', tmpDir);
    expect(stream).not.toBeNull();
    stream!.write('hello\n');
    stream!.write('world\n');
    await stream!.close();
    const content = await fs.readFile(path.join(tmpDir, 'logs', '42.log'), 'utf8');
    expect(content).toContain('hello');
    expect(content).toContain('world');
  });

  it('creates logs dir with mode 0750 + file with mode 0640', async () => {
    const stream = await openJobLogStream('43', tmpDir);
    stream!.write('data\n');
    await stream!.close();
    const fileStat = await fs.stat(path.join(tmpDir, 'logs', '43.log'));
    expect(fileStat.mode & 0o777).toBe(0o640);
  });

  it('appends across multiple writes (does not truncate)', async () => {
    const stream = await openJobLogStream('44', tmpDir);
    stream!.write('part1\n');
    stream!.write('part2\n');
    stream!.write('part3\n');
    await stream!.close();
    const content = await fs.readFile(path.join(tmpDir, 'logs', '44.log'), 'utf8');
    expect(content).toMatch(/part1[\s\S]*part2[\s\S]*part3/);
  });

  it('audit M3: UTF-8-safe — non-UTF-8 bytes become U+FFFD without throw', async () => {
    const stream = await openJobLogStream('45', tmpDir);
    expect(stream).not.toBeNull();
    stream!.write(Buffer.from([0xff, 0xfe, 0x00, 0x41])); // invalid UTF-8 + 'A'
    await stream!.close();
    const content = await fs.readFile(path.join(tmpDir, 'logs', '45.log'), 'utf8');
    // U+FFFD = REPLACEMENT CHARACTER
    expect(content).toContain('�');
    expect(content).toContain('A');
    // JSON.stringify must succeed without throw
    expect(() => JSON.stringify({ content })).not.toThrow();
  });
});

describe('openJobLogStream — graceful degrade', () => {
  it('returns null when cachePoolPath is empty string', async () => {
    const stream = await openJobLogStream('46', '');
    expect(stream).toBeNull();
  });

  // Skipped under root (CI Docker runs as uid 0): root bypasses POSIX rwx bits,
  // so a 0o555 dir is still writable and openJobLogStream cannot detect it.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('returns null when path non-writable (read-only parent)', async () => {
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fs.mkdir(readOnlyDir);
    await fs.chmod(readOnlyDir, 0o555); // r-x only
    const stream = await openJobLogStream('47', readOnlyDir);
    expect(stream).toBeNull();
    await fs.chmod(readOnlyDir, 0o755); // restore for cleanup
  });
});

describe('openJobLogStream — close idempotency', () => {
  it('close() is safe to call multiple times', async () => {
    const stream = await openJobLogStream('48', tmpDir);
    stream!.write('once\n');
    await stream!.close();
    await stream!.close();
    await stream!.close();
    // No throw
  });

  it('write() after close() is a silent no-op', async () => {
    const stream = await openJobLogStream('49', tmpDir);
    stream!.write('before\n');
    await stream!.close();
    stream!.write('after\n');
    const content = await fs.readFile(path.join(tmpDir, 'logs', '49.log'), 'utf8');
    expect(content).toContain('before');
    expect(content).not.toContain('after');
  });
});
