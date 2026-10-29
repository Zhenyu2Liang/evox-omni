/**
 * GET /api/cards — cards read model (used by the client to refresh the `/cards` page).
 *
 * Contract:
 *  - NO query params (a `?userId=`/`?sessionId=` param is IGNORED — identity is never query-trusted).
 *  - The user is the single seeded demo user, resolved SERVER-SIDE from runtime config only
 *    (`_lib/session#resolveUserId`) — the NON-AUTHORITATIVE demo-read user for this simulated-data
 *    read. It is never used for any auth/ownership decision.
 *  - Delegates to `@/banking-sdk`: `banking.card.getCards(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: { cards: CardView[] } }`.
 *
 * POST creates a manual-only simulated card proposal; dedicated verification commits it.
 * Card status and category limits remain separate security-gated agent operations.
 */
import type { NextRequest } from 'next/server';
import { banking, type CardView, type AccountView } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseBody } from '../_lib/http';
import { resolveUserId, requireIdentity } from '../_lib/session';
import { addDemoCardSchema, proposeCardChange } from '@/security/manual-card-management';

/** Success payload shape for `GET /api/cards`. */
export interface CardsData {
  cards: CardView[];
  accounts: AccountView[];
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const input = await parseBody(addDemoCardSchema, req);
    return jsonResponse(await proposeCardChange(await requireIdentity(req), input));
  } catch (error) { return errorResponse(error); }
}

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const userId = resolveUserId();
    const data: CardsData = await banking.card.getCardPage(userId);
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}
