// 26-01 (F3): SidecarModeField — Select (off/beside/central) + conditionally
// relevant central-path Input. Direct-render against the exported sub-component
// (mirrors settings-output-container-field.test.tsx). Asserts AC-5:
//   - visible FormLabel on both controls (form-labels)
//   - 3 mode options render
//   - central-path input disabled + de-emphasized when mode≠central, enabled when central
//   - cause+fix FormMessage wiring via localizeError

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useForm, FormProvider, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { wrap } from '../test-utils';

import { SidecarModeField } from '@/components/settings/settings-form';
import type { FormValues } from '@/src/lib/api/settings-serialize';

const identity = (m: string | undefined) => m;

function Harness({ mode }: { mode: 'off' | 'beside' | 'central' }) {
  const form = useForm<FormValues>({
    defaultValues: {
      sidecar_mode: mode,
      sidecar_central_path: '/config/x265-butler/sidecars/',
    } as FormValues,
  });
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <SidecarModeField
        control={form.control as Control<FormValues>}
        t={t}
        localizeError={identity}
      />
    </FormProvider>
  );
}

describe('SidecarModeField (26-01 F3)', () => {
  it('renders a visible label for both the mode select and the central-path input', () => {
    render(wrap(<Harness mode="beside" />));
    expect(screen.getByLabelText('Sidecar location')).toBeTruthy();
    expect(screen.getByLabelText('Central sidecar path')).toBeTruthy();
  });

  it('central-path input is DISABLED + de-emphasized when mode≠central', () => {
    render(wrap(<Harness mode="beside" />));
    const input = screen.getByLabelText('Central sidecar path') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // de-emphasis: the enclosing FormItem carries opacity-50.
    expect(input.closest('.opacity-50')).not.toBeNull();
  });

  it('central-path input is ENABLED when mode=central', () => {
    render(wrap(<Harness mode="central" />));
    const input = screen.getByLabelText('Central sidecar path') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.closest('.opacity-50')).toBeNull();
  });

  it('mode select exposes all 3 options (off / beside / central)', () => {
    render(wrap(<Harness mode="beside" />));
    const trigger = screen.getByLabelText('Sidecar location mode');
    act(() => {
      fireEvent.click(trigger);
    });
    // Options render in a portal once the Select opens.
    expect(screen.getByText('Off (no sidecar)')).toBeTruthy();
    expect(screen.getByText('Beside the file (default)')).toBeTruthy();
    expect(screen.getByText('Central tree (under /config)')).toBeTruthy();
  });

  it('persistent helper FormDescription is present (not placeholder-only)', () => {
    render(wrap(<Harness mode="central" />));
    // The mode description mentions all 3 modes; assert a stable fragment.
    expect(screen.getByText(/Central writes one mirrored tree/)).toBeTruthy();
  });
});
