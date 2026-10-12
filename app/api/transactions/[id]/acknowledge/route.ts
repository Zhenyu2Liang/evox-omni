import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { requireIdentity } from '../../../_lib/session';
import { errorResponse, jsonResponse } from '../../../_lib/http';

/** Records acknowledgement of one owned transaction; never changes money or its anomaly flag. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(req);
    const { id } = await context.params;
    const transaction = await prisma.transaction.findFirst({ where: { id, userId: identity.userId } });
    if (!transaction) throw new AppError('NOT_FOUND', '交易不存在');
    const dedupeKey = `ack:${identity.userId}:${id}`;
    await prisma.auditLog.upsert({ where: { dedupeKey }, update: {}, create: {
      dedupeKey, sessionId: identity.sessionId, userId: identity.userId,
      userRequest: '用户确认所选交易为本人交易', toolName: 'acknowledge_transaction',
      riskLevel: 'GREEN', status: 'success', confirmed: true, detail: id,
      toolResult: JSON.stringify({ transactionId: id, acknowledged: true }),
    } });
    return jsonResponse({ transactionId: id, acknowledged: true });
  } catch (error) { return errorResponse(error); }
}
