import { AppError } from './errors';
import { demoNow } from './clock';

/** Parse an explicit civil time or epoch; user prose never changes a declared time. */
export function scheduledTime(args: Record<string, unknown>): number {
  const local = args.runAtLocal;
  let epoch: number;
  if (local !== undefined) {
    if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) {
      throw new AppError('VALIDATION', 'Execution time must use YYYY-MM-DDTHH:mm[:ss] in Asia/Shanghai.');
    }
    const civil = local.length === 16 ? local + ':00' : local;
    epoch = Date.parse(civil + '+08:00');
    if (!Number.isFinite(epoch) || new Date(epoch + 8 * 3600000).toISOString().slice(0, 19) !== civil) {
      throw new AppError('VALIDATION', 'The execution date does not exist or its time is out of range.');
    }
    if (args.runAt !== undefined && args.runAt !== epoch) {
      throw new AppError('VALIDATION', 'The execution epoch and local time disagree.');
    }
  } else {
    if (typeof args.runAt !== 'number' || !Number.isSafeInteger(args.runAt)) {
      throw new AppError('VALIDATION', 'An explicit integer execution epoch or local time is required.');
    }
    epoch = args.runAt;
  }
  if (!Number.isSafeInteger(epoch) || epoch <= demoNow() || epoch > 8640000000000000) {
    throw new AppError('VALIDATION', 'Execution time must be a valid future instant.');
  }
  return epoch;
}
