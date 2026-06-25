import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusChip, statusToI18nKey } from '@/components/library/status-chip';
import type { FileStatus } from '@/src/lib/db/schema';

const ALL: readonly FileStatus[] = [
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
  'vanished',
  // 05-13: 3-bucket verdict + sidecar-driven skip evolution.
  'done-not-worth',
  'done-already-evaluated',
];

describe('StatusChip', () => {
  it.each(ALL)('test_StatusChip_when_status_%s_then_renders_label_and_icon_and_color', (status) => {
    const { container } = render(<StatusChip status={status} label={`L:${status}`} />);
    expect(screen.getByText(`L:${status}`)).toBeInTheDocument();
    const chip = container.querySelector(`[data-status="${status}"]`);
    expect(chip).not.toBeNull();
    // Color + icon (not color alone) — chip must contain a decorative SVG
    const icon = chip?.querySelector('svg');
    expect(icon).not.toBeNull();
  });
});

describe('statusToI18nKey', () => {
  it('test_statusToI18nKey_when_hyphenated_then_camelCase', () => {
    expect(statusToI18nKey('done-smaller')).toBe('doneSmaller');
    expect(statusToI18nKey('skipped-blocklist')).toBe('skippedBlocklist');
  });

  it('test_statusToI18nKey_when_no_hyphen_then_unchanged', () => {
    expect(statusToI18nKey('pending')).toBe('pending');
    expect(statusToI18nKey('failed')).toBe('failed');
  });

  // 05-13: 3-bucket verdict + sidecar-driven skip status keys.
  it('test_statusToI18nKey_for_done_not_worth_returns_doneNotWorth', () => {
    expect(statusToI18nKey('done-not-worth')).toBe('doneNotWorth');
  });

  it('test_statusToI18nKey_for_done_already_evaluated_returns_doneAlreadyEvaluated', () => {
    expect(statusToI18nKey('done-already-evaluated')).toBe('doneAlreadyEvaluated');
  });
});

// 05-13: STATUS_VISUALS exhaustiveness via Record<FileStatus, ...> guarantees
// the 2 new entries exist at compile time. These render-tests assert the
// runtime mapping (icon + color tone classes) for the 2 new chips.
describe('StatusChip — 05-13 done-not-worth + done-already-evaluated', () => {
  it('test_StatusChip_when_done_not_worth_then_amber_palette_MinusCircle', () => {
    const { container } = render(<StatusChip status="done-not-worth" label="Not worth" />);
    const chip = container.querySelector('[data-status="done-not-worth"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toContain('amber');
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Not worth')).toBeInTheDocument();
  });

  it('test_StatusChip_when_done_already_evaluated_then_slate_palette_History_icon', () => {
    const { container } = render(
      <StatusChip status="done-already-evaluated" label="Already evaluated" />,
    );
    const chip = container.querySelector('[data-status="done-already-evaluated"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toContain('slate');
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Already evaluated')).toBeInTheDocument();
  });
});
