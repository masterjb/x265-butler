// Phase 21 Plan 21-02 UAT-extension B — test-encode markdown serializer +
// clipboard assembler. 23-01: diagnosis-code line.

import { describe, it, expect } from 'vitest';
import {
  assembleReportForClipboard,
  renderTestEncodeMarkdown,
  type TestEncodeResultSnapshot,
} from '@/components/diagnostics/test-encode-result-markdown';

// 50-06: the run-configuration fields every snapshot now carries. Declared once
// so a future field addition surfaces here instead of in eight literals.
const CONFIG_50_06: Pick<
  TestEncodeResultSnapshot,
  | 'encoderRequested'
  | 'encoderFallback'
  | 'crf'
  | 'preset'
  | 'force10bit'
  | 'keyframeIntervalSec'
  | 'commandLine'
  | 'settingsSource'
> = {
  encoderRequested: 'auto',
  encoderFallback: false,
  crf: 23,
  preset: 'medium',
  force10bit: false,
  keyframeIntervalSec: 5,
  commandLine: ['/usr/bin/ffmpeg', '-hide_banner'],
  settingsSource: 'settings',
};

describe('renderTestEncodeMarkdown', () => {
  it('always emits section heading with placeholder when no result', () => {
    const md = renderTestEncodeMarkdown(null);
    expect(md).toContain('### Last test-encode (client UAT run)');
    expect(md).toContain('_not executed yet_');
  });

  it('renders success result with all fields and stdout block', () => {
    const snap: TestEncodeResultSnapshot = {
      outcome: 'success',
      encoderPicked: 'libx265',
      durationMs: 1234,
      exitCode: 0,
      ffmpegStdout: 'output ok',
      ffmpegStderr: '',
      mappedError: null,
      ...CONFIG_50_06,
    };
    const md = renderTestEncodeMarkdown(snap);
    expect(md).toContain('### Last test-encode');
    expect(md).toContain('outcome: `success`');
    expect(md).toContain('encoderPicked: `libx265`');
    expect(md).toContain('durationMs: 1234');
    expect(md).toContain('exitCode: 0');
    expect(md).toContain('**stdout:**');
    expect(md).toContain('output ok');
    expect(md).not.toContain('**stderr:**');
    expect(md).not.toContain('_not executed yet_');
    // 23-01: no diagnosis line when mappedError is null.
    expect(md).not.toContain('diagnosis:');
  });

  it('renders failed result with stderr block (matches UAT NVENC scenario)', () => {
    const snap: TestEncodeResultSnapshot = {
      outcome: 'failed',
      encoderPicked: 'hevc_nvenc',
      durationMs: 427,
      exitCode: 234,
      ffmpegStdout: '',
      ffmpegStderr: 'InitializeEncoder failed: invalid param (8)',
      mappedError: null,
      ...CONFIG_50_06,
    };
    const md = renderTestEncodeMarkdown(snap);
    expect(md).toContain('outcome: `failed`');
    expect(md).toContain('encoderPicked: `hevc_nvenc`');
    expect(md).toContain('exitCode: 234');
    expect(md).toContain('**stderr:**');
    expect(md).toContain('InitializeEncoder failed');
  });

  it('23-01: emits diagnosis-code line when mappedError is present', () => {
    const snap: TestEncodeResultSnapshot = {
      outcome: 'failed',
      encoderPicked: 'hevc_qsv',
      durationMs: 380,
      exitCode: 1,
      ffmpegStdout: '',
      ffmpegStderr: 'Error creating a MFX session: -9',
      mappedError: { code: 'qsvMfxSessionUnsupported', severity: 'warning' },
      ...CONFIG_50_06,
    };
    const md = renderTestEncodeMarkdown(snap);
    expect(md).toContain('- diagnosis: `qsvMfxSessionUnsupported`');
    // placed after exitCode, before the stderr block
    expect(md.indexOf('diagnosis:')).toBeGreaterThan(md.indexOf('exitCode:'));
    expect(md.indexOf('diagnosis:')).toBeLessThan(md.indexOf('**stderr:**'));
  });

  it('renders killed-timeout result with (killed) exit code', () => {
    const snap: TestEncodeResultSnapshot = {
      outcome: 'killed_timeout',
      encoderPicked: 'libx265',
      durationMs: 10000,
      exitCode: null,
      ffmpegStdout: '',
      ffmpegStderr: '',
      mappedError: null,
      ...CONFIG_50_06,
    };
    const md = renderTestEncodeMarkdown(snap);
    expect(md).toContain('outcome: `killed_timeout`');
    expect(md).toContain('exitCode: (killed)');
  });
});

describe('assembleReportForClipboard', () => {
  const BODY = '## diagnostics report\n\n### App\n- version: 1.0\n';

  it('appends test-encode section even when no run + generatedAt at very end', () => {
    const out = assembleReportForClipboard(BODY, null, '2026-05-23T15:00:00Z');
    expect(out).toMatch(
      /## diagnostics report[\s\S]+### Last test-encode[\s\S]+_not executed yet_[\s\S]+_Generated 2026-05-23T15:00:00Z_$/u,
    );
  });

  it('test-encode section sits BEFORE generatedAt footer', () => {
    const snap: TestEncodeResultSnapshot = {
      outcome: 'success',
      encoderPicked: 'libx265',
      durationMs: 100,
      exitCode: 0,
      ffmpegStdout: '',
      ffmpegStderr: '',
      mappedError: null,
      ...CONFIG_50_06,
    };
    const out = assembleReportForClipboard(BODY, snap, '2026-05-23T15:00:00Z');
    const testIdx = out.indexOf('### Last test-encode');
    const genIdx = out.indexOf('_Generated');
    expect(testIdx).toBeGreaterThan(0);
    expect(genIdx).toBeGreaterThan(testIdx);
  });

  it('omits generatedAt footer when timestamp is null/empty', () => {
    const out = assembleReportForClipboard(BODY, null, null);
    expect(out).not.toContain('_Generated');
    expect(out).toContain('_not executed yet_');
  });

  it('does NOT contain "paste into the unRAID forum thread" wording', () => {
    const out = assembleReportForClipboard(BODY, null, '2026-05-23T15:00:00Z');
    expect(out).not.toMatch(/paste into the unRAID forum thread/i);
  });

  it('trims trailing whitespace from report body before assembly', () => {
    const out = assembleReportForClipboard(BODY + '\n\n\n', null, '2026-05-23T15:00:00Z');
    // No more than 2 consecutive newlines anywhere except inside code-blocks.
    expect(out).not.toMatch(/\n{4,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-06 — the report says WHAT the test encode ran with.
// ─────────────────────────────────────────────────────────────────────────────
describe('50-06 AC-20/AC-27: the report carries the resolved configuration', () => {
  const base: TestEncodeResultSnapshot = {
    outcome: 'success',
    encoderPicked: 'hevc_qsv',
    durationMs: 900,
    exitCode: 0,
    ffmpegStdout: '',
    ffmpegStderr: '',
    mappedError: null,
    ...CONFIG_50_06,
    encoderRequested: 'qsv',
    crf: 26,
    preset: 'slow',
    force10bit: true,
    keyframeIntervalSec: 5,
    commandLine: ['/usr/local/bin/ffmpeg', '-hide_banner', '-f', 'lavfi'],
  };

  it('AC-20: one line per resolved setting', () => {
    const md = renderTestEncodeMarkdown(base);
    expect(md).toContain('- encoderRequested: `qsv`');
    expect(md).toContain('- crf: `26`');
    expect(md).toContain('- preset: `slow`');
    expect(md).toContain('- force10bit: `true`');
    expect(md).toContain('- keyframeIntervalSec: `5`');
  });

  it('AC-20/AC-27: the command block carries the BINARY, not just the arguments', () => {
    const md = renderTestEncodeMarkdown(base);
    expect(md).toContain('**command line:**');
    expect(md).toContain('/usr/local/bin/ffmpeg -hide_banner -f lavfi');
  });

  it('AC-26: an unresolved CRF is printed as such, never as an empty value', () => {
    const md = renderTestEncodeMarkdown({ ...base, crf: 'unresolved' });
    expect(md).toContain('- crf: `unresolved`');
  });

  it('AC-28: a fallback run says so, in its own emphasised line', () => {
    const md = renderTestEncodeMarkdown({
      ...base,
      encoderRequested: 'nvenc',
      encoderPicked: 'libx265',
      encoderFallback: true,
    });
    expect(md).toContain('**encoderFallback: requested `nvenc` was NOT detected');
    expect(md).toContain('this run used `libx265`**');
  });

  it('AC-28: a non-fallback run emits NO fallback line', () => {
    expect(renderTestEncodeMarkdown(base)).not.toContain('encoderFallback');
  });

  it('AC-25: an unavailable settings read is called out as factory defaults', () => {
    const md = renderTestEncodeMarkdown({ ...base, settingsSource: 'unavailable' });
    expect(md).toContain('settingsSource: `unavailable`');
    expect(md).toContain('FACTORY DEFAULTS');
  });

  it('AC-25: a healthy read adds no settingsSource line at all', () => {
    expect(renderTestEncodeMarkdown(base)).not.toContain('settingsSource');
  });

  it('the "not executed yet" placeholder is untouched', () => {
    const md = renderTestEncodeMarkdown(null);
    expect(md).toContain('_not executed yet_');
    expect(md).not.toContain('command line');
  });

  it('AC-21: the printed command line carries no library path', () => {
    const md = renderTestEncodeMarkdown({
      ...base,
      commandLine: ['/usr/local/bin/ffmpeg', '-i', 'testsrc=size=320x240', '/dev/null'],
    });
    expect(md).not.toMatch(/\/mnt\/|\/media\/|\.mkv|\.mp4/);
  });
});
