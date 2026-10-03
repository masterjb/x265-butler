import { NextResponse } from 'next/server';
import { getVersionInfo } from '@/src/lib/version';
import { getAutoScanStatus } from '@/src/lib/watch';
// 52-06: leaf import (not the encode barrel); reads the boot-probe caches, no spawn.
import {
  probeFfmpegVersionAtBoot,
  getFfmpegVersionCached,
  getFfmpegNvencVersionCached,
} from '@/src/lib/encode/ffmpeg-version';

// pino + future SQLite require Node APIs, NOT Edge runtime
export const runtime = 'nodejs';

// audit-added G3: never cache health — middleware/proxies ignore force-dynamic
export const dynamic = 'force-dynamic';

export async function GET() {
  // AC-10: warn-only semantics — autoScan.status='error' does NOT flip HTTP
  // status from 200. Operator inspects the structured fields.
  const autoScan = getAutoScanStatus();
  // 52-06: server init is lazy (first page request); kick the idempotent ffmpeg probe here
  // too, so a container polled only on /api/health (curl, HEALTHCHECK) names its builds
  // from the second call on. Spawns once per process, then returns immediately.
  probeFfmpegVersionAtBoot();
  return NextResponse.json(
    {
      ...getVersionInfo(),
      // 52-06: the exact ffmpeg builds of this image (null while the boot probe runs or on failure).
      ffmpeg: { version: getFfmpegVersionCached(), nvencVersion: getFfmpegNvencVersionCached() },
      autoScan,
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
