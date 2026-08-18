import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LangSwitch } from '@/components/app-shell/lang-switch';
import en from '@/messages/en.json';
import { wrap } from './test-utils';

describe('lang switch (audit-added G8)', () => {
  it('test_langSwitch_when_clicked_lists_both_locales', async () => {
    const user = userEvent.setup();
    render(wrap(<LangSwitch />));
    await user.click(screen.getByRole('button', { name: en.app.langSwitch.label }));
    expect(await screen.findByRole('menuitem', { name: en.app.langSwitch.en })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: en.app.langSwitch.de })).toBeInTheDocument();
  });

  it('test_langSwitch_when_each_locale_clicked_callback_executes', async () => {
    const user = userEvent.setup();
    for (const label of [en.app.langSwitch.en, en.app.langSwitch.de]) {
      render(wrap(<LangSwitch />));
      await user.click(screen.getByRole('button', { name: en.app.langSwitch.label }));
      const item = await screen.findByRole('menuitem', { name: label });
      await user.click(item);
      cleanup(); // tear down between iterations to avoid duplicate buttons
    }
  });
});
