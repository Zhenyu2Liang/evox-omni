import { prisma } from '../client';
import { AppError } from '../../errors';

export async function assertNoOpenManualReview(taskId: string): Promise<void> {
  const review = await prisma.manualReview.findFirst({ where: { taskId, status: 'open' } });
  if (review) throw new AppError('CONFLICT', '任务已转人工处理，请先完成核对并记录处理结论。');
}
