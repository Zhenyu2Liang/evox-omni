import { randomUUID } from 'node:crypto';
import { prisma } from '../client';
import { AppError } from '@/lib/errors';

export const getReportAnalysis = (id: string, userId: string) => prisma.billReportAnalysis.findFirst({ where: { id, userId } });

/** A short, fenced lease prevents duplicate paid requests across tabs and server processes. */
export async function claimReportAnalysis(id: string, userId: string, snapshot: string) {
  const attemptId = randomUUID(), now = new Date(), leaseExpiresAt = new Date(now.getTime() + 60000);
  try {
    await prisma.billReportAnalysis.create({ data: { id, userId, snapshot, attemptId, leaseExpiresAt, status: 'running' } });
    return attemptId;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
    const claimed = await prisma.billReportAnalysis.updateMany({
      where: { id, userId, OR: [{ status: 'failed' }, { status: 'running', leaseExpiresAt: { lt: now } }] },
      data: { attemptId, status: 'running', leaseExpiresAt, budgetJson: null, contentJson: null, httpStatus: null },
    });
    return claimed.count === 1 ? attemptId : null;
  }
}

export async function updateReportAnalysis(id: string, userId: string, attemptId: string,
  data: { budgetJson?: string; contentJson?: string; status?: 'completed' | 'failed'; httpStatus?: number }) {
  const result = await prisma.billReportAnalysis.updateMany({ where: { id, userId, attemptId, status: 'running', leaseExpiresAt: { gt: new Date() } }, data });
  if (result.count !== 1) throw new AppError('CONFLICT', 'Report analysis changed. Retry from the current report.');
}
