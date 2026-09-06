// 05-14: OutputContainerField — Select + amber-info warning banner +
// Tooltip help-icon + queue-semantic advisory. Direct-render test against
// the exported sub-component so the SettingsForm test surface stays
// focused on this plan's scope (broader form already exercised by the
// existing settings page integration coverage).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { wrap } from '../test-utils';

const { mockUseQueueCounts } = vi.hoisted(() => ({
  mockUseQueueCounts: vi.fn(),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: mockUseQueueCounts,
}));

import { OutputContainerField } from '@/components/settings/settings-form';

type FieldProps = React.ComponentProps<typeof OutputContainerField>['field'];
type FieldState = React.ComponentProps<typeof OutputContainerField>['fieldState'];

function makeField(over: Partial<FieldProps> = {}): FieldProps {
  return {
    value: 'mkv',
    onChange: vi.fn(),
    onBlur: vi.fn(),
    name: 'output_container',
    ref: () => undefined,
    ...over,
  };
}

const emptyFieldState: FieldState = {};

// FormLabel/FormItem/FormMessage from `@/components/ui/form` require an
// outer FormProvider — wrap the unit under test in a minimal RHF context
// so it renders standalone.
// 05-15: form widened to the 3-value setting union; HarnessRaw mirrors the
// production form shape. The inner `<TPropProvider />` plumbs the `t`
// translator the component requires (audit M1).
function TPropProvider({ field, fieldState }: { field: FieldProps; fieldState: FieldState }) {
  const t = useTranslations('settings');
  return <OutputContainerField field={field} fieldState={fieldState} t={t} />;
}

function HarnessRaw({ field }: { field: FieldProps }) {
  const form = useForm<{ output_container: 'mkv' | 'mp4' | 'match-source' }>({
    defaultValues: { output_container: field.value },
  });
  return (
    <FormProvider {...form}>
      <TPropProvider field={field} fieldState={emptyFieldState} />
    </FormProvider>
  );
}

beforeEach(() => {
  mockUseQueueCounts.mockReset();
  mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
});

describe('OutputContainerField', () => {
  it('test_when_value_mkv_then_select_visible_and_no_warning_banner', () => {
    render(wrap(<HarnessRaw field={makeField()} />));
    expect(screen.getByLabelText('Output container')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_when_value_mp4_then_warning_banner_visible_with_role_alert_and_aria_live_polite', () => {
    render(wrap(<HarnessRaw field={makeField({ value: 'mp4' })} />));
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(alert.getAttribute('aria-live')).toBe('polite');
  });

  it('test_when_value_mp4_then_banner_text_contains_compat_phrase', () => {
    render(wrap(<HarnessRaw field={makeField({ value: 'mp4' })} />));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('MP4');
  });

  it('test_when_Esc_pressed_on_banner_then_banner_dismissed_field_value_unchanged', () => {
    const onChange = vi.fn();
    render(wrap(<HarnessRaw field={makeField({ value: 'mp4', onChange })} />));
    const alert = screen.getByRole('alert');
    act(() => {
      fireEvent.keyDown(alert, { key: 'Escape' });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    // Esc-dismiss MUST NOT mutate the form value (operator must click Save
    // to persist; banner reappears if container changes back).
    expect(onChange).not.toHaveBeenCalled();
  });

  it('test_when_dismiss_button_clicked_then_banner_removed', () => {
    render(wrap(<HarnessRaw field={makeField({ value: 'mp4' })} />));
    const dismiss = screen.getByLabelText('Dismiss warning');
    act(() => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_when_pendingJobs_zero_then_queue_advisory_NOT_visible', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    render(wrap(<HarnessRaw field={makeField()} />));
    expect(screen.queryByText(/applies to jobs dispatched after save/)).toBeNull();
  });

  it('test_when_pendingJobs_positive_then_queue_advisory_visible', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 5 });
    render(wrap(<HarnessRaw field={makeField()} />));
    expect(screen.getByText(/applies to jobs dispatched after save/)).toBeTruthy();
  });

  it('test_when_pendingJobs_positive_AND_value_mp4_then_BOTH_banner_AND_advisory_visible', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 3 });
    render(wrap(<HarnessRaw field={makeField({ value: 'mp4' })} />));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/applies to jobs dispatched after save/)).toBeTruthy();
  });

  it('test_tooltip_trigger_button_has_aria_label', () => {
    render(wrap(<HarnessRaw field={makeField()} />));
    expect(screen.getByLabelText('More information about output container')).toBeTruthy();
  });

  // 05-15: match-source widening — 3rd SelectItem + advisory + banner suppression.
  it('test_when_value_match_source_then_advisory_visible_amber_banner_hidden', () => {
    render(wrap(<HarnessRaw field={makeField({ value: 'match-source' })} />));
    // Banner is `mp4`-only; match-source must NOT render the amber banner.
    expect(screen.queryByRole('alert')).toBeNull();
    // Neutral advisory paragraph rendered with the matchSource i18n key.
    const advisory = screen.getByText(/Picks MKV or MP4 based on the source file extension/);
    expect(advisory).toBeTruthy();
    expect(advisory.getAttribute('role')).toBe(null);
  });

  it('test_when_value_match_source_AND_pendingJobs_positive_then_BOTH_advisories_render', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 3 });
    render(wrap(<HarnessRaw field={makeField({ value: 'match-source' })} />));
    expect(screen.getByText(/applies to jobs dispatched after save/)).toBeTruthy();
    expect(screen.getByText(/Picks MKV or MP4 based on the source file extension/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_when_value_mkv_then_match_source_advisory_NOT_rendered', () => {
    render(wrap(<HarnessRaw field={makeField({ value: 'mkv' })} />));
    expect(screen.queryByText(/Picks MKV or MP4 based on the source file extension/)).toBeNull();
  });
});
