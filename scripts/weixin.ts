import nextEnv from '@next/env';
import { pathToFileURL } from 'node:url';
import { weixinConfig } from '../channels/weixin/config';
import { WeixinStore, emptyState } from '../channels/weixin/state';
import { BankingHttpClient } from '../channels/weixin/banking-client';
import { loginWeixin } from '../channels/weixin/login';
import { runWeixinWorker } from '../channels/weixin/worker';

export async function runWeixinCommand(args = process.argv.slice(2)): Promise<void> {
  nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error('运行配置加载失败。'); } });
  const [command, ...flags] = args;
  if (!['login', 'start', 'status', 'logout'].includes(command) || flags.some(flag => command !== 'login' || flag !== '--force')) {
    throw new Error('命令：pnpm weixin:login [--force] | weixin:start | weixin:status | weixin:logout');
  }
  const config = weixinConfig();
  const store = new WeixinStore(config.stateDir);
  const report = (text: string) => process.stdout.write(`${text}\n`);
  if (command === 'status') {
    const state = await store.load();
    report(JSON.stringify({ loggedIn: Boolean(state.auth), bankingUrl: config.bankingUrl,
      stateDirectory: config.stateDir, cachedMessages: Object.keys(state.deliveries).length }));
    return;
  }
  const release = await store.lock();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (command === 'login') await loginWeixin(store, flags.includes('--force'), shutdown.signal, report);
    if (command === 'start') await runWeixinWorker(store, new BankingHttpClient(config.bankingUrl), shutdown.signal, report);
    if (command === 'logout') { await store.save(emptyState((await store.load()).nextActionNumber)); report('本地微信登录与绑定已清除。'); }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runWeixinCommand().catch(error => {
    // 只输出已知业务提示；第三方异常可能包含令牌或原始 HTTP 数据。
    const message = error instanceof Error && /^(微信|银行|已有|命令|无法取得|运行配置|WEIXIN_)/.test(error.message)
      ? error.message : '微信通道启动失败，请检查网络和本地状态；未输出凭据。';
    process.stderr.write(`${message}\n`); process.exitCode = 1;
  });
}
