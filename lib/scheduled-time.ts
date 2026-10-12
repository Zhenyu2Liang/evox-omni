import { AppError } from './errors';
import { demoNow } from './clock';

/** Explicit civil time in the demo's Asia/Shanghai zone, never inferred by the model's epoch math. */
export function scheduledTime(args: Record<string, unknown>, request = ''): number {
  const matches = [...request.matchAll(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?\s*(?:的)?\s*(上午|下午|晚上|早上)?\s*(\d{1,2})(?:点|:|：)(?:(\d{1,2})分?)?/g)];
  if (matches.length > 1) throw new AppError('VALIDATION', '请求包含多个执行时间，请逐项明确要创建的任务与时间。');
  const match = matches[0];
  const local = typeof args.runAtLocal === 'string' ? args.runAtLocal : undefined;
  let epoch: number;
  let civilTime: string | undefined;
  if (match) {
    let hour = Number(match[5]);
    if (['下午', '晚上'].includes(match[4]) && hour < 12) hour += 12;
    civilTime = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${(match[6] ?? '00').padStart(2, '0')}:00`;
    epoch = Date.parse(`${civilTime}+08:00`);
  } else if (local) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) throw new AppError('VALIDATION', '执行时间格式应为 YYYY-MM-DDTHH:mm（北京时间）。');
    epoch = Date.parse(`${local}+08:00`);
    civilTime = local.length === 16 ? `${local}:00` : local;
  } else epoch = Number(args.runAt);
  if (!Number.isFinite(epoch) || epoch <= demoNow()) throw new AppError('VALIDATION', '执行时间无效或已经过去，请指定未来的北京时间。');
  if (civilTime && new Date(epoch + 8 * 3600000).toISOString().slice(0, 19) !== civilTime) throw new AppError('VALIDATION', '执行日期不存在或时间越界。');
  return epoch;
}
