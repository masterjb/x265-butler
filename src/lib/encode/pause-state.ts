// 32-02: in-memory queue pause flag — DELIBERATELY dependency-free.
//
// This module holds the single module-level `_paused` boolean and its getter.
// It is intentionally split out of orchestrator.ts: the orchestrator's module
// init runs `makeDefaultDeps()` which eagerly reads db repo exports, so importing
// `isQueuePaused` FROM the orchestrator (or the encode barrel) drags that whole
// graph into any consumer — breaking light server modules (GET /api/queue/status,
// the watcher service, the queue SSR page) whose tests only partially mock
// '@/src/lib/db'. By living here with ZERO imports, `isQueuePaused` can be
// consumed by those light modules without pulling the orchestrator (audit SR-3).
//
// The mutating side (setQueuePaused: emit + dispatch-kick + audit breadcrumb)
// stays in orchestrator.ts where it needs the dispatch internals; it flips the
// flag through __setPausedFlag below. The dispatch gate reads isQueuePaused().

let _paused = false;

/**
 * Single source of truth for the in-memory queue pause state. Consumed by the
 * orchestrator + watcher emit, GET /api/queue/status, and the queue SSR page.
 */
export function isQueuePaused(): boolean {
  return _paused;
}

/**
 * Internal setter — orchestrator.setQueuePaused() owns the side effects (emit,
 * dispatch-kick, audit). Not exported via the encode barrel.
 */
export function __setPausedFlag(paused: boolean): void {
  _paused = paused;
}

/** Test-reset hook — keep parity with the orchestrator's _stopping reset. */
export function __resetPausedFlag(): void {
  _paused = false;
}
