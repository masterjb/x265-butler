import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// Mock engine-events-client before component import
vi.mock('@/src/lib/api/engine-events-client', () => ({
  useBenchRunState: vi.fn(() => ({
    runId: null,
    mode: null,
    status: 'idle',
    completedCombos: 0,
    totalCombos: 0,
    currentPhase: null,
    errorReason: null,
  })),
}));

// Mock bench-client
const mockEnqueue = vi.fn();
vi.mock('@/src/lib/api/bench-client', () => ({
  enqueueBenchRun: (...args: unknown[]) => mockEnqueue(...args),
}));

import { BenchEnqueueForm } from '@/components/bench/bench-enqueue-form';
import { useBenchRunState } from '@/src/lib/api/engine-events-client';

const mockedUseBenchRunState = vi.mocked(useBenchRunState);

const MESSAGES = {
  bench: {
    form: {
      submit: 'Start Benchmark',
      mode: {
        label: 'Mode',
        native: 'Native Sweep',
        vmafAnchored: 'VMAF-anchored',
        help: 'Choose mode',
        hint: 'Mode hint',
      },
      files: {
        label: 'File IDs',
        placeholder: 'e.g. 12, 47',
        help: 'Comma-separated',
        hint: 'Files hint',
      },
      encoders: { label: 'Encoders', help: 'At least 1', hint: 'Encoders hint' },
      presets: {
        label: 'Presets',
        hint: 'Presets hint',
        groupFast: 'Fast',
        groupBalanced: 'Balanced',
        groupSlow: 'Slow',
      },
      nativeValues: {
        label: 'Native values',
        placeholder: '20, 23, 26',
        help: 'CRF values',
        hint: 'Native values hint',
      },
      vmafTargets: {
        label: 'VMAF targets',
        placeholder: '95, 92',
        help: 'VMAF targets',
        hint: 'VMAF targets hint',
      },
      advanced: {
        label: 'Advanced',
        sampleCount: 'Samples per file',
        sampleDuration: 'Sample duration',
        vmafModel: 'VMAF model',
      },
      disclosure: {
        label: 'Review & override defaults',
        summary: {
          native:
            'Native · {encCount, plural, one {# encoder} other {# encoders}} · {presetCount, plural, one {# preset} other {# presets}} · CRF {values}',
          vmaf: 'VMAF · {encCount, plural, one {# encoder} other {# encoders}} · {presetCount, plural, one {# preset} other {# presets}} · VMAF {values}',
        },
      },
      reset: {
        cta: '↻ Reset to defaults',
        disabledHint: 'Already on defaults',
      },
      settingsLink: '→ Persist defaults in Settings',
      sampleSection: 'Sample configuration',
      errors: {
        required: 'Required',
        outOfRange: 'Out of range',
        tooMany: 'Too many',
        submitFailed: 'Submit failed',
        encoderRequired: 'At least one encoder required',
        presetRequired: 'At least one preset required',
      },
    },
  },
};

const MESSAGES_DE = {
  bench: {
    form: {
      submit: 'Benchmark starten',
      mode: {
        label: 'Modus',
        native: 'Native Sweep',
        vmafAnchored: 'VMAF-verankert',
        help: 'Hilfe',
        hint: 'Modus-Hinweis',
      },
      files: {
        label: 'Datei-IDs',
        placeholder: 'z.B. 12, 47',
        help: 'Kommagetrennt',
        hint: 'Dateien-Hinweis',
      },
      encoders: { label: 'Encoder', help: 'Mind. 1', hint: 'Encoder-Hinweis' },
      presets: {
        label: 'Presets',
        hint: 'Presets-Hinweis',
        groupFast: 'Schnell',
        groupBalanced: 'Ausgewogen',
        groupSlow: 'Langsam',
      },
      nativeValues: {
        label: 'Native Werte',
        placeholder: '20, 23, 26',
        help: 'CRF',
        hint: 'CRF-Hinweis',
      },
      vmafTargets: {
        label: 'VMAF-Zielwerte',
        placeholder: '95, 92',
        help: 'VMAF',
        hint: 'VMAF-Hinweis',
      },
      advanced: {
        label: 'Erweitert',
        sampleCount: 'Samples pro Datei',
        sampleDuration: 'Sample-Dauer',
        vmafModel: 'VMAF-Modell',
      },
      disclosure: {
        label: 'Defaults überprüfen & überschreiben',
        summary: {
          native: 'Native · {encCount} Encoder · {presetCount} Presets · CRF {values}',
          vmaf: 'VMAF · {encCount} Encoder · {presetCount} Presets · VMAF {values}',
        },
      },
      reset: {
        cta: '↻ Auf Defaults zurücksetzen',
        disabledHint: 'Bereits auf Defaults',
      },
      settingsLink: '→ Defaults dauerhaft in Settings',
      sampleSection: 'Sample-Konfiguration',
      errors: {
        required: 'Pflichtfeld',
        outOfRange: 'Außerhalb',
        tooMany: 'Zu viele',
        submitFailed: 'Fehlgeschlagen',
        encoderRequired: 'Bitte mindestens einen Encoder auswählen',
        presetRequired: 'Bitte mindestens ein Preset auswählen',
      },
    },
  },
};

function wrapDE(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="de" messages={MESSAGES_DE} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

import type { BenchDefaults } from '@/components/bench/bench-defaults';

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

describe('BenchEnqueueForm', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    mockEnqueue.mockReset();
    mockedUseBenchRunState.mockReturnValue({
      runId: null,
      mode: null,
      status: 'idle',
      completedCombos: 0,
      totalCombos: 0,
      currentPhase: null,
      errorReason: null,
      currentComboId: null,
      currentComboPct: 0,
      currentComboOverallPct: 0,
    });
  });

  it('test_happyPath_submit_calls_enqueueBenchRun_with_parsed_integer_fileIds', async () => {
    mockEnqueue.mockResolvedValueOnce({ runId: 42 });
    const onEnqueued = vi.fn();
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} onEnqueued={onEnqueued} />));

    await userEvent.type(screen.getByLabelText('File IDs'), '1, 2, 3');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'native-sweep',
          fileIds: [1, 2, 3],
        }),
      );
    });
    expect(onEnqueued).toHaveBeenCalledWith(42);
  });

  it('test_mode_toggle_switches_value_input_label', async () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    // Default: native-sweep → "Native values"
    expect(screen.getByLabelText('Native values')).toBeInTheDocument();
    // Switch to vmaf-anchored
    await userEvent.click(screen.getByRole('radio', { name: 'VMAF-anchored' }));
    expect(screen.getByLabelText('VMAF targets')).toBeInTheDocument();
  });

  it('test_submit_disabled_when_fileIds_invalid', async () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    // Leave fileIds empty — validation error prevents submit
    await userEvent.clear(screen.getByLabelText('File IDs'));
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('test_submit_button_disabled_when_benchRun_status_is_running', () => {
    mockedUseBenchRunState.mockReturnValue({
      runId: 1,
      mode: 'native-sweep',
      status: 'running',
      completedCombos: 3,
      totalCombos: 12,
      currentPhase: 'encoding',
      errorReason: null,
      currentComboId: 7,
      currentComboPct: 42,
      currentComboOverallPct: 35,
    });
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    expect(screen.getByRole('button', { name: 'Start Benchmark' })).toBeDisabled();
  });

  it('test_advanced_fields_default_populated_from_props', () => {
    render(
      wrap(
        <BenchEnqueueForm
          defaults={{
            ...DEFAULTS,
            sampleCount: 5,
            sampleDurationSec: 30,
            vmafModel: 'vmaf_4k',
          }}
        />,
      ),
    );
    // Post-11-07: sample-section fields rendered directly inside main disclosure (no sub-details)
    expect(screen.getByLabelText('Samples per file')).toHaveValue(5);
    expect(screen.getByLabelText('Sample duration')).toHaveValue(30);
    expect(screen.getByLabelText('VMAF model')).toHaveValue('vmaf_4k');
  });

  // === 11-06 T4: pre-populate from 8-field defaults ===

  it('test_form_prepopulates_mode_from_defaults', () => {
    const custom: BenchDefaults = { ...DEFAULTS, mode: 'vmaf-anchored' };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByRole('radio', { name: 'VMAF-anchored' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Native Sweep' })).not.toBeChecked();
  });

  it('test_form_prepopulates_encoders_from_defaults', () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: ['libx265', 'hevc_nvenc'] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByRole('checkbox', { name: 'libx265' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'hevc_nvenc' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'hevc_qsv' })).not.toBeChecked();
  });

  it('test_form_prepopulates_presets_from_defaults', () => {
    const custom: BenchDefaults = { ...DEFAULTS, presets: ['medium', 'slow'] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByRole('checkbox', { name: 'medium' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'slow' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'veryfast' })).not.toBeChecked();
  });

  it('test_form_prepopulates_valuesText_from_defaults_nativeValues', () => {
    const custom: BenchDefaults = { ...DEFAULTS, nativeValues: '25,28' };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByLabelText('Native values')).toHaveValue('25,28');
  });

  it('test_RESET_on_mount_only_clears_fileIdsText_keeps_other_fields', async () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      mode: 'vmaf-anchored',
      encoders: ['libx265', 'hevc_nvenc'],
      presets: ['medium', 'slow'],
      nativeValues: '25,28',
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    // After mount-effect RESET fires: mode/encoders/presets/values must stay pre-populated.
    expect(screen.getByRole('radio', { name: 'VMAF-anchored' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'libx265' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'hevc_nvenc' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'medium' })).toBeChecked();
    // Post-11-07 audit:M1 — initState branches on defaults.mode. vmaf-anchored reads vmafBuckets,
    // not nativeValues. The test's mode:'vmaf-anchored' + DEFAULTS.vmafBuckets='95,92,88' wins.
    expect(screen.getByLabelText('VMAF targets')).toHaveValue('95,92,88');
    // File IDs must be cleared (RESET semantik).
    expect(screen.getByLabelText('File IDs')).toHaveValue('');
  });

  // === 11-07 T4: Disclosure + Reset + Auto-Expand cases ===

  // AC-1: Primary-Path collapsed
  it('test_disclosure_is_collapsed_on_mount', () => {
    const { container } = render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  it('test_file_ids_input_visible_above_disclosure', () => {
    const { container } = render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const fileIds = container.querySelector('#bench-file-ids');
    const details = container.querySelector('details');
    expect(fileIds).not.toBeNull();
    expect(details).not.toBeNull();
    // DOM-order: fileIds precedes details
    const cmp = fileIds!.compareDocumentPosition(details!);
    expect(cmp & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // AC-2: Summary-projection
  it('test_summary_projection_native_default', () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    expect(screen.getByText(/Native · 1 encoder · 3 presets · CRF 23,28/)).toBeInTheDocument();
  });

  it('test_summary_projection_vmaf_mode_default', () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      mode: 'vmaf-anchored',
      vmafBuckets: '95,92,88',
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByText(/VMAF · 1 encoder · 3 presets · VMAF 95,92,88/)).toBeInTheDocument();
  });

  it('test_summary_projection_values_truncation', () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      nativeValues: '20, 22, 24, 26, 28, 30, 32, 34, 36',
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    // Truncated values render with ellipsis "…"
    expect(screen.getByText(/…/)).toBeInTheDocument();
  });

  // AC-2 audit:M2 — EN ICU-plural
  it('test_summary_projection_en_plural_one_encoder', () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: ['libx265'] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    // Singular "1 encoder" not "1 encoders"
    expect(screen.getByText(/Native · 1 encoder · /)).toBeInTheDocument();
  });

  it('test_summary_projection_en_plural_three_encoders', () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      encoders: ['libx265', 'hevc_nvenc', 'hevc_qsv'],
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByText(/Native · 3 encoders/)).toBeInTheDocument();
  });

  // AC-2 audit:M2 — DE invariant noun form
  it('test_summary_projection_de_invariant_noun', () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      encoders: ['libx265', 'hevc_nvenc', 'hevc_qsv'],
    };
    render(wrapDE(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByText(/Native · 3 Encoder · /)).toBeInTheDocument();
  });

  // AC-3: All 8 fields when open
  it('test_disclosure_open_renders_all_8_fields', () => {
    const { container } = render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    expect(screen.getByRole('radio', { name: 'Native Sweep' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'libx265' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'veryfast' })).toBeInTheDocument();
    expect(screen.getByLabelText('Native values')).toBeInTheDocument();
    expect(screen.getByLabelText('Samples per file')).toBeInTheDocument();
    expect(screen.getByLabelText('Sample duration')).toBeInTheDocument();
    expect(screen.getByLabelText('VMAF model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '↻ Reset to defaults' })).toBeInTheDocument();
  });

  it('test_no_inner_advanced_disclosure', () => {
    const { container } = render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    expect(container.querySelectorAll('details').length).toBe(1);
  });

  // AC-4: Auto-expand-on-invalid
  it('test_submit_invalid_encoder_auto_expands_disclosure', async () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: [] };
    const { container } = render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('test_submit_invalid_encoder_shows_error_with_role_alert', async () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: [] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('At least one encoder required');
  });

  it('test_submit_invalid_encoder_does_not_call_enqueue', async () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: [] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('test_submit_invalid_preset_routes_error_to_preset_msg', async () => {
    const custom: BenchDefaults = { ...DEFAULTS, presets: [] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('At least one preset required');
  });

  // AC-4 audit:S1 — clear-error-on-fix
  it('test_error_clears_on_encoder_toggle_after_invalid_submit', async () => {
    const custom: BenchDefaults = { ...DEFAULTS, encoders: [] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    expect(screen.queryByRole('alert')).not.toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'libx265' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // AC-5: Reset
  it('test_reset_restores_defaults_preserving_file_ids', async () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('checkbox', { name: 'hevc_nvenc' }));
    expect(screen.getByRole('checkbox', { name: 'hevc_nvenc' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '↻ Reset to defaults' }));
    expect(screen.getByRole('checkbox', { name: 'hevc_nvenc' })).not.toBeChecked();
    expect(screen.getByLabelText('File IDs')).toHaveValue('42');
  });

  it('test_reset_disabled_when_state_equals_defaults', () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const reset = screen.getByRole('button', { name: '↻ Reset to defaults' });
    expect(reset).toBeDisabled();
  });

  it('test_reset_disabled_hint_visible_when_state_equals_defaults', () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    expect(screen.getByText('Already on defaults')).toBeInTheDocument();
  });

  it('test_reset_clickable_when_state_differs', async () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    await userEvent.click(screen.getByRole('checkbox', { name: 'hevc_nvenc' }));
    expect(screen.getByRole('button', { name: '↻ Reset to defaults' })).not.toBeDisabled();
  });

  // AC-5 audit:M1 — vmaf-mode reset
  it('test_reset_in_vmaf_mode_reads_vmaf_buckets_not_native_values', async () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      mode: 'vmaf-anchored',
      nativeValues: '23,28',
      vmafBuckets: '90,93,95',
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByLabelText('VMAF targets')).toHaveValue('90,93,95');
    await userEvent.clear(screen.getByLabelText('VMAF targets'));
    await userEvent.type(screen.getByLabelText('VMAF targets'), '80,85');
    await userEvent.click(screen.getByRole('button', { name: '↻ Reset to defaults' }));
    expect(screen.getByLabelText('VMAF targets')).toHaveValue('90,93,95');
  });

  it('test_reset_disabled_in_vmaf_mode_when_state_equals_defaults', () => {
    const custom: BenchDefaults = {
      ...DEFAULTS,
      mode: 'vmaf-anchored',
      vmafBuckets: '90,93,95',
    };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    expect(screen.getByRole('button', { name: '↻ Reset to defaults' })).toBeDisabled();
  });

  // AC-6: Settings-Link
  it('test_settings_link_href_has_locale_and_tab', () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const link = screen.getByRole('link', { name: /Persist defaults in Settings/ });
    expect(link).toHaveAttribute('href', '/en/settings?tab=bench');
  });

  it('test_settings_link_text_content', () => {
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    expect(screen.getByText('→ Persist defaults in Settings')).toBeInTheDocument();
  });

  // AC-10 audit:M4 — active-run-disable
  it('test_summary_toggle_suppressed_during_active_run', async () => {
    mockedUseBenchRunState.mockReturnValue({
      runId: 1,
      mode: 'native-sweep',
      status: 'running',
      completedCombos: 0,
      totalCombos: 12,
      currentPhase: null,
      errorReason: null,
      currentComboId: null,
      currentComboPct: 0,
      currentComboOverallPct: 0,
    });
    const { container } = render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(false);
  });

  it('test_reset_button_disabled_attr_during_active_run', () => {
    mockedUseBenchRunState.mockReturnValue({
      runId: 1,
      mode: 'native-sweep',
      status: 'running',
      completedCombos: 0,
      totalCombos: 12,
      currentPhase: null,
      errorReason: null,
      currentComboId: null,
      currentComboPct: 0,
      currentComboOverallPct: 0,
    });
    render(wrap(<BenchEnqueueForm defaults={DEFAULTS} />));
    const reset = screen.getByRole('button', { name: '↻ Reset to defaults' });
    expect(reset).toBeDisabled();
  });

  // AC-11 audit:S4 — reduced-motion
  it('test_scroll_into_view_uses_auto_when_reduced_motion', async () => {
    const scrollMock = vi.fn();
    Element.prototype.scrollIntoView = scrollMock;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const custom: BenchDefaults = { ...DEFAULTS, encoders: [] };
    render(wrap(<BenchEnqueueForm defaults={custom} />));
    await userEvent.type(screen.getByLabelText('File IDs'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Start Benchmark' }));
    expect(scrollMock).toHaveBeenCalled();
    expect(scrollMock).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center', behavior: 'auto' }),
    );
    vi.unstubAllGlobals();
  });
});
