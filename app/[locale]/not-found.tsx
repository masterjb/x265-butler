// Phase 21 Plan 21-03 T3 — heuristic-driven 404 surface.
//
// Server Component (no 'use client'). Reads original pathname from the
// `x-pathname` header injected by middleware (audit-M1), resolves locale via
// next-intl, snapshots onboarding-state from setting table, then classifies
// the failure-mode via classifyNotFound. Emits a single `notFoundEncountered`
// audit-trail line with `source:'not-found-server-component'` discipline.

import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { FileQuestion, Globe, MapPin, Rocket } from 'lucide-react';
import { settingRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { classifyNotFound, type NotFoundKind } from '@/src/lib/diagnostics/not-found-heuristic';
import { DEFAULT_LOCALE } from '@/src/lib/routes/known-routes';
import { PageContainer } from '@/components/page-layout';
import { HeuristicCallout } from '@/components/error-pages/heuristic-callout';
import { ErrorActionCluster } from '@/components/error-pages/error-action-cluster';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const FORUM_URL =
  process.env.NEXT_PUBLIC_FEEDBACK_FORUM_URL ??
  'https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/';

const KIND_ICON: Record<NotFoundKind, typeof FileQuestion> = {
  'route-unknown': MapPin,
  'locale-unknown': Globe,
  'locale-missing': Globe,
  fallback: FileQuestion,
};

// audit-S12 i18n naming-convention: kebab-case kinds → camelCase i18n branches.
const KIND_I18N_KEY: Record<NotFoundKind, string> = {
  'route-unknown': 'routeUnknown',
  'locale-unknown': 'localeUnknown',
  'locale-missing': 'localeMissing',
  fallback: 'fallback',
};

function readOnboardingSnapshot(): { onboardingCompleted: boolean } | undefined {
  try {
    return { onboardingCompleted: settingRepo().get('onboarding_completed') === 'true' };
  } catch {
    // Silent fallback — secondary callout is suppressed when DB unavailable.
    return undefined;
  }
}

export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'notfound' });
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? '';

  const result = classifyNotFound({
    pathname,
    resolvedLocale: locale,
    settings: readOnboardingSnapshot(),
  });

  logger.info(
    {
      event: 'notFoundEncountered',
      source: 'not-found-server-component',
      kind: result.kind,
      pathname: result.pathname,
      locale,
      onboardingIncomplete: result.onboardingIncomplete,
    },
    'diagnostics.not-found',
  );

  const localeForLinks =
    result.kind === 'locale-missing' || result.kind === 'locale-unknown'
      ? DEFAULT_LOCALE
      : result.locale;

  const Icon = KIND_ICON[result.kind];
  const branch = KIND_I18N_KEY[result.kind];
  const title = t(`${branch}.title`);
  const body =
    result.kind === 'route-unknown'
      ? t('routeUnknown.body', { route: result.route, candidate: result.candidates[0] ?? '' })
      : t(`${branch}.body`);

  const primaryActionLabel =
    result.kind === 'route-unknown'
      ? t('routeUnknown.primaryCta', { candidate: result.candidates[0] ?? '' })
      : t(`${branch}.primaryCta`);

  const primaryAction = (
    <a
      href={result.suggestedHref}
      className={cn(buttonVariants({ variant: 'default', size: 'lg' }), 'min-h-[44px] gap-2')}
      data-testid="primary-action"
    >
      <span>{primaryActionLabel}</span>
    </a>
  );

  const secondaryCallout = result.onboardingIncomplete
    ? {
        icon: Rocket,
        title: t('onboardingIncomplete.title'),
        body: t('onboardingIncomplete.body'),
      }
    : undefined;

  return (
    <PageContainer variant="centered">
      <HeuristicCallout
        kind={result.kind}
        icon={Icon}
        title={title}
        body={body}
        primaryAction={primaryAction}
        secondaryCallout={secondaryCallout}
      />
      <ErrorActionCluster
        diagnosticsHref={`/${localeForLinks}/diagnostics`}
        libraryHref={`/${localeForLinks}/library`}
        forumHref={FORUM_URL}
        onboardingHref={result.onboardingIncomplete ? `/${localeForLinks}/onboarding` : undefined}
        labels={{
          diagnostics: t('actionCluster.diagnostics'),
          library: t('actionCluster.library'),
          forum: t('actionCluster.forum'),
          onboarding: t('actionCluster.onboarding'),
        }}
      />
    </PageContainer>
  );
}
