// Shared markdown-serializer for last test-encode result. Always emits a
// `### Last test-encode` section — when no run has happened
// yet, emits `_not executed yet_` placeholder so 3rd-party bug reports include
// explicit evidence of whether functional-encoder probe was attempted.
//
// Used by CopyReportButton + FeedbackLinks via assembleReportForClipboard().

export interface TestEncodeResultSnapshot {
  outcome: 'success' | 'failed' | 'killed_timeout';
  encoderPicked: string;
  durationMs: number;
  exitCode: number | null;
  ffmpegStdout: string;
  ffmpegStderr: string;
  // Server-derived diagnosis (stable machine code) when the encode
  // failed and a stderr pattern matched; null otherwise. Human text stays in
  // the UI i18n (single-source) — the report carries the greppable code only.
  mappedError: { code: string; severity: 'error' | 'warning' } | null;
  // WHAT the test encode actually ran with. Without these a report saying
  // "test-encode failed" is not actionable, and "the test fares your config" is
  // an unverifiable claim.
  encoderRequested: string;
  encoderFallback: boolean;
  crf: number | 'unresolved';
  preset: string;
  force10bit: boolean;
  keyframeIntervalSec: number;
  commandLine: string[];
  settingsSource: 'settings' | 'unavailable';
}

export function renderTestEncodeMarkdown(result: TestEncodeResultSnapshot | null): string {
  const heading = `\n\n### Last test-encode\n\n`;

  if (!result) {
    return heading + '_not executed yet_';
  }

  const exitStr = result.exitCode === null ? '(killed)' : String(result.exitCode);
  // The resolved configuration. `encoderRequested` sits FIRST because a
  // divergence from encoderPicked changes how every line below it reads.
  const fallbackLine = result.encoderFallback
    ? `\n- **encoderFallback: requested \`${result.encoderRequested}\` was NOT detected — this run used \`${result.encoderPicked}\`**`
    : '';
  // A settings read that failed makes every value below a factory default. Saying
  // so is the difference between a report and a misleading report.
  const settingsLine =
    result.settingsSource === 'unavailable'
      ? '\n- **settingsSource: `unavailable` — the values below are FACTORY DEFAULTS, not the operator configuration**'
      : '';
  const configLines =
    `\n- encoderRequested: \`${result.encoderRequested}\`` +
    fallbackLine +
    settingsLine +
    `\n- crf: \`${result.crf}\`` +
    `\n- preset: \`${result.preset}\`` +
    `\n- force10bit: \`${result.force10bit}\`` +
    `\n- keyframeIntervalSec: \`${result.keyframeIntervalSec}\``;
  // The full command line, binary included (the image ships two ffmpeg binaries and
  // which one ran IS part of the diagnosis). Safe to share: synthetic input,
  // /dev/null output, no library path. NOT shell-quoted — this is diagnostic
  // output, not a copy-and-run command (same call as the job-log argv line in src/lib/encode/ffmpeg.ts).
  const commandBlock = result.commandLine.length
    ? `\n\n**command line:**\n\`\`\`\n${result.commandLine.join(' ')}\n\`\`\``
    : '';
  // Stable machine code only (human text is UI-side i18n).
  const diagnosisLine = result.mappedError ? `\n- diagnosis: \`${result.mappedError.code}\`` : '';
  const stdoutBlock = result.ffmpegStdout
    ? `\n\n**stdout:**\n\`\`\`\n${result.ffmpegStdout}\n\`\`\``
    : '';
  const stderrBlock = result.ffmpegStderr
    ? `\n\n**stderr:**\n\`\`\`\n${result.ffmpegStderr}\n\`\`\``
    : '';
  return (
    heading +
    `- outcome: \`${result.outcome}\`\n` +
    `- encoderPicked: \`${result.encoderPicked}\`\n` +
    `- durationMs: ${result.durationMs}\n` +
    `- exitCode: ${exitStr}` +
    configLines +
    diagnosisLine +
    commandBlock +
    stdoutBlock +
    stderrBlock
  );
}

/**
 * Assemble the full clipboard body in canonical order:
 *   1. /api/diagnostics-report body (server-rendered markdown, no trailing
 *      timestamp; the client appends its own footer).
 *   2. test-encode section (always emitted; placeholder if no run).
 *   3. generatedAt footer (very last line, italic).
 */
export function assembleReportForClipboard(
  reportBody: string,
  snapshot: TestEncodeResultSnapshot | null,
  generatedAt: string | null | undefined,
): string {
  const testEncodeSection = renderTestEncodeMarkdown(snapshot);
  const trimmedBody = reportBody.replace(/\s+$/u, '');
  const footer = generatedAt ? `\n\n_Generated ${generatedAt}_` : '';
  return trimmedBody + testEncodeSection + footer;
}
