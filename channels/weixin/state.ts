import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { weixinBaseUrl } from './config';

const authSchema = z.object({ botId: z.string().min(1), token: z.string().min(1),
  ownerId: z.string().min(1), baseUrl: z.string().transform(weixinBaseUrl) });
const stateSchema = z.object({
  version: z.literal(1), auth: authSchema.optional(), cursor: z.string(),
  deliveries: z.record(z.string(), z.object({ replies: z.array(z.string()), sent: z.number().int().nonnegative() })),
  offered: z.record(z.string(), z.object({ confirmed: z.boolean() })),
});
export type WeixinState = z.infer<typeof stateSchema>;
export type WeixinAuth = z.infer<typeof authSchema>;
export const emptyState = (): WeixinState => ({ version: 1, cursor: '', deliveries: {}, offered: {} });

export class WeixinStore {
  constructor(readonly directory: string) {}
  async load(): Promise<WeixinState> {
    try { return stateSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw new Error('微信本地状态无法读取，已停止连接；请检查状态文件或重新登录。');
    }
  }
  async save(state: WeixinState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'state.json');
    const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(stateSchema.parse(state)), { mode: 0o600 });
    await rename(temporary, file);
  }
  /** 同一状态目录只允许一个登录/收消息进程；进程崩溃后的旧锁可回收。 */
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'worker.lock');
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(owner); } finally { await handle.close(); }
        return async () => { if (await readFile(file, 'utf8').catch(() => '') === owner) await unlink(file); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = await readFile(file, 'utf8');
        let pid: number;
        try { pid = (JSON.parse(previous) as { pid: number }).pid; } catch { throw new Error('微信锁文件损坏，请检查本地状态目录。'); }
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('微信锁文件无效。');
        try { process.kill(pid, 0); throw new Error('微信连接已在运行，请先停止原进程。'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
        if (await readFile(file, 'utf8').catch(() => '') === previous) await unlink(file);
      }
    }
    throw new Error('无法取得微信连接锁。');
  }
}
