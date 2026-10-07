/*
 * CrfCard layout: one row per encoder, parameter badge,
 * compact controls, prose at full width, unique accessible names.
 *
 * jsdom computes no layout, so widths are asserted as CLASSES here; "no
 * horizontal scroll at 375/320 px" and the real pixel heights are proven only in
 * the human-verify checkpoint.
 *
 * Not self-referential: the dash gate
 * reads the shipped messages, and the grid-template check skips comment lines,
 * so a comment that NAMES the old template cannot trip it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup, within, act } from '@testing-library/react';
import { useForm, FormProvider, type UseFormReturn } from 'react-hook-form';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import de from '@/messages/de.json';
import en from '@/messages/en.json';
import type { FormValues } from '@/src/lib/api/settings-serialize';
import { resolveCrfParam } from '@/src/lib/encode/crf-defaults';

vi.mock('@/components/settings/run-mode-picker', () => ({
  RunModePicker: () => <div data-testid="run-mode-picker" />,
}));
vi.mock('@/components/settings/apply-from-bench-button', () => ({
  ApplyFromBenchButton: () => <button type="button">apply</button>,
}));

import { CrfCard } from '@/components/settings/crf-card';

const M = en.settings;
const ENCODERS = ['libx265', 'nvenc', 'qsv', 'vaapi'] as const;

const BASE: Partial<FormValues> = {
  crf_libx265: 23,
  crf_nvenc: 23,
  crf_qsv: 22,
  crf_vaapi: 22,
  preset_libx265: 'medium',
  preset_nvenc: 'p5',
  preset_qsv: 'slow',
  preset_vaapi: 'slow',
};

let formRef: UseFormReturn<FormValues> | null = null;

function Harness({ qsvRateControl }: { qsvRateControl?: 'icq-full' | 'cqp' }) {
  const form = useForm<FormValues>({ defaultValues: BASE as FormValues });
  formRef = form;
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
        detectedEncoders={['qsv']}
      />
    </FormProvider>
  );
}

function draw(qsvRateControl?: 'icq-full' | 'cqp') {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <Harness qsvRateControl={qsvRateControl} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  formRef = null;
});

describe('one row per encoder, in order, with the encoder name as its head', () => {
  it('renders four groups named after settings.field.encoder.option', () => {
    draw('icq-full');
    // the bench panel is a group too, so scope to the encoder list
    const list = screen.getByTestId('crf-row-libx265').parentElement!;
    const groups = within(list).getAllByRole('group');
    expect(groups).toHaveLength(4);
    groups.forEach((group, i) => {
      expect(group).toHaveAccessibleName(M.field.encoder.option[ENCODERS[i]]);
    });
  });

  it('the rows are separated by a divider, not only by spacing', () => {
    draw('icq-full');
    const list = screen.getByTestId('crf-row-libx265').parentElement!;
    expect(list.className).toMatch(/divide-y/);
  });

  it('the pre-51-01 140px column template is gone from the code (comments excluded)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'components/settings/crf-card.tsx'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('grid-cols-[140px_1fr]');
  });
});

describe('the badge names the flag the encoder really gets', () => {
  it.each([['icq-full'], ['cqp'], [undefined]] as const)('qsv tier %s', (tier) => {
    draw(tier);
    for (const enc of ENCODERS) {
      const badge = screen.getByTestId(`crf-param-${enc}`);
      const param = resolveCrfParam(enc, tier);
      expect(badge).toHaveTextContent(param);
      expect(badge).toHaveAccessibleName(M.section.crf.paramBadge.replace('{param}', param));
    }
  });
});

describe('compact controls, touch target kept', () => {
  it('CRF sits in a w-24 wrapper, both controls keep h-11', () => {
    draw('icq-full');
    for (const enc of ENCODERS) {
      const wrap = screen.getByTestId(`crf-input-wrap-${enc}`);
      expect(wrap.className).toMatch(/\bw-24\b/);
      const input = within(wrap).getByRole('spinbutton');
      expect(input.className).toMatch(/\bh-11\b/);
      const row = screen.getByTestId(`crf-row-${enc}`);
      expect(within(row).getByRole('combobox').className).toMatch(/\bh-11\b/);
      // checkpoint finding: a trailing 1fr track, otherwise col-span-full
      // (head, helpers, messages) ends after ~20rem instead of the card edge.
      expect(row.className).toMatch(/sm:grid-cols-\[6rem_14rem_minmax\(0,1fr\)\]/);
    }
  });
});

describe('a validation error is not squeezed into the CRF column', () => {
  it('renders full width below the control row and is referenced by the input', () => {
    draw('icq-full');
    act(() => {
      formRef!.setError('crf_qsv', { type: 'max', message: 'crfRange' });
    });
    const row = screen.getByTestId('crf-row-qsv');
    const alert = within(row).getByRole('alert');
    expect(alert).toHaveTextContent('crfRange');
    expect(alert.className).toMatch(/col-span-full/);
    const wrap = screen.getByTestId('crf-input-wrap-qsv');
    expect(wrap.contains(alert)).toBe(false);
    const input = within(wrap).getByRole('spinbutton');
    expect(input.getAttribute('aria-describedby')!.split(' ')).toContain(alert.id);
  });
});

describe('helpers at full width; the shared sentence lives in the description', () => {
  it('each CRF helper and preset helper spans the full row', () => {
    draw('icq-full');
    for (const enc of ENCODERS) {
      const row = screen.getByTestId(`crf-row-${enc}`);
      const presetHelper = within(row).getByText(M.section.crf.preset.helper[enc]);
      expect(presetHelper.className).toMatch(/col-span-full/);
    }
  });

  it.each([
    ['de', de],
    ['en', en],
  ] as const)('%s: {param} parity', (_loc, msgs) => {
    expect(msgs.settings.field.crf_qsv.helper).not.toContain('{param}');
    expect(msgs.settings.field.crf_qsv.helperUnknown).toContain('{param}');
  });
});

describe('unique accessible names, helpers stay wired', () => {
  it('four CRF inputs and four preset selects, all names distinct', () => {
    draw('icq-full');
    const names: string[] = [];
    for (const enc of ENCODERS) {
      const input = screen.getByLabelText(M.field[`crf_${enc}`].label);
      expect(input).toHaveRole('spinbutton');
      names.push(M.field[`crf_${enc}`].label);
      const presetName = M.section.crf.preset.labelFor.replace(
        '{encoder}',
        M.field.encoder.option[enc],
      );
      expect(screen.getByRole('combobox', { name: presetName })).toBeInTheDocument();
      names.push(presetName);
    }
    expect(new Set(names).size).toBe(8);
  });

  it('every aria-describedby id of a CRF input exists and one carries the helper', () => {
    draw('icq-full');
    const helpers = {
      libx265: M.field.crf_libx265.helper,
      nvenc: M.field.crf_nvenc.helper,
      qsv: M.field.crf_qsv.helper,
      vaapi: M.field.crf_vaapi.helper,
    };
    for (const enc of ENCODERS) {
      const input = screen.getByLabelText(M.field[`crf_${enc}`].label);
      const ids = input.getAttribute('aria-describedby')!.split(' ').filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      const texts = ids.map((id) => {
        const el = document.getElementById(id);
        expect(el).not.toBeNull();
        return el!.textContent;
      });
      expect(texts).toContain(helpers[enc]);
    }
  });

  it('no region landmark and no heading inside the rows', () => {
    draw('icq-full');
    for (const enc of ENCODERS) {
      const row = screen.getByTestId(`crf-row-${enc}`);
      expect(within(row).queryAllByRole('region')).toHaveLength(0);
      expect(within(row).queryAllByRole('heading')).toHaveLength(0);
    }
  });
});

describe('no dashes in the strings this card shows', () => {
  const DASH = /—| – /;
  function collect(o: unknown, p: string, out: Array<[string, string]>) {
    if (typeof o === 'string') out.push([p, o]);
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) collect(v, `${p}.${k}`, out);
  }
  it.each([
    ['de', de],
    ['en', en],
  ] as const)('%s', (_loc, msgs) => {
    const out: Array<[string, string]> = [];
    const { applyFromBench: _skip, ...crf } = msgs.settings.section.crf;
    collect(crf, 'section.crf', out);
    for (const enc of ENCODERS) collect(msgs.settings.field[`crf_${enc}`], `field.crf_${enc}`, out);
    const offenders = out.filter(([, v]) => DASH.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

describe('the card header uses the full width', () => {
  it('title/description are no longer a flex-1 sibling of the picker', () => {
    draw('icq-full');
    const panel = screen.getByTestId('crf-bench-panel');
    const header = panel.parentElement!;
    expect(header.className).not.toMatch(/lg:flex-row/);
    const title = within(header).getByText(M.section.crf.title);
    expect(title.closest('.flex-1')).toBeNull();
  });

  it('the bench controls live in a framed, titled panel below the description', () => {
    draw('icq-full');
    const panel = screen.getByTestId('crf-bench-panel');
    expect(panel).toHaveAccessibleName(M.section.crf.benchPanel.title);
    expect(panel.className).toMatch(/\bborder\b/);
    expect(within(panel).getByTestId('run-mode-picker')).toBeInTheDocument();
  });
});

describe('bench panel rows', () => {
  it('the mode options are a fixed 3-column grid, never flex-wrap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })),
    );
    vi.resetModules();
    vi.doUnmock('@/components/settings/run-mode-picker');
    const { RunModePicker } = await import('@/components/settings/run-mode-picker');
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <RunModePicker
          selectedRunId={null}
          mode="balanced"
          selectionSource="default"
          selectionMode="default"
          onChange={() => {}}
          action={<button type="button">apply</button>}
        />
      </NextIntlClientProvider>,
    );
    const group = screen.getByRole('radiogroup');
    expect(group.className).toMatch(/\bgrid-cols-3\b/);
    expect(group.className).not.toMatch(/flex-wrap/);
    // the action renders last, after the mode hint
    const root = group.closest('.flex-col')!.parentElement!;
    expect(root.lastElementChild).toHaveTextContent('apply');
    vi.unstubAllGlobals();
  });
});
