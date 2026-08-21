// 12-02 T4: ApplyFromBenchButton component tests — 12 cases.
// Covers AC-1..AC-12 (mount-fetch states + click setValue + sync-guard +
// audit-log + no-leak guard + auth-required distinct tooltip).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { UseFormReturn } from 'react-hook-form';
import enMessages from '@/messages/en.json';
import type { FormValues } from '@/src/lib/api/settings-serialize';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ApplyFromBenchButton } from '@/components/settings/apply-from-bench-button';
import { toast } from 'sonner';
import { logger } from '@/src/lib/logger';

const mockSetValue = vi.fn();

function makeMockForm(
  overrides: Partial<UseFormReturn<FormValues>> = {},
): UseFormReturn<FormValues> {
  return {
    setValue: mockSetValue,
    formState: { dirtyFields: {} } as UseFormReturn<FormValues>['formState'],
    ...overrides,
  } as unknown as UseFormReturn<FormValues>;
}

function renderButton(form: UseFormReturn<FormValues> = makeMockForm()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <ApplyFromBenchButton form={form} />
    </NextIntlClientProvider>,
  );
}

function mockFetchResponse(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

function mockFetchThrow(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('network error'))),
  );
}

function mockFetchPending(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
}

// Re-query button each tick — element reference goes stale when state transitions
// between tooltip-wrapped (disabled) and bare (ready) renders.
function currentButton(): HTMLElement {
  return screen.getByRole('button', { name: /Apply CRF values/ });
}

async function waitForReadyButton(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(currentButton()).not.toBeDisabled();
  });
  return currentButton();
}

async function waitForDisabledButton(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(currentButton()).toBeDisabled();
  });
  return currentButton();
}

describe('ApplyFromBenchButton (12-02)', () => {
  beforeEach(() => {
    mockSetValue.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('test_case_1_ready_state_renders_enabled_button', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
        nvenc: { crf: 21, preset: 'p4' },
        qsv: { crf: 19, preset: 'medium' },
        vaapi: { crf: 22, preset: null },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button.textContent).toBe('Apply from bench');
  });

  it('test_case_2_404_no_data_disabled_with_tooltipNoBench_and_logger_info', async () => {
    mockFetchResponse(404, { error: 'no_completed_bench_run', requestId: 'srv-abc' });
    renderButton();
    const button = await waitForDisabledButton();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => {
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('bench_recommendation_fetch_no_data');
    });
    // Tooltip-trigger wrapper present (base-ui renders TooltipContent only on
    // open-state; trigger wrapper signals tooltip is wired — content copy is
    // verified by the i18n structural-equality test in tests/i18n-completeness).
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeInTheDocument();
  });

  it('test_case_3_401_auth_required_distinct_tooltipAuthRequired_and_logger_warn', async () => {
    mockFetchResponse(401, { error_code: 'auth_required' });
    renderButton();
    await waitForDisabledButton();
    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'bench_recommendation_fetch_unauthorized',
      );
    });
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeInTheDocument();
  });

  it('test_case_4_500_fetch_error_tooltipFetchError_and_logger_error', async () => {
    mockFetchResponse(500, { error: 'internal_error', requestId: 'srv-xyz' });
    renderButton();
    await waitForDisabledButton();
    await waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        { status: 500 },
        'bench_recommendation_fetch_failed',
      );
    });
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeInTheDocument();
  });

  it('test_case_5_network_throw_logger_error_status_network', async () => {
    mockFetchThrow();
    renderButton();
    await waitForDisabledButton();
    await waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        { status: 'network' },
        'bench_recommendation_fetch_failed',
      );
    });
  });

  it('test_case_6_idle_loading_aria_busy_true_visible_loading_label', async () => {
    mockFetchPending();
    renderButton();
    const button = currentButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.textContent).toBe('Loading…');
    // tooltip-trigger structure wired during idle-loading; content (tooltipInitialLoading)
    // renders only on open-state — covered by manual UAT at T5.
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeInTheDocument();
  });

  it('test_case_7_click_setValue_all_4_crf_AND_3_preset_skipping_vaapi_null_AND_apply_log_with_presetCount', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
        nvenc: { crf: 21, preset: 'p4' },
        qsv: { crf: 19, preset: 'medium' },
        vaapi: { crf: 22, preset: null },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    // 4 CRF setValue calls + 3 preset setValue calls (vaapi null → skip).
    expect(mockSetValue).toHaveBeenCalledTimes(7);
    expect(mockSetValue).toHaveBeenCalledWith('crf_libx265', 20, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('crf_nvenc', 21, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('crf_qsv', 19, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('crf_vaapi', 22, {
      shouldDirty: true,
      shouldValidate: true,
    });
    // 12-03 V2: preset setValue calls (3 of 4 — vaapi null skipped).
    expect(mockSetValue).toHaveBeenCalledWith('preset_libx265', 'medium', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('preset_nvenc', 'p4', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('preset_qsv', 'medium', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    // 12-04 audit M4: payload shape — `runId` REPLACED by `resolvedRunId`;
    // new fields selection_source / selectedRunId / selectionMode / mode.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      {
        selection_source: 'default',
        selectedRunId: null,
        resolvedRunId: 42,
        selectionMode: 'default',
        mode: 'quality',
        completedAt: 1715600000,
        encoders: ['libx265', 'nvenc', 'qsv', 'vaapi'],
        count: 4,
        presetCount: 3,
      },
      'bench_recommendation_applied',
    );
  });

  it('test_case_8_partial_recommendations_only_setValue_present_keys_AND_their_preset', async () => {
    mockFetchResponse(200, {
      runId: 7,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    // 1 CRF + 1 preset setValue (libx265=medium Catalog-valid).
    expect(mockSetValue).toHaveBeenCalledTimes(2);
    expect(mockSetValue).toHaveBeenCalledWith('crf_libx265', 20, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('preset_libx265', 'medium', {
      shouldDirty: true,
      shouldValidate: true,
    });
    const setValueFields = mockSetValue.mock.calls.map((c) => c[0]);
    expect(setValueFields).not.toContain('crf_nvenc');
    expect(setValueFields).not.toContain('crf_qsv');
    expect(setValueFields).not.toContain('crf_vaapi');
    expect(setValueFields).not.toContain('preset_nvenc');
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        encoders: ['libx265'],
        count: 1,
        presetCount: 1,
        resolvedRunId: 7,
        selection_source: 'default',
        selectionMode: 'default',
        mode: 'quality',
      }),
      'bench_recommendation_applied',
    );
  });

  it('test_case_9_rapid_double_click_sync_guard_exactly_one_burst', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
        nvenc: { crf: 21, preset: 'p4' },
        qsv: { crf: 19, preset: 'medium' },
        vaapi: { crf: 22, preset: null },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    act(() => {
      button.click();
      button.click();
    });
    // 12-03 V2: 4 CRF + 3 preset (vaapi null skip) = 7 calls, single burst.
    expect(mockSetValue).toHaveBeenCalledTimes(7);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);
  });

  it('test_case_10_no_AlertDialog_rendered_on_click_with_dirty_form', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
      },
    });
    const dirtyForm = makeMockForm({
      formState: { dirtyFields: { crf_libx265: true } } as UseFormReturn<FormValues>['formState'],
    });
    renderButton(dirtyForm);
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mockSetValue).toHaveBeenCalled();
  });

  it('test_case_11_preset_field_setValue_when_Catalog_valid_12_03_V2', async () => {
    // 12-03 V2 INVERTS the 12-02 case-11 "preset ignored" contract: when
    // rec.preset is Catalog-valid, V2 setValue's the corresponding
    // preset_<encoder> field with shouldDirty + shouldValidate.
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(mockSetValue).toHaveBeenCalledWith('crf_libx265', 20, expect.anything());
    expect(mockSetValue).toHaveBeenCalledWith('preset_libx265', 'medium', {
      shouldDirty: true,
      shouldValidate: true,
    });
  });

  it('test_case_12_requestId_never_leaks_to_dom_toast_or_logger', async () => {
    const SECRET_ID = 'abc-123-uuid-leak-canary';
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      requestId: SECRET_ID,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(document.body.textContent).not.toContain(SECRET_ID);
    const toastCalls = vi
      .mocked(toast.success)
      .mock.calls.flatMap((c) => c.map((arg) => JSON.stringify(arg)));
    expect(toastCalls.some((s) => s.includes(SECRET_ID))).toBe(false);
    const loggerCalls = vi
      .mocked(logger.info)
      .mock.calls.flatMap((c) => c.map((arg) => JSON.stringify(arg)));
    expect(loggerCalls.some((s) => s.includes(SECRET_ID))).toBe(false);
  });

  // 12-03 V2: invalid Catalog preset → setValue skipped + skip-log emitted.
  it('test_case_13_invalid_preset_setValue_skipped_AND_skip_log_emitted_AND_presetCount_not_incremented', async () => {
    mockFetchResponse(200, {
      runId: 9,
      completedAt: 1715600000,
      recommendations: {
        qsv: { crf: 22, preset: 'turbo' },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    // CRF setValue fires; preset setValue SKIPPED (turbo ∉ Catalog).
    expect(mockSetValue).toHaveBeenCalledWith('crf_qsv', 22, expect.anything());
    const setValueFields = mockSetValue.mock.calls.map((c) => c[0]);
    expect(setValueFields).not.toContain('preset_qsv');
    // Diagnostic skip-log emitted.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { encoder: 'qsv', requested: 'turbo' },
      'bench_recommendation_preset_skipped',
    );
    // presetCount stays at 0.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        presetCount: 0,
        resolvedRunId: 9,
        mode: 'quality',
      }),
      'bench_recommendation_applied',
    );
  });

  // 12-03 V2: null preset → silent skip (null is expected back-compat shape).
  it('test_case_14_null_preset_silent_skip_no_skip_log', async () => {
    mockFetchResponse(200, {
      runId: 10,
      completedAt: 1715600000,
      recommendations: {
        vaapi: { crf: 22, preset: null },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(mockSetValue).toHaveBeenCalledWith('crf_vaapi', 22, expect.anything());
    const setValueFields = mockSetValue.mock.calls.map((c) => c[0]);
    expect(setValueFields).not.toContain('preset_vaapi');
    // null preset must NOT trigger the skip-log surface.
    const allInfoCalls = vi.mocked(logger.info).mock.calls.flatMap((c) => c);
    expect(
      allInfoCalls.some((arg) =>
        typeof arg === 'string'
          ? arg === 'bench_recommendation_preset_skipped'
          : arg && typeof arg === 'object',
      ),
    ).toBe(true); // applied-log fires regardless
    const skipLogFired = vi
      .mocked(logger.info)
      .mock.calls.some((c) => c[1] === 'bench_recommendation_preset_skipped');
    expect(skipLogFired).toBe(false);
  });

  // 12-03 audit SR7: toast.success carries BOTH counts. With 4 valid CRF + 3
  // valid preset (vaapi null skip), the en.json `{crfCount, presetCount,
  // runId}` placeholder set produces a string containing both numbers.
  // 12-04 V3 (Plan 12-04 audit M3 + M4 + AC-9 + AC-13)
  it('test_case_v3_1_url_carries_runId_and_mode_query_params', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            runId: 7,
            completedAt: 1715600000,
            recommendations: { libx265: { crf: 20, preset: 'medium' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const form = makeMockForm();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton
          form={form}
          runId={7}
          mode="balanced"
          selectionMeta={{
            selectionSource: 'operator',
            selectedRunId: 7,
            selectionMode: 'operator',
          }}
        />
      </NextIntlClientProvider>,
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [calledUrl] = (fetchSpy.mock.calls as unknown as Array<[unknown]>)[0];
    expect(String(calledUrl)).toMatch(/runId=7/);
    expect(String(calledUrl)).toMatch(/mode=balanced/);
  });

  it('test_case_v3_2_dynamic_label_when_operator_changed', async () => {
    mockFetchResponse(200, {
      runId: 7,
      completedAt: 1715600000,
      recommendations: { libx265: { crf: 20, preset: 'medium' } },
    });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton
          form={makeMockForm()}
          runId={7}
          mode="balanced"
          selectionMeta={{
            selectionSource: 'operator',
            selectedRunId: 7,
            selectionMode: 'operator',
          }}
        />
      </NextIntlClientProvider>,
    );
    const button = await waitForReadyButton();
    expect(button.textContent).toMatch(/Run #7/);
    expect(button.textContent).toMatch(/Balanced/);
  });

  it('test_case_v3_3_audit_log_payload_carries_selection_source_when_operator', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: { libx265: { crf: 20, preset: 'medium' } },
    });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton
          form={makeMockForm()}
          runId={42}
          mode="size"
          selectionMeta={{
            selectionSource: 'operator',
            selectedRunId: 42,
            selectionMode: 'operator',
          }}
        />
      </NextIntlClientProvider>,
    );
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        selection_source: 'operator',
        selectedRunId: 42,
        resolvedRunId: 42,
        selectionMode: 'operator',
        mode: 'size',
      }),
      'bench_recommendation_applied',
    );
  });

  it('test_case_v3_4_empty_mode_disabled_AND_empty_log_emitted_once', async () => {
    mockFetchResponse(200, {
      runId: 50,
      completedAt: 1715600000,
      recommendations: {},
    });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton
          form={makeMockForm()}
          runId={50}
          mode="balanced"
          selectionMeta={{
            selectionSource: 'operator',
            selectedRunId: 50,
            selectionMode: 'operator',
          }}
        />
      </NextIntlClientProvider>,
    );
    await waitForDisabledButton();
    await waitFor(() => {
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        { runId: 50, mode: 'balanced', reason: 'no_combos_with_role' },
        'bench_recommendation_empty_mode',
      );
    });
    // Empty-mode label collapses to base, no "(Balanced)" suffix.
    expect(currentButton().textContent).toBe('Apply from bench');
  });

  it('test_case_v3_5_abort_controller_fires_on_dep_change', async () => {
    // Audit M3 race-guard contract: when (runId, mode) deps change, the
    // effect cleanup MUST invoke AbortController.abort() on the prior
    // controller so an in-flight fetch is cancelled before its setState
    // can run. We spy on the AbortController constructor + abort method
    // to assert the cleanup ran exactly once on rerender.
    const realAbortController = global.AbortController;
    const abortSpy = vi.fn();
    let ctorCount = 0;
    class SpyAbortController extends realAbortController {
      constructor() {
        super();
        ctorCount++;
      }
      abort(reason?: unknown) {
        abortSpy(reason);
        super.abort(reason);
      }
    }
    vi.stubGlobal('AbortController', SpyAbortController);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})), // hang forever
    );
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton form={makeMockForm()} runId={1} mode="quality" />
      </NextIntlClientProvider>,
    );
    expect(ctorCount).toBeGreaterThan(0);
    // Change runId → effect cleanup MUST abort the prior controller.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApplyFromBenchButton form={makeMockForm()} runId={99} mode="quality" />
      </NextIntlClientProvider>,
    );
    expect(abortSpy).toHaveBeenCalled();
    vi.stubGlobal('AbortController', realAbortController);
  });

  it('test_case_15_toast_success_string_contains_both_crfCount_and_presetCount_SR7', async () => {
    mockFetchResponse(200, {
      runId: 42,
      completedAt: 1715600000,
      recommendations: {
        libx265: { crf: 20, preset: 'medium' },
        nvenc: { crf: 21, preset: 'p4' },
        qsv: { crf: 19, preset: 'medium' },
        vaapi: { crf: 22, preset: null },
      },
    });
    renderButton();
    const button = await waitForReadyButton();
    fireEvent.click(button);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    const toastArg = vi.mocked(toast.success).mock.calls[0][0];
    const rendered = String(toastArg);
    // Both counts surface to the operator (locale-independent number check).
    expect(rendered).toMatch(/4/);
    expect(rendered).toMatch(/3/);
  });
});
