import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { randomUuidV4 } from '@/src/lib/ui/random-uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Same schema as app/api/queue/reorder/route.ts clientNonce.
const nonceSchema = z.string().uuid();

const originalRandomUUID = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');

function removeRandomUUID() {
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
}

afterEach(() => {
  if (originalRandomUUID) Object.defineProperty(crypto, 'randomUUID', originalRandomUUID);
  else delete (crypto as { randomUUID?: unknown }).randomUUID;
});

describe('randomUuidV4', () => {
  it('test_randomUuidV4_when_randomUUID_available_then_returns_v4_uuid', () => {
    const id = randomUuidV4();
    expect(id).toMatch(UUID_V4);
    expect(nonceSchema.safeParse(id).success).toBe(true);
  });

  it('test_randomUuidV4_when_randomUUID_missing_then_fallback_returns_schema_valid_v4_uuid', () => {
    removeRandomUUID();
    expect(typeof crypto.randomUUID).not.toBe('function');
    const id = randomUuidV4();
    expect(id).toMatch(UUID_V4);
    expect(nonceSchema.safeParse(id).success).toBe(true);
  });

  it('test_randomUuidV4_when_fallback_called_1000_times_then_no_duplicates', () => {
    removeRandomUUID();
    const ids = new Set(Array.from({ length: 1000 }, () => randomUuidV4()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
