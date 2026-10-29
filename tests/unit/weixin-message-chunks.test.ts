import { describe, expect, it } from 'vitest';
import { splitReply } from '@/channels/weixin/message-chunks';

describe('WeChat long reply boundaries', () => {
  it('preserves the complete message while keeping short commands on one part', () => {
    const command = '/确认 action_1234567890';
    const text = '业务说明'.repeat(385) + '\n\n' + command + '\n/取消 action_1234567890\n\n' + '后续说明\n'.repeat(420);
    const chunks = splitReply(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => Array.from(chunk).length <= 1600)).toBe(true);
    expect(chunks.some(chunk => chunk.includes(command))).toBe(true);
    expect(chunks.slice(0, -1).every(chunk => chunk.endsWith('\n'))).toBe(true);
  });
  it('never separates a surrogate pair when one oversized line must be split', () => {
    const text = '🟡'.repeat(3201);
    const chunks = splitReply(text);
    expect(chunks.map(chunk => Array.from(chunk).length)).toEqual([1600, 1600, 1]);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => !chunk.includes('\uFFFD'))).toBe(true);
  });
  it('leaves short replies unchanged and rejects invalid limits', () => {
    expect(splitReply('查询完成\n金额：¥219.87')).toEqual(['查询完成\n金额：¥219.87']);
    expect(splitReply('')).toEqual([]);
    expect(() => splitReply('text', 0)).toThrow();
  });
});
