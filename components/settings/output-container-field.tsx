'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
// 05-14 audit-added (G5): queue-semantic advisory visibility gates on
// pending_count > 0. useQueueCounts is the existing live-update hook
// already wired to the SSE engine-events stream.
import { useQueueCounts } from '@/src/lib/api/engine-events-client';
import { FormControl, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
// 05-14: Tooltip + AlertTriangle/HelpCircle for the output_container Select
// + warning banner (MP4 selected) + help-icon trigger.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle, HelpCircle } from 'lucide-react';

// 05-14: output-container field — Select + amber-info warning banner
// on MP4 + Tooltip help-icon + queue-semantic advisory gated on
// pendingJobs > 0. Extracted to a sub-component so the Settings tab JSX
// stays readable and the queue-counts hook has a stable mount/unmount
// boundary.
type OutputContainerFieldProps = {
  // react-hook-form passes a typed ControllerRenderProps; we accept a
  // narrower shape to keep the boundary explicit and test-friendly.
  // 05-15 audit M1: widened to the 3-value setting union — without this,
  // the form schema's `z.enum(['mkv','mp4','match-source'])` resolves to a
  // wider type than the props accepted, breaking `pnpm tsc --noEmit`.
  field: {
    value: 'mkv' | 'mp4' | 'match-source';
    onChange: (v: 'mkv' | 'mp4' | 'match-source') => void;
    onBlur: () => void;
    name: string;
    ref: React.Ref<unknown>;
  };
  fieldState: {
    error?: { message?: string };
  };
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function OutputContainerField({
  field,
  fieldState,
}: OutputContainerFieldProps): React.ReactElement {
  const t = useTranslations('settings');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const queueCounts = useQueueCounts();

  // Reset Esc-dismiss state when operator toggles back to MKV — banner
  // re-appears on next MP4 selection without keeping stale-dismissed state.
  useEffect(() => {
    if (field.value !== 'mp4') setBannerDismissed(false);
  }, [field.value]);

  const showBanner = field.value === 'mp4' && !bannerDismissed;
  const showQueueAdvisory = queueCounts.pendingJobs > 0;

  return (
    <FormItem>
      <div className="flex items-center gap-2">
        <FormLabel htmlFor="output_container">{t('field.outputContainer.label')}</FormLabel>
        <Tooltip>
          <TooltipTrigger
            render={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                aria-label={t('field.outputContainer.tooltip.trigger')}
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <HelpCircle aria-hidden="true" className="size-4" />
              </button>
            )}
          />
          <TooltipContent>
            <span className="block max-w-xs text-xs leading-relaxed">
              {t('field.outputContainer.description')}
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <FormControl>
        <Select
          value={field.value}
          onValueChange={(v) => {
            // 05-15: accept the 3-value setting union; reject everything else.
            if (v === 'mkv' || v === 'mp4' || v === 'match-source') field.onChange(v);
          }}
        >
          <SelectTrigger
            id="output_container"
            className="w-full h-11 lg:h-9"
            aria-label={t('field.outputContainer.aria.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mkv">{t('field.outputContainer.options.mkv')}</SelectItem>
            <SelectItem value="mp4">{t('field.outputContainer.options.mp4')}</SelectItem>
            <SelectItem value="match-source">
              {t('field.outputContainer.options.matchSource')}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormControl>
      {showBanner && (
        <div
          role="alert"
          aria-live="polite"
          aria-label={t('field.outputContainer.aria.warning')}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setBannerDismissed(true);
            }
          }}
          className="mt-3 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1 leading-relaxed">{t('field.outputContainer.warning.mp4')}</div>
          <button
            type="button"
            aria-label={t('field.outputContainer.warning.dismiss')}
            onClick={() => setBannerDismissed(true)}
            className="text-amber-700 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {showQueueAdvisory && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          {t('field.outputContainer.advisory.queueSemantic')}
        </p>
      )}
      {field.value === 'match-source' && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          {t('field.outputContainer.advisory.matchSource')}
        </p>
      )}
      <FormMessage>{fieldState.error?.message}</FormMessage>
    </FormItem>
  );
}
