# Card detail & virtual-card consumption API

## Responsibility

`consume/route.ts` delegates proposals and verification to `security/card-consumption.ts`.
The original arguments, action identity, challenge consumption, account lock and receipt remain
server-owned. Category caps use monthly family spending, including predecessor cards after replacement.

HTTP edge for a single card (`:id`). Each handler validates input, resolves the fixed demo
workspace server-side, delegates to the banking SDK and serializes the frozen envelope. Ownership
and domain rules stay INSIDE the SDK (`banking.card.*`): unknown/foreign card → `NOT_FOUND`,
unbound/inactive card or a non-CHECKING bound account → `CONFLICT`, over monthly limit →
`LIMIT_EXCEEDED`, insufficient balance → `INSUFFICIENT_FUNDS`, bad amount/precision → `VALIDATION`.

Identity is always server-side (`_lib/session#resolveUserId`); a client can never name the user or
spend another user's card. All shared plumbing comes from `_lib` (`http`, `session`, `types`,
`schemas`) — no parallel helpers live here.

## Routes

| Route | Handler | Contract |
| --- | --- | --- |
| `DELETE /api/cards/[id]` | `route.ts` | Manual demo-card deletion proposal (`security/manual-card-management#proposeCardChange`); MFA verify/cancel live under `/api/cards/changes/[id]/{verify,cancel}` (see `../CONTEXT.md`). |
| `POST /api/cards/[id]/consume` | `consume/route.ts` | `{ amount, category?, merchant?, executionKey? }` creates a RED proposal without a debit. Resubmit identical parameters plus `actionId`, `confirmed:true` and `code` to verify and execute. Returns `CardConsumptionResponse`; `result` contains the committed `ConsumeCardResult` only after execution. An `occurredAt` key is rejected with `400 VALIDATION`. |
| `GET /api/cards/[id]/consumptions` | `consumptions/route.ts` | Optional `?limit=` (1–500, shared `limitQuerySchema`) → `{ ok:true, data: { consumptions: CardConsumptionView[] } }`. |

## Routing Table

- `./consume/` — RED proposal and verification through `security/card-consumption`, the shared gateway and execution fence. The SDK checks monthly and category limits in its debit transaction; retries reuse the persisted action and verified receipt. Page execution does not request model narration.
- `./consumptions/` — GET a card's consumption ledger, newest first (SDK default 20, hard cap 200).
- `route.ts` — DELETE manual demo-card proposal (no subdirectory).

## Constraints

- Route modules export ONLY HTTP handlers, route config and TypeScript types; the consume body schema stays module-private.
- Next.js dynamic params are awaited (`(await ctx.params).id`) via `_lib/types#IdRouteContext`; `_lib` imports are `../../../_lib/...` from the child route folders.
- The client can never supply `userId` or another user's card id.
