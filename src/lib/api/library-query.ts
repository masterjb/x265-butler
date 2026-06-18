import { z } from 'zod';
import type { FileStatus } from '@/src/lib/db/schema';
import type { ListOptions } from '@/src/lib/db/repos/file';

const FILE_STATUSES: readonly [FileStatus, ...FileStatus[]] = [
  'pending',
  'queued',
  'encoding',
  'done-smaller',
  'done-larger',
  'skipped-codec',
  'skipped-bitrate',
  'skipped-suffix',
  'skipped-tag',
  'skipped-sidecar',
  'skipped-blocklist',
  'failed',
  'blocklisted',
  'interrupted',
  // 05-bonus: explicit filter to surface vanished rows. Selecting this
  // filter implies includeVanished.
  'vanished',
];

// 15-01 audit M4: NULL-byte + ASCII control-char regex guard for pathPrefix.
// Used as a zod-level pre-binding reject; pre-empts any downstream weirdness
// from drivers that mishandle U+0000..U+001F in path-strings. Operator-facing
// failure shape is `.catch(undefined)` (silent drop, matches `share`/`file`
// field semantics); route handler surfaces a `library_pathprefix_rejected`
// warn log when raw input was present but parsed undefined.
// eslint-disable-next-line no-control-regex
const PATH_PREFIX_CONTROL_CHAR_REGEX = /^[^\x00-\x1f]*$/;

// 01-04 CONTEXT.md §3.1 — query schema reused by Server Component + Route Handler.
export const libraryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().max(500).optional(),
  status: z.union([z.enum(FILE_STATUSES), z.literal('all')]).optional(),
  sort: z.enum(['size', 'bitrate', 'duration', 'scanned']).default('size'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  // 05-bonus: operator opt-in to surface vanished rows when status filter is
  // 'all'. Accepts '1'/'true' as truthy; any other or absent → false.
  includeVanished: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  // 07-01: deep-link single-file filter (`?file=N`). Per-field `.catch(undefined)`
  // localizes failure: malformed input ('abc', '-3') yields `undefined` for
  // `file` while sibling fields keep their parsed values. Without `.catch`
  // here, the OUTER schema-cascade fallback in app/[locale]/library/page.tsx
  // would drop EVERY operator-supplied param (page/sort/dir/q/status/etc.)
  // — collateral data-loss from the operator's perspective. Empty-string
  // `?file=` is filtered out pre-parse by the `if (value && value !== '')`
  // guard in page.tsx; negative `?file=-3` rejected by `.min(1)` and falls
  // through `.catch(undefined)` same as 'abc'.
  file: z.coerce.number().int().min(1).optional().catch(undefined),
  // 14-03: share-axis filter. Accepts numeric id, 'all' (= no filter, default
  // state), or 'orphan' (NULL-share bucket). Per-field `.catch(undefined)`
  // mirrors `file:` handling — malformed input ('abc', '-3', '0') yields
  // undefined for this field WITHOUT cascade-dropping sibling params.
  share: z
    .union([z.literal('all'), z.literal('orphan'), z.coerce.number().int().positive()])
    .optional()
    .catch(undefined),
  // 15-01: deep-link folder-restrict filter. STARTS WITH semantics (file.ts
  // `escapePathPrefix(s) + '/%'`). Per-field `.catch(undefined)` mirrors
  // `share`/`file` — malformed input falls through without dropping siblings.
  // audit M4 regex pre-binding-reject for NULL-byte + ASCII control chars.
  pathPrefix: z
    .string()
    .max(500)
    .regex(PATH_PREFIX_CONTROL_CHAR_REGEX, 'control-char')
    .optional()
    .catch(undefined),
});

export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

// Accept either URLSearchParams or a record (Next.js gives a record from
// searchParams). Filter out empty strings before parsing so default values win.
export function parseLibraryQuery(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
): LibraryQuery {
  const raw: Record<string, string> = {};
  if (input instanceof URLSearchParams) {
    input.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
  } else {
    for (const [k, v] of Object.entries(input)) {
      if (v == null) continue;
      const value = Array.isArray(v) ? v[0] : v;
      if (value && value !== '') raw[k] = value;
    }
  }
  return libraryQuerySchema.parse(raw);
}

// Convert a parsed query back into the repo-shaped ListOptions.
export function toListOptions(q: LibraryQuery): ListOptions {
  return {
    page: q.page,
    size: q.size,
    q: q.q,
    status: q.status,
    sort: q.sort,
    dir: q.dir,
    includeVanished: q.includeVanished,
    // 07-01: deep-link single-file filter forwarded to fileRepo.listPaginated.
    idFilter: q.file,
    // 14-03: share-axis filter mapping — 'all' → undefined (no filter),
    // 'orphan' → 'orphan' literal, numeric → numeric.
    shareId: q.share === 'all' ? undefined : q.share === 'orphan' ? 'orphan' : q.share,
    // 15-01: pathPrefix forwarded to fileRepo.listPaginated STARTS WITH filter.
    pathPrefix: q.pathPrefix,
  };
}
