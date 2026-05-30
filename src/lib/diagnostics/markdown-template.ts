// Phase 21 Plan 21-01 — pure render of DiagnosticsPayload → markdown.
//
// GitHub-flavored markdown only. No BBCode. No operator-secret fields enter
// the payload upstream, so no escaping required beyond identity.

import type { DiagnosticsPayload } from './types';

export function renderDiagnosticsMarkdown(payload: DiagnosticsPayload): string {
  const parts: string[] = [];
  parts.push('## x265-butler diagnostics report');
  parts.push('');

  parts.push('### App');
  parts.push(`- version: \`${payload.app.version}\``);
  parts.push(`- gitHash: \`${payload.app.gitHash}\``);
  parts.push(
    `- committedAt: ${payload.app.committedAt === null ? '_unset_' : `\`${payload.app.committedAt}\``}`,
  );
  parts.push(
    `- committedAtCET: ${payload.app.committedAtCET === null ? '_unset_' : `\`${payload.app.committedAtCET}\``}`,
  );
  parts.push('');

  parts.push('### Runtime');
  parts.push(`- nodeVersion: \`${payload.runtime.nodeVersion}\``);
  parts.push(`- platform: \`${payload.runtime.platform}\``);
  parts.push(`- arch: \`${payload.runtime.arch}\``);
  parts.push(`- uptimeSec: ${payload.runtime.uptimeSec}`);
  parts.push(`- pid: ${payload.runtime.pid}`);
  parts.push('');

  parts.push('### Mounts');
  if (payload.mounts.length === 0) {
    parts.push('_no mounts probed_');
  } else {
    parts.push('| path | readable | writable | error |');
    parts.push('|---|---|---|---|');
    for (const m of payload.mounts) {
      parts.push(
        `| \`${m.path}\` | ${m.readable ? '✓' : '✗'} | ${m.writable ? '✓' : '✗'} | ${m.error ?? ''} |`,
      );
    }
  }
  parts.push('');

  parts.push('### Devices');
  parts.push(
    `- DRI: ${payload.devices.dri.length === 0 ? '_none_' : payload.devices.dri.map((d) => `\`${d}\``).join(', ')}`,
  );
  parts.push(
    `- NVIDIA: ${payload.devices.nvidia.length === 0 ? '_none_' : payload.devices.nvidia.map((d) => `\`${d}\``).join(', ')}`,
  );
  parts.push('');

  parts.push('### Encoders');
  parts.push(
    `- detected: ${payload.encoders.detected.length === 0 ? '_none_' : payload.encoders.detected.map((e) => `\`${e}\``).join(', ')}`,
  );
  // 23-04 (audit SR2/AC-12): flag the kill-switch so a bug-report copied from an
  // escape-hatch host does NOT silently imply the encoders were runtime-verified.
  if (payload.encoders.probeEncodeDisabled) {
    parts.push(
      '- ⚠️ probe-encode gate DISABLED — outcomes are feature-parse-only, NOT runtime-verified',
    );
  }
  if (payload.encoders.warnings.length > 0) {
    parts.push('- detection warnings:');
    for (const w of payload.encoders.warnings) {
      parts.push(`  - \`${w.code}\`${w.message ? ` — ${w.message}` : ''}`);
    }
  } else {
    parts.push('- detection warnings: _none_');
  }
  // 23-04: per-encoder runtime-probe outcome. The `detail` excerpt is RAW ffmpeg
  // stderr — rendered verbatim inside a code span (opaque/escaped), NEVER fed
  // through next-intl/ICU (audit SR4/AC-13).
  if (payload.encoders.outcome.length > 0) {
    parts.push('- probe outcomes:');
    for (const o of payload.encoders.outcome) {
      const detail = o.detail ? ` — \`${o.detail}\`` : '';
      parts.push(`  - \`${o.encoder}\`: ${o.outcome}${detail}`);
    }
  }
  parts.push('');

  parts.push('### Active warnings');
  if (payload.warnings.length === 0) {
    parts.push('_no warnings_');
  } else {
    for (const w of payload.warnings) {
      parts.push(`- **${w.severity.toUpperCase()}** \`${w.source}:${w.code}\` — ${w.message}`);
    }
  }
  parts.push('');

  parts.push('### Recent errors (in-memory, last ≤25)');
  if (payload.recentErrors.length === 0) {
    parts.push('_no recent errors_');
  } else {
    parts.push('```');
    for (const e of payload.recentErrors) {
      const tsIso = e.ts > 0 ? new Date(e.ts).toISOString() : '(no-ts)';
      parts.push(`${tsIso} L${e.level} ${e.source ? `[${e.source}] ` : ''}${e.msg}`);
    }
    parts.push('```');
  }
  parts.push('');

  parts.push('### Onboarding');
  parts.push(`- completed: ${payload.onboarding.completed ? '✓' : '✗'}`);
  parts.push(`- hasShare: ${payload.onboarding.hasShare ? '✓' : '✗'}`);
  parts.push('');

  // 22-00 IMP-14 audit-fix:SR5 — append in pinned order (regression-sentinel):
  // Container Image → Blocklist Evaluation. Both NEW sections at H2 level per
  // AC-5 contract; historical H3 sections above are NOT reordered.
  const ci = payload.containerImage;
  parts.push('## Container Image');
  parts.push(`- OS: ${ci.os.prettyName ?? '—'}`);
  parts.push(`- GLIBC: ${ci.glibc.version ?? '—'}`);
  parts.push(
    `- Intel Media Driver: ${ci.drivers.intelMediaDriver.version ?? '—'} (${ci.drivers.intelMediaDriver.source ?? '—'})`,
  );
  parts.push(`- libva: ${ci.drivers.libva.version ?? '—'}`);
  parts.push(`- libdrm: ${ci.drivers.libdrm.version ?? '—'}`);
  // 23-00 (B2): oneVPL MFX-runtime presence — root-cause surface for `MFX -9`.
  parts.push(
    `- oneVPL MFX runtime (libmfx-gen1.2): ${ci.drivers.oneVpl.libmfxGen1.version ?? '—'}`,
  );
  parts.push(`- oneVPL dispatcher (libvpl2): ${ci.drivers.oneVpl.libvpl.version ?? '—'}`);
  parts.push(`- libigfxcmrt7: ${ci.drivers.oneVpl.libigfxcmrt.version ?? '—'}`);
  parts.push(
    '- _(oneVPL versions report installed-package presence; runtime QSV-functionality is verified separately by the probe-encode — 23-04)_',
  );
  parts.push(`- ffmpeg version: ${ci.ffmpeg.version ?? '—'}`);
  parts.push('');
  parts.push('<details>');
  parts.push('<summary>ffmpeg configuration flags</summary>');
  parts.push('');
  parts.push('```');
  parts.push(ci.ffmpeg.configurationFlags ? ci.ffmpeg.configurationFlags.join(' ') : '—');
  parts.push('```');
  parts.push('');
  parts.push('</details>');
  parts.push('');

  // 23-05 — append `## CPU` after `## Container Image` (both image/hardware
  // capability surfaces). hevcQsv reflects HARDWARE capability by the gen-table;
  // runtime QSV-functionality is verified by the probe-encode (23-04).
  const cpu = payload.cpu;
  parts.push('## CPU');
  parts.push(`- Vendor: ${cpu.vendorId ?? '—'}${cpu.isIntel ? ' (Intel)' : ''}`);
  parts.push(`- Model name: ${cpu.modelName ?? '—'}`);
  parts.push(`- CPUID family/model: ${cpu.family ?? '—'} / ${cpu.model ?? '—'}`);
  parts.push(`- Microarch: ${cpu.microarch ?? '—'}`);
  parts.push(`- Graphics gen: ${cpu.graphicsGen ?? '—'}`);
  parts.push(`- HEVC-QSV (hardware): ${cpu.hevcQsv}`);
  parts.push(
    '- _(HEVC-QSV reflects iGPU HARDWARE capability by the embedded gen-table; runtime QSV functionality is verified separately by the probe-encode — 23-04)_',
  );
  parts.push('');

  parts.push('## Blocklist Evaluation');
  // 22-00 audit-fix:M3 / AC-9 — PII / forum-paste disclosure comment.
  parts.push(
    '<!-- Operator: paths below are verbatim. Redact mount/user prefixes before posting if sensitive. -->',
  );
  parts.push('');
  parts.push(`- Total entries: ${payload.blocklist.totalEntries}`);
  parts.push(`- Pattern cache: ${payload.blocklist.patternCachedAt ?? '—'}`);
  parts.push('');
  if (payload.blocklist.recentEvaluations.length === 0) {
    parts.push('_No recent evaluations._');
  } else {
    parts.push('| Path | Matched | When |');
    parts.push('|------|---------|------|');
    for (const e of payload.blocklist.recentEvaluations) {
      const matched = e.matchedEntry
        ? `✓ ${e.matchedEntry.kind}:\`${e.matchedEntry.pattern ?? `id:${e.matchedEntry.id}`}\``
        : 'PASS';
      parts.push(`| \`${e.path}\` | ${matched} | ${e.matchedAt} |`);
    }
  }
  parts.push('');

  // 22-01 IMP-2 — append `## Slow Requests` after `## Blocklist Evaluation`.
  // Append-only contract (regression-sentinel test pins order in 22-01 T4).
  parts.push('## Slow Requests');
  parts.push('');
  if (payload.slowRequests.topN.length === 0) {
    parts.push('_No slow requests recorded (threshold: 1s)._');
  } else {
    parts.push('| Route | Duration (ms) | At | Breakdown |');
    parts.push('|-------|---------------|-----|-----------|');
    for (const r of payload.slowRequests.topN) {
      const bd =
        r.breakdown && Object.keys(r.breakdown).length > 0
          ? Object.entries(r.breakdown)
              .map(([k, v]) => `${k}=${v.toFixed(0)}`)
              .join(' ')
          : '—';
      parts.push(`| \`${r.route}\` | ${r.durationMs.toFixed(0)} | ${r.atIso} | \`${bd}\` |`);
    }
  }
  parts.push('');

  // 22-01 IMP-3 — append `## Slow Queries` after `## Slow Requests`.
  parts.push('## Slow Queries');
  parts.push('');
  if (payload.slowQueries.topN.length === 0) {
    parts.push('_No slow queries recorded (threshold: 100ms)._');
  } else {
    parts.push('| Query | Duration (ms) | At |');
    parts.push('|-------|---------------|-----|');
    for (const q of payload.slowQueries.topN) {
      parts.push(`| \`${q.queryName}\` | ${q.durationMs.toFixed(0)} | ${q.atIso} |`);
    }
  }
  parts.push('');

  // 22-01 IMP-4 — append `## Web Vitals` after `## Slow Queries`.
  parts.push('## Web Vitals');
  parts.push('');
  const routeKeys = Object.keys(payload.webVitals.byRoute);
  if (routeKeys.length === 0) {
    parts.push('_No web vitals recorded._');
  } else {
    parts.push('| Route | TTFB p75 (ms) | LCP p75 (ms) | INP p75 (ms) | Samples |');
    parts.push('|-------|---------------|--------------|--------------|---------|');
    for (const route of routeKeys.sort()) {
      const rv = payload.webVitals.byRoute[route];
      const ttfb = rv.ttfb ? rv.ttfb.p75.toFixed(0) : '—';
      const lcp = rv.lcp ? rv.lcp.p75.toFixed(0) : '—';
      const inp = rv.inp ? rv.inp.p75.toFixed(0) : '—';
      const samples = Math.max(
        rv.ttfb?.sampleSize ?? 0,
        rv.lcp?.sampleSize ?? 0,
        rv.inp?.sampleSize ?? 0,
      );
      parts.push(`| \`${route}\` | ${ttfb} | ${lcp} | ${inp} | ${samples} |`);
    }
  }
  parts.push('');

  // 23-02 — append `## DRI Render Devices` after `## Web Vitals` (trailing,
  // last section). Append-only: the Container Image → Blocklist → Slow Requests
  // → Slow Queries → Web Vitals order above is NOT reordered.
  parts.push('## DRI Render Devices');
  parts.push('');
  if (payload.devices.renderDevices.length === 0) {
    parts.push('_No render devices found (no /dev/dri)._');
  } else {
    parts.push('| Device | GID | Group | In group | R | W | Error |');
    parts.push('|---|---|---|---|---|---|---|');
    for (const d of payload.devices.renderDevices) {
      parts.push(
        `| \`${d.path}\` | ${d.gid ?? '—'} | ${d.groupName ?? '—'} | ${d.inRenderGroup ? '✓' : '✗'} | ${d.readable ? '✓' : '✗'} | ${d.writable ? '✓' : '✗'} | ${d.error ?? ''} |`,
      );
    }
    parts.push('');
    parts.push(
      '_Group name is container-side and informational; the numeric GID is authoritative. Membership counts the process primary GID (PGID) AND supplementary groups — fix via `PGID=<gid>` or `--group-add <gid>`._',
    );
  }
  parts.push('');

  // 21-02 UAT-extension: trailing `_Generated ..._` line removed from
  // template. Timestamp is now emitted by client-side
  // assembleReportForClipboard() AFTER any optional test-encode appendix so
  // the timestamp sits at the absolute end of the clipboard body. The
  // forum-paste reminder line was dropped as redundant (operator already
  // intentionally clicked "Copy report" / "Bug report").

  return parts.join('\n');
}
