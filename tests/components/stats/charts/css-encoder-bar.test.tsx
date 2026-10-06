import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { CssEncoderBar } from '@/components/stats/charts/css-encoder-bar';
import type { EncoderPerfRow } from '@/src/lib/db';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const ROWS: EncoderPerfRow[] = [
  { encoder: 'hevc_nvenc', jobCount: 55, totalSavedBytes: 14_241_464_680, avgSavedPercent: 42.3 },
  { encoder: 'libx265', jobCount: 10, totalSavedBytes: 2_000_000_000, avgSavedPercent: 30.0 },
];

describe('CssEncoderBar', () => {
  it('test_cssEncoderBar_when_empty_then_shows_empty_state', () => {
    render(wrap(<CssEncoderBar rows={[]} locale="en" />));
    const emptyTitle = en.stats.charts.encoderPerf.empty.title;
    expect(screen.getByText(emptyTitle)).toBeTruthy();
  });

  it('test_cssEncoderBar_when_rows_then_renders_encoder_names', () => {
    render(wrap(<CssEncoderBar rows={ROWS} locale="en" />));
    expect(screen.getByText('hevc_nvenc')).toBeTruthy();
    expect(screen.getByText('libx265')).toBeTruthy();
  });

  it('test_cssEncoderBar_has_data_testid', () => {
    const { container } = render(wrap(<CssEncoderBar rows={ROWS} locale="en" />));
    expect(container.querySelector('[data-testid="css-encoder-bar"]')).toBeTruthy();
  });

  it('test_cssEncoderBar_bytes_formatted_with_tabular_nums', () => {
    const { container } = render(wrap(<CssEncoderBar rows={ROWS} locale="en" />));
    const nums = container.querySelectorAll('.tabular-nums');
    expect(nums.length).toBeGreaterThan(0);
  });

  it('test_cssEncoderBar_role_img_with_aria_label', () => {
    const { container } = render(wrap(<CssEncoderBar rows={ROWS} locale="en" />));
    const img = container.querySelector('[role="img"]');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('aria-label')).toBeTruthy();
  });
});
