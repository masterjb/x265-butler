// The pattern for planning markers in a line, shared by the repository guard and by tests that
// check an operator-facing text for leftovers. It lives here because importing it from the guard
// itself would register the guard's test cases a second time.

export const MARKER = new RegExp(
  [
    // Plan or step ID like 22-01, 14-02b or 11-02-FIX. The lookarounds keep versions (2.51.4),
    // dates (2026-10-06, 06-10-2026) and longer digit runs out: a hyphen followed by a digit
    // continues a date, a hyphen followed by a letter is a suffix on a plan ID.
    String.raw`(?<![0-9.\-])[0-9]{2}-[0-9]{2}[a-z]?(?![0-9]|-[0-9])`,
    // Acceptance-criterion number, but not the codec name E-AC-3.
    String.raw`(?<!E-)\bAC-[0-9]+`,
    // Review shorthand: "audit M2", "audit-MH-1", "audit S4".
    String.raw`\b[Aa]udit[- ]?(?:MH|SR|M|S)[- ]?[0-9]+`,
    String.raw`\bMH-[0-9]+`,
    String.raw`\bSR-[0-9]+`,
    // Roadmap position.
    String.raw`\b(?:Phase|Plan) [0-9]{1,2}\b`,
    // Improvement and issue-list IDs.
    String.raw`\bIMP-[0-9]+`,
    String.raw`\bISS-[0-9]{3}\b`,
    // Acceptance-test finding IDs. The bare word UAT is ordinary text.
    String.raw`\bUAT-[0-9]+`,
  ].join('|'),
);

export function markerHits(path: string, source: string): string[] {
  return source
    .split('\n')
    .flatMap((line, i) =>
      MARKER.test(line) ? [`${path}:${i + 1}: ${line.trim().slice(0, 120)}`] : [],
    );
}
