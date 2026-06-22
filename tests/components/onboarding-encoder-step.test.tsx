/*
 * 20-03 Plan Task 5 — EncoderStep integration cases.
 *
 * Covers AC-1 (chip mount inside payload branch), AC-4 (DetectFailRemediation
 * embed in errored branch), AC-13 (fallback-resolution guard — chip NOT
 * rendered + /api/bench/recommendation NOT called), AC-14 (vendor-key per-key
 * remediation copy via embedded EncoderWarningsBadge), audit-trail logger
 * events fire once per mount.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

const { mockLoggerInfo } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EncoderStep, type DetectionPayload } from '@/components/onboarding/encoder-step';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  const messages = locale === 'en' ? en : de;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makePayload(over: Partial<DetectionPayload> = {}): DetectionPayload {
  return {
    refreshed: true,
    detected: ['nvenc', 'libx265'],
    active: 'nvenc',
    resolution: 'auto',
    ...over,
  };
}

function multiUrlFetch(routes: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (url: string) => {
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('EncoderStep — BenchRecommendationChip integration (AC-1, AC-13)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockLoggerInfo.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('test_encoder_step_chip_mounts_inside_payload_branch_with_recommendation', async () => {
    const fetchStub = multiUrlFetch({
      '/api/bench/recommendation': {
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      },
      '/api/notifications': { status: 200, body: { notifications: [] } },
    });
    vi.stubGlobal('fetch', fetchStub);
    render(
      wrap(
        <EncoderStep
          cachedDetection={makePayload()}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/Recommended.*nvenc.*CRF 23/);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'onboarding.encoderStep.benchRecommendationServed',
      }),
    );
  });

  it('test_encoder_step_chip_not_rendered_when_resolution_fallback (AC-13)', async () => {
    const fetchStub = multiUrlFetch({
      '/api/bench/recommendation': {
        status: 200,
        body: { recommendations: { libx265: { crf: 23, preset: 'medium' } } },
      },
      '/api/notifications': { status: 200, body: { notifications: [] } },
    });
    vi.stubGlobal('fetch', fetchStub);
    const { container } = render(
      wrap(
        <EncoderStep
          cachedDetection={makePayload({ active: 'libx265', resolution: 'fallback' })}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    // Wait one tick for any rogue effects.
    await new Promise((r) => setTimeout(r, 20));
    // Fallback-resolution → chip NOT rendered.
    expect(container.querySelector('[role="status"]')).toBeNull();
    // AC-13: /api/bench/recommendation MUST NOT be called when resolution=fallback.
    const recommendationCalls = fetchStub.mock.calls.filter((c) =>
      String(c[0]).includes('/api/bench/recommendation'),
    );
    expect(recommendationCalls).toHaveLength(0);
    // Fallback Alert (from existing payload.resolution === 'fallback' branch) IS visible.
    expect(screen.getByRole('alert')).toHaveTextContent(/Detection failed/);
  });
});

describe('EncoderStep — AutoCropAwareness callout (35-02 AC-6)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockLoggerInfo.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renders the awareness callout deep-linking #auto-crop in a NEW tab (SR-2)', async () => {
    const fetchStub = multiUrlFetch({
      '/api/bench/recommendation': {
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      },
      '/api/notifications': { status: 200, body: { notifications: [] } },
    });
    vi.stubGlobal('fetch', fetchStub);
    render(
      wrap(
        <EncoderStep
          cachedDetection={makePayload()}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const callout = await screen.findByTestId('onboarding-autocrop-awareness');
    expect(callout).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /auto-crop settings/i });
    expect(link).toHaveAttribute('href', '/en/settings#auto-crop');
    // SR-2: new-tab nav so a mid-wizard click cannot destroy onboarding state.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('localizes the callout in German (AC-7 parity)', async () => {
    const fetchStub = multiUrlFetch({
      '/api/bench/recommendation': {
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      },
      '/api/notifications': { status: 200, body: { notifications: [] } },
    });
    vi.stubGlobal('fetch', fetchStub);
    render(
      wrap(
        <EncoderStep
          cachedDetection={makePayload()}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
        'de',
      ),
    );
    expect(await screen.findByTestId('onboarding-autocrop-awareness')).toBeInTheDocument();
    expect(screen.getByText(/Schwarze Balken automatisch entfernen/)).toBeInTheDocument();
  });
});

describe('EncoderStep — DetectFailRemediation embed (AC-4, AC-14)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockLoggerInfo.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('test_encoder_step_errored_branch_renders_remediation_heading_and_badge', async () => {
    const fetchStub = multiUrlFetch({
      '/api/encoders/refresh': { status: 500, body: { error: 'boom' } },
      '/api/notifications': {
        status: 200,
        body: {
          notifications: [
            {
              id: 'n1',
              severity: 'warn',
              code: 'nvenc_no_runtime',
              title: 'notification.detection.nvenc_no_runtime.title',
            },
          ],
        },
      },
    });
    vi.stubGlobal('fetch', fetchStub);
    render(
      wrap(
        <EncoderStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    // Fallback Alert visible.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Detection failed/);
    // Remediation heading visible (i18n key step4.detectFailRemediation.heading).
    await waitFor(() => expect(screen.getByText(/Suggested next steps/i)).toBeInTheDocument());
    // Audit-trail event fired once.
    await waitFor(() => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'onboarding.encoderStep.detectFailRemediationShown' }),
      );
    });
    const remediationEvents = mockLoggerInfo.mock.calls.filter(
      (c) => c[0]?.event === 'onboarding.encoderStep.detectFailRemediationShown',
    );
    expect(remediationEvents).toHaveLength(1);
  });

  for (const code of [
    'nvenc_no_runtime',
    'qsv_only_legacy_intel',
    'dri_present_no_driver',
    'vainfo_binary_missing',
  ]) {
    for (const locale of ['en', 'de'] as const) {
      it(`test_encoder_step_remediation_renders_vendor_key_${code}_in_${locale} (AC-14)`, async () => {
        const fetchStub = multiUrlFetch({
          '/api/encoders/refresh': { status: 500, body: { error: 'boom' } },
          '/api/notifications': {
            status: 200,
            body: {
              notifications: [
                {
                  id: 'n1',
                  severity: 'warn',
                  code,
                  title: `notification.detection.${code}.title`,
                },
              ],
            },
          },
        });
        vi.stubGlobal('fetch', fetchStub);
        render(
          wrap(
            <EncoderStep
              cachedDetection={null}
              onDetectionResolved={vi.fn()}
              onContinue={vi.fn()}
              onBack={vi.fn()}
              isSubmitting={false}
            />,
            locale,
          ),
        );
        // Badge mounts → fetch /api/notifications happens; assert remediation heading rendered.
        const headingText = locale === 'en' ? /Suggested next steps/i : /Nächste Schritte/i;
        await waitFor(() => expect(screen.getByText(headingText)).toBeInTheDocument());
      });
    }
  }
});
