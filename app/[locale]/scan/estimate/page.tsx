// Phase 13 Plan 13-04 Task 4a — Server Component for /[locale]/scan/estimate.
//
// 14-04 (Plan 14-04 Task 7): pre-fill sourced from shareRepo().listAll()[0]
// instead of legacy settings.scan_root / min_size_mb / extensions / max_depth.
// When shares table is empty, the form starts with an empty path-input —
// operator hand-types (acceptable transition affordance per CONTEXT R4).

import fs from 'node:fs';
import { shareRepo } from '@/src/lib/db';
import { EstimateClient } from './estimate-client';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EstimatePage({ searchParams }: Props) {
  const sp = await searchParams;
  const pathParam = typeof sp.path === 'string' ? sp.path : undefined;

  const firstShare = shareRepo().listAll()[0];
  const scanRoot = firstShare?.path ?? '';
  const initialPath = pathParam ?? scanRoot;
  const extensions = firstShare?.extensions_csv ?? 'mp4,mkv,avi';
  const minSizeMb = firstShare?.min_size_mb ?? 50;
  const maxDepth = firstShare?.max_depth ?? 12;

  let scanRootExists = false;
  if (scanRoot) {
    try {
      scanRootExists = fs.statSync(scanRoot).isDirectory();
    } catch {
      scanRootExists = false;
    }
  }

  return (
    <EstimateClient
      initialPath={initialPath}
      scanRoot={scanRoot}
      scanRootExists={scanRootExists}
      defaultExtensions={extensions}
      defaultMinSizeMb={minSizeMb}
      defaultMaxDepth={maxDepth}
    />
  );
}
