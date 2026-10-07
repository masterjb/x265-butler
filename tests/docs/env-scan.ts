// Doc-contract helpers. Pure parsers (string in, set/map out) plus a few
// repo readers. Every parser throws when the structured place it looks for is
// missing or smaller than its minimum: an empty set would make every
// `subset of` assertion pass and the drift guard would be green by accident.
//
// Public on purpose: tests/docs/public-contract.test.ts runs in the public
// mirror too. The stripped dev-env-coverage test imports from here, never the
// other way round.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..');

export const readRepo = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');
export const existsRepo = (rel: string): boolean => existsSync(join(REPO_ROOT, rel));

export class ContractParseError extends Error {}

const fail = (msg: string): never => {
  throw new ContractParseError(msg);
};

const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

// ───────────────────────── README targets ─────────────────────────

/**
 * READMEs that carry the operator facts. README.md is the only operator
 * documentation in both the developer repo and the mirror; a second copy that
 * reappears under docs/public/ would drift, so it turns the guard red.
 */
export function resolveReadmes(exists: (rel: string) => boolean): string[] {
  if (exists('docs/public/README.md')) {
    fail('docs/public/README.md is back; README.md is the only operator documentation');
  }
  return ['README.md'];
}

// ───────────────────────── section helpers ─────────────────────────

/** Body of the markdown section under `heading` (exact line), up to the next heading of the same or higher level. */
export function sectionBody(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) fail(`section "${heading}" not found`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^(#+)\s/.exec(l);
    if (m && m[1].length <= level) break;
    out.push(l);
  }
  return out.join('\n');
}

// ───────────────────────── volumes ─────────────────────────

/** Container paths from the "- Volumes:" list in "### unRAID (Production)". Minimum 3. */
export function parseReadmeVolumes(md: string): Set<string> {
  const body = sectionBody(md, '### unRAID (Production)');
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^- Volumes:\s*$/.test(l));
  if (start < 0) fail('"- Volumes:" list not found in "### unRAID (Production)"');
  const vols = new Set<string>();
  for (const l of lines.slice(start + 1)) {
    if (!/^\s+- /.test(l)) break;
    const m = /^\s+- (?:optional )?`(\/[^`]+)` → /.exec(l);
    if (!m) fail(`volume line does not match "- [optional ]\`/x\` → ...": ${l.trim()}`);
    vols.add(m![1]);
  }
  if (vols.size < 3) fail(`volume list has ${vols.size} entries, expected at least 3`);
  return vols;
}

// ───────────────────────── env table ─────────────────────────

export const READ_BY = ['app', 'entrypoint', 'OS', 'driver'] as const;
export type ReadBy = (typeof READ_BY)[number];
export interface EnvRow {
  name: string;
  defaultValue: string;
  readBy: ReadBy;
  purpose: string;
}

const ENV_TABLE_HEADER = ['Variable', 'Default', 'Read by', 'Purpose'];

/** Rows of the table under "### Environment variables". Minimum 8 rows. */
export function parseEnvTable(md: string): EnvRow[] {
  const body = sectionBody(md, '### Environment variables');
  const tableLines = body.split('\n').filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 2) fail('no markdown table under "### Environment variables"');
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const header = cells(tableLines[0]);
  if (header.join('|') !== ENV_TABLE_HEADER.join('|')) {
    fail(`env table header is "${header.join(' | ')}", expected "${ENV_TABLE_HEADER.join(' | ')}"`);
  }
  const rows = tableLines.slice(2).map((l): EnvRow => {
    const [variable, def, readBy, purpose] = cells(l);
    const name = /^`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(variable)?.[1];
    if (!name) fail(`env table row needs one backticked variable name: ${l.trim()}`);
    if (!(READ_BY as readonly string[]).includes(readBy)) {
      fail(
        `env table row ${name}: "Read by" is "${readBy}", expected one of ${READ_BY.join(', ')}`,
      );
    }
    return { name: name!, defaultValue: def, readBy: readBy as ReadBy, purpose: purpose ?? '' };
  });
  if (rows.length < 8) fail(`env table has ${rows.length} rows, expected at least 8`);
  return rows;
}

// ───────────────────────── code env ─────────────────────────

const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const LITERAL_ACCESS = new RegExp(
  `process\\.env(?:\\.(${ENV_NAME})|\\[\\s*'(${ENV_NAME})'\\s*\\]|\\[\\s*"(${ENV_NAME})"\\s*\\])`,
  'g',
);

/**
 * Env names read in one source file. Only literal access counts; any other
 * `process.env` use (destructuring, `const env = process.env`, computed key)
 * throws, because the guard could not see which name is read.
 */
export function extractEnvNames(src: string, file: string): Set<string> {
  const names = new Set<string>();
  src.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    const total = line.match(/process\.env\b/g)?.length ?? 0;
    if (total === 0) return;
    const literal = [...line.matchAll(LITERAL_ACCESS)];
    for (const m of literal) names.add(m[1] ?? m[2] ?? m[3]);
    if (literal.length !== total) {
      fail(
        `${file}:${i + 1}: non-literal process.env access, name not visible to the doc guard: ${line.trim()}`,
      );
    }
  });
  return names;
}

const CODE_DIRS = ['src', 'app', 'lib', 'components'];
const isSource = (name: string) => /\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name);
const isTest = (name: string) => /\.test\.(ts|tsx)$/.test(name);

function walk(rel: string): string[] {
  return readdirSync(join(REPO_ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(child);
    return isSource(e.name) && !isTest(e.name) ? [child] : [];
  });
}

/** App source files: src/, app/, lib/, components/ and every root-level source (next.config.ts, middleware.ts). */
export function listCodeFiles(): string[] {
  const root = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && isSource(e.name) && !isTest(e.name))
    .map((e) => e.name);
  const dirs = CODE_DIRS.filter(existsRepo).flatMap(walk);
  return [...root, ...dirs];
}

/** name → files that read it. Minimum 30 names. */
export function scanCodeEnv(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of listCodeFiles()) {
    for (const name of extractEnvNames(readRepo(file), file)) {
      out.set(name, [...(out.get(name) ?? []), file]);
    }
  }
  if (out.size < 30) fail(`code env scan found ${out.size} names, expected at least 30`);
  return out;
}

/** Upper-case shell variables the entrypoint reads ($X / ${X}). */
export function parseEntrypointEnv(sh: string): Set<string> {
  const names = new Set<string>();
  for (const line of sh.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  }
  if (names.size === 0) fail('docker-entrypoint.sh reads no upper-case variables');
  return names;
}

// ───────────────────────── Dockerfile ─────────────────────────

/** ENV keys and values of the runtime stage (after the last FROM). */
export function parseDockerfileRuntimeEnv(dockerfile: string): Map<string, string> {
  const lines = dockerfile.split('\n');
  const lastFrom = lines.map((l) => /^\s*FROM\b/i.test(l)).lastIndexOf(true);
  if (lastFrom < 0) fail('Dockerfile has no FROM');
  // join continuation lines, then read ENV instructions
  const joined = lines
    .slice(lastFrom)
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => /^\s*ENV\s/.test(l));
  const env = new Map<string, string>();
  for (const l of joined) {
    for (const m of l
      .replace(/^\s*ENV\s+/, '')
      .matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/g)) {
      env.set(m[1], m[2].replace(/^"|"$/g, ''));
    }
  }
  if (env.size === 0) fail('Dockerfile runtime stage sets no ENV');
  return env;
}

export function parseDockerfileExpose(dockerfile: string): number[] {
  const ports = dockerfile
    .split('\n')
    .filter((l) => /^\s*EXPOSE\s/.test(l))
    .flatMap((l) => l.replace(/^\s*EXPOSE\s+/, '').split(/\s+/))
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
  if (ports.length === 0) fail('Dockerfile has no EXPOSE');
  return ports;
}

// ───────────────────────── CA template ─────────────────────────

export interface TemplateConfig {
  name: string;
  target: string;
  defaultValue: string;
  type: string;
  required: boolean;
}

export function parseTemplateConfigs(xml: string): TemplateConfig[] {
  const attr = (tag: string, a: string) => new RegExp(`\\b${a}="([^"]*)"`).exec(tag)?.[1] ?? '';
  const configs = [...xml.matchAll(/<Config\b[^>]*>/g)].map((m) => ({
    name: attr(m[0], 'Name'),
    target: attr(m[0], 'Target'),
    defaultValue: attr(m[0], 'Default'),
    type: attr(m[0], 'Type'),
    required: attr(m[0], 'Required') === 'true',
  }));
  if (configs.length === 0) fail('template has no <Config> entries');
  return configs;
}

// ───────────────────────── code fallbacks ─────────────────────────

/** Container-path fallbacks like `share.path ?? '/media'` or `shares[0].path === '/media'` in app/ and src/. */
export function findPathFallbacks(
  files: { file: string; src: string }[],
): { file: string; path: string }[] {
  const out: { file: string; path: string }[] = [];
  for (const { file, src } of files) {
    for (const line of src.split('\n')) {
      if (isCommentLine(line)) continue;
      for (const m of line.matchAll(/\.path\s*(?:\?\?|===)\s*'(\/[a-z0-9]+)'/g)) {
        out.push({ file, path: m[1] });
      }
    }
  }
  return out;
}

// ───────────────────────── misc ─────────────────────────

/** Every `X` backtick token in a text that looks like an env name. */
export function backtickEnvTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));
}

/** Owners of github.com/<owner>/ links. */
export function githubOwners(text: string): string[] {
  return [...text.matchAll(/github\.com\/([A-Za-z0-9-]+)\//g)].map((m) => m[1]);
}
