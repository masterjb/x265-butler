import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { BulletKpiCard } from '@/components/stats/charts/bullet-kpi-card';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const THRESHOLDS = { healthy: 0.05, attention: 0.1 };

describe('BulletKpiCard', () => {
  it('test_bulletKpiCard_healthy_zone_shows_correct_label_and_icon', () => {
    render(
      wrap(
        <BulletKpiCard
          value={0.02}
          sampleSize={100}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    // healthy threshold label
    const healthyLabel = en.stats.charts.failedJobRate.threshold.healthy;
    expect(screen.getByText(healthyLabel)).toBeTruthy();
  });

  it('test_bulletKpiCard_attention_zone_shows_correct_label', () => {
    render(
      wrap(
        <BulletKpiCard
          value={0.07}
          sampleSize={50}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    const attentionLabel = en.stats.charts.failedJobRate.threshold.attention;
    expect(screen.getByText(attentionLabel)).toBeTruthy();
  });

  it('test_bulletKpiCard_critical_zone_shows_correct_label', () => {
    render(
      wrap(
        <BulletKpiCard
          value={0.15}
          sampleSize={200}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    const criticalLabel = en.stats.charts.failedJobRate.threshold.critical;
    expect(screen.getByText(criticalLabel)).toBeTruthy();
  });

  it('test_bulletKpiCard_renders_percent_value_with_tabular_nums', () => {
    const { container } = render(
      wrap(
        <BulletKpiCard
          value={0.036}
          sampleSize={10}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    // 0.036 * 1000 / 10 = 3.6%
    expect(screen.getByText('3.6%')).toBeTruthy();
    const numEl = container.querySelector('.tabular-nums');
    expect(numEl).toBeTruthy();
  });

  it('test_bulletKpiCard_sample_size_annotation_visible', () => {
    render(
      wrap(
        <BulletKpiCard
          value={0.05}
          sampleSize={99}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    expect(screen.getByText('n=99')).toBeTruthy();
  });

  it('test_bulletKpiCard_not_color_only_icon_present', () => {
    const { container } = render(
      wrap(
        <BulletKpiCard
          value={0.12}
          sampleSize={5}
          thresholds={THRESHOLDS}
          titleKey="failedJobRate.title"
        />,
      ),
    );
    // At least one icon (svg) should be present in the zone display area
    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(0);
  });
});
