import { describe, it, expect } from 'vitest';
import { libraryQuerySchema, parseLibraryQuery, toListOptions } from '@/src/lib/api/library-query';

describe('libraryQuerySchema', () => {
  it('test_schema_when_empty_then_defaults_applied', () => {
    const out = libraryQuerySchema.parse({});
    expect(out.page).toBe(1);
    expect(out.size).toBe(25);
    expect(out.sort).toBe('size');
    expect(out.dir).toBe('desc');
  });

  it('test_schema_when_invalid_size_over_200_then_throws', () => {
    expect(() => libraryQuerySchema.parse({ size: '300' })).toThrow();
  });

  it('test_schema_when_invalid_status_then_throws', () => {
    expect(() => libraryQuerySchema.parse({ status: 'bogus' })).toThrow();
  });

  it('test_schema_when_status_all_then_accepted', () => {
    const out = libraryQuerySchema.parse({ status: 'all' });
    expect(out.status).toBe('all');
  });
});

describe('parseLibraryQuery', () => {
  it('test_parseLibraryQuery_when_URLSearchParams_then_parsed', () => {
    const params = new URLSearchParams('page=2&size=10&q=movie&sort=scanned&dir=asc');
    const out = parseLibraryQuery(params);
    expect(out).toEqual({
      page: 2,
      size: 10,
      q: 'movie',
      sort: 'scanned',
      dir: 'asc',
      includeVanished: false,
    });
  });

  it('test_parseLibraryQuery_when_record_then_parsed', () => {
    const out = parseLibraryQuery({ page: '3', q: 'foo', status: 'failed' });
    expect(out.page).toBe(3);
    expect(out.q).toBe('foo');
    expect(out.status).toBe('failed');
  });

  it('test_parseLibraryQuery_when_record_with_arrays_then_first_value_wins', () => {
    const out = parseLibraryQuery({ q: ['first', 'second'] });
    expect(out.q).toBe('first');
  });

  it('test_parseLibraryQuery_when_empty_string_param_then_default_wins', () => {
    const out = parseLibraryQuery({ q: '', size: '' });
    expect(out.q).toBeUndefined();
    expect(out.size).toBe(25);
  });

  it('test_parseLibraryQuery_when_undefined_value_then_skipped', () => {
    const out = parseLibraryQuery({ q: undefined, status: undefined });
    expect(out.q).toBeUndefined();
    expect(out.status).toBeUndefined();
  });
});

describe('toListOptions', () => {
  it('test_toListOptions_when_full_query_then_passes_through', () => {
    const opts = toListOptions({
      page: 1,
      size: 50,
      q: 'foo',
      status: 'pending',
      sort: 'size',
      dir: 'desc',
      includeVanished: false,
    });
    expect(opts).toEqual({
      page: 1,
      size: 50,
      q: 'foo',
      status: 'pending',
      sort: 'size',
      dir: 'desc',
      includeVanished: false,
    });
  });
});
