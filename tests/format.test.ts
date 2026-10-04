import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatBytesAccessible,
  formatBitrate,
  formatDuration,
  formatRelativeTime,
  formatResolution,
  formatTimestamp,
} from '@/src/lib/format';

describe('formatBytes', () => {
  it('test_formatBytes_when_zero_then_returns_0_B', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('test_formatBytes_when_under_1_KiB_then_no_decimal_B', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('test_formatBytes_when_KiB_then_one_decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(2048)).toBe('2.0 KiB');
  });

  it('test_formatBytes_when_GiB_then_one_decimal', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
  });

  it('test_formatBytes_when_locale_de_then_uses_comma_decimal', () => {
    // 1.5 KiB → "1,5 KiB" in de-DE
    expect(formatBytes(1536, 'de')).toBe('1,5 KiB');
  });

  it('test_formatBytes_when_negative_or_NaN_then_returns_dash', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('test_formatDuration_when_under_hour_then_m_ss', () => {
    expect(formatDuration(83)).toBe('1:23');
  });

  it('test_formatDuration_when_over_hour_then_h_mm_ss', () => {
    expect(formatDuration(3600 + 24 * 60 + 33)).toBe('1:24:33');
  });

  it('test_formatDuration_when_null_or_negative_then_dash', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatBitrate', () => {
  it('test_formatBitrate_when_kbps_then_no_decimal', () => {
    expect(formatBitrate(800_000)).toBe('800 kbps');
  });

  it('test_formatBitrate_when_Mbps_then_one_decimal', () => {
    expect(formatBitrate(5_200_000)).toBe('5.2 Mbps');
  });

  it('test_formatBitrate_when_Mbps_de_then_comma_decimal', () => {
    expect(formatBitrate(5_200_000, 'de')).toBe('5,2 Mbps');
  });

  it('test_formatBitrate_when_null_then_dash', () => {
    expect(formatBitrate(null)).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000;

  it('test_formatRelativeTime_when_under_45s_then_just_now', () => {
    expect(formatRelativeTime(now - 30, now)).toBe('just now');
    expect(formatRelativeTime(now - 30, now, 'de')).toBe('gerade eben');
  });

  it('test_formatRelativeTime_when_minutes_then_m_ago', () => {
    expect(formatRelativeTime(now - 5 * 60, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 5 * 60, now, 'de')).toBe('vor 5 m');
  });

  it('test_formatRelativeTime_when_hours_then_h_ago', () => {
    expect(formatRelativeTime(now - 2 * 3600, now)).toBe('2h ago');
    expect(formatRelativeTime(now - 2 * 3600, now, 'de')).toBe('vor 2 h');
  });

  it('test_formatRelativeTime_when_days_then_d_ago', () => {
    expect(formatRelativeTime(now - 3 * 86400, now)).toBe('3d ago');
    expect(formatRelativeTime(now - 3 * 86400, now, 'de')).toBe('vor 3 d');
  });

  it('test_formatRelativeTime_when_zero_then_dash', () => {
    expect(formatRelativeTime(0, now)).toBe('—');
  });
});

describe('formatResolution', () => {
  it('test_formatResolution_when_full_then_WxH', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
  });

  it('test_formatResolution_when_either_null_then_dash', () => {
    expect(formatResolution(null, 1080)).toBe('—');
    expect(formatResolution(1920, null)).toBe('—');
  });
});

describe('formatTimestamp', () => {
  it('test_formatTimestamp_when_zero_then_dash', () => {
    expect(formatTimestamp(0)).toBe('—');
  });

  it('test_formatTimestamp_when_valid_then_returns_formatted_string', () => {
    // 2023-11-14T22:13:20Z, locale-formatted; assert it's not the dash
    const out = formatTimestamp(1_700_000_000, 'en');
    expect(out).not.toBe('—');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(5);
  });
});

// 03-04 audit S14: full-word unit names for screen readers
describe('formatBytesAccessible', () => {
  it('test_formatBytesAccessible_when_zero_then_full_word_bytes_en', () => {
    expect(formatBytesAccessible(0, 'en')).toBe('0 bytes');
  });

  it('test_formatBytesAccessible_when_zero_then_full_word_Byte_de', () => {
    expect(formatBytesAccessible(0, 'de')).toBe('0 Byte');
  });

  it('test_formatBytesAccessible_when_GiB_then_spells_gibibytes_en', () => {
    expect(formatBytesAccessible(2 * 1024 ** 3, 'en')).toBe('2.0 gibibytes');
  });

  it('test_formatBytesAccessible_when_GiB_then_spells_Gibibyte_de', () => {
    expect(formatBytesAccessible(2 * 1024 ** 3, 'de')).toBe('2,0 Gibibyte');
  });

  it('test_formatBytesAccessible_when_KiB_then_spells_kibibytes', () => {
    expect(formatBytesAccessible(1024, 'en')).toBe('1.0 kibibytes');
  });

  it('test_formatBytesAccessible_when_under_1_KiB_then_bytes_no_decimal', () => {
    expect(formatBytesAccessible(512, 'en')).toBe('512 bytes');
  });

  it('test_formatBytesAccessible_when_negative_then_no_data_string', () => {
    expect(formatBytesAccessible(-1, 'en')).toBe('no data');
    expect(formatBytesAccessible(-1, 'de')).toBe('keine Daten');
  });
});
