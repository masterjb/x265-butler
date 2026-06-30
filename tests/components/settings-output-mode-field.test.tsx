// 26-02 (F5): OutputModeField — Select (suffix/replace) + P3 arm-confirm on the
// replace one-way-door (AC-9) + off+replace anti-double-work amber hint (AC-10).
// Direct-render against the exported sub-component (mirrors
// settings-sidecar-mode-field.test.tsx).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useForm, FormProvider, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { wrap } from '../test-utils';

import { OutputModeField } from '@/components/settings/settings-form';
import type { FormValues } from '@/src/lib/api/settings-serialize';

const identity = (m: string | undefined) => m;

function Harness({
  mode = 'suffix',
  sidecar = 'beside',
  onArm,
}: {
  mode?: 'suffix' | 'replace';
  sidecar?: 'off' | 'beside' | 'central';
  onArm?: () => void;
}) {
  const form = useForm<FormValues>({
    defaultValues: { output_mode: mode, sidecar_mode: sidecar } as FormValues,
  });
  const t = useTranslations('settings');
  const [armed, setArmed] = useState(false);
  return (
    <FormProvider {...form}>
      <OutputModeField
        control={form.control as Control<FormValues>}
        t={t}
        localizeError={identity}
        replaceArmed={armed}
        onArm={() => {
          setArmed(true);
          onArm?.();
        }}
      />
    </FormProvider>
  );
}

describe('OutputModeField (26-02 F5)', () => {
  it('renders a visible label and 2 options (suffix / replace)', () => {
    render(wrap(<Harness mode="suffix" />));
    expect(screen.getByLabelText('Output strategy')).toBeTruthy();
    const trigger = screen.getByLabelText('Output strategy mode');
    act(() => {
      fireEvent.click(trigger);
    });
    expect(screen.getByText('Keep original, write a new file (default)')).toBeTruthy();
    expect(screen.getByText('Replace original in place')).toBeTruthy();
  });

  it('suffix mode shows NO replace warning and NO off+replace hint', () => {
    render(wrap(<Harness mode="suffix" sidecar="off" />));
    expect(screen.queryByText(/Replace moves each original to the trash/)).toBeNull();
    expect(screen.queryByText(/Sidecar metadata is off while replace is on/)).toBeNull();
  });

  // AC-9: replace reveals the amber warning + a P3 arm-confirm control.
  it('replace shows the one-way-door warning and an arm control', () => {
    render(wrap(<Harness mode="replace" sidecar="beside" />));
    expect(screen.getByText(/Replace moves each original to the trash/)).toBeTruthy();
    // The P3 ConfirmButton primary renders with the arm label.
    expect(screen.getByText('Enable in-place replace')).toBeTruthy();
  });

  // AC-9: arming the P3 control fires onArm. P3 is inverted-cooldown: click ARM →
  // 3s cooldown (primary disabled) → armed → click CONFIRM → fires.
  it('P3 arm→cooldown→confirm fires onArm and then shows the armed-confirmed state', () => {
    vi.useFakeTimers();
    try {
      const onArm = vi.fn();
      render(wrap(<Harness mode="replace" sidecar="beside" onArm={onArm} />));
      const primary = screen.getByTestId('confirm-button-primary');
      act(() => {
        fireEvent.click(primary); // idle → cooldown
      });
      act(() => {
        vi.advanceTimersByTime(3100); // cooldown → armed (ELAPSE_COOLDOWN)
      });
      act(() => {
        fireEvent.click(primary); // armed → fired → onConfirm
      });
      expect(onArm).toHaveBeenCalledTimes(1);
      // After arming, the confirmed indicator replaces the button.
      expect(screen.getByText('In-place replace enabled — save to apply.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // AC-10: off + replace renders the anti-double-work amber advisory.
  it('off + replace renders the anti-double-work hint', () => {
    render(wrap(<Harness mode="replace" sidecar="off" />));
    expect(screen.getByText(/Sidecar metadata is off while replace is on/)).toBeTruthy();
  });

  it('beside + replace does NOT render the off+replace hint', () => {
    render(wrap(<Harness mode="replace" sidecar="beside" />));
    expect(screen.queryByText(/Sidecar metadata is off while replace is on/)).toBeNull();
  });
});
