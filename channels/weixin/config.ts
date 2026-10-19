import path from 'node:path';

/** 微信协议端点只能来自微信登录结果，不能由聊天内容指定。 */
export function weixinBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password ||
      url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('微信服务地址无效。');
  return url.origin;
}

export function bankingBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WEIXIN_BANKING_URL 必须指向本机 Banking Agent，例如 http://127.0.0.1:3000。');
  }
  return url.origin;
}

export function weixinConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    bankingUrl: bankingBaseUrl(env.WEIXIN_BANKING_URL || 'http://127.0.0.1:3000'),
    stateDir: path.resolve(env.WEIXIN_STATE_DIR || '.local/weixinbot'),
  };
}
