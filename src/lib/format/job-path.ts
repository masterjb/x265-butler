// 05-10 B2: pure helpers to split a scan-rooted path into filename (basename)
// and parent directory. POSIX-style separators only — scan paths are produced
// by the Node fs scanner under a Linux container where '/' is the separator.

const ROOT_LABEL = '(root)';

export function fileNameOf(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function parentOf(path: string): string {
  if (!path) return ROOT_LABEL;
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return ROOT_LABEL;
  const parent = trimmed.slice(0, idx);
  return parent === '' ? ROOT_LABEL : parent;
}

export const ROOT_PARENT_LABEL = ROOT_LABEL;
