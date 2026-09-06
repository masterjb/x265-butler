import pkg from '../../package.json' with { type: 'json' };

export interface VersionInfo {
  version: string;
  gitHash: string;
  committedAt: number | null;
  committedAtCET: string | null;
}

export function getVersionInfo(): VersionInfo {
  const version = pkg.version;
  const gitHash = process.env.GIT_HASH ?? 'dev';

  const raw = process.env.GIT_COMMITTED_AT;
  let committedAt: number | null = null;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      committedAt = parsed;
    }
  }

  const committedAtCET = committedAt !== null ? formatCET(committedAt) : null;

  return { version, gitHash, committedAt, committedAtCET };
}

function formatCET(unixSeconds: number): string {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}, ${get('hour')}:${get('minute')}:${get('second')}`;
}
