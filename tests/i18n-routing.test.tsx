import { describe, it, expect } from 'vitest';
import { routing } from '@/i18n/routing';

describe('i18n routing config', () => {
  it('test_routing_when_initialized_returns_en_de_locales', () => {
    expect(routing.locales).toEqual(['en', 'de']);
  });

  it('test_routing_when_initialized_returns_en_as_default_locale', () => {
    expect(routing.defaultLocale).toBe('en');
  });

  it('test_routing_when_initialized_uses_always_locale_prefix', () => {
    expect(routing.localePrefix).toBe('always');
  });
});
