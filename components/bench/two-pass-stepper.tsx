'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import {
  PlayCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  ClipboardCheck,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// 11-03 AC-6: pass2State literal 'disabled' widened to operable union.
// 'disabled' is preserved for graceful-degradation when run.status !== 'completed'.
export type Pass1State = 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type Pass2State =
  | 'disabled' // run not yet completed → Pass-2 not invokable
  | 'idle' // ready, awaiting operator click on "Use this"
  | 'running' // verify in flight; overallPct + cancel affordance
  | 'complete' // verified; metrics inline
  | 'failed' // verify failed; retry affordance
  | 'cancelled'; // operator cancelled; restart affordance

export interface TwoPassStepperProps {
  pass1State: Pass1State;
  pass1Progress?: { completed: number; total: number };
  pass1ErrorReason?: string;
  pass2State: Pass2State;
  // 11-03: Pass-2 result + lifecycle controls.
  pass2VerifiedVmaf?: number;
  pass2ErrorReason?: string;
  onPass2Retry?: () => void;
}

function pass1Icon(state: Pass1State, className?: string) {
  const cls = cn('h-5 w-5', className);
  switch (state) {
    case 'idle':
    case 'queued':
      return <PlayCircle className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-primary')} aria-hidden="true" />;
    case 'complete':
      return <CheckCircle2 className={cn(cls, 'text-green-500')} aria-hidden="true" />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-destructive')} aria-hidden="true" />;
    case 'cancelled':
      return <Ban className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
  }
}

function pass2Icon(state: Pass2State, className?: string) {
  const cls = cn('h-5 w-5', className);
  switch (state) {
    case 'disabled':
    case 'idle':
      return <ClipboardCheck className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-primary')} aria-hidden="true" />;
    case 'complete':
      return <CheckCircle2 className={cn(cls, 'text-green-500')} aria-hidden="true" />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-destructive')} aria-hidden="true" />;
    case 'cancelled':
      return <Ban className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
  }
}

function pillClass(state: Pass1State | Pass2State): string {
  switch (state) {
    case 'complete':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'failed':
      return 'bg-destructive/10 text-destructive';
    case 'running':
      return 'bg-primary/10 text-primary';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export function TwoPassStepper({
  pass1State,
  pass1Progress,
  pass1ErrorReason,
  pass2State,
  pass2VerifiedVmaf,
  pass2ErrorReason,
  onPass2Retry,
}: TwoPassStepperProps) {
  const t = useTranslations('bench.stepper');
  const tPass2 = useTranslations('bench.pass2');
  const pass2TooltipId = useId();

  const pass1PillContent =
    pass1State === 'running' && pass1Progress
      ? t('progressPill', { completed: pass1Progress.completed, total: pass1Progress.total })
      : t(`state.${pass1State}`);

  const pass2PillContent =
    pass2State === 'disabled' || pass2State === 'idle'
      ? tPass2('idle')
      : pass2State === 'running'
        ? tPass2('running')
        : pass2State === 'complete'
          ? tPass2('complete')
          : pass2State === 'failed'
            ? tPass2('failed')
            : tPass2('cancelled');

  return (
    <TooltipProvider>
      <div className="flex items-start gap-0" role="list" aria-label="2-pass stepper">
        {/* Pass 1 */}
        <div
          className="flex flex-col items-center flex-1 gap-2"
          role="listitem"
          aria-label={`Pass 1: ${pass1PillContent}`}
        >
          <div className="flex items-center gap-2">
            {pass1Icon(pass1State)}
            <span className="text-sm font-medium">{t('pass1.label')}</span>
          </div>
          <span
            className={cn('text-xs font-medium px-2 py-0.5 rounded-full', pillClass(pass1State))}
          >
            {pass1PillContent}
          </span>
          {pass1State === 'failed' && pass1ErrorReason && (
            <span className="text-xs text-destructive">{pass1ErrorReason}</span>
          )}
        </div>

        {/* Connector line */}
        <div className="h-0.5 flex-1 bg-border self-center mt-0" aria-hidden="true" />

        {/* Pass 2 — widens via pass2State (11-03 AC-6) */}
        <div
          className={cn(
            'flex flex-col items-center flex-1 gap-2',
            pass2State === 'disabled' && 'opacity-50',
          )}
          role="listitem"
          aria-label={`Pass 2: ${pass2PillContent}`}
        >
          {pass2State === 'disabled' ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-describedby={pass2TooltipId}
                    className="flex items-center gap-2 cursor-default"
                  />
                }
              >
                {pass2Icon(pass2State)}
                <span className="text-sm font-medium">{t('pass2.label')}</span>
              </TooltipTrigger>
              <TooltipContent id={pass2TooltipId}>{tPass2('verifyTooltipReady')}</TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-2">
              {pass2Icon(pass2State)}
              <span className="text-sm font-medium">{t('pass2.label')}</span>
            </div>
          )}

          <span
            className={cn('text-xs font-medium px-2 py-0.5 rounded-full', pillClass(pass2State))}
          >
            {pass2PillContent}
          </span>

          {pass2State === 'complete' && pass2VerifiedVmaf !== undefined && (
            <span className="text-xs font-mono tabular-nums text-muted-foreground">
              VMAF {pass2VerifiedVmaf.toFixed(2)}
            </span>
          )}

          {pass2State === 'failed' && (
            <>
              {pass2ErrorReason && (
                <span className="text-xs text-destructive max-w-[200px] text-center break-words">
                  {pass2ErrorReason}
                </span>
              )}
              {onPass2Retry && (
                <button
                  type="button"
                  onClick={onPass2Retry}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  {tPass2('retry')}
                </button>
              )}
            </>
          )}

          {pass2State === 'cancelled' && onPass2Retry && (
            <button
              type="button"
              onClick={onPass2Retry}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {tPass2('restart')}
            </button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
