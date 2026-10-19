import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { setTimeout as sleep } from 'node:timers/promises';
import { getQRCode, getQRCodeStatus } from './transport';
import { emptyState, type WeixinStore } from './state';
import { weixinBaseUrl } from './config';

/** 登录在本地 CLI 完成；微信令牌不会进入 Web 路由、模型上下文或日志。 */
export async function loginWeixin(store: WeixinStore, force: boolean, signal: AbortSignal,
  report: (text: string) => void): Promise<void> {
  const previous = await store.load();
  if (previous.auth && !force) { report('已有微信登录缓存。运行 pnpm weixin:start 可连接；重新扫码请加 --force。'); return; }
  const qr = await getQRCode('3');
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信未返回有效二维码。');
  const directory = path.resolve('logs');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'weixin-login.png');
  await QRCode.toFile(file, qr.qrcode_img_content, { width: 420, margin: 4 });
  report(await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true }));
  report(`请用微信扫描二维码并确认。二维码图片：${file}`);
  report('只允许扫码返回的用户访问当前演示账户，不会自动接受其他联系人。');
  const deadline = Date.now() + 180_000;
  let baseUrl = 'https://ilinkai.weixin.qq.com';
  let scanned = false;
  let networkFailures = 0;
  while (Date.now() < deadline && !signal.aborted) {
    let status: Awaited<ReturnType<typeof getQRCodeStatus>>;
    try { status = await getQRCodeStatus(qr.qrcode, baseUrl); networkFailures = 0; }
    catch {
      if (signal.aborted) return;
      if (++networkFailures >= 3) throw new Error('微信扫码状态连续获取失败，请检查网络后重新登录。');
      report('微信扫码状态暂时无法获取，正在重试。');
      await sleep(2000, undefined, { signal }).catch(() => undefined);
      continue;
    }
    if (status.status === 'scaned_but_redirect' && status.redirect_host) {
      baseUrl = weixinBaseUrl(`https://${status.redirect_host}`);
    }
    if (status.status === 'scaned' && !scanned) { report('已扫码，请在微信中确认。'); scanned = true; }
    if (status.status === 'expired') throw new Error('二维码已过期，请重新运行 pnpm weixin:login。');
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
        throw new Error('微信登录缺少机器人令牌或扫码用户身份，未建立绑定。');
      }
      const state = previous.auth?.botId === status.ilink_bot_id && previous.auth.ownerId === status.ilink_user_id ? previous : emptyState();
      state.auth = { botId: status.ilink_bot_id, token: status.bot_token, ownerId: status.ilink_user_id,
        baseUrl: weixinBaseUrl(status.baseurl || baseUrl) };
      await store.save(state);
      report('微信登录成功，用户绑定已保存。现在可运行 pnpm weixin:start。');
      return;
    }
    await sleep(1000, undefined, { signal }).catch(() => undefined);
  }
  if (!signal.aborted) throw new Error('微信扫码超时，尚未完成真实微信联通。');
}
