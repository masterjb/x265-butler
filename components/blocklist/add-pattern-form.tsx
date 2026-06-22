'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// 22-03 T2: shape of the optional extensionWarning field returned by
// POST /api/library/[id]/blocklist on mode='pattern' created branches.
type ExtensionWarning = {
  resolvedExt: string;
  scanExtensions: string[];
};

// 04-02: add-pattern inline form. Reuses 01-04 hand-rolled <Form> pattern but
// simplified for single-field. Client-side validation (min 2 chars + max 2 stars
// + length cap 4096); server-side zod also validates (defense-in-depth).
//
// ui-ux-pro-max review (Plan 04-02):
//   A4 auto-focus invalid input on submit error (focus-management rule)
//   B2 onBlur inline validation instead of submit-only
//   B3 min-h-[44px] touch target on Cancel + Submit

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function AddPatternForm({
  onAdded,
  onCancel,
}: {
  onAdded: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('blocklist');
  const [pattern, setPattern] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 22-03 T2: ephemeral inline warning (D1α + D2α). Dismiss is the only path
  // to onAdded when set — form stays open until operator acknowledges.
  const [extensionWarning, setExtensionWarning] = useState<ExtensionWarning | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function validate(value: string): string | null {
    if (value.length < 2) return t('error.patternTooShort');
    if (value.length > 4096) return t('error.patternTooComplex');
    const starCount = (value.match(/\*/g) ?? []).length;
    if (starCount > 2) return t('error.patternTooComplex');
    return null;
  }

  // ui-ux-pro-max B2: validate onBlur (not keystroke). Skip when empty —
  // operator hasn't committed yet.
  function handleBlur(): void {
    if (pattern.length === 0) return;
    const validationError = validate(pattern);
    setError(validationError);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate(pattern);
    if (validationError) {
      setError(validationError);
      // ui-ux-pro-max A4: auto-focus invalid field after submit error.
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithTimeout('/api/library/0/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'pattern', pathPattern: pattern }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'pattern_too_complex') {
          setError(t('error.patternTooComplex'));
        } else {
          setError(t('error.addFailed'));
        }
        // Auto-focus on server-side validation error too.
        inputRef.current?.focus();
        return;
      }
      // 22-03 T2: parse body for optional extensionWarning. When present, keep
      // the form open with the amber surface; dismiss is the only path to
      // onAdded. When absent, retain pre-22-03 close-immediately behavior.
      const body = (await res.json().catch(() => ({}))) as {
        extensionWarning?: ExtensionWarning;
      };
      toast.success(t('added.toast'));
      if (body.extensionWarning) {
        setExtensionWarning(body.extensionWarning);
        // Form stays open — operator dismisses to clear + collapse.
        return;
      }
      setPattern('');
      onAdded();
    } catch {
      setError(t('error.addFailed'));
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">{t('addPattern.headline')}</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-2">
            <label htmlFor="pattern" className="text-sm font-medium">
              {t('addPattern.label')}
            </label>
            <Input
              id="pattern"
              ref={inputRef}
              type="text"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                if (error) setError(null);
              }}
              onBlur={handleBlur}
              placeholder={t('addPattern.placeholder')}
              autoComplete="off"
              autoFocus
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'pattern-error pattern-helper' : 'pattern-helper'}
            />
            <p id="pattern-helper" className="text-xs text-muted-foreground">
              {t('addPattern.helper')}
            </p>
            {error && (
              <p id="pattern-error" className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          {extensionWarning && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="flex-1">
                <p className="font-medium">
                  {t('addPattern.extensionWarning.title', { ext: extensionWarning.resolvedExt })}
                </p>
                <p className="mt-1">
                  {t('addPattern.extensionWarning.body', {
                    exts: extensionWarning.scanExtensions.join(', '),
                    ext: extensionWarning.resolvedExt,
                  })}
                </p>
                <div className="mt-2 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setExtensionWarning(null);
                      setPattern('');
                      onAdded();
                    }}
                  >
                    {t('addPattern.extensionWarning.dismiss')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setExtensionWarning(null);
                onCancel();
              }}
              disabled={submitting}
              className="min-h-[44px] md:min-h-0"
            >
              {t('addPattern.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={submitting || pattern.length < 2}
              className="min-h-[44px] md:min-h-0"
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
              {t('addPattern.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
