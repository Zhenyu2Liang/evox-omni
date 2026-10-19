import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { getUpdates, sendMessage } from 'pi-weixinbot/src/weixin-api.ts';

describe('固定版本 pi-weixinbot 协议模块', () => {
  let server: Server;
  afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  async function start(reply: string) {
    const received: Array<{ url: string; authorization?: string; body: unknown }> = [];
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      received.push({ url: request.url!, authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(reply);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    return { baseUrl: `http://127.0.0.1:${address.port}`, received };
  }
  it('轮询携带认证和游标，uint64 消息编号无精度损失', async () => {
    const f = await start('{"ret":0,"msgs":[{"message_id":18446744073709551610}],"get_updates_buf":"next"}');
    const response = await getUpdates({ baseUrl: f.baseUrl, token: 'test-token', get_updates_buf: 'previous' });
    expect(response.msgs?.[0].message_id).toBe('18446744073709551610');
    expect(response.get_updates_buf).toBe('next'); expect(f.received[0].authorization).toBe('Bearer test-token');
    expect(f.received[0].body).toMatchObject({ get_updates_buf: 'previous' });
  });
  it('发送使用固定收件人、上下文和幂等 client_id', async () => {
    const f = await start('{"ret":0}');
    await sendMessage({ baseUrl: f.baseUrl, token: 'test-token', to: 'owner', text: '已查询', clientId: 'stable', contextToken: 'context' });
    expect(f.received[0].body).toMatchObject({ msg: { to_user_id: 'owner', client_id: 'stable', context_token: 'context', message_type: 2 } });
  });
  it('HTTP 200 但微信业务拒绝不能视为已发送', async () => {
    const f = await start('{"ret":-14,"errmsg":"expired"}');
    await expect(sendMessage({ baseUrl: f.baseUrl, to: 'owner', text: 'reply', clientId: 'stable' })).rejects.toThrow('expired');
  });
});
