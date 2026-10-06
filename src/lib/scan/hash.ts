import crypto from 'node:crypto';
import fs from 'node:fs';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

// Partial SHA-256 over three 4 MiB chunks (first / middle / last).
// Bounded I/O per file: at most 12 MiB read regardless of file size.
// Files smaller than CHUNK_SIZE are hashed in full.
// See internal design notes §4.1.
export async function hashFile(filePath: string): Promise<string> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stats = await fh.stat();
    const size = stats.size;
    const hash = crypto.createHash('sha256');

    if (size < CHUNK_SIZE) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      hash.update(buf.subarray(0, bytesRead));
      return hash.digest('hex');
    }

    const halfChunk = Math.floor(CHUNK_SIZE / 2);
    const offsets: number[] = [
      0,
      Math.max(Math.floor(size / 2) - halfChunk, 0),
      Math.max(size - CHUNK_SIZE, 0),
    ];

    const buf = Buffer.alloc(CHUNK_SIZE);
    for (const offset of offsets) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      hash.update(buf.subarray(0, bytesRead));
    }

    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}
