// 11-06 T3: BenchSettingsTab erweitert auf 8 Felder + 3 Section-Header.

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

// 12-05 T3 AC-12: BenchSettingsTab imports `logger` for the audit-trail
// emission on legacy-format recovery. Mock the module so tests don't hit
// pino + ring-buffer in jsdom (server-only path).
vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
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
        legacyFormatRecovered: 'Defaults loaded.',
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

const DEFAULTS: BenchDefaults = {
  mode: 'native-sweep',
  encoders: ['libx265'],
  presets: ['veryfast', 'medium', 'slow'],
  nativeValues: '23,28',
  sampleCount: 3,
  sampleDurationSec: 20,
  vmafModel: 'vmaf_v0.6.1',
  vmafBuckets: '95,92,88',
};

describe('BenchSettingsTab (11-06 expanded 8-field)', () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    routerRefresh.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
  });

  it('test_renders_all_8_fields_plus_3_section_headers', () => {
    const { container } = render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    // 3 section headers
    expect(screen.getByText('Sampling')).toBeInTheDocument();
    expect(screen.getByText('Default Matrix')).toBeInTheDocument();
    expect(screen.getByText('VMAF')).toBeInTheDocument();
    // 8 fields — labels (3 bucket-inputs + 1 mode-fieldset + encoders-fieldset + presets-fieldset + 1 vmaf-text-input)
    expect(screen.getByLabelText('Samples per file')).toBeInTheDocument();
    expect(screen.getByLabelText('Sample duration (s)')).toBeInTheDocument();
    expect(screen.getByText('Default Mode')).toBeInTheDocument();
    expect(screen.getByText('Default Encoders')).toBeInTheDocument();
    expect(screen.getByText('Default Presets')).toBeInTheDocument();
    expect(screen.getByLabelText('Default Native Values')).toBeInTheDocument();
    expect(screen.getByLabelText('VMAF model')).toBeInTheDocument();
    // 12-05 T3 Fix-B + 16-04 reduce: vmafBuckets section heading is a <p>
    // (no label); 3 dedicated number-Inputs each carry their own bucketN.label.
    expect(screen.getByText('VMAF Pareto Buckets')).toBeInTheDocument();
    expect(screen.getByLabelText('Bucket 1 (highest quality)')).toBeInTheDocument();
    expect(screen.getByLabelText('Bucket 3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bucket 4 (lowest)')).toBeNull();
    // Container max-w-2xl
    const form = container.querySelector('form');
    expect(form?.className).toContain('max-w-2xl');
  });

  it('test_defaults_pre_populated_correctly', () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    expect(screen.getByLabelText('Samples per file')).toHaveValue(3);
    expect(screen.getByLabelText('Sample duration (s)')).toHaveValue(20);
    expect(screen.getByLabelText('Default Native Values')).toHaveValue('23,28');
    expect(screen.getByLabelText('VMAF model')).toHaveValue('vmaf_v0.6.1');
    // 12-05 T3 Fix-B + 16-04 reduce: 3 dedicated number-Inputs.
    expect(screen.getByLabelText('Bucket 1 (highest quality)')).toHaveValue(95);
    expect(screen.getByLabelText('Bucket 2')).toHaveValue(92);
    expect(screen.getByLabelText('Bucket 3')).toHaveValue(88);
    expect(screen.queryByLabelText('Bucket 4 (lowest)')).toBeNull();
    // mode radio: native-sweep selected
    const nativeRadio = screen.getByRole('radio', { name: 'Native Sweep' });
    expect(nativeRadio).toBeChecked();
    // encoders: libx265 checked, others unchecked
    const libx265 = screen.getByRole('checkbox', { name: 'libx265' });
    expect(libx265).toBeChecked();
    const nvenc = screen.getByRole('checkbox', { name: 'hevc_nvenc' });
    expect(nvenc).not.toBeChecked();
  });

  it('test_mode_radio_toggle_changes_state', async () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    const vmafRadio = screen.getByRole('radio', { name: 'VMAF-anchored' });
    expect(vmafRadio).not.toBeChecked();
    await userEvent.click(vmafRadio);
    expect(vmafRadio).toBeChecked();
  });

  it('test_encoder_checkbox_toggle_adds_and_removes', async () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    const nvenc = screen.getByRole('checkbox', { name: 'hevc_nvenc' });
    await userEvent.click(nvenc);
    expect(nvenc).toBeChecked();
    await userEvent.click(nvenc);
    expect(nvenc).not.toBeChecked();
  });

  it('test_preset_checkbox_toggle_adds_and_removes', async () => {
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    const placebo = screen.getByRole('checkbox', { name: 'placebo' });
    expect(placebo).not.toBeChecked();
    await userEvent.click(placebo);
    expect(placebo).toBeChecked();
    await userEvent.click(placebo);
    expect(placebo).not.toBeChecked();
  });

  it('test_submit_button_fires_fetch_with_all_8_keys', async () => {
    const fetchMock = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    const body = JSON.parse((init?.body ?? '{}') as string);
    const settings = body.settings;
    expect(Object.keys(settings).sort()).toEqual(
      [
        'bench_default_encoders',
        'bench_default_mode',
        'bench_default_native_values',
        'bench_default_presets',
        'bench_sample_count',
        'bench_sample_duration_seconds',
        'bench_vmaf_buckets',
        'bench_vmaf_model',
      ].sort(),
    );
    expect(settings.bench_default_mode).toBe('native-sweep');
    expect(settings.bench_default_encoders).toBe('libx265');
  });

  it('test_save_shows_success_toast_on_ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Bench defaults saved');
    });
  });

  it('test_save_calls_router_refresh_on_ok_so_bench_page_picks_up_new_defaults', async () => {
    // 11-06 T6 fix: BenchSettingsTab.handleSave must invalidate the RSC cache
    // after successful PUT so /bench server-component re-reads new defaults
    // on next navigation. Without this, EnqueueForm stays pre-populated with
    // stale settings until hard-refresh — observed UAT failure 2026-05-12.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it('test_save_does_not_call_router_refresh_on_failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 400 }))),
    );
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('test_save_shows_error_toast_on_not_ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 400 }))),
    );
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to save bench defaults');
    });
  });

  it('test_save_button_disabled_while_in_flight', async () => {
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolveFetch = r;
          }),
      ),
    );
    render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    const btn = screen.getByRole('button', { name: 'Save defaults' });
    await userEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    resolveFetch(new Response('{}', { status: 200 }));
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
  });

  it('test_max_w_2xl_container_width_applied', () => {
    const { container } = render(wrap(<BenchSettingsTab defaults={DEFAULTS} />));
    const form = container.querySelector('form');
    expect(form?.className).toContain('max-w-2xl');
  });
});
