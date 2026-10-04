import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { firaSans, firaCode } from '@/lib/fonts';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import { ShellGate } from '@/components/app-shell/shell-gate';
import { SkipLink } from '@/components/app-shell/skip-link';
import { Toaster } from '@/components/ui/sonner';
import { AuthStatusProvider } from '@/components/auth/auth-status-provider';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import { getServerAuthStatus } from '@/src/lib/auth/server-status';
import '../globals.css';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const messages = await getMessages();

  // 05-02 audit M2: SSR-seeded auth status. Client reads synchronously from
  // context — no mount-time fetch when auth_enabled='false'. Zero CLS.
  const initialAuthStatus = await getServerAuthStatus();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${firaSans.variable} ${firaCode.variable}`}
    >
      <body>
        {/* Plan 21-03 audit-M2: stale-cache fingerprint for error.tsx classify.
            window.__APP_VERSION__ is the version baked at SSR time; the client
            bundle reads process.env.NEXT_PUBLIC_APP_VERSION at runtime — a
            mismatch indicates the operator is on a stale tab post-deploy. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__APP_VERSION__=${JSON.stringify(
              process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
            )};`,
          }}
        />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
            <AuthStatusProvider initialStatus={initialAuthStatus}>
              <SkipLink />
              {/* 05-02 ShellGate: suppresses Topbar+Sidebar on /[locale]/login;
                  full App-Shell on every other route (byte-identical 1.4.0 markup). */}
              <ShellGate>{children}</ShellGate>
              {/* 22-01 IMP-4: client-side Web Vitals reporter. Hand-rolled
                  PerformanceObserver (ZERO new npm deps). Mounts under
                  [locale]/layout (NOT outer app/layout) so usePathname() works. */}
              <WebVitalsReporter />
              {/* 13-01b T7 SR9: visibleToasts>=3 required for sonner-stack
                  rapid-trigger UAT (3 independent P2 undo-toasts). Sonner default
                  is 3 but we set it explicitly to prevent future regression. */}
              <Toaster richColors position="bottom-right" visibleToasts={3} />
            </AuthStatusProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
