import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashFile } from '@/src/lib/scan/hash';

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/scan');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'sample.bin');
const FIXTURE_SIZE = 12 * 1024 * 1024;

// audit-added S11: deterministic PRNG via SHA-256(seed || counter) chain.
// Same seed → same bytes on every machine and Node version.
// Generated once and cached on disk via the .gitignored fixtures dir.
function generateDeterministicBlob(size: number): Buffer {
  const seed = Buffer.from('x265-butler-fixture-v1');
  const out = Buffer.alloc(size);
  const counter = Buffer.alloc(4);
  for (let offset = 0; offset < size; offset += 32) {
    counter.writeUInt32LE(Math.floor(offset / 32), 0);
    const digest = crypto.createHash('sha256').update(seed).update(counter).digest();
    const remaining = size - offset;
    digest.copy(out, offset, 0, Math.min(32, remaining));
  }
  return out;
}

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!fs.existsSync(FIXTURE_PATH) || fs.statSync(FIXTURE_PATH).size !== FIXTURE_SIZE) {
    fs.writeFileSync(FIXTURE_PATH, generateDeterministicBlob(FIXTURE_SIZE));
  }
}, 30_000);

describe('hashFile', () => {
  it('test_hashFile_when_called_then_returns_64_char_lowercase_hex', async () => {
    const result = await hashFile(FIXTURE_PATH);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test_hashFile_when_same_content_called_twice_then_returns_identical_hash', async () => {
    const a = await hashFile(FIXTURE_PATH);
    const b = await hashFile(FIXTURE_PATH);
    expect(a).toBe(b);
  });

  it('test_hashFile_when_middle_chunk_mutated_then_hash_differs', async () => {
    const tmp = path.join(os.tmpdir(), `hash-mutate-${Date.now()}.bin`);
    const blob = generateDeterministicBlob(FIXTURE_SIZE);
    fs.writeFileSync(tmp, blob);
    try {
      const original = await hashFile(tmp);
      // Mutate one byte at offset 4 MiB + 1024 — inside the middle chunk
      // (middle offset = floor(12 MiB / 2) - 2 MiB = 4 MiB).
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 4 * 1024 * 1024 + 1024);
      } finally {
        fs.closeSync(fd);
      }
      const mutated = await hashFile(tmp);
      expect(mutated).not.toBe(original);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('test_hashFile_when_first_byte_mutated_then_hash_differs', async () => {
    const tmp = path.join(os.tmpdir(), `hash-mutate-first-${Date.now()}.bin`);
    const blob = generateDeterministicBlob(FIXTURE_SIZE);
    fs.writeFileSync(tmp, blob);
    try {
      const original = await hashFile(tmp);
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.writeSync(fd, Buffer.from([0xab]), 0, 1, 0);
      } finally {
        fs.closeSync(fd);
      }
      const mutated = await hashFile(tmp);
      expect(mutated).not.toBe(original);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('test_hashFile_when_file_smaller_than_4MiB_then_hashes_whole_file', async () => {
    const tmp = path.join(os.tmpdir(), `hash-tiny-${Date.now()}.bin`);
    const content = Buffer.from('hello world tiny content');
    fs.writeFileSync(tmp, content);
    try {
      const result = await hashFile(tmp);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      const expected = crypto.createHash('sha256').update(content).digest('hex');
      expect(result).toBe(expected);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('test_hashFile_when_size_is_exactly_4MiB_then_returns_deterministic_hash', async () => {
    const tmp = path.join(os.tmpdir(), `hash-4mib-${Date.now()}.bin`);
    fs.writeFileSync(tmp, generateDeterministicBlob(4 * 1024 * 1024));
    try {
      const a = await hashFile(tmp);
      const b = await hashFile(tmp);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('test_hashFile_when_zero_byte_file_then_hashes_empty_buffer', async () => {
    const tmp = path.join(os.tmpdir(), `hash-empty-${Date.now()}.bin`);
    fs.writeFileSync(tmp, Buffer.alloc(0));
    try {
      const result = await hashFile(tmp);
      const expected = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
      expect(result).toBe(expected);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
