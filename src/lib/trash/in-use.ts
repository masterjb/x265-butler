import type { JobRepo } from '../db/repos/job';
import type { TrashEntryRow } from '../db/schema';

// The trash row is written before the original is moved, and the move can take
// minutes across filesystems. While the file's latest job is still encoding,
// the entry may point at a file that is only half moved, so restore and
// permanent delete must leave it alone.
export function isTrashEntryInUse(
  entry: Pick<TrashEntryRow, 'file_id'>,
  jobs: Pick<JobRepo, 'findByFileId'>,
): boolean {
  if (entry.file_id === null) return false;
  return jobs.findByFileId(entry.file_id)?.status === 'encoding';
}
