import { describe, expect, it } from 'vitest';
import { encodeRuntimeValue, runtimeRequestDigest, snapshotRuntimeValue } from './serialization';

describe('runtime event serialization', () => {
  it('detaches mutable nested messages and preserves exact bigint values', () => {
    const original = { message: { content: [{ text: 'original' }] }, balance: 9007199254740993123n };
    const snapshot = snapshotRuntimeValue(original);
    original.message.content[0].text = 'changed';
    expect(snapshot).toEqual({ balance: '9007199254740993123', message: { content: [{ text: 'original' }] } });
  });

  it('redacts credentials while retaining internal reasoning evidence', () => {
    const stored = JSON.parse(encodeRuntimeValue({ newPassword: 'secret-value', args: { otpCode: '123456', apiKey: 'private-key' }, thinking: 'internal reasoning', header: 'Bearer private-token', text: 'sk-1234567890abcdef' }));
    expect(stored.newPassword).toBe('[REDACTED]');
    expect(stored.args).toEqual({ apiKey: '[REDACTED]', otpCode: '[REDACTED]' });
    expect(stored.thinking).toBe('internal reasoning');
    expect(stored.header).toBe('Bearer [REDACTED]');
    expect(stored.text).toBe('[REDACTED]');
  });

  it('hashes original credentials and canonicalizes object ordering', () => {
    expect(runtimeRequestDigest('unsupported_secret_tool', { newPassword: 'first' })).not.toBe(runtimeRequestDigest('unsupported_secret_tool', { newPassword: 'second' }));
    expect(runtimeRequestDigest('query', { a: '1', b: '2' })).toBe(runtimeRequestDigest('query', { b: '2', a: '1' }));
  });

  it('redacts credential-bearing text and fragmented password tool arguments', () => {
    const value = {
      message: 'newPassword=private-value', code: '123456',
      event: { type: 'toolcall_delta', delta: 'private-value', partial: { content: [{ type: 'toolCall', name: 'unsupported_secret_tool', arguments: { newPassword: 'private-value' }, partialJson: '{"newPassword":"private-value' }] } },
    };
    const stored = encodeRuntimeValue(value);
    expect(stored).not.toContain('private-value');
    expect(stored).not.toContain('123456');
    expect(stored).toContain('toolcall_delta');
  });

  it('serializes exact decimal adapters without exposing their implementation fields', () => {
    expect(encodeRuntimeValue({ amount: { toJSON: () => '0.30' } })).toBe('{"amount":"0.30"}');
  });

  it('rejects circular and non-finite payloads', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeRuntimeValue(value)).toThrow('circular reference');
    expect(() => encodeRuntimeValue({ amount: Infinity })).toThrow('non-finite number');
  });
});
