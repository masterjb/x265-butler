'use client';

// 05-04 T2.A: Export-CSV toolbar action.
// Phase 5 Plan 05-04 — AC-5 + audit S2/S3/S4.
//
// Click flow:
//   1. submitLockRef synchronous double-click guard
//   2. authFetch GET /api/library/export.csv?<currentQueryString>
//   3. parse Content-Disposition (RFC 5987 first; fall back to legacy filename=)
//   4. Blob → object URL → transient anchor → click → revoke (audit S2: revoke
//      even when anchor flow throws, via try/finally)
//   5. AuthRedirectError swallowed silently (interceptor in authFetcher handles redirect)
//   6. Other errors → inline aria-live toast + Retry button (recovery path per
//      MASTER §11). audit S4: distinguish header-fail vs mid-stream truncation.

import { Download, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { authFetch, AuthRedirectError } from '@/components/auth/auth-fetcher';

export interface ExportCsvActionProps {
  currentQueryString: string;
  disabled?: boolean;
}

class ExportError extends Error {
  constructor(public readonly kind: 'export_failed' | 'export_partial') {
    super(kind);
    this.name = 'ExportError';
  }
}

// audit S4: filename* (RFC 5987) takes priority over legacy filename=.
export function parseFilenameFromCD(cd: string): string | null {
  const utf8Match = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // fallthrough to ASCII variant
    }
  }
  const asciiMatch = cd.match(/filename="([^"]+)"/i);
  if (asciiMatch) return asciiMatch[1];
  return null;
}

export function ExportCsvAction({ currentQueryString, disabled = false }: ExportCsvActionProps) {
  const t = useTranslations('library.export');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  async function runExport(): Promise<void> {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setInFlight(true);
    setError(null);
    try {
      const path = currentQueryString
        ? `/api/library/export.csv?${currentQueryString}`
        : '/api/library/export.csv';
      const res = await authFetch(path, { method: 'GET' });
      if (!res.ok) throw new ExportError('export_failed');

      let blob: Blob;
      try {
        blob = await res.blob();
      } catch {
        // audit S4: header succeeded but stream truncated mid-download.
        throw new ExportError('export_partial');
      }

      const cd = res.headers.get('Content-Disposition') ?? '';
      const filename = parseFilenameFromCD(cd) ?? 'x265-butler-library.csv';
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        // audit S2: revoke even when anchor flow throws.
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if (e instanceof AuthRedirectError) return;
      const partial = e instanceof ExportError && e.kind === 'export_partial';
      setError(partial ? t('error.message_partial') : t('error.message'));
    } finally {
      submitLockRef.current = false;
      setInFlight(false);
    }
  }

  const isDisabled = disabled || inFlight;
  const showEmptyTooltip = disabled && !inFlight;

  const button = (
    <Button
      type="button"
      variant="outline"
      size="lg"
      onClick={() => void runExport()}
      disabled={isDisabled}
      aria-label={t('button.aria')}
      aria-busy={inFlight || undefined}
      className="min-h-[44px]"
    >
      {inFlight ? (
        <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Download aria-hidden="true" />
      )}
      {inFlight ? t('button.busy') : t('button.idle')}
    </Button>
  );

  return (
    <div className="flex flex-col items-end gap-2">
      {showEmptyTooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent>{t('empty.tooltip')}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {error && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm font-medium text-destructive"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => void runExport()}
            aria-label={t('error.retry')}
            className="min-h-[44px]"
          >
            {t('error.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
