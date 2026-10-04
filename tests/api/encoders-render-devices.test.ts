import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderDeviceProbe } from '@/src/lib/diagnostics/types';

const { mockProbeRenderDevices, mockLoggerWarn } = vi.hoisted(() => ({
  mockProbeRenderDevices: vi.fn<() => Promise<RenderDeviceProbe[]>>(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/src/lib/diagnostics/render-device-probe', () => ({
  probeRenderDevices: mockProbeRenderDevices,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({ warn: mockLoggerWarn }),
  },
  default: {},
}));

import { GET, runtime } from '@/app/api/encoders/render-devices/route';

function probe(path: string, over: Partial<RenderDeviceProbe> = {}): RenderDeviceProbe {
  return {
    path,
    exists: true,
    gid: 44,
    groupName: 'render',
    processGroups: [44],
    processGid: 44,
    inRenderGroup: true,
    readable: true,
    writable: true,
    ...over,
  };
}

describe('GET /api/encoders/render-devices', () => {
  beforeEach(() => {
    mockProbeRenderDevices.mockReset();
    mockLoggerWarn.mockReset();
    delete process.env.NEXT_PHASE;
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_two_render_nodes_then_returns_200_mapped_array', async () => {
    mockProbeRenderDevices.mockResolvedValue([
      probe('/dev/dri/renderD128'),
      probe('/dev/dri/renderD129', { groupName: 'video', inRenderGroup: false, writable: false }),
    ]);
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual([
      {
        path: '/dev/dri/renderD128',
        node: 'renderD128',
        exists: true,
        readable: true,
        writable: true,
        groupName: 'render',
        inRenderGroup: true,
      },
      {
        path: '/dev/dri/renderD129',
        node: 'renderD129',
        exists: true,
        readable: true,
        writable: false,
        groupName: 'video',
        inRenderGroup: false,
      },
    ]);
  });

  it('test_GET_when_no_dri_then_returns_200_empty_array', async () => {
    mockProbeRenderDevices.mockResolvedValue([]);
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('test_GET_when_probe_throws_then_returns_200_empty_array_never_500', async () => {
    mockProbeRenderDevices.mockRejectedValue(new Error('readdir blew up'));
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('test_GET_when_NEXT_PHASE_build_then_short_circuits_to_200_empty', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(mockProbeRenderDevices).not.toHaveBeenCalled();
  });
});
