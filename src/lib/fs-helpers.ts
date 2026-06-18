import fs from 'node:fs/promises';

// Extracted from src/lib/encode/staging.ts commitOutput EXDEV-fallback pattern.
// Used by restore endpoint (app/api/trash/[id]/restore) and any future caller
// needing atomic cross-filesystem move with explicit fsync (audit 02-02 M3).
//
// 28-03 (P10): async (node:fs/promises) so a multi-GB cross-FS restore copy no
// longer blocks the event loop. Semantics are byte-for-byte identical to the
// prior sync version — same rename-first / EXDEV copy+fsync+rename+unlink path,
// same tmp-suffix, same M3 fsync guarantee, same failure surfacing.
export async function moveAcrossFilesystems(srcPath: string, dstPath: string): Promise<void> {
  try {
    await fs.rename(srcPath, dstPath);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code !== 'EXDEV') {
      throw err;
    }
    // EXDEV: src and dst on different filesystems — fallback to copy+fsync+rename+unlink.
    // S8 (02-02): unlink tmp first to clear prior crash debris.
    const tmp = `${dstPath}.x265-butler.move.tmp`;
    try {
      await fs.unlink(tmp);
    } catch {
      // tmp absent — nothing to clear
    }
    try {
      await fs.copyFile(srcPath, tmp);
      // M3 (02-02): explicit fd-fsync pattern — fsync(O_RDONLY) flushes OS write-back cache.
      const fh = await fs.open(tmp, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, dstPath);
      await fs.unlink(srcPath);
    } catch (innerErr) {
      try {
        await fs.unlink(tmp);
      } catch {
        // best-effort cleanup
      }
      throw innerErr;
    }
  }
}
