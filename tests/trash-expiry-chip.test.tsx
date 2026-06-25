import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExpiryChip, getExpiryTier } from '@/components/trash/expiry-chip';
import { wrap } from './test-utils';

const NOW = 1_700_000_000;
const DAY = 86_400;

describe('getExpiryTier — boundary logic', () => {
  it('test_getExpiryTier_when_8_days_remaining_then_safe', () => {
    expect(getExpiryTier(NOW + 8 * DAY, NOW)).toBe('safe');
  });

  it('test_getExpiryTier_when_7_days_remaining_then_soon', () => {
    expect(getExpiryTier(NOW + 7 * DAY, NOW)).toBe('soon');
  });

  it('test_getExpiryTier_when_1_day_remaining_then_soon', () => {
    expect(getExpiryTier(NOW + DAY, NOW)).toBe('soon');
  });

  it('test_getExpiryTier_when_less_than_1_day_then_urgent', () => {
    expect(getExpiryTier(NOW + DAY - 1, NOW)).toBe('urgent');
  });

  it('test_getExpiryTier_when_already_expired_then_urgent', () => {
    expect(getExpiryTier(NOW - 1, NOW)).toBe('urgent');
  });
});

describe('ExpiryChip — rendering', () => {
  it('test_ExpiryChip_when_safe_tier_then_data_expiry_tier_safe', () => {
    render(wrap(<ExpiryChip expiresAt={NOW + 10 * DAY} now={NOW} />));
    const chip = document.querySelector('[data-expiry-tier="safe"]');
    expect(chip).not.toBeNull();
  });

  it('test_ExpiryChip_when_soon_tier_then_data_expiry_tier_soon', () => {
    render(wrap(<ExpiryChip expiresAt={NOW + 3 * DAY} now={NOW} />));
    const chip = document.querySelector('[data-expiry-tier="soon"]');
    expect(chip).not.toBeNull();
  });

  it('test_ExpiryChip_when_urgent_tier_then_data_expiry_tier_urgent', () => {
    render(wrap(<ExpiryChip expiresAt={NOW + 3600} now={NOW} />));
    const chip = document.querySelector('[data-expiry-tier="urgent"]');
    expect(chip).not.toBeNull();
  });

  it('test_ExpiryChip_when_retention_days_then_tooltip_contains_retention', () => {
    render(wrap(<ExpiryChip expiresAt={NOW + 10 * DAY} now={NOW} retentionDays={30} />));
    const chip = document.querySelector('[data-expiry-tier]');
    expect(chip?.getAttribute('title')).toMatch(/30/);
  });

  it('test_ExpiryChip_when_urgent_tier_then_shows_hours_label', () => {
    // 2 hours remaining
    render(wrap(<ExpiryChip expiresAt={NOW + 2 * 3600} now={NOW} />));
    expect(screen.getByText(/2/)).toBeInTheDocument();
  });

  it('test_ExpiryChip_when_safe_tier_then_shows_days_label', () => {
    // 10 days remaining
    render(wrap(<ExpiryChip expiresAt={NOW + 10 * DAY} now={NOW} />));
    expect(screen.getByText(/10/)).toBeInTheDocument();
  });
});
