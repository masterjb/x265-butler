// @vitest-environment node
// The docs are a contract. Container paths, the port, the env table and
// the GitHub links in the README are checked against the Dockerfile, the CA
// template and the code. v2.51.0 shipped a template that mapped `/library`
// while the app fell back to `/media`; this test turns such drift red in the MR.
//
// Runs in the public mirror as well: it reads README.md, CONTRIBUTING.md, the
// Dockerfile, the template and the code, never docs/dev. README.md is the only
// operator documentation, in both places.

import { describe, it, expect } from 'vitest';
import {
  ContractParseError,
  backtickEnvTokens,
  existsRepo,
  extractEnvNames,
  findPathFallbacks,
  githubOwners,
  listCodeFiles,
  parseDockerfileExpose,
  parseDockerfileRuntimeEnv,
  parseEntrypointEnv,
  parseEnvTable,
  parseReadmeVolumes,
  parseTemplateConfigs,
  readRepo,
  resolveReadmes,
  scanCodeEnv,
} from './env-scan';

const README_FILES = resolveReadmes(existsRepo);
const dockerfile = readRepo('Dockerfile');
const template = parseTemplateConfigs(readRepo('unraid/x265-butler.xml'));
const templatePaths = template.filter((c) => c.type === 'Path');
const templatePathTargets = new Set(templatePaths.map((c) => c.target));
const templateVariables = template.filter((c) => c.type === 'Variable');
const templatePort = template.find((c) => c.type === 'Port');

const EXPECTED_VOLUMES = new Set(['/config', '/media', '/cache']);

// Dockerfile runtime ENV keys that are not operator settings.
const DOCKERFILE_ENV_INTERNAL: Record<string, string> = {
  NODE_ENV: 'fixed to production by the image',
  PORT: 'container port, change the host side of the port mapping instead',
  HOSTNAME: 'bind address of the Node server inside the container',
  GIT_HASH: 'build argument, shown under /api/health',
  GIT_COMMITTED_AT: 'build argument, shown under /api/health',
};

describe('contract parsers fail closed', () => {
  it('parser fails on missing section', () => {
    expect(() => parseReadmeVolumes('# x\n\n## Deployment\n')).toThrow(ContractParseError);
    expect(() => parseEnvTable('# x\n\n### Something else\n| a | b |\n')).toThrow(
      /Environment variables/,
    );
  });

  it('parser fails when the structured place is too small', () => {
    const vols = '### unRAID (Production)\n\n- Volumes:\n  - `/config` → x\n';
    expect(() => parseReadmeVolumes(vols)).toThrow(/at least 3/);
    const table =
      '### Environment variables\n\n| Variable | Default | Read by | Purpose |\n|---|---|---|---|\n| `PUID` | `99` | entrypoint | user |\n';
    expect(() => parseEnvTable(table)).toThrow(/at least 8/);
  });

  it('parser fails on a wrong table header or an unknown "Read by"', () => {
    const header = '### Environment variables\n\n| Name | Default |\n|---|---|\n| `A` | b |\n';
    expect(() => parseEnvTable(header)).toThrow(/header/);
    const readBy =
      '### Environment variables\n\n| Variable | Default | Read by | Purpose |\n|---|---|---|---|\n| `A` | b | kernel | c |\n';
    expect(() => parseEnvTable(readBy)).toThrow(/Read by/);
  });

  it('non-literal process.env access is rejected', () => {
    expect(() => extractEnvNames('const { A } = process.env;', 'x.ts')).toThrow(/x\.ts:1/);
    expect(() => extractEnvNames('const env = process.env;', 'x.ts')).toThrow(ContractParseError);
    expect(() => extractEnvNames('const v = process.env[key];', 'x.ts')).toThrow(
      ContractParseError,
    );
    expect(
      extractEnvNames('a(process.env.A, process.env[\'B\'], process.env["C"]);', 'x.ts'),
    ).toEqual(new Set(['A', 'B', 'C']));
    expect(extractEnvNames('// reads process.env per call\n * process.env too', 'x.ts')).toEqual(
      new Set(),
    );
  });

  it('README.md is the only operator README; a second copy is rejected', () => {
    expect(resolveReadmes(() => false)).toEqual(['README.md']);
    expect(resolveReadmes((rel) => rel === 'docs/public')).toEqual(['README.md']);
    expect(() => resolveReadmes((rel) => rel === 'docs/public/README.md')).toThrow(
      /docs\/public\/README\.md is back/,
    );
  });

  it('README.md carries no developer internals', () => {
    const md = readRepo('README.md');
    for (const heading of [
      'Data Model',
      'API Surface',
      'Architecture',
      'Implementation Phases',
      'Design Decisions',
      'Open Questions',
    ]) {
      expect(md, heading).not.toMatch(new RegExp(`^#{2,3} ${heading}\\b`, 'm'));
    }
  });
});

describe.each(README_FILES)('doc contract: %s', (rel) => {
  const md = readRepo(rel);

  it('volumes: template == README == fallbacks', () => {
    const vols = parseReadmeVolumes(md);
    expect(vols).toEqual(EXPECTED_VOLUMES);
    expect(templatePathTargets).toEqual(vols);
  });

  it('port: README default port == EXPOSE == template', () => {
    const line = md.split('\n').find((l) => l.startsWith('- Default port:'));
    expect(line, 'README needs a "- Default port:" line').toBeDefined();
    const port = Number(/^- Default port: `(\d+)`/.exec(line ?? '')?.[1]);
    expect(parseDockerfileExpose(dockerfile)).toContain(port);
    expect(templatePort?.target).toBe(String(port));
    expect(templatePort?.defaultValue).toBe(String(port));
    // any other host port in the README (compose example) must be flagged as free to choose
    const hostPorts = [...md.matchAll(new RegExp(`"?(\\d+):${port}\\b`, 'g'))].map((m) => m[1]);
    if (hostPorts.some((h) => h !== templatePort?.defaultValue)) {
      expect(line).toMatch(/any free host port/);
    }
  });

  it('env table: every row real', () => {
    const rows = parseEnvTable(md);
    const codeEnv = scanCodeEnv();
    const entrypointEnv = parseEntrypointEnv(readRepo('docker-entrypoint.sh'));
    for (const r of rows) {
      if (r.readBy === 'app')
        expect(codeEnv.has(r.name), `${r.name}: Read by app, not read by code`).toBe(true);
      if (r.readBy === 'entrypoint')
        expect(entrypointEnv.has(r.name), `${r.name}: Read by entrypoint, not read there`).toBe(
          true,
        );
    }
  });

  it('no AUTH_ENABLED/DEFAULT_LOCALE env', () => {
    expect(md).not.toMatch(/\bAUTH_ENABLED\b/);
    expect(md).not.toMatch(/\bDEFAULT_LOCALE\b/);
  });

  it('auth is described as a Settings toggle', () => {
    expect(md).toMatch(/auth[^\n]*enabled under Settings/i);
  });

  it('template variables in env table', () => {
    const names = new Set(parseEnvTable(md).map((r) => r.name));
    expect(templateVariables.length).toBeGreaterThan(0);
    for (const v of templateVariables)
      expect(names.has(v.target), `${v.target} missing in env table`).toBe(true);
  });

  it('dockerfile ENV keys covered', () => {
    const names = new Set(parseEnvTable(md).map((r) => r.name));
    for (const key of parseDockerfileRuntimeEnv(dockerfile).keys()) {
      expect(
        names.has(key) || key in DOCKERFILE_ENV_INTERNAL,
        `${key} neither in env table nor internal`,
      ).toBe(true);
    }
  });

  it('defaults match Dockerfile ENV', () => {
    const env = parseDockerfileRuntimeEnv(dockerfile);
    const rows = parseEnvTable(md);
    for (const key of ['PUID', 'PGID', 'TZ']) {
      const row = rows.find((r) => r.name === key);
      expect(row, `${key} row`).toBeDefined();
      expect(row?.defaultValue).toBe(`\`${env.get(key)}\``);
    }
  });
});

describe('code fallbacks are template targets', () => {
  it('every container-path fallback in app/ and src/ is a template path', () => {
    const files = listCodeFiles()
      .filter((f) => f.startsWith('app/') || f.startsWith('src/'))
      .map((file) => ({ file, src: readRepo(file) }));
    const found = findPathFallbacks(files);
    expect(found.length).toBeGreaterThanOrEqual(4);
    for (const f of [
      'app/api/scan/route.ts',
      'app/api/scan/estimate/route.ts',
      'app/[locale]/onboarding/page.tsx',
      'app/api/onboarding/complete/route.ts',
    ]) {
      expect(found.map((x) => x.file)).toContain(f);
    }
    for (const x of found)
      expect(templatePathTargets.has(x.path), `${x.file}: ${x.path}`).toBe(true);
  });

  it('/config is VOLUME in the Dockerfile and a required template path', () => {
    expect(dockerfile).toMatch(/^VOLUME \["\/config"\]$/m);
    expect(templatePaths.find((c) => c.target === '/config')?.required).toBe(true);
  });
});

describe('github links use masterjb', () => {
  const files = [...README_FILES, 'CONTRIBUTING.md', 'unraid/x265-butler.xml'];

  it('at least one github.com link is checked', () => {
    expect(files.flatMap((f) => githubOwners(readRepo(f))).length).toBeGreaterThan(0);
  });

  it.each(files)('%s: no github.com/MisterJB link (GitHub account is masterjb)', (rel) => {
    expect(githubOwners(readRepo(rel)).filter((o) => o.toLowerCase() === 'misterjb')).toEqual([]);
  });
});

describe('doc index names the contract', () => {
  const docs = ['CONTRIBUTING.md'];

  it.each(docs)('%s points at tests/docs/public-contract.test.ts', (rel) => {
    expect(readRepo(rel)).toContain('tests/docs/public-contract.test.ts');
  });

  it('env names in the README table are backticked tokens', () => {
    // sanity for the dev coverage test: the table is the README source of truth
    for (const rel of README_FILES) {
      const names = parseEnvTable(readRepo(rel)).map((r) => r.name);
      const tokens = backtickEnvTokens(readRepo(rel));
      for (const n of names) expect(tokens.has(n)).toBe(true);
    }
  });
});
