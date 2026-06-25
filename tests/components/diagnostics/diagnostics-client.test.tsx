// Phase 21 Plan 21-02 T3 Step 6 — DiagnosticsClient wrapper tests (AC-1).
// Plan 21-05 — gate audit-emit + kill-switch (AC-7 + AC-8 + AC-9 audit-M3).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { wrap } from '../../test-utils';
import { DiagnosticsClient } from '@/components/diagnostics/diagnostics-client';
import type { DiagnosticsPayload, RenderDeviceProbe } from '@/src/lib/diagnostics/types';
import type { TestEncodeResultSnapshot } from '@/components/diagnostics/test-encode-result-markdown';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// 21-05 test-double: TestEncodeRunner exposes a button that fires onResult
// with a controllable snapshot. Lets us drive null→completed transitions
// without mocking the full /api/diagnostics/test-encode response chain.
const { runnerSnapshotRef } = vi.hoisted(() => ({
  runnerSnapshotRef: {
    current: {
      outcome: 'success',
      encoderPicked: 'libx265',
      durationMs: 1234,
      exitCode: 0,
      ffmpegStdout: '',
      ffmpegStderr: '',
    } as TestEncodeResultSnapshot,
  },
}));

vi.mock('@/components/diagnostics/test-encode-runner', () => ({
  TestEncodeRunner: ({ onResult }: { onResult?: (s: TestEncodeResultSnapshot | null) => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'mock-test-encode-runner',
        onClick: () => onResult?.(runnerSnapshotRef.current),
      },
      'mock-runner',
    ),
}));

function fixture(): DiagnosticsPayload {
  return {
    app: {
      version: '2.17.3',
      gitHash: 'abc1234',
      committedAt: 1700000000,
      committedAtCET: '14.11.2023 13:33:20',
    },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 42, pid: 999 },
    mounts: [
      { path: '/media', readable: true, writable: true },
      { path: '/config', readable: true, writable: false },
    ],
    devices: { dri: ['/dev/dri/renderD128'], nvidia: [], renderDevices: [] },
    encoders: {
      detected: ['libx265', 'nvenc'],
      warnings: [{ code: 'NVENC_PROBE_OK' }],
      outcome: [],
    },
    warnings: [
      { severity: 'warn', source: 'mount', code: 'MOUNT_READ_ONLY', message: '/config read-only' },
      { severity: 'error', source: 'encoder', code: 'ENC_X', message: 'enc-issue' },
    ],
    recentErrors: [{ ts: 1700000000000, level: 50, msg: 'first error', source: 'test' }],
    onboarding: { completed: true, hasShare: true },
    cache: DEFAULT_CACHE_BLOCK_24_03,
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    pollingShares: [],
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-05-23T13:00:00.000Z',
  };
}

describe('DiagnosticsClient', () => {
  it('renders all key section titles', () => {
    render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    expect(screen.getByText(/App Info|App-Info/i)).toBeInTheDocument();
    expect(screen.getByText(/Runtime|Laufzeit/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Encoders|Encoder/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Warnings|Warnungen/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Recent Errors|Letzte Fehler/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Test Encode|Test-Encode/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Copy Report|Bericht kopieren/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Report an issue|Problem melden/i).length).toBeGreaterThan(0);
  });

  it('initialPayload props flow into child render (version, encoders, mounts)', () => {
    render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    expect(screen.getAllByText(/2\.17\.3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/abc1234/).length).toBeGreaterThan(0);
    expect(screen.getByText(/libx265, nvenc/)).toBeInTheDocument();
    expect(screen.getByText(/^\/media$/)).toBeInTheDocument();
    expect(screen.getAllByText(/\/config/).length).toBeGreaterThan(0);
  });

  it('warning severity icons rendered for both warn and error', () => {
    const { container } = render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    // Two warnings + one mount warning rendered.
    expect(screen.getByText(/MOUNT_READ_ONLY/)).toBeInTheDocument();
    expect(screen.getByText(/ENC_X/)).toBeInTheDocument();
    // svg icons rendered (severityIcon → AlertCircle for error, AlertTriangle for warn)
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});

// 23-02 — Render Devices card (AC-5).
describe('DiagnosticsClient 23-02 Render Devices card', () => {
  const IN_GROUP: RenderDeviceProbe = {
    path: '/dev/dri/renderD128',
    exists: true,
    gid: 105,
    groupName: 'render',
    processGroups: [44, 105],
    processGid: 1000,
    inRenderGroup: true,
    readable: true,
    writable: true,
  };
  // 29-02: writable:false → groupFixRelevant=true → STILL amber, but the label is
  // now accessProblem (not notInGroup). The audit M1 RED→GREEN assertion-rewrite.
  const OUT_OF_GROUP: RenderDeviceProbe = {
    path: '/dev/dri/renderD129',
    exists: true,
    gid: 106,
    groupName: null,
    processGroups: [44, 105],
    processGid: 1000,
    inRenderGroup: false,
    readable: true,
    writable: false,
  };
  // 29-02 rasalf: RW both pass, NOT in group → muted reassurance, NO amber.
  const RW_OK_NO_GROUP: RenderDeviceProbe = {
    path: '/dev/dri/renderD130',
    exists: true,
    gid: 18,
    groupName: null,
    processGroups: [44, 105],
    processGid: 1000,
    inRenderGroup: false,
    readable: true,
    writable: true,
  };

  function withRenderDevices(rd: RenderDeviceProbe[]): DiagnosticsPayload {
    return { ...fixture(), devices: { dri: [], nvidia: [], renderDevices: rd } };
  }

  it('AC-5/M1: populated → R/W-failing row amber w/ AlertTriangle + accessProblem, in-group muted', () => {
    const { container } = render(
      wrap(<DiagnosticsClient initialPayload={withRenderDevices([IN_GROUP, OUT_OF_GROUP])} />),
    );
    expect(screen.getByText('/dev/dri/renderD128')).toBeInTheDocument();
    expect(screen.getByText('/dev/dri/renderD129')).toBeInTheDocument();
    // writable:false → amber + icon + text (never color alone)
    const amber = container.querySelector('.text-amber-600');
    expect(amber).not.toBeNull();
    expect(amber!.querySelector('svg')).not.toBeNull(); // AlertTriangle present
    // audit M1: label is now accessProblem, NOT the dropped notInGroup key
    expect(amber!.textContent).toMatch(/no access|kein Zugriff/i);
    expect(amber!.textContent).not.toMatch(/not in group|nicht in Gruppe/i);
    // in-group → muted ✓ inGroup text exists somewhere
    expect(screen.getAllByText(/in group|in Gruppe/i).length).toBeGreaterThan(0);
  });

  it('AC-2: rasalf RW-OK + not-in-group → muted reassurance, NO amber, NO AlertTriangle', () => {
    const { container } = render(
      wrap(<DiagnosticsClient initialPayload={withRenderDevices([RW_OK_NO_GROUP])} />),
    );
    // no amber, no alarm icon row for this device
    expect(container.querySelector('.text-amber-600')).toBeNull();
    expect(
      screen.getByText(/group membership not required|nicht erforderlich/i),
    ).toBeInTheDocument();
    // footnote is the neutral groupNoteOk (no PGID advisory)
    expect(screen.getByText(/changes are not required|nicht erforderlich/i)).toBeInTheDocument();
  });

  it('AC-3: readable:false device → amber + AlertTriangle + accessProblem + groupNoteFix', () => {
    const NO_READ: RenderDeviceProbe = {
      ...IN_GROUP,
      path: '/dev/dri/renderD131',
      readable: false,
    };
    const { container } = render(
      wrap(<DiagnosticsClient initialPayload={withRenderDevices([NO_READ])} />),
    );
    const amber = container.querySelector('.text-amber-600');
    expect(amber).not.toBeNull();
    expect(amber!.querySelector('svg')).not.toBeNull();
    expect(amber!.textContent).toMatch(/no access|kein Zugriff/i);
    // failing device → fix-advisory footnote present (PGID)
    expect(screen.getByText(/PGID/)).toBeInTheDocument();
  });

  it('AC-7/SR2: in-group BUT writable:false → amber accessProblem, NOT a hidden ✓ in-group', () => {
    const IN_GROUP_NO_WRITE: RenderDeviceProbe = {
      ...IN_GROUP,
      path: '/dev/dri/renderD132',
      inRenderGroup: true,
      writable: false,
    };
    const { container } = render(
      wrap(<DiagnosticsClient initialPayload={withRenderDevices([IN_GROUP_NO_WRITE])} />),
    );
    const amber = container.querySelector('.text-amber-600');
    expect(amber).not.toBeNull();
    expect(amber!.querySelector('svg')).not.toBeNull();
    expect(amber!.textContent).toMatch(/no access|kein Zugriff/i);
    // the W-failure must surface — NOT hide behind a muted "✓ in group"
    expect(screen.queryByText(/✓ in group|✓ in Gruppe/i)).toBeNull();
  });

  it('AC-5: empty renderDevices → localized empty-state, no amber row', () => {
    const { container } = render(
      wrap(<DiagnosticsClient initialPayload={withRenderDevices([])} />),
    );
    expect(
      screen.getByText(/No render devices found|Keine Render-Devices gefunden/i),
    ).toBeInTheDocument();
    expect(container.querySelector('.text-amber-600')).toBeNull();
  });
});

// Plan 21-05 — test-encode-evidence gate audit-emit (AC-7 + AC-8).
describe('DiagnosticsClient 21-05 gate audit-emit', () => {
  function collectLogEventBodies(): Array<{ event: string; payload?: Record<string, unknown> }> {
    const captured: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/diagnostics/log-event')) {
        captured.push(JSON.parse(String(init?.body ?? '{}')));
      }
      return new Response(null, { status: 204 });
    });
    return captured;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-7: mount with lastTestEncodeResult=null → exactly 1× copyReportGated POST', async () => {
    const captured = collectLogEventBodies();
    render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    await waitFor(() => {
      const gatedEvents = captured.filter((c) => c.event === 'copyReportGated');
      expect(gatedEvents.length).toBe(1);
    });
    expect(captured[0]).toMatchObject({
      event: 'copyReportGated',
      payload: { source: 'diagnostics-client' },
    });
  });

  it('AC-7: StrictMode dev-double-invoke still emits exactly 1× copyReportGated', async () => {
    const captured = collectLogEventBodies();
    render(
      <React.StrictMode>{wrap(<DiagnosticsClient initialPayload={fixture()} />)}</React.StrictMode>,
    );
    // Let StrictMode double-invoke effects settle.
    await new Promise((r) => setTimeout(r, 50));
    const gatedEvents = captured.filter((c) => c.event === 'copyReportGated');
    expect(gatedEvents.length).toBe(1);
  });

  it('AC-8: TestEncodeRunner.onResult success → exactly 1× copyReportUnlocked + payload shape', async () => {
    runnerSnapshotRef.current = {
      outcome: 'success',
      encoderPicked: 'libx265',
      durationMs: 555,
      exitCode: 0,
      ffmpegStdout: '',
      ffmpegStderr: '',
      mappedError: null,
    };
    const captured = collectLogEventBodies();
    render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    await waitFor(() => {
      expect(captured.filter((c) => c.event === 'copyReportGated').length).toBe(1);
    });
    act(() => {
      fireEvent.click(screen.getByTestId('mock-test-encode-runner'));
    });
    await waitFor(() => {
      expect(captured.filter((c) => c.event === 'copyReportUnlocked').length).toBe(1);
    });
    const unlock = captured.find((c) => c.event === 'copyReportUnlocked')!;
    expect(unlock.payload).toEqual({
      source: 'diagnostics-client',
      outcome: 'success',
      encoderPicked: 'libx265',
    });
  });

  it('AC-8: second onResult within same session does NOT re-emit copyReportUnlocked', async () => {
    const captured = collectLogEventBodies();
    render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
    await waitFor(() => {
      expect(captured.filter((c) => c.event === 'copyReportGated').length).toBe(1);
    });
    act(() => fireEvent.click(screen.getByTestId('mock-test-encode-runner')));
    await waitFor(() => {
      expect(captured.filter((c) => c.event === 'copyReportUnlocked').length).toBe(1);
    });
    act(() => fireEvent.click(screen.getByTestId('mock-test-encode-runner')));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured.filter((c) => c.event === 'copyReportUnlocked').length).toBe(1);
  });

  it.each(['failed', 'killed_timeout'] as const)(
    'AC-8: outcome=%s unlocks copyReportUnlocked',
    async (outcome) => {
      runnerSnapshotRef.current = {
        outcome,
        encoderPicked: 'hevc_nvenc',
        durationMs: 42,
        exitCode: outcome === 'killed_timeout' ? null : 234,
        ffmpegStdout: '',
        ffmpegStderr: '',
        mappedError: null,
      };
      const captured = collectLogEventBodies();
      const { unmount } = render(wrap(<DiagnosticsClient initialPayload={fixture()} />));
      await waitFor(() => {
        expect(captured.filter((c) => c.event === 'copyReportGated').length).toBe(1);
      });
      act(() => fireEvent.click(screen.getByTestId('mock-test-encode-runner')));
      await waitFor(() => {
        expect(captured.filter((c) => c.event === 'copyReportUnlocked').length).toBe(1);
      });
      const unlock = captured.find((c) => c.event === 'copyReportUnlocked')!;
      expect((unlock.payload as { outcome: string }).outcome).toBe(outcome);
      unmount();
    },
  );
});

// Plan 21-05 AC-9 audit-M3 — kill-switch ZERO-emit verification via
// vi.stubEnv + vi.resetModules + dynamic await import() (module-load constant
// re-evaluation pattern, mirrors 20-03 NEXT_PUBLIC_ONBOARDING_*_DISABLED).
describe('DiagnosticsClient 21-05 kill-switch ZERO-emit', () => {
  // Re-install matchMedia stub before each test in this describe because
  // vi.resetModules() in afterEach can leave jsdom globals in a state where
  // next-themes (transitively loaded via wrap()'s ThemeProvider) sees a stale
  // matchMedia binding. Setup.ts only installs once-per-file at module-load.
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('AC-9: KILL_COPY_REPORT_GATE=true at module-load → ZERO copyReportGated/Unlocked emits', async () => {
    vi.stubEnv('NEXT_PUBLIC_DIAGNOSTICS_COPYREPORT_GATE_DISABLED', '1');
    vi.resetModules();
    const captured: Array<{ event: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/diagnostics/log-event')) {
        captured.push(JSON.parse(String(init?.body ?? '{}')));
      }
      return new Response(null, { status: 204 });
    });
    const mod = await import('@/components/diagnostics/diagnostics-client');
    const Comp = mod.DiagnosticsClient;
    render(wrap(<Comp initialPayload={fixture()} />));
    await new Promise((r) => setTimeout(r, 50));
    // Drive a snapshot through the runner to confirm unlock-path is also suppressed.
    act(() => fireEvent.click(screen.getByTestId('mock-test-encode-runner')));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.filter((c) => c.event === 'copyReportGated').length).toBe(0);
    expect(captured.filter((c) => c.event === 'copyReportUnlocked').length).toBe(0);
  });
});
