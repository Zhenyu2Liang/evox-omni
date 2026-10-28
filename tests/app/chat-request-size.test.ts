import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { runTurn } from '@/agent';
import { resetDatabase } from '@/tests/helpers/db';
import { postJson } from './harness';

vi.mock('@/agent', () => ({ runTurn: vi.fn(async () => ({ events: [{ type: 'done' }] })) }));
beforeEach(async () => { await resetDatabase(); vi.mocked(runTurn).mockClear(); });

it.each([4001, 300000])('rejects %i characters before any model request', async length => {
  const response = await postJson(POST, '/api/chat?stream=0', { message: 'x'.repeat(length) });
  expect(response.status).toBe(400);
  expect(runTurn).not.toHaveBeenCalled();
});
it('accepts 4000 Chinese characters within the byte limit', async () => {
  const response = await postJson(POST, '/api/chat?stream=0', { message: '中'.repeat(4000) });
  expect(response.status).toBe(200);
  expect(runTurn).toHaveBeenCalledOnce();
});
