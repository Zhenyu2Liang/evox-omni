import { describe, expect, it } from 'vitest';
import { redactRequest } from '@/lib/sensitive';
import { encodeRuntimeValue } from '@/agent/durable/serialization';
import { buildSystemPrompt } from '@/agent/system-prompt';

describe('credential redaction and noncredential identifiers', () => {
  it('does not erase the complete system prompt because an identifier ends in password', () => {
    const prompt = buildSystemPrompt({ userId: 'owner_password', toolNames: ['freeze_card'], turnIntentTool: true });
    expect(redactRequest(prompt)).toBe(prompt);
    expect(JSON.parse(encodeRuntimeValue({ content: prompt })).content).toBe(prompt);
    expect(prompt).toContain('describe_turn');
  });
  it.each(['password: real-secret', 'newPassword=real-secret', '"currentPassword": "real-secret"'])
  ('continues to redact an actual credential declaration: %s', text => {
    expect(redactRequest(text)).not.toContain('real-secret');
  });
  it('preserves a discussion naming a capability without including a credential', () => {
    expect(redactRequest('Explain reset_password: RED.')).toBe('Explain reset_password: RED.');
  });
});
