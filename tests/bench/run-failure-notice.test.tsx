// Plan 52-05 AC-2 (UI) + E8: run-level failure surfaces.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { PartialFailureNotice, RunFailedNotice } from '@/components/bench/run-failure-notice';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const BEFUND_REASON =
  'all_combos_failed:63|Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0';

describe('RunFailedNotice (52-05)', () => {
  it('test_notice_when_all_combos_failed_then_states_count', () => {
    render(wrap(<RunFailedNotice errorReason={BEFUND_REASON} />));
    expect(screen.getByText('All 63 combinations failed.')).toBeInTheDocument();
  });

  it('test_notice_when_all_combos_failed_then_shows_cause_line', () => {
    render(wrap(<RunFailedNotice errorReason={BEFUND_REASON} />));
    expect(screen.getByText(/Required: 13\.1 Found: 13\.0/)).toBeInTheDocument();
  });

  it('test_notice_when_all_combos_failed_then_shows_next_step_hint', () => {
    render(wrap(<RunFailedNotice errorReason={BEFUND_REASON} />));
    expect(screen.getByText(en.bench.runFailure.allFailedHint)).toBeInTheDocument();
  });

  it('test_notice_when_german_then_plural_sentence', () => {
    render(wrap(<RunFailedNotice errorReason={BEFUND_REASON} />, 'de'));
    expect(screen.getByText('Alle 63 Kombinationen sind fehlgeschlagen.')).toBeInTheDocument();
  });

  it('test_notice_when_legacy_reason_then_shows_raw_text', () => {
    render(wrap(<RunFailedNotice errorReason="boot_recovery_stale_running" />));
    expect(screen.getByText('boot_recovery_stale_running')).toBeInTheDocument();
  });

  it('test_notice_when_rendered_then_is_alert', () => {
    render(wrap(<RunFailedNotice errorReason={BEFUND_REASON} />));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('PartialFailureNotice (52-05 E8)', () => {
  it('test_partial_when_some_failed_then_states_failed_of_total', () => {
    render(wrap(<PartialFailureNotice failed={2} total={9} />));
    expect(
      screen.getByText('2 of 9 combinations failed; the results are based on the rest only.'),
    ).toBeInTheDocument();
  });

  it('test_partial_when_none_failed_then_renders_nothing', () => {
    render(wrap(<PartialFailureNotice failed={0} total={9} />));
    expect(screen.queryByTestId('bench-run-partial-failure')).toBeNull();
  });
});
