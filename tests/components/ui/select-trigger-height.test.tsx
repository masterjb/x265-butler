/*
 * 51-02 — SelectTrigger honours a caller's height.
 *
 * Until 51-02 the primitive set its height as `data-[size=default]:h-8`. That
 * variant selector (class + attribute) out-ranked a caller's `h-11` / `lg:h-9`
 * on specificity, and tailwind-merge kept both classes because the modifiers
 * differ, so 13 dropdowns rendered 32 px next to 44/36 px inputs. The height
 * is now a plain class that tailwind-merge resolves against `className`.
 *
 * jsdom computes no CSS, so these are class assertions: once only same-rank
 * utility classes remain, the cascade is deterministic. The pixel result is
 * proven in the 51-02 human-verify checkpoint.
 *
 * The source gate checks that a pattern this plan REMOVES stays gone, with
 * comments stripped ([[feedback_grep_gates_self_referential]]); it is what
 * trips if `shadcn add select --overwrite` restores the upstream variant.
 */

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';

afterEach(() => cleanup());

function trigger(props: React.ComponentProps<typeof SelectTrigger> = {}) {
  render(
    <Select>
      <SelectTrigger aria-label="t" {...props}>
        <SelectValue />
      </SelectTrigger>
    </Select>,
  );
  return screen.getByRole('combobox', { name: 't' });
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe('AC-1: a caller height wins', () => {
  it('h-11 lg:h-9 replaces the default h-8, no data-size height remains', () => {
    const c = classes(trigger({ className: 'h-11 lg:h-9' }));
    expect(c).toContain('h-11');
    expect(c).toContain('lg:h-9');
    expect(c).not.toContain('h-8');
    expect(c.some((x) => /^data-\[size=[a-z]+\]:h-/.test(x))).toBe(false);
  });
});

describe('AC-2: default and sm are unchanged', () => {
  it('default → h-8 with rounded-lg, data-size="default"', () => {
    const el = trigger();
    const c = classes(el);
    expect(c).toContain('h-8');
    expect(c).toContain('rounded-lg');
    expect(el).toHaveAttribute('data-size', 'default');
  });

  it('sm → h-7 with the sm radius replacing rounded-lg (audit SR-1)', () => {
    const el = trigger({ size: 'sm' });
    const c = classes(el);
    expect(c).toContain('h-7');
    expect(c).not.toContain('h-8');
    expect(c).toContain('rounded-[min(var(--radius-md),10px)]');
    expect(c).not.toContain('rounded-lg');
    expect(el).toHaveAttribute('data-size', 'sm');
  });
});

describe('AC-3: no height behind a data-size variant in the primitive', () => {
  it('components/ui/select.tsx carries no data-[size=…]:h-* class (comments excluded)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/ui/select.tsx'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/data-\[size=[a-z]+\]:h-/);
  });
});
