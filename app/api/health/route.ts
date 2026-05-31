import { NextResponse } from 'next/server';
import { getVersionInfo } from '@/src/lib/version';
import { getAutoScanStatus } from '@/src/lib/watch';

// pino + future SQLite require Node APIs, NOT Edge runtime
export const runtime = 'nodejs';

// audit-added G3: never cache health — middleware/proxies ignore force-dynamic
export const dynamic = 'force-dynamic';

export async function GET() {
  // AC-10: warn-only semantics — autoScan.status='error' does NOT flip HTTP
  // status from 200. Operator inspects the structured fields.
  const autoScan = getAutoScanStatus();
  return NextResponse.json(
    { ...getVersionInfo(), autoScan },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
