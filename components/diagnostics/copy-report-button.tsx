'use client';

// Phase 21 Plan 21-02 — CopyReport button.
//
// Fetches /api/diagnostics-report (markdown body), writes to clipboard,
// sonner-toast on success, fallback path on Clipboard-API unavailable,
// modal-fallback when both clipboard + execCommand fail.
// audit-SR1: byteLength via TextEncoder (true UTF-8 bytes).
// audit-SR3+SR4: AbortController + 10s timeout + unmount cleanup.
// audit-SR5: prefers-reduced-motion → text-only "Loading..." label.
// audit-SR6: modal-fallback for legacy/non-HTTPS browsers.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Clipboard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';
import {
  assembleReportForClipboard,
  type TestEncodeResultSnapshot,
} from './test-encode-result-markdown';

const REPORT_TIMEOUT_MS = 10_000;

async function postLogEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/diagnostics/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
      keepalive: true,
    });
  } catch {
    // Best-effort audit-trail; never block UX on log-event failure.
  }
}

async function copyViaClipboardApi(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyReportButton({
  lastTestEncodeResult,
  generatedAt,
  gated = false,
}: {
  lastTestEncodeResult?: TestEncodeResultSnapshot | null;
  generatedAt?: string | null;
  gated?: boolean;
} = {}) {
  const t = useTranslations('diagnostics');
  const [loading, setLoading] = useState(false);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleClick = async () => {
    // Plan 21-05 T0 d1: defensive guard — disabled attr already blocks browser
    // click, but cheap insurance against future regression of the disabled prop.
    if (gated) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, REPORT_TIMEOUT_MS);

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

      let copied = await copyViaClipboardApi(body);
      if (!copied) copied = copyViaExecCommand(body);

      if (!copied) {
        // audit-SR6: modal-fallback dialog.
        setFallbackText(body);
        return;
      }

      const byteLength = new TextEncoder().encode(body).length;
      toast.success(t('copyReport.toastSuccess'), { duration: 3000 });
      void postLogEvent('diagnosticsReportCopied', { byteLength });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (timedOut) toast.error(t('copyReport.toastTimeout'));
      } else {
        toast.error(t('copyReport.toastError', { status: 'network' }));
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  return (
    <>
      <Button
        type="button"
        onClick={handleClick}
        disabled={gated || loading}
        aria-busy={loading || undefined}
        aria-describedby={gated ? 'copy-report-gate-helper' : undefined}
        className="min-h-[44px] gap-2"
      >
        {loading && !reduceMotion ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Clipboard className="size-4" aria-hidden="true" />
        )}
        <span>{loading ? t('loading') : t('copyReport.button')}</span>
      </Button>
      {gated && (
        <p id="copy-report-gate-helper" role="note" className="mt-2 text-sm text-muted-foreground">
          {t('copyReport.gateHelper')}
        </p>
      )}

      <Dialog
        open={fallbackText !== null}
        onOpenChange={(open) => {
          if (!open) setFallbackText(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('copyReport.fallbackTitle')}</DialogTitle>
            <DialogDescription>{t('copyReport.fallbackInstruction')}</DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={fallbackText ?? ''}
            className="h-64 w-full resize-none rounded border bg-muted p-2 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setFallbackText(null)}>
              {t('refresh')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
