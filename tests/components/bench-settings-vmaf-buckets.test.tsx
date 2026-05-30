// 12-05 T5a Fix-B + AC-12 coverage — VMAF-Buckets number-Input refactor.
// 16-04: count narrowed 4 → 3; legacy-4 input recovers via banner+log;
// 1×3 horizontal layout; React.StrictMode logger-idempotency (audit-M1).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

const loggerInfo = vi.fn();
vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { BenchSettingsTab } from '@/components/bench/bench-settings-tab';
import type { BenchDefaults } from '@/components/bench/bench-defaults';

const MESSAGES = {
  bench: {
    settings: {
      title: 'Bench defaults',
      section: { sampling: 'Sampling', matrix: 'Default Matrix', vmaf: 'VMAF' },
      sampleCount: { label: 'Samples per file', help: '3 sweet-spot' },
      sampleDurationSeconds: { label: 'Sample duration (s)', help: '20 sweet-spot' },
      mode: {
        label: 'Default Mode',
        help: 'Initial mode',
        native: 'Native Sweep',
        vmafAnchored: 'VMAF-anchored',
      },
      encoders: { label: 'Default Encoders', help: 'Pre-selected' },
      presets: {
        label: 'Default Presets',
        help: 'Pre-selected presets',
        groupFast: 'Fast',
        groupBalanced: 'Balanced',
        groupSlow: 'Slow',
      },
      nativeValues: { label: 'Default Native Values', help: 'CRF/QP CSV' },
      vmafModel: { label: 'VMAF model', help: 'libvmaf model' },
      vmafBuckets: {
        label: 'VMAF Pareto Buckets',
        help: 'Three thresholds',
        bucket1: { label: 'Bucket 1 (highest quality)' },
        bucket2: { label: 'Bucket 2' },
        bucket3: { label: 'Bucket 3' },
        errors: {
          outOfRange: 'Value must be between 0 and 100',
          notDescending: 'Values must be strictly descending',
        },
        legacyFormatRecovered: 'Stored VMAF buckets were invalid — defaults (95/92/88) loaded.',
        dismissLegacyNotice: 'Dismiss notice',
        dismissAction: 'Dismiss',
      },
      save: 'Save defaults',
      saved: 'Bench defaults saved',
      saveFailed: 'Failed to save bench defaults',
      errors: { vmafBuckets: 'VMAF buckets invalid' },
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

const DEFAULTS_VALID: BenchDefaults = {
  mode: 'native-sweep',
  encoders: ['libx265'],
  presets: ['veryfast', 'medium', 'slow'],
  nativeValues: '23,28',
  sampleCount: 3,
  sampleDurationSec: 20,
  vmafModel: 'vmaf_v0.6.1',
  vmafBuckets: '95,92,88',
};

function withVmafBuckets(value: string): BenchDefaults {
  return { ...DEFAULTS_VALID, vmafBuckets: value };
}

describe('BenchSettingsTab VMAF-Buckets (16-04: 3-input 1×3)', () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    routerRefresh.mockReset();
    loggerInfo.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
  });

  // AC-3 case: render-default — defaults.vmafBuckets='95,92,88'
  // → exactly 3 inputs render with values 95/92/88.
  it('test_render_default_csv_renders_3_number_inputs_with_parsed_values', () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    expect(screen.getByLabelText('Bucket 1 (highest quality)')).toHaveValue(95);
    expect(screen.getByLabelText('Bucket 2')).toHaveValue(92);
    expect(screen.getByLabelText('Bucket 3')).toHaveValue(88);
    expect(screen.queryByLabelText('Bucket 4 (lowest)')).toBeNull();
    const b1 = screen.getByLabelText('Bucket 1 (highest quality)') as HTMLInputElement;
    expect(b1.type).toBe('number');
    expect(b1.min).toBe('0');
    expect(b1.max).toBe('100');
    expect(b1.step).toBe('1');
  });

  // AC-3 case: 1×3 horizontal grid class applied.
  it('test_grid_wrapper_uses_three_column_layout', () => {
    const { container } = render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    // The bucket grid wrapper is the closest ancestor of bucket-1 with grid-cols-3.
    const b1 = screen.getByLabelText('Bucket 1 (highest quality)');
    const wrapperDiv = b1.closest('.grid');
    expect(wrapperDiv).not.toBeNull();
    expect(wrapperDiv?.className).toContain('grid-cols-3');
    expect(wrapperDiv?.className).not.toContain('grid-cols-2');
    // Ensure exactly 3 number-inputs render in that grid (descending semantic 1→2→3).
    const inputs = wrapperDiv?.querySelectorAll('input[type="number"]') ?? [];
    expect(inputs.length).toBe(3);
    // DOM-order = visual-order = descending semantic (M14 carry-forward).
    expect(inputs[0].getAttribute('id')).toBe('bench-vmaf-bucket-1');
    expect(inputs[1].getAttribute('id')).toBe('bench-vmaf-bucket-2');
    expect(inputs[2].getAttribute('id')).toBe('bench-vmaf-bucket-3');
    // Suppress unused-var lint on container.
    expect(container).toBeTruthy();
  });

  it('test_valid_descending_state_save_button_enabled', () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).not.toBeDisabled();
  });

  it('test_invalid_descending_surfaces_inline_error_and_disables_save', async () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    const b2 = screen.getByLabelText('Bucket 2') as HTMLInputElement;
    await userEvent.clear(b2);
    await userEvent.type(b2, '99');
    expect(b2).toHaveValue(99);
    expect(screen.getByText('Values must be strictly descending')).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).toBeDisabled();
  });

  it('test_out_of_range_surfaces_inline_error_and_disables_save', async () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    const b1 = screen.getByLabelText('Bucket 1 (highest quality)') as HTMLInputElement;
    await userEvent.clear(b1);
    await userEvent.type(b1, '150');
    expect(b1).toHaveValue(150);
    expect(screen.getByText('Value must be between 0 and 100')).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).toBeDisabled();
  });

  // 16-04 AC-9: csv-serialization on save uses 3-csv shape.
  it('test_csv_serialization_on_save_preserves_three_csv_shape', async () => {
    const fetchMock = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init?.body ?? '{}') as string);
    expect(body.settings.bench_vmaf_buckets).toBe('95,92,88');
  });

  // 16-04 AC-4: legacy 4-element string → null parse → fallback [95,92,88] + banner.
  it('test_legacy_4_value_csv_falls_back_to_3_default_and_renders_banner', () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />));
    expect(screen.getByLabelText('Bucket 1 (highest quality)')).toHaveValue(95);
    expect(screen.getByLabelText('Bucket 2')).toHaveValue(92);
    expect(screen.getByLabelText('Bucket 3')).toHaveValue(88);
    expect(screen.queryByLabelText('Bucket 4 (lowest)')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // 16-04 AC-4: legacy 4-element → logger.info exactly-once with legacyValue payload.
  it('test_legacy_4_value_csv_emits_logger_event_exactly_once', async () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />));
    await waitFor(() => {
      expect(loggerInfo).toHaveBeenCalledTimes(1);
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      { legacyValue: '95,92,88,85' },
      'bench_vmaf_buckets_legacy_format_recovered',
    );
  });

  // 16-04 audit-M1: React.StrictMode dev-double-mount must not double-emit.
  it('test_strict_mode_dev_double_mount_emits_logger_only_once', async () => {
    render(
      <React.StrictMode>
        {wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />)}
      </React.StrictMode>,
    );
    // useRef-guarded — wait a tick then assert exactly-once.
    await waitFor(() => {
      expect(loggerInfo).toHaveBeenCalledTimes(1);
    });
  });

  // 16-04 AC-4: dismiss-button hides banner.
  it('test_dismiss_button_hides_legacy_banner', async () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />));
    expect(screen.getByRole('status')).toBeInTheDocument();
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss notice' });
    await userEvent.click(dismissBtn);
    expect(screen.queryByRole('status')).toBeNull();
  });

  // 16-04 AC-4: first bucket-edit clears legacy banner (banner intent: "you didn't change this").
  it('test_first_bucket_edit_clears_legacy_banner', async () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />));
    expect(screen.getByRole('status')).toBeInTheDocument();
    const b1 = screen.getByLabelText('Bucket 1 (highest quality)') as HTMLInputElement;
    await userEvent.clear(b1);
    await userEvent.type(b1, '96');
    expect(screen.queryByRole('status')).toBeNull();
  });

  // Valid 3-element csv → NO banner + NO logger emission.
  it('test_valid_3_value_csv_emits_no_logger_event_and_no_banner', () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    expect(screen.queryByRole('status')).toBeNull();
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  // NaN-guard (M9 carry-forward): non-numeric inside csv → fallback + banner + logger event.
  it('test_csv_with_nan_triggers_fallback_path_and_logger_event', async () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,abc,88')} />));
    expect(screen.getByLabelText('Bucket 1 (highest quality)')).toHaveValue(95);
    expect(screen.getByLabelText('Bucket 3')).toHaveValue(88);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await waitFor(() => {
      expect(loggerInfo).toHaveBeenCalledTimes(1);
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      { legacyValue: '95,abc,88' },
      'bench_vmaf_buckets_legacy_format_recovered',
    );
  });

  // 16-04 AC-6: banner text contains the new 3-csv default-tuple "(95/92/88)".
  it('test_legacy_banner_text_contains_3_csv_default_tuple', () => {
    render(wrap(<BenchSettingsTab defaults={withVmafBuckets('95,92,88,85')} />));
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/\(95\/92\/88\)/);
    expect(banner).not.toHaveTextContent(/\(95\/92\/88\/85\)/);
  });

  // 16-04 AC-3: page renders exactly three number-inputs (count-hard-check
  // independent of label-resolution).
  it('test_exactly_three_number_inputs_render_under_vmaf_buckets_section', () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    const ids = ['bench-vmaf-bucket-1', 'bench-vmaf-bucket-2', 'bench-vmaf-bucket-3'];
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
    expect(document.getElementById('bench-vmaf-bucket-4')).toBeNull();
    expect(document.getElementById('bench-vmaf-bucket-5')).toBeNull();
  });

  // 16-04 AC-9: csv-shape of the save payload reflects operator edits
  // (not the initial-defaults string).
  it('test_save_payload_csv_reflects_edited_bucket_values', async () => {
    const fetchMock = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<BenchSettingsTab defaults={DEFAULTS_VALID} />));
    const b1 = screen.getByLabelText('Bucket 1 (highest quality)') as HTMLInputElement;
    await userEvent.clear(b1);
    await userEvent.type(b1, '96');
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init?.body ?? '{}') as string);
    expect(body.settings.bench_vmaf_buckets).toBe('96,92,88');
  });
});
