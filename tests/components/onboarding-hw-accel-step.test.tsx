/*
 * Phase 18 Plan 18-02 — HwAccelStep tests.
 *
 * Render-branch tests (4 vendor-keyed): active / nvidia / software / legacyIntel.
 * CTA + a11y (4): Test-now button, submitLockRef double-click guard,
 * Continue-anyway, Active-Continue.
 * Error-paths (2): AbortError, 5xx.
 * Test-now cache-bypass (1): amber → green transition on re-detection.
 * StrictMode dev-double-mount (1): fetch called exactly once per logical mount.
 * Branch resolver (1): legacyIntel-warning wins over active-encoder.
 * EncoderStep regression at wizard position 4 (2): cached-read, fallback-probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

import { HwAccelStep, resolveBranch } from '@/components/onboarding/hw-accel-step';
import { EncoderStep, type DetectionPayload } from '@/components/onboarding/encoder-step';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

type DetectionWithWarnings = DetectionPayload & {
  warnings?: Array<{ code: string }>;
};

function makePayload(over: Partial<DetectionWithWarnings> = {}): DetectionWithWarnings {
  return {
    refreshed: true,
    detected: ['libx265'],
    active: 'libx265',
    resolution: 'auto',
    ...over,
  };
}

function mockFetchOnce(payload: DetectionWithWarnings | 'error', status = 200) {
  return vi.fn(async () => {
    if (payload === 'error') {
      return new Response('boom', { status: 500 });
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('HwAccelStep — branch resolver (pure)', () => {
  it('test_hw_accel_step_branch_resolver_priority_legacy_intel_wins_over_active', () => {
    // legacyIntel-warning even with QSV detected → legacyIntel branch wins.
    const p = makePayload({
      detected: ['qsv', 'libx265'],
      warnings: [{ code: 'qsv_only_legacy_intel' }],
    });
    expect(resolveBranch(p)).toBe('legacyIntel');
  });
});

describe('HwAccelStep — render branches', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_hw_accel_step_renders_active_branch_when_nvenc_detected', async () => {
    const payload = makePayload({ detected: ['nvenc', 'libx265'], active: 'nvenc' });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    expect(
      await screen.findByRole('region', { name: /Hardware acceleration active/i }),
    ).toBeInTheDocument();
  });

  it('test_hw_accel_step_renders_nvidia_branch_when_nvenc_no_runtime_warning', async () => {
    const payload = makePayload({
      detected: ['libx265'],
      warnings: [{ code: 'nvenc_no_runtime' }],
    });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    expect(
      await screen.findByRole('region', { name: /NVIDIA plugin missing/i }),
    ).toBeInTheDocument();
  });

  it('test_hw_accel_step_renders_software_branch_when_only_libx265_no_nvidia_device', async () => {
    const payload = makePayload({ detected: ['libx265'] });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    expect(
      await screen.findByRole('region', { name: /Software encoding active/i }),
    ).toBeInTheDocument();
  });

  it('test_hw_accel_step_renders_legacy_intel_branch_when_qsv_only_legacy_intel_warning', async () => {
    const payload = makePayload({
      detected: ['vaapi', 'libx265'],
      warnings: [{ code: 'qsv_only_legacy_intel' }],
    });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    expect(await screen.findByRole('region', { name: /Legacy Intel iGPU/i })).toBeInTheDocument();
  });
});

describe('HwAccelStep — CTA + a11y', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_hw_accel_step_active_branch_continue_button_calls_onContinue', async () => {
    const payload = makePayload({ detected: ['nvenc'], active: 'nvenc' });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    const onContinue = vi.fn();
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await screen.findByRole('region', { name: /Hardware acceleration active/i });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('test_hw_accel_step_continue_anyway_visible_in_nvidia_branch_calls_onContinue', async () => {
    const payload = makePayload({
      detected: ['libx265'],
      warnings: [{ code: 'nvenc_no_runtime' }],
    });
    vi.stubGlobal('fetch', mockFetchOnce(payload));
    const onContinue = vi.fn();
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });
    fireEvent.click(screen.getByRole('button', { name: /Continue with software encoding/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('test_hw_accel_step_test_now_button_reruns_detection_with_cache_bypass', async () => {
    // First mount: nvenc_no_runtime → amber branch. Test-now refires fetch.
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      const payload = makePayload({
        detected: ['libx265'],
        warnings: [{ code: 'nvenc_no_runtime' }],
      });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });
    expect(callCount).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Test now$/i }));
    await waitFor(() => {
      expect(callCount).toBe(2);
    });
  });

  it('test_hw_accel_step_test_now_button_submit_lock_prevents_double_click', async () => {
    let resolveSecond: ((res: Response) => void) | null = null;
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify(
            makePayload({
              detected: ['libx265'],
              warnings: [{ code: 'nvenc_no_runtime' }],
            }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });
    const testNow = screen.getByRole('button', { name: /^Test now$/i });
    fireEvent.click(testNow);
    fireEvent.click(testNow);
    fireEvent.click(testNow);
    // submitLockRef + button-disabled → only ONE in-flight fetch beyond mount.
    expect(callCount).toBe(2);
    // Resolve to clean up.
    if (resolveSecond) {
      (resolveSecond as (res: Response) => void)(
        new Response(JSON.stringify(makePayload({ detected: ['libx265'] })), { status: 200 }),
      );
    }
  });
});

describe('HwAccelStep — error paths', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_hw_accel_step_renders_inline_error_when_detect_returns_5xx', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('error'));
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Detection failed/i);
  });

  it('test_hw_accel_step_renders_inline_error_when_detect_aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Detection failed/i);
  });
});

describe('HwAccelStep — Test-now 2-payload sequence (AC-4 strengthened)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_test_now_button_re_renders_to_active_branch_when_second_payload_includes_nvenc', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify(
            makePayload({
              detected: ['libx265'],
              warnings: [{ code: 'nvenc_no_runtime' }],
            }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify(makePayload({ detected: ['nvenc'], active: 'nvenc', warnings: [] })),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <HwAccelStep
          cachedDetection={null}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });
    fireEvent.click(screen.getByRole('button', { name: /^Test now$/i }));
    expect(
      await screen.findByRole('region', { name: /Hardware acceleration active/i }),
    ).toBeInTheDocument();
  });
});

describe('HwAccelStep — React.StrictMode dev-double-mount (AC-15)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_hw_accel_step_useEffect_fires_fetch_exactly_once_under_strict_mode', async () => {
    const fetchMock = mockFetchOnce(makePayload({ detected: ['libx265'] }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <StrictMode>
        {wrap(
          <HwAccelStep
            cachedDetection={null}
            onDetectionResolved={vi.fn()}
            onContinue={vi.fn()}
            onBack={vi.fn()}
            isSubmitting={false}
          />,
        )}
      </StrictMode>,
    );
    await screen.findByRole('region', { name: /Software encoding active/i });
    // Even with StrictMode double-mount, probeFiredRef guards the fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HwAccelStep — 23-06 NVENC requirements (AC-2/AC-3/AC-7)', () => {
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  function renderStep(
    node: React.ReactNode = (
      <HwAccelStep
        cachedDetection={null}
        onDetectionResolved={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
        isSubmitting={false}
      />
    ),
  ) {
    return render(wrap(node));
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_hw_accel_step_software_branch_renders_nvidia_hint_with_per_field_copy', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(makePayload({ detected: ['libx265'] })));
    renderStep();
    expect(await screen.findByText('Running an NVIDIA GPU?')).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Copy extra parameter --runtime=nvidia'),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Copy variable name NVIDIA_VISIBLE_DEVICES'),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Copy variable value all')).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Copy variable name NVIDIA_DRIVER_CAPABILITIES'),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Copy variable value compute,video,utility'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/--gpus all/)).toBeNull();
  });

  it('test_hw_accel_step_legacy_intel_branch_does_NOT_render_nvidia_hint', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        makePayload({
          detected: ['vaapi', 'libx265'],
          warnings: [{ code: 'qsv_only_legacy_intel' }],
        }),
      ),
    );
    renderStep();
    await screen.findByRole('region', { name: /Legacy Intel iGPU/i });
    expect(screen.queryByText('Running an NVIDIA GPU?')).toBeNull();
    expect(screen.queryByLabelText('Copy extra parameter --runtime=nvidia')).toBeNull();
  });

  it('test_hw_accel_step_nvidia_branch_per_field_copy_writes_BARE_values_never_joined', async () => {
    const writeText = stubClipboard();
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        makePayload({ detected: ['libx265'], warnings: [{ code: 'nvenc_no_runtime' }] }),
      ),
    );
    renderStep();
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });

    fireEvent.click(await screen.findByLabelText('Copy extra parameter --runtime=nvidia'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('--runtime=nvidia'));
    fireEvent.click(await screen.findByLabelText('Copy variable name NVIDIA_VISIBLE_DEVICES'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('NVIDIA_VISIBLE_DEVICES'));
    fireEvent.click(await screen.findByLabelText('Copy variable value all'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('all'));
    fireEvent.click(await screen.findByLabelText('Copy variable name NVIDIA_DRIVER_CAPABILITIES'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('NVIDIA_DRIVER_CAPABILITIES'));
    fireEvent.click(await screen.findByLabelText('Copy variable value compute,video,utility'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('compute,video,utility'));

    // AUDIT-M1: no copy button ever writes a joined KEY=value paste value.
    const joined = writeText.mock.calls.some((c) => /^NVIDIA_[A-Z_]+=/.test(String(c[0])));
    expect(joined).toBe(false);
    expect(screen.queryByText(/--gpus all/)).toBeNull();
  });

  it('test_hw_accel_step_copy_feedback_keyed_per_button_not_shared', async () => {
    stubClipboard();
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        makePayload({ detected: ['libx265'], warnings: [{ code: 'nvenc_no_runtime' }] }),
      ),
    );
    renderStep();
    await screen.findByRole('region', { name: /NVIDIA plugin missing/i });

    const extraBtn = await screen.findByLabelText('Copy extra parameter --runtime=nvidia');
    const nameBtn = await screen.findByLabelText('Copy variable name NVIDIA_VISIBLE_DEVICES');
    fireEvent.click(extraBtn);
    await waitFor(() => expect(extraBtn.querySelector('.lucide-check')).not.toBeNull());
    // Sibling button must NOT have flipped (per-field state key, not shared bool).
    expect(nameBtn.querySelector('.lucide-check')).toBeNull();
    expect(nameBtn.querySelector('.lucide-copy')).not.toBeNull();
  });

  it('test_hw_accel_step_nvidia_steps_mention_both_variables_en_and_de', async () => {
    for (const messages of [en, de] as const) {
      vi.stubGlobal(
        'fetch',
        mockFetchOnce(
          makePayload({ detected: ['libx265'], warnings: [{ code: 'nvenc_no_runtime' }] }),
        ),
      );
      render(
        <NextIntlClientProvider
          locale={messages === en ? 'en' : 'de'}
          messages={messages}
          timeZone="UTC"
        >
          <HwAccelStep
            cachedDetection={null}
            onDetectionResolved={vi.fn()}
            onContinue={vi.fn()}
            onBack={vi.fn()}
            isSubmitting={false}
          />
        </NextIntlClientProvider>,
      );
      await screen.findByRole('region', { name: /NVIDIA plugin missing|NVIDIA-Plugin fehlt/i });
      const list = screen.getByRole('list');
      expect(list).toHaveTextContent('NVIDIA_VISIBLE_DEVICES');
      expect(list).toHaveTextContent('NVIDIA_DRIVER_CAPABILITIES');
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});

describe('EncoderStep at wizard position 4 — cached-detection regression (AC-3)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_encoder_step_at_position_4_reads_cached_detection_no_refetch', async () => {
    // 20-03: with BenchRecommendationChip mounted in the payload branch the
    // chip fetches /api/bench/recommendation per AC-1; the original AC-3
    // intent (cached-detection → no encoder re-probe) is preserved by
    // asserting /api/encoders/refresh specifically is NOT re-called.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ recommendations: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const cached: DetectionPayload = {
      refreshed: true,
      detected: ['nvenc', 'libx265'],
      active: 'nvenc',
      resolution: 'auto',
    };
    render(
      wrap(
        <EncoderStep
          cachedDetection={cached}
          onDetectionResolved={vi.fn()}
          onContinue={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    // Allow chip + badge effects to settle before asserting absence of probe.
    await new Promise((r) => setTimeout(r, 20));
    const refreshCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/encoders/refresh'),
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it('test_encoder_step_at_position_4_falls_back_to_probe_when_cache_null', async () => {
    const fetchMock = mockFetchOnce(makePayload({ detected: ['libx265'] }));
    vi.stubGlobal('fetch', fetchMock);
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
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/encoders/refresh', expect.anything());
    });
  });
});
