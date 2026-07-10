// 34-02: GpuDeviceField — controlled base-ui Select listing the probed render
// nodes + Auto sentinel (''). Direct-render against the exported sub-component
// (mirrors settings-sidecar-mode-field.test.tsx). Asserts:
//   - visible FormLabel + persistent FormDescription (form-labels / helper-text)
//   - Auto + every probed node render as options (open the portal)
//   - a pinned-but-absent device value is injected as a still-selectable option (AC-4)
//   - the option value is the FULL /dev/dri/renderD<N> path (AC-2)

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useForm, FormProvider, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { wrap } from '../test-utils';

import { GpuDeviceField } from '@/components/settings/gpu-device-field';
import type { FormValues, RenderDeviceOption } from '@/src/lib/api/settings-serialize';

function dev(over: Partial<RenderDeviceOption> & { path: string }): RenderDeviceOption {
  return {
    node: over.path.split('/').pop() ?? over.path,
    exists: true,
    readable: true,
    writable: true,
    groupName: 'render',
    inRenderGroup: true,
    ...over,
  };
}

const TWO_NODES: RenderDeviceOption[] = [
  dev({ path: '/dev/dri/renderD128' }),
  dev({ path: '/dev/dri/renderD129', groupName: 'video', writable: false }),
];

function Harness({
  value = '',
  renderDevices = TWO_NODES,
}: {
  value?: string;
  renderDevices?: RenderDeviceOption[];
}) {
  const form = useForm<FormValues>({
    defaultValues: { gpu_device: value } as FormValues,
  });
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <GpuDeviceField
        control={form.control as Control<FormValues>}
        t={t}
        renderDevices={renderDevices}
      />
    </FormProvider>
  );
}

describe('GpuDeviceField (34-02)', () => {
  it('renders a visible label and persistent helper description', () => {
    render(wrap(<Harness />));
    expect(screen.getByLabelText('Render device')).toBeTruthy();
    // Persistent FormDescription (not placeholder-only).
    expect(screen.getByText(/Auto uses the first detected render node/)).toBeTruthy();
  });

  it('Auto is the default selection when value is empty', () => {
    const { container } = render(wrap(<Harness value="" />));
    // base-ui mirrors the Select value into a hidden form input; empty = Auto.
    const hidden = container.querySelector('input[id$="hidden-input"]') as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe('');
  });

  it('exposes Auto + every probed node as options', () => {
    render(wrap(<Harness />));
    const trigger = screen.getByLabelText('Render device');
    act(() => {
      fireEvent.click(trigger);
    });
    expect(screen.getByText('Auto (first detected)')).toBeTruthy();
    expect(screen.getByText('renderD128')).toBeTruthy();
    expect(screen.getByText('renderD129')).toBeTruthy();
  });

  it('injects a pinned-but-absent device as a still-selectable option (AC-4)', () => {
    // gpu_device pinned to renderD129 but the probe only returns renderD128.
    render(
      wrap(
        <Harness
          value="/dev/dri/renderD129"
          renderDevices={[dev({ path: '/dev/dri/renderD128' })]}
        />,
      ),
    );
    const trigger = screen.getByLabelText('Render device');
    act(() => {
      fireEvent.click(trigger);
    });
    expect(screen.getByText('renderD129')).toBeTruthy();
    expect(screen.getByText(/not currently present/)).toBeTruthy();
  });

  it('the pinned full path is the persisted Select value (AC-2 value = full path)', () => {
    const { container } = render(wrap(<Harness value="/dev/dri/renderD129" />));
    // base-ui mirrors the Select value into a hidden form input — the FULL path
    // (not the basename) is what persists, proving option value = full path.
    const hidden = container.querySelector('input[id$="hidden-input"]') as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe('/dev/dri/renderD129');
  });
});
