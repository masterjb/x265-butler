// 05-18: OutputSuffixField — container-aware Input placeholder + helper-text.
// Sub-component subscribes to `output_container` via useWatch INSIDE its own
// body (audit S3 — Hook-rules clean). Display-only contract; orchestrator at
// encode is truth-source. Tests cover AC-1..AC-9 of plan 05-18.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useForm, FormProvider, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { wrap } from '../test-utils';
import type { FormValues } from '@/src/lib/api/settings-serialize';

const { mockUseQueueCounts } = vi.hoisted(() => ({
  mockUseQueueCounts: vi.fn(),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: mockUseQueueCounts,
}));

import { OutputSuffixField } from '@/components/settings/settings-form';
// 16-05 audit M5: drift-guard test imports sanitizeOutputSuffix to assert
// placeholder ≡ sanitizer composition (AC-12).
import { sanitizeOutputSuffix } from '@/src/lib/encode/staging';

type Container = 'mkv' | 'mp4' | 'match-source';
type FormShape = { output_container: Container; output_suffix: string };

// Harness wraps OutputSuffixField in a real react-hook-form context. The
// sub-component subscribes via useWatch directly — defaultValues feed the
// container-aware placeholder + helper-key resolution.
function FieldHarness({
  container,
  suffix,
  formRef,
}: {
  container: Container | undefined;
  suffix: string;
  formRef?: React.MutableRefObject<ReturnType<typeof useForm<FormShape>> | null>;
}) {
  const form = useForm<FormShape>({
    defaultValues: {
      output_container: container as Container,
      output_suffix: suffix,
    },
  });
  if (formRef) formRef.current = form;
  const t = useTranslations('settings');
  const localizeError = (m: string | undefined) => m;
  const fieldShim = {
    value: form.watch('output_suffix') ?? '',
    onChange: (() => undefined) as React.ChangeEventHandler<HTMLInputElement>,
    onBlur: () => undefined,
    name: 'output_suffix',
    ref: () => undefined,
  };
  return (
    <FormProvider {...form}>
      <OutputSuffixField
        field={fieldShim}
        fieldState={{}}
        control={form.control as unknown as Control<FormValues>}
        t={t}
        localizeError={localizeError}
      />
    </FormProvider>
  );
}

beforeEach(() => {
  mockUseQueueCounts.mockReset();
  mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
});

describe('OutputSuffixField', () => {
  // AC-1 — explicit mkv: placeholder "-x265.mkv" + helper.mkv copy (16-05)
  it('test_when_container_mkv_then_placeholder_x265_mkv_and_helper_mkv_copy', () => {
    render(wrap(<FieldHarness container="mkv" suffix="" />));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('-x265.mkv');
    expect(screen.getByText(en.settings.field.outputSuffix.helper.mkv)).toBeInTheDocument();
  });

  // AC-2 — explicit mp4: placeholder "-x265.mp4" + helper.mp4 copy (16-05)
  it('test_when_container_mp4_then_placeholder_x265_mp4_and_helper_mp4_copy', () => {
    render(wrap(<FieldHarness container="mp4" suffix="" />));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('-x265.mp4');
    expect(screen.getByText(en.settings.field.outputSuffix.helper.mp4)).toBeInTheDocument();
  });

  // AC-3 — match-source: placeholder "-x265" (extensionless label) + matchSource (16-05)
  it('test_when_container_match_source_then_placeholder_x265_and_helper_match_source_copy', () => {
    render(wrap(<FieldHarness container="match-source" suffix="" />));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('-x265');
    expect(screen.getByText(en.settings.field.outputSuffix.helper.matchSource)).toBeInTheDocument();
  });

  // AC-4 — live-update on container toggle (mkv → mp4 via setValue).
  // audit S4: wrap in act() + waitFor for React 19 strict-mode async-render
  // safety.
  it('test_when_container_toggled_mkv_to_mp4_then_placeholder_and_helper_live_update', async () => {
    const formRef: React.MutableRefObject<ReturnType<typeof useForm<FormShape>> | null> = {
      current: null,
    };
    render(wrap(<FieldHarness container="mkv" suffix="" formRef={formRef} />));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.placeholder).toBe('-x265.mkv');
    act(() => {
      formRef.current?.setValue('output_container', 'mp4');
    });
    await waitFor(() => {
      expect(input.placeholder).toBe('-x265.mp4');
      expect(screen.getByText(en.settings.field.outputSuffix.helper.mp4)).toBeInTheDocument();
    });
  });

  // AC-8 — transient-undefined container defaults to mkv copy + -x265.mkv
  // placeholder; no runtime throw (mirrors OutputSuffixPreview AC-9 guard).
  it('test_when_container_undefined_then_defaults_to_mkv_placeholder_and_helper', () => {
    expect(() => {
      render(wrap(<FieldHarness container={undefined} suffix="" />));
    }).not.toThrow();
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('-x265.mkv');
    expect(screen.getByText(en.settings.field.outputSuffix.helper.mkv)).toBeInTheDocument();
  });

  // AC-6 (05-18 b2-deviation): OutputSuffixPreview removed entirely (User-r2
  // mid-UAT). Asserts the role="status" preview <output> NEVER renders inside
  // OutputSuffixField, regardless of container or suffix state. Preview is
  // gone; helper-text alone explains the resolved-filename contract.
  it('test_when_field_renders_with_any_suffix_then_no_preview_status_output_present', () => {
    render(wrap(<FieldHarness container="mkv" suffix=".x265.mkv" />));
    expect(screen.queryByRole('status')).toBeNull();
  });

  // AC-5 part 1 — legacy single-string `helper` is GONE; helper is an object.
  it('test_when_helper_subtree_inspected_then_legacy_string_helper_removed_and_object_present', () => {
    const en_helper = en.settings.field.outputSuffix.helper;
    const de_helper = de.settings.field.outputSuffix.helper;
    expect(typeof en_helper).toBe('object');
    expect(typeof de_helper).toBe('object');
    // Negative: legacy single-string shape would have been a string, not object.
    expect(typeof en_helper).not.toBe('string');
    expect(typeof de_helper).not.toBe('string');
  });

  // AC-5 part 2 — EN ↔ DE structural equality at the helper subtree (3 leaf
  // keys present in both locales, no extras).
  it('test_when_helper_subtree_compared_en_de_then_same_three_leaf_keys', () => {
    const en_keys = Object.keys(en.settings.field.outputSuffix.helper).sort();
    const de_keys = Object.keys(de.settings.field.outputSuffix.helper).sort();
    expect(en_keys).toEqual(['matchSource', 'mkv', 'mp4']);
    expect(de_keys).toEqual(['matchSource', 'mkv', 'mp4']);
    expect(en_keys).toEqual(de_keys);
  });
});

// 16-05 audit M5 + AC-12: placeholder ≡ sanitizer composition drift-guard.
// Pins the invariant that the rendered placeholder string equals what the
// shared sanitizer would compose for the SAME container input. A future
// container addition (e.g. 'webm') cannot drift the placeholder without
// simultaneously updating the sanitizer — single source of truth gate.
describe('OutputSuffixField — placeholder-vs-sanitizer drift-guard (AC-12)', () => {
  it.each(['mkv', 'mp4'] as const)(
    'placeholder for container=%s equals sanitizeOutputSuffix("-x265", container)',
    (c) => {
      render(wrap(<FieldHarness container={c} suffix="" />));
      const input = screen.getByRole('textbox');
      expect(input.getAttribute('placeholder')).toBe(sanitizeOutputSuffix('-x265', c));
    },
  );

  // match-source: composition happens upstream at dispatch (resolveContainerFromSource
  // → mkv|mp4); the Settings-Form placeholder shows the bare LABEL only.
  it('placeholder for container=match-source is the bare "-x265" label', () => {
    render(wrap(<FieldHarness container="match-source" suffix="" />));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('-x265');
  });
});
