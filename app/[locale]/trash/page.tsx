import { TrashClient } from './trash-client';

export const dynamic = 'force-dynamic';

// audit-added S3: guard against next-build static analysis phase.
const BUILD_PHASE = process.env.NEXT_PHASE === 'phase-production-build';

const BASE_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
const DEFAULT_PAGE_SIZE = 25;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100, 200]);

function parseSize(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || !ALLOWED_PAGE_SIZES.has(n)) return DEFAULT_PAGE_SIZE;
  return n;
}

function parsePage(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TrashPage({ searchParams }: Props) {
  if (BUILD_PHASE) {
    return (
      <TrashClient
        initialRows={[]}
        initialTotal={0}
        initialBytesReclaimed={0}
        initialCount={0}
        pagination={{ page: 1, size: DEFAULT_PAGE_SIZE, total: 0, pageCount: 0 }}
      />
    );
  }

  const sp = await searchParams;
  const sizeRaw = Array.isArray(sp.size) ? sp.size[0] : sp.size;
  const pageRaw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const size = parseSize(sizeRaw);
  const page = parsePage(pageRaw);

  const [listData, summaryData] = await Promise.all([
    fetchJson<{ rows: import('@/src/lib/db/schema').TrashEntryRow[]; total: number }>(
      `/api/trash?page=${page}&size=${size}`,
    ),
    fetchJson<{ bytesReclaimed: number; count: number }>('/api/trash/summary'),
  ]);

  const total = listData?.total ?? 0;
  const pageCount = total === 0 ? 0 : Math.ceil(total / size);

  return (
    <TrashClient
      initialRows={listData?.rows ?? []}
      initialTotal={total}
      initialBytesReclaimed={summaryData?.bytesReclaimed ?? 0}
      initialCount={summaryData?.count ?? 0}
      pagination={{ page, size, total, pageCount }}
    />
  );
}
