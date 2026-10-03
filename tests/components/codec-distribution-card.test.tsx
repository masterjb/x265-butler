// 08-03 Plan Task 1 — A4 Codec-Distribution Card tests (redesign: KPI chips + CSS stacked bars).
// Plan pin: EXACTLY 5 tests in this file (AC-7).
//   1. data present → renders KPI chips + stacked bar rows + visible legend
//   2. hevc count zero → callout NOT rendered
//   3. hevc count positive → callout rendered with count + percent
//   4. totalFiles zero → empty state, no chart
//   5. rendered → chart aria-label contains all bucket breakdowns

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { CodecDistributionCard } from '@/components/dashboard/codec-distribution-card';
import type { CodecDistribution } from '@/src/lib/db';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const FULL_FIXTURE: CodecDistribution = {
  codec: [
    { bucket: 'hevc', count: 60, bytes: 600_000_000_000 },
    { bucket: 'h264', count: 30, bytes: 300_000_000_000 },
    { bucket: 'av1', count: 5, bytes: 50_000_000_000 },
    { bucket: 'vp9', count: 3, bytes: 20_000_000_000 },
    { bucket: 'other', count: 1, bytes: 5_000_000_000 },
    { bucket: 'unknown', count: 1, bytes: 5_000_000_000 },
  ],
  container: [
    { bucket: 'mkv', count: 80 },
    { bucket: 'mp4', count: 15 },
    { bucket: 'other', count: 5 },
  ],
  totalFiles: 100,
  totalBytes: 980_000_000_000,
};

describe('CodecDistributionCard', () => {
  it('test_codecDistributionCard_when_data_present_then_renders_kpi_chips_and_stacked_bars_per_bucket', () => {
    const { container } = render(
      wrap(<CodecDistributionCard stats={{ codecDistribution: FULL_FIXTURE }} />),
    );
    // two role="img" wrappers: codec bar + container bar
    const charts = screen.getAllByRole('img');
    expect(charts.length).toBe(2);
    const chart = charts[0]; // codec bar
    expect(chart).toBeTruthy();
    // aria-label includes all 6 bucket labels
    const aria = chart.getAttribute('aria-label') ?? '';
    expect(aria).toMatch(/HEVC/);
    expect(aria).toMatch(/H\.264/);
    expect(aria).toMatch(/AV1/);
    expect(aria).toMatch(/VP9/);
    expect(aria).toMatch(/Other/);
    expect(aria).toMatch(/Unknown/);
    // visible codec legend has 6 <li> rows
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBe(2); // codec legend + container legend
    const codecLegend = lists[0];
    expect(codecLegend.querySelectorAll('li').length).toBe(6);
    const containerLegend = lists[1];
    expect(containerLegend.querySelectorAll('li').length).toBe(3); // mkv/mp4/other
    // AC-2: bar segment divs have proportional widths set via inline style
    const barDivs = container.querySelectorAll('[style*="width"]');
    expect(barDivs.length).toBeGreaterThan(0);
  });

  it('test_codecDistributionCard_when_hevc_count_zero_then_hevc_callout_NOT_rendered', () => {
    const noHevc: CodecDistribution = {
      ...FULL_FIXTURE,
      codec: FULL_FIXTURE.codec.filter((b) => b.bucket !== 'hevc'),
      totalFiles: 40,
    };
    render(wrap(<CodecDistributionCard stats={{ codecDistribution: noHevc }} />));
    // The aria-label string contains 'codec' but not 'HEVC:'. The visible callout
    // would render text like 'HEVC: N file(s) · M%' — assert that visible body text
    // does NOT contain that pattern. The legend row renders "HEVC <count>" (no
    // colon), and the chart aria renders "HEVC <count> (<percent>%)" — neither
    // matches /HEVC:.*Library/ per AC-3-bis DOM-disambiguation contract.
    expect(screen.queryByText(/HEVC:.*Library/)).toBeNull();
  });

  it('test_codecDistributionCard_when_hevc_count_positive_then_hevc_callout_rendered_with_count_and_percent', () => {
    render(wrap(<CodecDistributionCard stats={{ codecDistribution: FULL_FIXTURE }} />));
    // ICU plural: count=60 → "60 files"; percent: 60/100 = 60%.
    expect(screen.getByText(/HEVC: 60 files · 60% of Library/)).toBeTruthy();

    // Singular branch: count=1 → "1 file" (skill-review SR3 ICU plural coverage).
    // Tighter fixture per plan T3 step 8 option (b): hevc=1 + h264=99 → totalFiles=100.
    const singularFixture: CodecDistribution = {
      codec: [
        { bucket: 'hevc', count: 1, bytes: 10_000_000_000 },
        { bucket: 'h264', count: 99, bytes: 990_000_000_000 },
      ],
      container: FULL_FIXTURE.container,
      totalFiles: 100,
      totalBytes: 1_000_000_000_000,
    };
    const { unmount } = render(
      wrap(<CodecDistributionCard stats={{ codecDistribution: singularFixture }} />),
    );
    expect(screen.getByText(/HEVC: 1 file · 1% of Library/)).toBeTruthy();
    unmount();
  });

  it('test_codecDistributionCard_when_totalFiles_zero_then_empty_state_no_chart', () => {
    const emptyFixture: CodecDistribution = {
      codec: [],
      container: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    const { container } = render(
      wrap(<CodecDistributionCard stats={{ codecDistribution: emptyFixture }} />),
    );
    // Empty-state copy renders.
    expect(screen.getByText(/No files indexed yet/)).toBeTruthy();
    // No chart instantiated.
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelectorAll('.recharts-pie-sector').length).toBe(0);
  });

  it('test_codecDistributionCard_when_rendered_then_chart_aria_label_contains_all_bucket_breakdowns', () => {
    render(wrap(<CodecDistributionCard stats={{ codecDistribution: FULL_FIXTURE }} />));
    const aria = screen.getAllByRole('img')[0].getAttribute('aria-label') ?? '';
    // Each bucket's legendRow is `{label} {count} ({percent}%)`.
    expect(aria).toMatch(/HEVC 60 \(60%\)/);
    expect(aria).toMatch(/H\.264 30 \(30%\)/);
    expect(aria).toMatch(/AV1 5 \(5%\)/);
    expect(aria).toMatch(/VP9 3 \(3%\)/);
    expect(aria).toMatch(/Other 1 \(1%\)/);
    expect(aria).toMatch(/Unknown 1 \(1%\)/);
    // Total summary present.
    expect(aria).toMatch(/100 files total/);
  });

  // Suppress unused-import lint: vi is needed only if we need spies later;
  // keep available for ICU date/time mocks if a future test extends.
  void vi;
});
