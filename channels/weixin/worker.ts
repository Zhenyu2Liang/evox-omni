import { setTimeout as sleep } from 'node:timers/promises';
import { BankingHttpClient } from './banking-client';
import { WeixinBridge } from './bridge';
import { createWeixinTransport } from './transport';
import { WeixinStore } from './state';

export async function runWeixinWorker(store: WeixinStore, bank: BankingHttpClient, signal: AbortSignal,
  report: (message: string) => void): Promise<void> {
  const state = await store.load();
  if (!state.auth) throw new Error('微信尚未登录，请先运行 pnpm weixin:login。');
  const health = await bank.health();
  report(`微信通道已启动；银行模型模式：${health.llmMode}。仅处理扫码绑定用户的文字私聊。`);
  const transport = createWeixinTransport(state.auth);
  const bridge = new WeixinBridge(state, bank, transport, () => store.save(state));
  while (!signal.aborted) {
    try {
      const update = await transport.poll(state.cursor);
      if (update.errcode === -14 || update.ret === -14) throw new Error('WEIXIN_LOGIN_EXPIRED');
      if ((update.ret ?? 0) !== 0 || (update.errcode ?? 0) !== 0) throw new Error('微信取消息失败。');
      for (const message of update.msgs || []) {
        if (signal.aborted) break;
        await bridge.handle(message);
      }
      // 停止发生在批次中途时不能提交整个批次游标；重启依靠去重继续。
      if (!signal.aborted && update.get_updates_buf !== undefined) {
        state.cursor = update.get_updates_buf;
        await store.save(state);
      }
      if (!update.msgs?.length && !signal.aborted) await sleep(250, undefined, { signal });
    } catch (error) {
      if (signal.aborted) break;
      const code = (error as { code?: string }).code;
      if ((error instanceof Error && error.message === 'WEIXIN_LOGIN_EXPIRED') || ['-14', '401', '403'].includes(code || '')) {
        throw new Error('微信登录已失效，请重新运行 pnpm weixin:login --force。');
      }
      report('微信通道请求暂时失败，5 秒后重试；未提交消息游标。');
      await sleep(5000, undefined, { signal }).catch(() => undefined);
    }
  }
}
