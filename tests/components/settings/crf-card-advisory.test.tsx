/*
 * 49-05 Task 2 — CrfCard: per-tier QSV helper, legacy-default advisory, bench link.
 *
 * Covers AC-2 (each field names its real parameter), AC-3 (the QSV helper tells
 * the truth about the tier, including "not verified"), AC-9 (the advisory is
 * conditional and changes NOTHING), AC-9b (the estimate marking also reaches a
 * fresh install, i.e. it does NOT hang on the advisory condition) and AC-10
 * (the empirical path is reachable from the CRF area).
 *
 * The two header controls are stubbed: they own bench-run fetching and picker
 * state that has nothing to do with what this file asserts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import type { FormValues } from '@/src/lib/api/settings-serialize';

vi.mock('@/components/settings/run-mode-picker', () => ({
  RunModePicker: () => <div data-testid="run-mode-picker" />,
}));
vi.mock('@/components/settings/apply-from-bench-button', () => ({
  ApplyFromBenchButton: () => <button type="button">apply</button>,
}));

import { CrfCard } from '@/components/settings/crf-card';

const M = en.settings;

const BASE: Partial<FormValues> = {
  crf_libx265: 23,
  crf_nvenc: 23,
  crf_qsv: 26,
  crf_vaapi: 22,
  preset_libx265: 'medium',
  preset_nvenc: 'p5',
  preset_qsv: 'slow',
  preset_vaapi: 'slow',
};

function Harness({
  values,
  qsvRateControl,
  detectedEncoders,
}: {
  values?: Partial<FormValues>;
  qsvRateControl?: 'icq-full' | 'cqp';
  detectedEncoders?: Array<'nvenc' | 'qsv' | 'vaapi' | 'libx265'>;
}) {
  const form = useForm<FormValues>({
    defaultValues: { ...BASE, ...values } as FormValues,
  });
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <CrfCard
        form={form}
        t={t}
        localizeError={(m) => m}
        pickerRunId={null}
        pickerMode="balanced"
        pickerSource="default"
        pickerModeSource="default"
        onPickerChange={() => {}}
        applyButtonRunId={undefined}
        applyButtonMeta={undefined as never}
        qsvRateControl={qsvRateControl}
        detectedEncoders={detectedEncoders}
      />
    </FormProvider>
  );
}

function draw(props: React.ComponentProps<typeof Harness> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <Harness {...props} />
    </NextIntlClientProvider>,
  );
}

/** ICU-substitute the way next-intl does, so assertions use the shipped string. */
function helperWithParam(param: string): string {
  return M.field.crf_qsv.helper.replace('{param}', param);
}
function unknownWithParam(param: string): string {
  return M.field.crf_qsv.helperUnknown.replace('{param}', param);
}

afterEach(() => cleanup());

describe('AC-2: every CRF field names its real parameter', () => {
  it('libx265 / nvenc / vaapi helpers render verbatim', () => {
    draw({ qsvRateControl: 'icq-full' });
    expect(screen.getByText(M.field.crf_libx265.helper)).toBeInTheDocument();
    expect(screen.getByText(M.field.crf_nvenc.helper)).toBeInTheDocument();
    expect(screen.getByText(M.field.crf_vaapi.helper)).toBeInTheDocument();
  });
});

describe('AC-3: the QSV helper follows the resolved tier', () => {
  it("icq-full → names '-global_quality'", () => {
    draw({ qsvRateControl: 'icq-full' });
    expect(screen.getByText(helperWithParam('-global_quality'))).toBeInTheDocument();
    expect(screen.queryByText(unknownWithParam('-global_quality'))).not.toBeInTheDocument();
  });

  it("cqp → names '-q:v'", () => {
    draw({ qsvRateControl: 'cqp' });
    expect(screen.getByText(helperWithParam('-q:v'))).toBeInTheDocument();
  });

  // AC-3b: unresolved does NOT go silent — it names the fallback the encode
  // really ships, because getActiveQsvRateControl() falls back to 'icq-full'.
  it('undefined → says "not verified" AND names the -global_quality fallback', () => {
    draw({ qsvRateControl: undefined });
    const line = screen.getByText(unknownWithParam('-global_quality'));
    expect(line).toBeInTheDocument();
    expect(line.textContent).toContain('-global_quality');
  });
});

describe('AC-9: the legacy-default advisory', () => {
  it('shows on crf_qsv === 22 with qsv detected', () => {
    draw({ values: { crf_qsv: 22 }, qsvRateControl: 'icq-full', detectedEncoders: ['qsv'] });
    expect(screen.getByText(M.field.crf_qsv.advisoryLegacyDefault)).toBeInTheDocument();
  });

  it('hides when the value is not 22', () => {
    draw({ values: { crf_qsv: 26 }, qsvRateControl: 'icq-full', detectedEncoders: ['qsv'] });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
  });

  it('hides when qsv is not detected', () => {
    draw({ values: { crf_qsv: 22 }, qsvRateControl: 'icq-full', detectedEncoders: ['nvenc'] });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
  });

  // The settings/page.tsx catch-branch (:207-214) degrades detected to
  // ['libx265']. A QSV recommendation on top of a failed probe would be a
  // recommendation built on a non-detection.
  it('hides on the detection-failure fallback ["libx265"]', () => {
    draw({ values: { crf_qsv: 22 }, qsvRateControl: undefined, detectedEncoders: ['libx265'] });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
  });

  it('hides when no detection was threaded at all', () => {
    draw({ values: { crf_qsv: 22 }, qsvRateControl: 'icq-full' });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
  });

  it('is display-only: it dissolves on edit and never rewrites the field', () => {
    draw({ values: { crf_qsv: 22 }, qsvRateControl: 'icq-full', detectedEncoders: ['qsv'] });
    const input = screen.getByLabelText(M.field.crf_qsv.label) as HTMLInputElement;
    expect(input.value).toBe('22'); // NOT silently bumped to 26
    act(() => {
      fireEvent.change(input, { target: { value: '26' } });
    });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
    expect((screen.getByLabelText(M.field.crf_qsv.label) as HTMLInputElement).value).toBe('26');
  });

  it('carries an icon so the amber colour is not the only signal', () => {
    const { container } = draw({
      values: { crf_qsv: 22 },
      qsvRateControl: 'icq-full',
      detectedEncoders: ['qsv'],
    });
    const advisory = container.querySelector('[role="status"]');
    expect(advisory).not.toBeNull();
    expect(advisory?.querySelector('svg')).not.toBeNull();
  });
});

describe('AC-9b / AC-10: the estimate marking and the empirical path', () => {
  // A fresh install has crf_qsv = 26, so the advisory never fires there. The
  // "26 is an estimate" fact must still reach it — it lives in the helper.
  it('a fresh install (26, no advisory) still reads that 26 is an estimate', () => {
    draw({ values: { crf_qsv: 26 }, qsvRateControl: 'icq-full', detectedEncoders: ['qsv'] });
    expect(screen.queryByText(M.field.crf_qsv.advisoryLegacyDefault)).not.toBeInTheDocument();
    const helper = screen.getByText(helperWithParam('-global_quality'));
    expect(helper.textContent).toMatch(/estimate/i);
    expect(helper.textContent).toMatch(/bench/i);
  });

  it('the card description links to /{locale}/bench', () => {
    draw({ qsvRateControl: 'icq-full' });
    const link = screen.getByRole('link', { name: M.section.crf.benchLink });
    expect(link).toHaveAttribute('href', '/en/bench');
    expect(screen.getByText(M.section.crf.description, { exact: false })).toBeInTheDocument();
  });
});
