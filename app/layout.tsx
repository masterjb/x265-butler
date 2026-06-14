import { EngineEventsProvider } from '@/src/lib/api/engine-events-client';

// Root layout — minimal. The real <html>/<body> live in [locale]/layout.tsx
// so the `lang` attribute can match the URL locale. This split is the
// next-intl + App Router idiomatic pattern.
//
// 02-04: EngineEventsProvider wraps here so ONE EventSource survives
// Queue ↔ Library ↔ Trash navigation. No initial state at root level —
// provider bootstraps from /api/queue/status on first EventSource open.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <EngineEventsProvider>{children}</EngineEventsProvider>;
}
