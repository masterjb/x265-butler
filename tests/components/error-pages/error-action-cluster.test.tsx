// Phase 21 Plan 21-03 T2 — ErrorActionCluster component tests.
// AC-7 + AC-14: hrefs propagate, forum opens new tab, onboarding conditional,
// touch-target classes present.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorActionCluster } from '@/components/error-pages/error-action-cluster';

const labels = {
  diagnostics: 'Diagnostics',
  library: 'Library',
  forum: 'Report bug',
  onboarding: 'Start onboarding',
};

describe('ErrorActionCluster', () => {
  it('renders Diagnostics + Library + Forum buttons by default (no onboarding)', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref="https://example.test/forum"
        labels={labels}
      />,
    );
    expect(screen.getByTestId('action-diagnostics').getAttribute('href')).toBe('/en/diagnostics');
    expect(screen.getByTestId('action-library').getAttribute('href')).toBe('/en/library');
    expect(screen.getByTestId('action-forum').getAttribute('href')).toBe(
      'https://example.test/forum',
    );
    expect(screen.queryByTestId('action-onboarding')).toBeNull();
  });

  it('renders Onboarding button when onboardingHref is set', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref="https://example.test/forum"
        onboardingHref="/en/onboarding"
        labels={labels}
      />,
    );
    expect(screen.getByTestId('action-onboarding').getAttribute('href')).toBe('/en/onboarding');
  });

  it('forum link opens new tab with rel="noopener noreferrer"', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref="https://example.test/forum"
        labels={labels}
      />,
    );
    const forum = screen.getByTestId('action-forum');
    expect(forum.getAttribute('target')).toBe('_blank');
    expect(forum.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders primary-action slot above secondary cluster', () => {
    render(
      <ErrorActionCluster
        primaryAction={<button type="button">Hard refresh</button>}
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref="https://example.test/forum"
        labels={labels}
      />,
    );
    expect(screen.getByRole('button', { name: 'Hard refresh' })).toBeTruthy();
  });

  it('every secondary button carries min-h-[44px] touch-target class', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/d"
        libraryHref="/en/l"
        forumHref="https://example.test/forum"
        onboardingHref="/en/o"
        labels={labels}
      />,
    );
    for (const id of [
      'action-diagnostics',
      'action-library',
      'action-forum',
      'action-onboarding',
    ]) {
      const el = screen.getByTestId(id);
      expect(el.className).toContain('min-h-[44px]');
    }
  });

  it('every secondary button carries aria-label', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/d"
        libraryHref="/en/l"
        forumHref="https://example.test/forum"
        labels={labels}
      />,
    );
    expect(screen.getByTestId('action-diagnostics').getAttribute('aria-label')).toBe('Diagnostics');
    expect(screen.getByTestId('action-library').getAttribute('aria-label')).toBe('Library');
    expect(screen.getByTestId('action-forum').getAttribute('aria-label')).toBe('Report bug');
  });

  it('respects locale-missing default-locale hrefs from caller', () => {
    render(
      <ErrorActionCluster
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref="https://example.test/forum"
        labels={labels}
      />,
    );
    expect(screen.getByTestId('action-library').getAttribute('href')!.startsWith('/en/')).toBe(
      true,
    );
  });
});
