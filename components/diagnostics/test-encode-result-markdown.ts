// Phase 21 Plan 21-02 UAT-extension B:
// Shared markdown-serializer for last test-encode result. Always emits a
// `### Last test-encode (client UAT run)` section — when no run has happened
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
  // 23-01: server-derived diagnosis (stable machine code) when the encode
  // failed and a stderr pattern matched; null otherwise. Human text stays in
  // the UI i18n (single-source) — the report carries the greppable code only.
  mappedError: { code: string; severity: 'error' | 'warning' } | null;
}

export function renderTestEncodeMarkdown(result: TestEncodeResultSnapshot | null): string {
  const heading = `\n\n### Last test-encode (client UAT run)\n\n`;

  if (!result) {
    return heading + '_not executed yet_';
  }

  const exitStr = result.exitCode === null ? '(killed)' : String(result.exitCode);
  // 23-01: stable machine code only (human text is UI-side i18n).
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
    diagnosisLine +
    stdoutBlock +
    stderrBlock
  );
}

/**
 * Assemble the full clipboard body in canonical order:
 *   1. /api/diagnostics-report body (server-rendered markdown, no trailing
 *      timestamp since 21-02 UAT-extension stripped it).
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
