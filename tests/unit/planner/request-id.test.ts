import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestId, RequestIdUnavailableError } from '@/components/chat/request-id';

afterEach(() => vi.unstubAllGlobals());

describe('browser request identity', () => {
  it('calls native randomUUID with its required crypto receiver', () => {
    const source = {
      randomUUID() {
        expect(this).toBe(source);
        return '00010203-0405-4607-8809-0a0b0c0d0e0f';
      },
    };
    vi.stubGlobal('crypto', source);
    expect(createRequestId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('creates a version 4 UUID from getRandomValues on an ordinary HTTP page', () => {
    const source = {
      getRandomValues(bytes: Uint8Array) {
        expect(this).toBe(source);
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    };
    vi.stubGlobal('crypto', source);
    expect(createRequestId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('uses fresh secure random values for each new request without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 16 }, () => createRequestId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    }
  });

  it.each([undefined, {}])('refuses an unsafe fallback when crypto is %j', source => {
    vi.stubGlobal('crypto', source);
    expect(createRequestId).toThrow(RequestIdUnavailableError);
  });
});
