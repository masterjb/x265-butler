// @vitest-environment node
// 22-00 T3 IMP-11: container-image probe tests.
// AC-4 contract: ContainerImageBlock shape + null-safe + boot-cache (AC-10).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  probeContainerImage,
  clearContainerImageCache,
  type ContainerImageProbeDeps,
} from '@/src/lib/diagnostics/container-image-probe';

function mkExecFile(handlers: Record<string, (args: readonly string[]) => string | Error>) {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const handler = handlers[file];
    if (!handler) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${file}`);
      err.code = 'ENOENT';
      throw err;
    }
    const result = handler(args);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '' };
  });
}

function happyExecFile() {
  return mkExecFile({
    ldd: () => 'ldd (Debian GLIBC 2.36-9+deb12u4) 2.36\n',
    vainfo: () =>
      'Trying display: drm\nvainfo: VA-API version: 1.17.0\nvainfo: Driver version: Intel iHD driver - 23.1.6\n',
    'dpkg-query': (args) => {
      const pkg = args[args.length - 1];
      if (pkg === 'libva2') return '2.17.0-1';
      if (pkg === 'libdrm2') return '2.4.114-1';
      // 23-00 SR-c: REAL plan-time versions — epoch (`1:`), binNMU (`+b1`) and
      // dfsg suffixes must pass through dpkg `${Version}` verbatim, unsanitized.
      if (pkg === 'libmfx-gen1.2') return '25.1.4-1';
      if (pkg === 'libvpl2') return '1:2.14.0-1+b1';
      if (pkg === 'libigfxcmrt7') return '25.2.3+dfsg1-1';
      return '';
    },
    ffmpeg: () =>
      'ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers\n' +
      'built with gcc 12 (Debian 12.2.0-14)\n' +
      'configuration: --enable-gpl --enable-libx265 --enable-vaapi\n' +
      'libavutil 58.  2.100\n',
  });
}

function happyReadFile() {
  return vi.fn(async (path: unknown) => {
    if (path === '/etc/os-release') {
      return 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n';
    }
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(path)}`);
    err.code = 'ENOENT';
    throw err;
  }) as never;
}

function happyAccess() {
  return vi.fn(async () => undefined);
}

function makeDeps(): ContainerImageProbeDeps & { _exec: ReturnType<typeof happyExecFile> } {
  const exec = happyExecFile();
  return {
    execFile: exec,
    readFile: happyReadFile(),
    access: happyAccess(),
    logger: { debug: vi.fn() },
    _exec: exec,
  };
}

describe('22-00 T3: probeContainerImage', () => {
  beforeEach(() => {
    clearContainerImageCache();
  });

  it('happy: all 4 sub-probes return data → ContainerImageBlock populated', async () => {
    const deps = makeDeps();
    const result = await probeContainerImage(deps);

    expect(result.os).toEqual({
      id: 'debian',
      version: '12',
      prettyName: 'Debian GNU/Linux 12 (bookworm)',
    });
    expect(result.glibc.version).toBe('2.36');
    expect(result.drivers.intelMediaDriver.version).toBe('Intel iHD driver - 23.1.6');
    expect(result.drivers.intelMediaDriver.source).toBe('vainfo');
    expect(result.drivers.libva.version).toBe('2.17.0-1');
    expect(result.drivers.libdrm.version).toBe('2.4.114-1');
    expect(result.ffmpeg.version).toBe('6.0');
    expect(result.ffmpeg.configurationFlags).toEqual([
      '--enable-gpl',
      '--enable-libx265',
      '--enable-vaapi',
    ]);
    // 23-00 SR-c: oneVPL versions pass through dpkg ${Version} verbatim —
    // epoch + binNMU + dfsg suffixes preserved, not sanitized.
    expect(result.drivers.oneVpl.libmfxGen1.version).toBe('25.1.4-1');
    expect(result.drivers.oneVpl.libvpl.version).toBe('1:2.14.0-1+b1');
    expect(result.drivers.oneVpl.libigfxcmrt.version).toBe('25.2.3+dfsg1-1');
  });

  it('os-release-missing: readFile ENOENT → os fields null + failure-emit fires', async () => {
    const debug = vi.fn();
    const deps: ContainerImageProbeDeps = {
      execFile: happyExecFile(),
      readFile: vi.fn(async () => {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }) as never,
      access: happyAccess(),
      logger: { debug },
    };
    const result = await probeContainerImage(deps);

    expect(result.os).toEqual({ id: null, version: null, prettyName: null });
    expect(result.glibc.version).toBe('2.36');
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ subprobe: 'os', reason: 'binary_missing' }),
      'container_image_probe_failed',
    );
  });

  it('ldd-fail: glibc.version null + failure-emit fires', async () => {
    const debug = vi.fn();
    const deps: ContainerImageProbeDeps = {
      execFile: mkExecFile({
        // ldd missing
        vainfo: () => 'vainfo: Driver version: Intel iHD driver - 23.1.6\n',
        'dpkg-query': () => '2.17.0-1',
        ffmpeg: () => 'ffmpeg version 6.0\nconfiguration: --enable-gpl\n',
      }),
      readFile: happyReadFile(),
      access: happyAccess(),
      logger: { debug },
    };
    const result = await probeContainerImage(deps);

    expect(result.glibc.version).toBeNull();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ subprobe: 'glibc' }),
      'container_image_probe_failed',
    );
  });

  it('dpkg-fall-to-null: libva + libdrm null when dpkg-query missing', async () => {
    const deps: ContainerImageProbeDeps = {
      execFile: mkExecFile({
        ldd: () => 'ldd 2.36\n',
        vainfo: () => 'vainfo: Driver version: Intel iHD driver - 23.1.6\n',
        // dpkg-query missing
        ffmpeg: () => 'ffmpeg version 6.0\nconfiguration: --enable-gpl\n',
      }),
      readFile: happyReadFile(),
      access: happyAccess(),
      logger: { debug: vi.fn() },
    };
    const result = await probeContainerImage(deps);

    expect(result.drivers.libva.version).toBeNull();
    expect(result.drivers.libdrm.version).toBeNull();
    // 23-00: oneVPL probes share the dpkg-query binary → all null when missing.
    expect(result.drivers.oneVpl.libmfxGen1.version).toBeNull();
    expect(result.drivers.oneVpl.libvpl.version).toBeNull();
    expect(result.drivers.oneVpl.libigfxcmrt.version).toBeNull();
  });

  it('vainfo-fail + so-symlink-exists: intelMediaDriver falls back to so-symlink source', async () => {
    const deps: ContainerImageProbeDeps = {
      execFile: mkExecFile({
        ldd: () => 'ldd 2.36\n',
        // vainfo missing
        'dpkg-query': () => '2.17.0-1',
        ffmpeg: () => 'ffmpeg version 6.0\nconfiguration: --enable-gpl\n',
      }),
      readFile: happyReadFile(),
      access: happyAccess(),
      logger: { debug: vi.fn() },
    };
    const result = await probeContainerImage(deps);

    expect(result.drivers.intelMediaDriver.source).toBe('so-symlink');
    expect(result.drivers.intelMediaDriver.version).toBeNull();
  });

  it('cache: 2 sequential calls without clear → execFile called exactly once-per-probe-binary', async () => {
    const deps = makeDeps();
    await probeContainerImage(deps);
    await probeContainerImage(deps);
    // ldd + vainfo + dpkg-query (×5: libva2 + libdrm2 + libmfx-gen1.2 + libvpl2
    // + libigfxcmrt7) + ffmpeg = 8 execFile calls per probe.
    // Cache must prevent re-probing on the 2nd call.
    expect(deps._exec).toHaveBeenCalledTimes(8);
  });

  it('AC-10 concurrency: 2 simultaneous probeContainerImage() calls → execFile called exactly once-per-probe', async () => {
    const deps = makeDeps();
    const [a, b] = await Promise.all([probeContainerImage(deps), probeContainerImage(deps)]);
    // pendingPromise memoization: 8 execFile calls total (1 probe-run shared).
    expect(deps._exec).toHaveBeenCalledTimes(8);
    expect(a).toBe(b); // SAME reference
  });

  it('clearContainerImageCache resets both resolved-cache AND pending-promise', async () => {
    const deps = makeDeps();
    await probeContainerImage(deps);
    expect(deps._exec).toHaveBeenCalledTimes(8);

    clearContainerImageCache();
    await probeContainerImage(deps);
    expect(deps._exec).toHaveBeenCalledTimes(16);
  });
});
