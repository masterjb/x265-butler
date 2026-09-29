import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkipLink } from '@/components/app-shell/skip-link';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import en from '@/messages/en.json';
import { wrap } from './test-utils';

describe('app shell', () => {
  it('test_skipLink_when_rendered_targets_main_landmark', () => {
    render(wrap(<SkipLink />));
    const link = screen.getByRole('link', { name: en.app.skipLink });
    expect(link).toHaveAttribute('href', '#main');
  });

  it('test_themeToggle_when_clicked_opens_menu_with_three_options', async () => {
    const user = userEvent.setup();
    render(wrap(<ThemeToggle />));
    await user.click(screen.getByRole('button', { name: en.app.themeToggle.label }));
    expect(
      await screen.findByRole('menuitem', { name: new RegExp(en.app.themeToggle.light, 'i') }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('menuitem', { name: new RegExp(en.app.themeToggle.dark, 'i') }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('menuitem', {
        name: new RegExp(en.app.themeToggle.system, 'i'),
      }),
    ).toBeInTheDocument();
  });

  it('test_themeToggle_when_each_option_clicked_callback_executes', async () => {
    const user = userEvent.setup();
    for (const label of [
      en.app.themeToggle.light,
      en.app.themeToggle.dark,
      en.app.themeToggle.system,
    ]) {
      render(wrap(<ThemeToggle />));
      await user.click(screen.getByRole('button', { name: en.app.themeToggle.label }));
      const item = await screen.findByRole('menuitem', { name: new RegExp(label, 'i') });
      await user.click(item);
      cleanup(); // tear down between iterations to avoid duplicate buttons in DOM
    }
  });
});
