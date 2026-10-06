'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Wizard step 1 (Welcome). No form, ONE primary CTA.
// Heading hierarchy: EXACTLY ONE <h1> per step.

export function WelcomeStep({
  onContinue,
  isSubmitting,
}: {
  onContinue: () => void;
  isSubmitting: boolean;
}) {
  const t = useTranslations('onboarding');
  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('step1.headline')}
          </h1>
          <p className="text-base text-muted-foreground">{t('step1.body')}</p>
        </div>
        <Button
          type="button"
          size="lg"
          className="w-full md:w-auto md:self-start"
          onClick={onContinue}
          // In-flight button-disable defense-in-depth.
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
        >
          {t('step1.cta')}
        </Button>
      </CardContent>
    </Card>
  );
}
