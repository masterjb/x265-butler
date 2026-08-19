// 05-02 T1: Login page Server Component.
// Phase 5 Plan 05-02 (Auth UI) — AC-1 + audit S1 (force-dynamic).
//
// Server-side requireAuth() short-circuits redirect-when-authed BEFORE render
// (no flash of login form). Setup-required CTA renders when auth_enabled=true
// AND auth_setup_completed=false.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LogIn, Lock } from 'lucide-react';
import { ensureServerInit } from '@/src/lib/server-init';
import { getServerAuthStatus } from '@/src/lib/auth/server-status';
import { LoginForm } from './login-form';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { LangSwitch } from '@/components/app-shell/lang-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_NEXT_PATHS = [
  '/library',
  '/dashboard',
  '/queue',
  '/trash',
  '/blocklist',
  '/logs',
  '/settings',
  '/bench',
];

const LOCALE_PREFIX_RE = /^\/(en|de)(?=\/|$)/;

function validateNextServer(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 256) return null;
  if (/[\\:]/.test(raw)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(raw)) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.includes('..')) return null;
  const stripped = raw.replace(LOCALE_PREFIX_RE, '') || '/';
  const matches = ALLOWED_NEXT_PATHS.some(
    (allowed) => stripped === allowed || stripped.startsWith(allowed + '/'),
  );
  return matches ? raw : null;
}

interface LoginPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[]; expired?: string }>;
}

export default async function LoginPage({ params, searchParams }: LoginPageProps) {
  const { locale } = await params;
  const search = await searchParams;
  setRequestLocale(locale);
  ensureServerInit();

  const status = await getServerAuthStatus();
  const next = validateNextServer(search.next) ?? `/${locale}/library`;

  // auth disabled → login is useless; redirect home.
  if (!status.authEnabled) {
    redirect(`/${locale}/library`);
  }

  // already authenticated → redirect to validated next or library.
  if (status.authenticated) {
    redirect(next);
  }

  const t = await getTranslations('login');

  // setup not done → CTA pointing to Settings → Auth (no login form).
  if (!status.setupCompleted) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div className="w-full max-w-sm space-y-6 sm:max-w-md">
          <div className="text-center">
            <Lock className="mx-auto size-8 text-primary" aria-hidden="true" />
            <h1 className="mt-3 font-sans text-2xl font-semibold tracking-tight text-foreground">
              {t('setupRequired.title')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{t('setupRequired.body')}</p>
          </div>
          <Link
            href={`/${locale}/settings?tab=auth`}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogIn className="size-4" aria-hidden="true" />
            {t('setupRequired.cta')}
          </Link>
        </div>
      </div>
    );
  }

  // standard login form
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
      <div className="w-full max-w-sm space-y-6 sm:max-w-md">
        <div className="text-center">
          <Lock className="mx-auto size-8 text-primary" aria-hidden="true" />
          <h1 className="mt-3 font-sans text-2xl font-semibold tracking-tight text-foreground">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <LoginForm next={next} expired={search.expired === '1'} />
        <p className="text-center text-xs text-muted-foreground">{t('recovery.note')}</p>
      </div>
      <div className="mt-8 flex items-center gap-1">
        <ThemeToggle />
        <LangSwitch />
      </div>
    </div>
  );
}
