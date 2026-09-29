import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getVersionInfo } from '../src/lib/version.js';
import pkg from '../package.json' with { type: 'json' };

describe('getVersionInfo', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GIT_HASH;
    delete process.env.GIT_COMMITTED_AT;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it('returns gitHash="dev" and null timestamps when env unset', () => {
    const info = getVersionInfo();
    expect(info.gitHash).toBe('dev');
    expect(info.committedAt).toBeNull();
    expect(info.committedAtCET).toBeNull();
  });

  it('uses GIT_HASH when set', () => {
    process.env.GIT_HASH = 'abc123';
    expect(getVersionInfo().gitHash).toBe('abc123');
  });

  it('parses GIT_COMMITTED_AT when numeric and finite', () => {
    process.env.GIT_COMMITTED_AT = '1745526000';
    const info = getVersionInfo();
    expect(info.committedAt).toBe(1745526000);
    expect(info.committedAtCET).toMatch(/^\d{2}\.\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}$/);
  });

  it('returns null for non-numeric GIT_COMMITTED_AT without crashing', () => {
    process.env.GIT_COMMITTED_AT = 'not-a-number';
    const info = getVersionInfo();
    expect(info.committedAt).toBeNull();
    expect(info.committedAtCET).toBeNull();
  });

  it('reads version from package.json', () => {
    expect(getVersionInfo().version).toBe(pkg.version);
  });
});
