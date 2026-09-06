// 13-06: shared encode-path guard + retroactive flip helper.
// Layer-1 (retroactive flip): consumed by POST /api/library/[id]/blocklist
// pattern-mode AFTER the pattern entry INSERT in the same TX. Pre-existing
// files matching the just-inserted pattern flip status='blocklisted'.
// Layer-2 (encode-path guard): consumed by /api/queue + /api/library/[id]/retry
// + /api/library/bulk-retry AFTER each route's ELIGIBLE_STATES check, BEFORE
// the enqueue / setStatus call. Defense-in-depth — scan-time skip-pipeline
// remains the primary check.

import type { FileRow, FileStatus } from '@/src/lib/db/schema';
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';
import type { FileRepo } from '@/src/lib/db/repos/file';

// Mirrors retry-eligibility + queue-eligibility unions. Used by BOTH Layer-1
// (retroactive flip target set) AND Layer-2 (guard check is symmetric —
// only files that COULD be enqueued get blocked).
export const ENCODE_GUARD_ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set([
  'pending',
  'failed',
  'interrupted',
  'done-larger',
  'done-not-worth',
]);

// audit M3 + SR4: defense bound for retroactive flip scope. Mirrors 13-04
// SR5 ESTIMATE_MAX_FILES=100_000 precedent. Operator pattern matching
// >cap files indicates a likely mistake (e.g. pattern `*`); reject with
// 409 rather than risk OOM / multi-MB JSON response / multi-MB pino log.
export const ENCODE_GUARD_MAX_FLIP_SCOPE = 100_000;

// SR4: response-body cap on flippedIds array. Full list still goes to pino
// (machine-parseable). Operator UI typically does not display individual
// IDs; counter + truncation flag is sufficient.
export const ENCODE_GUARD_FLIP_RESPONSE_CAP = 1000;

// SR5: warn-level threshold — pattern adds flipping >= this many files
// emit pino warn (not info) for ops-paging signal.
export const ENCODE_GUARD_WARN_THRESHOLD = 100;

export class EncodeGuardScopeCapError extends Error {
  readonly scopeCount: number;
  readonly cap: number;
  constructor(scopeCount: number, cap: number) {
    super(`blocklist flip scope ${scopeCount} exceeds cap ${cap}`);
    this.name = 'EncodeGuardScopeCapError';
    this.scopeCount = scopeCount;
    this.cap = cap;
  }
}

export type GuardResult = { blocked: false } | { blocked: true; reason: 'blocklisted' };

export function requireNotBlocklisted(file: FileRow, blocklistRepo: BlocklistRepo): GuardResult {
  if (blocklistRepo.matchByFileIdOrPath(file.id, file.path)) {
    return { blocked: true, reason: 'blocklisted' };
  }
  return { blocked: false };
}

// SR2 SOC2 audit-trail: per-file previousStatus snapshot for pino events.
export type FlippedFile = { id: number; previousStatus: FileStatus };

export function flipMatchingFilesToBlocklisted(args: {
  pattern: string;
  fileRepo: FileRepo;
  matchPath: (pattern: string, filePath: string) => boolean;
}): { flippedCount: number; flipped: FlippedFile[] } {
  const candidates = args.fileRepo.listEligibleForBlocklistFlip(
    Array.from(ENCODE_GUARD_ELIGIBLE_STATES),
  );
  const matched: FlippedFile[] = [];
  const matchedIds: number[] = [];
  for (const c of candidates) {
    if (args.matchPath(args.pattern, c.path)) {
      matched.push({ id: c.id, previousStatus: c.status });
      matchedIds.push(c.id);
    }
  }
  if (matchedIds.length === 0) return { flippedCount: 0, flipped: [] };
  const flippedCount = args.fileRepo.bulkSetStatusByIds(
    matchedIds,
    'blocklisted',
    Array.from(ENCODE_GUARD_ELIGIBLE_STATES),
  );
  return { flippedCount, flipped: matched };
}
