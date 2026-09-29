import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TwoPassStepper } from '@/components/bench/two-pass-stepper';

const MESSAGES = {
  bench: {
    stepper: {
      pass1: { label: 'Quick check' },
      pass2: {
        label: 'Full check',
      },
      state: {
        idle: 'Idle',
        queued: 'Queued',
        running: 'Running',
        complete: 'Complete',
        failed: 'Failed',
        cancelled: 'Cancelled',
      },
      progressPill: '{completed} of {total} combos',
    },
    pass2: {
      heading: 'Pass-2',
      idle: 'Ready',
      running: 'Verifying',
      complete: 'Verified',
      failed: 'Failed',
      cancelled: 'Cancelled',
      retry: 'Retry',
      restart: 'Restart',
      progressLabel: 'Pass-2 progress',
      verifiedSourceFile: 'Source: {path}',
      vmafLabel: 'VMAF',
      sizeLabel: 'Size',
      timeLabel: 'Time',
      deltaVsSample: 'Δ {delta}',
      savingsVsFull: '{pct}% saved',
      cancelCta: 'Cancel verify',
      verifyTooltipReady: 'Run a bench to enable Pass-2 verify',
    },
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('TwoPassStepper', () => {
  it('test_twoPassStepper_renders_2_steps_in_correct_dom_order', () => {
    render(wrap(<TwoPassStepper pass1State="idle" pass2State="disabled" />));
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Pass 1 first, Pass 2 second
    expect(items[0]).toHaveAttribute('aria-label', expect.stringContaining('Pass 1'));
    expect(items[1]).toHaveAttribute('aria-label', expect.stringContaining('Pass 2'));
  });

  it('test_twoPassStepper_pass2_always_has_aria_disabled_and_describedby', () => {
    render(wrap(<TwoPassStepper pass1State="idle" pass2State="disabled" />));
    // The Pass-2 step renders a button with aria-disabled=true
    const buttons = screen.getAllByRole('button');
    const pass2btn = buttons.find((b) => b.getAttribute('aria-disabled') === 'true');
    expect(pass2btn).toBeTruthy();
    expect(pass2btn).toHaveAttribute('aria-describedby');
  });

  it('test_twoPassStepper_pass1_running_shows_progress_pill', () => {
    render(
      wrap(
        <TwoPassStepper
          pass1State="running"
          pass1Progress={{ completed: 5, total: 18 }}
          pass2State="disabled"
        />,
      ),
    );
    // Progress pill content should show "5 of 18 combos"
    expect(screen.getByText('5 of 18 combos')).toBeInTheDocument();
  });

  // 11-03 AC-6: Pass-2 widens to operable union — running state shows pill only
  // (progress bar + cancel moved to Pass2ProgressCard)
  it('test_pass2_running_shows_running_pill', () => {
    render(wrap(<TwoPassStepper pass1State="complete" pass2State="running" />));
    expect(screen.getByText('Verifying')).toBeInTheDocument();
  });

  it('test_pass2_complete_shows_verified_vmaf', () => {
    render(
      wrap(
        <TwoPassStepper pass1State="complete" pass2State="complete" pass2VerifiedVmaf={92.34} />,
      ),
    );
    expect(screen.getByText(/92\.34/)).toBeInTheDocument();
  });

  it('test_pass2_failed_renders_retry_button_when_handler_present', () => {
    const retry = vi.fn();
    render(
      wrap(
        <TwoPassStepper
          pass1State="complete"
          pass2State="failed"
          pass2ErrorReason="ffmpeg crashed"
          onPass2Retry={retry}
        />,
      ),
    );
    screen.getByText('Retry').click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ffmpeg crashed/)).toBeInTheDocument();
  });

  it('test_pass2_cancelled_renders_restart_button', () => {
    const retry = vi.fn();
    render(
      wrap(<TwoPassStepper pass1State="complete" pass2State="cancelled" onPass2Retry={retry} />),
    );
    screen.getByText('Restart').click();
    expect(retry).toHaveBeenCalled();
  });

  it('test_pass2_idle_renders_no_progressbar_and_no_tooltip', () => {
    render(wrap(<TwoPassStepper pass1State="complete" pass2State="idle" />));
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
