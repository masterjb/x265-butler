'use client';

// Phase 21 Plan 21-02 — shared prefers-reduced-motion hook for diagnostics
// components. audit-SR5: uniform treatment across RefreshButton + CopyReport +
// TestEncodeRunner + EncoderReplayRunner + FeedbackLinks.

import { useEffect, useState } from 'react';

export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!mq || typeof mq.matches !== 'boolean') return;
    setReduce(mq.matches);
    if (typeof mq.addEventListener !== 'function') return;
    const handler = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener('change', handler);
    return () => {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', handler);
      }
    };
  }, []);
  return reduce;
}
