import { AppError } from './errors';
import { demoNow } from './clock';

export interface RequestedExecutionTime {
  sourceText: string;
  local: string;
  epoch: number;
}

/** Extract explicit times without assigning them to a business operation. */
export function requestedExecutionTimes(request: string): RequestedExecutionTime[] {
  return [...request.matchAll(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?\s*(?:的)?\s*(上午|下午|晚上|早上)?\s*(\d{1,2})(?:点|:|：)(?:(\d{1,2})分?)?/g)]
    .map(match => {
      let hour = Number(match[5]);
      if (/(?:下午|晚上)/.test(match[4] ?? '') && hour < 12) hour += 12;
      const local = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${(match[6] ?? '00').padStart(2, '0')}:00`;
      return { sourceText: match[0], local, epoch: Date.parse(`${local}+08:00`) };
    });
}

/** Explicit civil time in the demo's Asia/Shanghai zone, never inferred by the model's epoch math. */
export function scheduledTime(args: Record<string, unknown>, request = ''): number {
  const matches = requestedExecutionTimes(request);
  const local = typeof args.runAtLocal === 'string' ? args.runAtLocal : undefined;
  const normalizedLocal = local?.length === 16 ? `${local}:00` : local;
  const selected = matches.length > 1 ? matches.filter(time => normalizedLocal
    ? time.local === normalizedLocal : time.epoch === Number(args.runAt)) : matches;
  if (selected.length > 1 || (matches.length > 1 && selected.length !== 1)) {
    throw new AppError('VALIDATION', 'Each scheduled operation must select exactly one requested execution time.');
  }
  const match = selected[0];
  let epoch: number;
  let civilTime: string | undefined;
  if (match) {
    civilTime = match.local;
    epoch = match.epoch;
  } else if (local) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) throw new AppError('VALIDATION', '执行时间格式应为 YYYY-MM-DDTHH:mm（北京时间）。');
    epoch = Date.parse(`${local}+08:00`);
    civilTime = local.length === 16 ? `${local}:00` : local;
  } else epoch = Number(args.runAt);
  if (!Number.isFinite(epoch) || epoch <= demoNow()) throw new AppError('VALIDATION', '执行时间无效或已经过去，请指定未来的北京时间。');
  if (civilTime && new Date(epoch + 8 * 3600000).toISOString().slice(0, 19) !== civilTime) throw new AppError('VALIDATION', '执行日期不存在或时间越界。');
  return epoch;
}
