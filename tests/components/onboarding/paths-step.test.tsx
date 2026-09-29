import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { wrap } from '../../test-utils';

// 23-03 Task 3 — PathsStep writable-gate. fetch + logger mocked; non-skip branch
// only (PathsStep is never mounted in the auto-skip branch).

const { mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn(), child: () => ({}) },
  default: {},
}));

import { PathsStep } from '@/components/onboarding/paths-step';

function probeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const INITIAL = { scan_root: '/media', min_size_mb: '50' };

async function enableForm(): Promise<void> {
  // Trigger onChange validation so form.formState.isValid flips true and the
  // Continue button enables.
  const input = screen.getByLabelText(/scan root/i);
  await userEvent.clear(input);
  await userEvent.type(input, '/media');
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled());
}

function continueBtn(): HTMLElement {
  return screen.getByRole('button', { name: /continue/i });
}

describe('PathsStep writable-gate', () => {
  beforeEach(() => {
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('test_probe_writable_true_then_onContinue_called_no_warning', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      probeResponse({ path: '/media', exists: true, readable: true, writable: true }),
    );
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('test_probe_writable_false_then_warning_checkbox_continue_disabled_no_advance', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      probeResponse({
        path: '/media',
        exists: true,
        readable: true,
        writable: false,
        error: 'EACCES',
      }),
    );
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(continueBtn()).toBeDisabled();
  });

  it('test_check_override_then_continue_advances_logs_once_and_posts_acknowledged', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      probeResponse({
        path: '/media',
        exists: true,
        readable: true,
        writable: false,
        error: 'EACCES',
      }),
    );
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(continueBtn()).not.toBeDisabled());
    await userEvent.click(continueBtn());

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    // browser override event logged exactly once.
    const overrideEvents = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .filter(
        (c) =>
          (c as { event?: string }).event === 'onboarding.pathsStep.writableOverrideAcknowledged',
      );
    expect(overrideEvents).toHaveLength(1);
    // second POST carries acknowledged:true (durable server trail).
    const ackCall = fetchMock.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return typeof init?.body === 'string' && init.body.includes('"acknowledged":true');
    });
    expect(ackCall).toBeDefined();
  });

  it('test_probe_2xx_skip_stub_no_writable_key_then_fail_open_no_warning', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      probeResponse({ skipped: true, requestId: 'build' }),
    );
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_probe_fetch_rejects_then_fail_open_and_warn_logged', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    const probeFailed = mockLoggerWarn.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { event?: string }).event === 'onboarding.pathsStep.probeFailed');
    expect(probeFailed).toBeDefined();
  });

  it('test_probe_non_2xx_then_fail_open', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      probeResponse({ error: 'internal_error' }, false, 500),
    );
    const onContinue = vi.fn();
    render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    await userEvent.click(continueBtn());
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_rapid_double_submit_while_probing_fires_single_probe_single_advance', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    const onContinue = vi.fn();
    const { container } = render(
      wrap(
        <PathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    await enableForm();
    const formEl = container.querySelector('form') as HTMLFormElement;
    // Two rapid submits while the first probe is still pending.
    fireEvent.submit(formEl);
    fireEvent.submit(formEl);
    await waitFor(() => expect(fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1));
    resolveFetch(probeResponse({ path: '/media', exists: true, readable: true, writable: true }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

describe('PathsStep writable-gate kill-switch', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('test_kill_switch_disabled_then_onContinue_immediate_fetch_never_called', async () => {
    vi.stubEnv('NEXT_PUBLIC_ONBOARDING_WRITABLE_GATE_DISABLED', '1');
    // re-import so the module-load constant captures the stubbed env.
    const { PathsStep: KillSwitchPathsStep } = await import('@/components/onboarding/paths-step');
    const onContinue = vi.fn();
    render(
      wrap(
        <KillSwitchPathsStep
          initialValues={INITIAL}
          onContinue={onContinue}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const input = screen.getByLabelText(/scan root/i);
    await userEvent.clear(input);
    await userEvent.type(input, '/media');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
