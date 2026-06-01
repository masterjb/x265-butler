// 01-04: locale-aware formatters used by Library + Settings.
// IEC binary units (KiB / MiB / GiB / TiB) — matches `du -h` and storage
// vendor conventions; do NOT switch to SI (KB) without an explicit decision.

export type FormatLocale = 'en' | 'de';

const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function localeNumber(n: number, locale: FormatLocale, opts?: Intl.NumberFormatOptions): string {
  const tag = locale === 'de' ? 'de-DE' : 'en-US';
  return new Intl.NumberFormat(tag, opts).format(n);
}

// 03-04 audit S14: KPI aria-labels speak full unit names.
// Screen readers pronounce "GB" as the letters G-B (poor); "gigabytes" reads
// correctly. Use this for aria-labels ONLY — visible text uses formatBytes.
const IEC_UNIT_NAMES_EN: Record<(typeof IEC_UNITS)[number], string> = {
  B: 'bytes',
  KiB: 'kibibytes',
  MiB: 'mebibytes',
  GiB: 'gibibytes',
  TiB: 'tebibytes',
  PiB: 'pebibytes',
};
const IEC_UNIT_NAMES_DE: Record<(typeof IEC_UNITS)[number], string> = {
  B: 'Byte',
  KiB: 'Kibibyte',
  MiB: 'Mebibyte',
  GiB: 'Gibibyte',
  TiB: 'Tebibyte',
  PiB: 'Pebibyte',
};

export function formatBytesAccessible(n: number, locale: FormatLocale = 'en'): string {
  if (!Number.isFinite(n) || n < 0) return locale === 'de' ? 'keine Daten' : 'no data';
  if (n === 0) return locale === 'de' ? '0 Byte' : '0 bytes';
  let value = n;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < IEC_UNITS.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const unitKey = IEC_UNITS[unitIdx];
  const fractionDigits = unitIdx === 0 ? 0 : 1;
  const number = localeNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  const unitName = locale === 'de' ? IEC_UNIT_NAMES_DE[unitKey] : IEC_UNIT_NAMES_EN[unitKey];
  return `${number} ${unitName}`;
}

export function formatBytes(n: number, locale: FormatLocale = 'en'): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return `0 ${IEC_UNITS[0]}`;
  let value = n;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < IEC_UNITS.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  // 1 decimal for KiB+, 0 for B
  const fractionDigits = unitIdx === 0 ? 0 : 1;
  return `${localeNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ${IEC_UNITS[unitIdx]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => v.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatBitrate(bps: number | null | undefined, locale: FormatLocale = 'en'): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return '—';
  if (bps === 0) return `0 bps`;
  if (bps < 1_000_000) {
    return `${localeNumber(bps / 1_000, locale, { maximumFractionDigits: 0 })} kbps`;
  }
  return `${localeNumber(bps / 1_000_000, locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} Mbps`;
}

// Short relative-time labels — keep the table column narrow.
// EN: "just now", "5m ago", "2h ago", "3d ago"
// DE: "gerade eben", "vor 5 m", "vor 2 h", "vor 3 d"
export function formatRelativeTime(
  epochSeconds: number,
  now: number,
  locale: FormatLocale = 'en',
): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '—';
  const diff = Math.max(0, Math.floor(now - epochSeconds));
  if (diff < 45) {
    return locale === 'de' ? 'gerade eben' : 'just now';
  }
  const minutes = Math.round(diff / 60);
  if (minutes < 60) {
    return locale === 'de' ? `vor ${minutes} m` : `${minutes}m ago`;
  }
  const hours = Math.round(diff / 3600);
  if (hours < 48) {
    return locale === 'de' ? `vor ${hours} h` : `${hours}h ago`;
  }
  const days = Math.round(diff / 86400);
  if (days < 30) {
    return locale === 'de' ? `vor ${days} d` : `${days}d ago`;
  }
  const months = Math.round(diff / (86400 * 30));
  if (months < 12) {
    return locale === 'de' ? `vor ${months} Mon.` : `${months}mo ago`;
  }
  const years = Math.round(diff / (86400 * 365));
  return locale === 'de' ? `vor ${years} J.` : `${years}y ago`;
}

export function formatResolution(width: number | null, height: number | null): string {
  if (width == null || height == null || width <= 0 || height <= 0) return '—';
  return `${width}×${height}`;
}

// Long-form full timestamp for tooltip / detail panel.
export function formatTimestamp(epochSeconds: number, locale: FormatLocale = 'en'): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '—';
  const d = new Date(epochSeconds * 1000);
  const tag = locale === 'de' ? 'de-DE' : 'en-US';
  return new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(d);
}

// 15-02: HH:MM:SS-only formatter for Storage-Analyzer as-of-label. Uses a
// fixed `en-GB` locale + `timeStyle: 'medium'` to keep SSR/CSR output
// deterministic (avoids hydration mismatch from AM/PM-flip across locales).
// Accepts an ISO-8601 string or an epoch-millisecond number.
export function formatTime(input: string | number | null | undefined): string {
  if (input == null) return '—';
  const d = typeof input === 'string' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' }).format(d);
}
