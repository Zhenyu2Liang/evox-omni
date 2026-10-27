import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { requireIdentity } from '../../../_lib/session';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import type { IdRouteContext } from '../../../_lib/types';

/** The issuance receipt reveals an owned new card to its verified customer, never to a model tool. */
export async function GET(request: NextRequest, context: IdRouteContext): Promise<Response> {
  try {
    const identity = await requireIdentity(request);
    const action = await prisma.pendingAction.findUnique({ where: { id: (await context.params).id }, include: { mfa: true } });
    if (!action) throw new AppError('NOT_FOUND', '未找到发卡操作。');
    if (action.userId !== identity.userId || action.sessionId !== identity.sessionId) throw new AppError('SECURITY_DENIED', '无权查看该发卡凭证。');
    if (!['replace_card', 'apply_virtual_card'].includes(action.toolName) || action.status !== 'executed' ||
        !action.requiresMfa || !action.mfa?.verifiedAt || !action.mfa.consumedAt) {
      throw new AppError('SECURITY_DENIED', '仅已完成本人验证的成功发卡操作可查看新卡号。');
    }
    const result = safeParse<{ ok?: boolean; data?: { id?: unknown } } | null>(action.resultJson, null);
    const cardId = result?.ok === true && typeof result.data?.id === 'string' ? result.data.id : undefined;
    if (!cardId) throw new AppError('CONFLICT', '发卡结果暂不可读取，请核对操作记录。');
    const card = await prisma.card.findFirst({ where: { id: cardId, userId: identity.userId }, select: { id: true, numberFull: true, numberMasked: true } });
    if (!card?.numberFull) throw new AppError('NOT_FOUND', '新卡完整卡号尚未记录。');
    const response = jsonResponse({ cardId: card.id, cardNumber: card.numberFull, numberMasked: card.numberMasked });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
