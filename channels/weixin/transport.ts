// 固定版本的上游协议模块；不加载扩展入口或旧版 Pi 编码工具。
import { getUpdates, sendMessage, getQRCode, getQRCodeStatus } from 'pi-weixinbot/src/weixin-api.ts';
import type { WeixinAuth } from './state';

export { getQRCode, getQRCodeStatus };

export function createWeixinTransport(auth: WeixinAuth) {
  return {
    poll: (cursor: string) => getUpdates({ baseUrl: auth.baseUrl, token: auth.token, get_updates_buf: cursor, timeoutMs: 10_000 }),
    send: (to: string, text: string, clientId: string, contextToken: string) => sendMessage({
      baseUrl: auth.baseUrl, token: auth.token, to, text, clientId, contextToken,
    }),
  };
}
