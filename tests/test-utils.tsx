import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';
import type { ReactElement } from 'react';

export function wrap(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}
