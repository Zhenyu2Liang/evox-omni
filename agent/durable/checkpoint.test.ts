import { describe, expect, it } from 'vitest';
import { decodeCheckpoint, encodeCheckpoint, hasRedactedCredentials } from './checkpoint';
import { newSession } from '@/agent/session';
import type { AppConfig } from '@/lib/config';

const config: AppConfig = { llmMode: 'live', llmProvider: 'checkpoint-test', llmModel: 'checkpoint-model', demoUserId: 'user_liming' };

describe('complete checkpoint boundaries', () => {
  it('preserves original session, transcript, intent and revision without runtime functions', () => {
    const snapshot = newSession(config.demoUserId);
    snapshot.revision = 7;
    const checkpoint = decodeCheckpoint(encodeCheckpoint(snapshot, config), config);
    expect(checkpoint.snapshot).toMatchObject({ sessionId: snapshot.sessionId, userId: snapshot.userId, revision: 7, transcript: [] });
    expect(checkpoint.snapshot.agentState.messages).toEqual([]);
  });

  it.each(['llmMode', 'llmProvider', 'llmModel'] as const)('requires the original %s configuration', field => {
    const json = encodeCheckpoint(newSession(config.demoUserId), config);
    expect(() => decodeCheckpoint(json, { ...config, [field]: field === 'llmMode' ? 'mock' : 'changed' })).toThrow('original provider');
  });

  it('rejects an incomplete checkpoint instead of restoring an empty successful state', () => {
    expect(() => decodeCheckpoint(JSON.stringify({ version: 1, provider: config, snapshot: {} }), config)).toThrow('incomplete');
  });

  it('detects redacted credentials in nested original call arguments', () => {
    expect(hasRedactedCredentials({ args: [{ currentPassword: '[REDACTED]' }] })).toBe(true);
    expect(hasRedactedCredentials({ args: { amount: '10.00', contactId: 'contact_zhangwei' } })).toBe(false);
  });

});
