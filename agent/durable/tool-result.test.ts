import { describe, expect, it } from 'vitest';
import { savedToolContent, savedToolMetadata } from './tool-result';

describe('durable Pi tool result projection', () => {
  it('retains all original text and image parts instead of reconstructing the summary', () => {
    const content = [{ type: 'text' as const, text: 'Query summary.' },
      { type: 'text' as const, text: '{"accountId":"account-1","balance":"10.25"}' },
      { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }];
    expect(savedToolContent({ content, summary: 'Query summary.', data: { balance: '10.25' } })).toBe(content);
  });

  it('keeps an explicitly empty original result empty', () => {
    expect(savedToolContent({ content: [], summary: 'This is audit metadata only.' })).toEqual([]);
  });

  it('projects both the bank receipt summary and complete public data when no Pi content exists', () => {
    expect(savedToolContent({ summary: 'The confirmed operation completed.', data: { id: 'receipt-1' } }))
      .toEqual([{ type: 'text', text: 'The confirmed operation completed.' },
        { type: 'text', text: '{"ok":true,"data":{"id":"receipt-1"}}' }]);
    expect(savedToolMetadata({ durationMs: 0 })).toEqual({ durationMs: 0 });
    expect(savedToolMetadata({})).toEqual({});
  });

  it('restores a failed bank receipt as a model-visible structured error', () => {
    const [message] = savedToolContent({ ok: false, errorCode: 'CONFLICT', error: 'The saved quote changed.' });
    expect(message.type === 'text' && JSON.parse(message.text).bankingError)
      .toMatchObject({ code: 'CONFLICT', message: 'The saved quote changed.', retryable: false });
  });
});
