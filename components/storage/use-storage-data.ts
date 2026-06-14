'use client';

// 15-02: SWR hooks for the 5 storage-analyzer endpoints.
// Key-shape `[endpoint, share, depth?]` keeps cache-invalidation predictable
// when the toolbar mutates `?share=` or the depth-selector value.

import useSWR, { type SWRResponse } from 'swr';

import type {
  BucketResult,
  CodecSlice,
  KpiResult,
  ShareTableRow,
  TopFolderRow,
} from '@/src/lib/db/repos/storage';

export type StorageShare = 'all' | number;

interface BaseEnvelope {
  computedAt: string;
  dataAsOf: string;
  requestId: string;
  effectiveFilters?: { share?: 'all' | number; depth?: number };
}

export interface KpisResponse extends BaseEnvelope {
  totalSizeBytes: KpiResult['totalSizeBytes'];
  largestFolder: KpiResult['largestFolder'];
  mostOptimizedShare: KpiResult['mostOptimizedShare'];
  legacyCodecPercent: KpiResult['legacyCodecPercent'];
}

export interface BucketsResponse extends BaseEnvelope {
  buckets: BucketResult[];
}

export interface CodecPieResponse extends BaseEnvelope {
  codecs: CodecSlice[];
  note: string;
}

export interface SharesTableResponse extends BaseEnvelope {
  rows: ShareTableRow[];
}

export interface TopFoldersResponse extends BaseEnvelope {
  rows: TopFolderRow[];
  depth: number;
  share: 'all' | number;
  truncated: boolean;
}

interface StorageErrorBody {
  error: { code: string; message: string };
  requestId?: string;
}

export class StorageFetchError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StorageFetchError';
    this.status = status;
    this.code = code;
  }
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as StorageErrorBody;
      if (body?.error?.code) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // Body wasn't JSON — keep statusText fallback.
    }
    throw new StorageFetchError(res.status, code, message);
  }
  return (await res.json()) as T;
}

function buildShareQuery(share: StorageShare, extra?: Record<string, string | number>): string {
  const params = new URLSearchParams();
  if (share !== 'all') params.set('share', String(share));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const SWR_CONFIG = {
  // CONTEXT A5=c — live-SQL, no extra cache; revalidate on focus is the
  // staleness signal operators rely on.
  revalidateOnFocus: true,
  shouldRetryOnError: false,
} as const;

export function useKpis(share: StorageShare): SWRResponse<KpisResponse, StorageFetchError> {
  return useSWR<KpisResponse, StorageFetchError>(
    ['/api/storage/kpis', share],
    () => fetcher<KpisResponse>(`/api/storage/kpis${buildShareQuery(share)}`),
    SWR_CONFIG,
  );
}

export function useBuckets(share: StorageShare): SWRResponse<BucketsResponse, StorageFetchError> {
  return useSWR<BucketsResponse, StorageFetchError>(
    ['/api/storage/buckets', share],
    () => fetcher<BucketsResponse>(`/api/storage/buckets${buildShareQuery(share)}`),
    SWR_CONFIG,
  );
}

export function useCodecPie(share: StorageShare): SWRResponse<CodecPieResponse, StorageFetchError> {
  return useSWR<CodecPieResponse, StorageFetchError>(
    ['/api/storage/codec-pie', share],
    () => fetcher<CodecPieResponse>(`/api/storage/codec-pie${buildShareQuery(share)}`),
    SWR_CONFIG,
  );
}

export function useSharesTable(): SWRResponse<SharesTableResponse, StorageFetchError> {
  return useSWR<SharesTableResponse, StorageFetchError>(
    ['/api/storage/shares-table'],
    () => fetcher<SharesTableResponse>('/api/storage/shares-table'),
    SWR_CONFIG,
  );
}

export function useTopFolders(
  share: StorageShare,
  depth: number,
): SWRResponse<TopFoldersResponse, StorageFetchError> {
  return useSWR<TopFoldersResponse, StorageFetchError>(
    ['/api/storage/top-folders', share, depth],
    () =>
      fetcher<TopFoldersResponse>(`/api/storage/top-folders${buildShareQuery(share, { depth })}`),
    SWR_CONFIG,
  );
}
