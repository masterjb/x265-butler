// Phase 21 Plan 21-03 T2 — HeuristicCallout component tests.
// AC-7 + AC-14: presence of icon/title/body/primary-action, optional secondary
// callout, a11y attributes.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileQuestion, Rocket } from 'lucide-react';
import { HeuristicCallout } from '@/components/error-pages/heuristic-callout';

describe('HeuristicCallout', () => {
  it('renders icon + h1 title + body', () => {
    render(
      <HeuristicCallout
        icon={FileQuestion}
        title="Unknown route"
        body="The path you typed is not a known section."
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Unknown route');
    expect(screen.getByText('The path you typed is not a known section.')).toBeTruthy();
    const svg = document.querySelector('svg[aria-hidden="true"]');
    expect(svg).not.toBeNull();
  });

  it('renders primaryAction slot when provided', () => {
    render(
      <HeuristicCallout
        icon={FileQuestion}
        title="t"
        body="b"
        primaryAction={<button type="button">Go to library</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Go to library' })).toBeTruthy();
  });

  it('renders secondary callout when provided', () => {
    render(
      <HeuristicCallout
        icon={FileQuestion}
        title="Primary"
        body="b"
        secondaryCallout={{
          icon: Rocket,
          title: 'Onboarding incomplete',
          body: 'Finish setup to unlock everything.',
        }}
      />,
    );
    expect(screen.getByTestId('secondary-callout')).toBeTruthy();
    expect(screen.getByText('Onboarding incomplete')).toBeTruthy();
  });

  it('omits secondary callout when not provided', () => {
    render(<HeuristicCallout icon={FileQuestion} title="t" body="b" />);
    expect(screen.queryByTestId('secondary-callout')).toBeNull();
  });

  it('exposes data-kind attribute for analytics', () => {
    render(<HeuristicCallout icon={FileQuestion} title="t" body="b" kind="route-unknown" />);
    const section = document.querySelector('section[data-kind="route-unknown"]');
    expect(section).not.toBeNull();
  });

  it('aria-labelledby links section to title id', () => {
    render(<HeuristicCallout icon={FileQuestion} title="t" body="b" />);
    const section = document.querySelector('section[aria-labelledby="heuristic-callout-title"]');
    expect(section).not.toBeNull();
    expect(document.getElementById('heuristic-callout-title')).not.toBeNull();
  });
});
