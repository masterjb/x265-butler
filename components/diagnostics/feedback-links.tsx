'use client';

// FeedbackLinks: Bug + Feature buttons.
//
// Layout: stacked under the "── Report an issue ──" heading,
// stacked <sm, side-by-side >=md. 2-step (copy + open) since
// Invision-board does NOT support deep-link body-prefill.
// Defensive `?? 'unknown'` interpolation on feature-template.
// FORUM_URL env-var kill-switch (mirrors docs/dev/kill-switches.md).
// AbortController + 10s timeout + unmount cleanup on bug-fetch.
// prefers-reduced-motion → text "Loading...".

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bug, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { AppVersionBlock } from '@/src/lib/diagnostics/types';
import { copyText } from '@/src/lib/ui/copy-text';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';
import {
  assembleReportForClipboard,
  type TestEncodeResultSnapshot,
} from './test-encode-result-markdown';

const FORUM_URL =
  process.env.NEXT_PUBLIC_FEEDBACK_FORUM_URL ??
  'https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/';

const BUG_REPORT_TIMEOUT_MS = 10_000;

async function postLogEvent(type: 'bug' | 'feature'): Promise<void> {
  try {
    await fetch('/api/diagnostics/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'feedbackLinkOpened', payload: { type } }),
      keepalive: true,
    });
  } catch {
    // Best-effort audit-trail.
  }
}

export function FeedbackLinks({
  app,
  lastTestEncodeResult,
  generatedAt,
  gated = false,
}: {
  app: AppVersionBlock;
  lastTestEncodeResult?: TestEncodeResultSnapshot | null;
  generatedAt?: string | null;
  gated?: boolean;
}) {
  const t = useTranslations('diagnostics');
  const [bugLoading, setBugLoading] = useState(false);
  const [featureLoading, setFeatureLoading] = useState(false);
  const submitLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleBugReport = async () => {
    // Defensive guard on top of disabled attr.
    if (gated) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setBugLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, BUG_REPORT_TIMEOUT_MS);

    try {
      const res = await fetch('/api/diagnostics-report', { signal: ac.signal });
      if (!res.ok) {
        toast.error(t('copyReport.toastError', { status: res.status }));
        return;
      }
      const reportBody = await res.text();
      const body = assembleReportForClipboard(
        reportBody,
        lastTestEncodeResult ?? null,
        generatedAt ?? null,
      );
      const copied = await copyText(body);
      if (!copied) {
        toast.error(t('copyReport.toastError', { status: 'clipboard' }));
        return;
      }
      toast.success(t('feedback.toastBugCopied'), {
        duration: 5000,
        action: {
          label: t('feedback.openForum'),
          onClick: () => {
            window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
          },
        },
      });
      window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
      void postLogEvent('bug');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (timedOut) toast.error(t('copyReport.toastTimeout'));
      } else {
        toast.error(t('copyReport.toastError', { status: 'network' }));
      }
    } finally {
      clearTimeout(timeout);
      setBugLoading(false);
      submitLockRef.current = false;
    }
  };

  const handleFeatureRequest = async () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setFeatureLoading(true);

    try {
      // Defensive nullish-coalescing prevents `vundefined · undefined`.
      const versionDisplay = app?.version ?? 'unknown';
      const hashDisplay = app?.gitHash ?? 'unknown';
      const template =
        `**${t('feedback.featureTemplate.what')}**\n\n` +
        `**${t('feedback.featureTemplate.why')}**\n\n` +
        `**${t('feedback.featureTemplate.how')}**\n\n` +
        `---\n*x265-butler v${versionDisplay} · ${hashDisplay}*`;

      const copied = await copyText(template);
      if (!copied) {
        toast.error(t('copyReport.toastError', { status: 'clipboard' }));
        return;
      }
      toast.success(t('feedback.toastFeatureCopied'), {
        duration: 5000,
        action: {
          label: t('feedback.openForum'),
          onClick: () => {
            window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
          },
        },
      });
      window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
      void postLogEvent('feature');
    } finally {
      setFeatureLoading(false);
      submitLockRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-1 flex-col">
          <Button
            type="button"
            variant="outline"
            onClick={handleBugReport}
            disabled={gated || bugLoading || featureLoading}
            aria-busy={bugLoading || undefined}
            aria-describedby={gated ? 'bug-report-gate-helper' : undefined}
            className="min-h-[44px] gap-2"
          >
            {bugLoading && !reduceMotion ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Bug className="size-4" aria-hidden="true" />
            )}
            <span>{bugLoading ? t('loading') : t('feedback.bugReport')}</span>
          </Button>
          {gated && (
            <p
              id="bug-report-gate-helper"
              role="note"
              className="mt-2 text-sm text-muted-foreground"
            >
              {t('feedback.bugGateHelper')}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleFeatureRequest}
          disabled={bugLoading || featureLoading}
          aria-busy={featureLoading || undefined}
          className="min-h-[44px] flex-1 gap-2"
        >
          {featureLoading && !reduceMotion ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          <span>{featureLoading ? t('loading') : t('feedback.featureRequest')}</span>
        </Button>
      </div>
    </div>
  );
}
