// 13-02 T4 tests — SelectionBar shared component (≥10 cases per plan).

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SelectionBar } from '@/components/ui/selection-bar';

describe('SelectionBar', () => {
  it('count===0 → renders nothing (defensive guard; Parent should also unmount)', () => {
    const { container } = render(
      <SelectionBar count={0} onClear={() => undefined} countLabel="0 selected" clearLabel="Clear">
        <button>do</button>
      </SelectionBar>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('count===1 desktop → role="region" with aria-label', () => {
    render(
      <SelectionBar count={1} onClear={() => undefined} countLabel="1 selected" clearLabel="Clear">
        <button>do</button>
      </SelectionBar>,
    );
    const desktop = screen.getByTestId('selection-bar-desktop');
    expect(desktop).toHaveAttribute('role', 'region');
    expect(desktop).toHaveAttribute('aria-label', '1 selected');
  });

  it('count===5 desktop → countLabel + clear-button + children visible', () => {
    render(
      <SelectionBar
        count={5}
        onClear={() => undefined}
        countLabel="5 selected"
        clearLabel="Clear selection"
      >
        <button data-testid="action-cluster-child">Bulk Action</button>
      </SelectionBar>,
    );
    expect(screen.getAllByText('5 selected').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('action-cluster-child').length).toBe(2); // desktop + mobile
    expect(screen.getByTestId('selection-bar-clear-desktop')).toBeInTheDocument();
  });

  it('count===5 mobile → mobile bar rendered with same content slots', () => {
    render(
      <SelectionBar count={5} onClear={() => undefined} countLabel="5 selected" clearLabel="Clear">
        <button data-testid="action-cluster-child">Action</button>
      </SelectionBar>,
    );
    const mobile = screen.getByTestId('selection-bar-mobile');
    expect(mobile).toBeInTheDocument();
    expect(mobile).toHaveAttribute('role', 'region');
    expect(screen.getByTestId('selection-bar-clear-mobile')).toBeInTheDocument();
  });

  it('onClear callback fires on click clear-button (desktop)', () => {
    const onClear = vi.fn();
    render(
      <SelectionBar count={3} onClear={onClear} countLabel="3 selected" clearLabel="Clear">
        <button>do</button>
      </SelectionBar>,
    );
    fireEvent.click(screen.getByTestId('selection-bar-clear-desktop'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('onClear callback fires on click clear-button (mobile)', () => {
    const onClear = vi.fn();
    render(
      <SelectionBar count={3} onClear={onClear} countLabel="3 selected" clearLabel="Clear">
        <button>do</button>
      </SelectionBar>,
    );
    fireEvent.click(screen.getByTestId('selection-bar-clear-mobile'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('count > maxCap → max-warning banner rendered (both surfaces)', () => {
    render(
      <SelectionBar
        count={600}
        maxCap={500}
        onClear={() => undefined}
        countLabel="600 selected"
        clearLabel="Clear"
        maxWarningLabel="600 of max 500 — please reduce by 100"
      >
        <button>do</button>
      </SelectionBar>,
    );
    expect(screen.getByTestId('selection-bar-max-warning-desktop')).toBeInTheDocument();
    expect(screen.getByTestId('selection-bar-max-warning-mobile')).toBeInTheDocument();
    expect(screen.getAllByText(/600 of max 500/).length).toBeGreaterThanOrEqual(1);
  });

  it('count <= maxCap → no max-warning banner', () => {
    render(
      <SelectionBar
        count={500}
        maxCap={500}
        onClear={() => undefined}
        countLabel="500 selected"
        clearLabel="Clear"
        maxWarningLabel="should not render"
      >
        <button>do</button>
      </SelectionBar>,
    );
    expect(screen.queryByTestId('selection-bar-max-warning-desktop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selection-bar-max-warning-mobile')).not.toBeInTheDocument();
  });

  it('children prop renders verbatim (action-cluster passes through)', () => {
    render(
      <SelectionBar count={2} onClear={() => undefined} countLabel="2 selected" clearLabel="Clear">
        <span data-testid="cluster-marker">[CLUSTER]</span>
      </SelectionBar>,
    );
    expect(screen.getAllByTestId('cluster-marker').length).toBe(2); // desktop + mobile
  });

  it('default maxCap=500 — count=500 no warning, count=501 warning', () => {
    const { rerender } = render(
      <SelectionBar
        count={500}
        onClear={() => undefined}
        countLabel="x"
        clearLabel="Clear"
        maxWarningLabel="warn"
      >
        <button>do</button>
      </SelectionBar>,
    );
    expect(screen.queryByTestId('selection-bar-max-warning-desktop')).not.toBeInTheDocument();
    rerender(
      <SelectionBar
        count={501}
        onClear={() => undefined}
        countLabel="x"
        clearLabel="Clear"
        maxWarningLabel="warn"
      >
        <button>do</button>
      </SelectionBar>,
    );
    expect(screen.getByTestId('selection-bar-max-warning-desktop')).toBeInTheDocument();
  });

  it('aria-label on desktop+mobile matches countLabel (S1+S2 contract)', () => {
    render(
      <SelectionBar
        count={7}
        onClear={() => undefined}
        countLabel="7 ausgewählt"
        clearLabel="Clear"
      >
        <button>do</button>
      </SelectionBar>,
    );
    expect(screen.getByTestId('selection-bar-desktop')).toHaveAttribute(
      'aria-label',
      '7 ausgewählt',
    );
    expect(screen.getByTestId('selection-bar-mobile')).toHaveAttribute(
      'aria-label',
      '7 ausgewählt',
    );
  });

  // 27-04 — desktop clear-button size-harmonized to ConfirmButton md siblings
  // (h-11/min-h-11/px-4/text-sm/gap-2 + X size-4). Tokenized (NOT substring:
  // `min-h-11` contains `h-11`, so a bare className.includes('h-11') would be a
  // false-green if the standalone height class were ever dropped). Pins AC-1+AC-2.
  it('desktop clear-button carries the harmonized size (h-11/px-4/text-sm/gap-2 + X size-4)', () => {
    render(
      <SelectionBar count={3} onClear={() => undefined} countLabel="3 selected" clearLabel="Clear">
        <button>do</button>
      </SelectionBar>,
    );
    const btn = screen.getByTestId('selection-bar-clear-desktop');
    const cls = btn.className.split(/\s+/);
    // AC-1 height parity (exact tokens, not substring):
    expect(cls).toContain('h-11');
    expect(cls).toContain('min-h-11');
    expect(cls).not.toContain('h-9');
    // AC-2 padding / text / gap parity:
    expect(cls).toContain('px-4');
    expect(cls).toContain('text-sm');
    expect(cls).toContain('gap-2');
    expect(cls).not.toContain('px-3');
    expect(cls).not.toContain('text-xs');
    expect(cls).not.toContain('gap-1');
    // AC-2 X-icon size bump (size-3.5 → size-4):
    const iconCls = (btn.querySelector('svg')?.getAttribute('class') ?? '').split(/\s+/);
    expect(iconCls).toContain('size-4');
    expect(iconCls).not.toContain('size-3.5');
  });
});
