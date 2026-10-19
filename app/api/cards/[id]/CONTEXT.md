# Card detail & virtual-card consumption API

## Responsibility

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
| `POST /api/cards/[id]/consume` | `consume/route.ts` | Body `{ amount (exact CNY decimal string), category?, merchant?, executionKey? }` → `{ ok:true, data: ConsumeCardResult }`. Booking time is SERVER-OWNED: a body containing an `occurredAt` key is rejected with `400 VALIDATION` (never stripped), before any delegation. |
| `GET /api/cards/[id]/consumptions` | `consumptions/route.ts` | Optional `?limit=` (1–500, shared `limitQuerySchema`) → `{ ok:true, data: { consumptions: CardConsumptionView[] } }`. |

## Routing Table

- `./consume/` — POST virtual-card consumption: SDK-atomic debit of the bound CHECKING account plus a `channel='CARD'` ledger row and a `CardConsumption` row in one transaction, monthly-limit guarded and idempotent on `executionKey`.
- `./consumptions/` — GET a card's consumption ledger, newest first (SDK default 20, hard cap 200).
- `route.ts` — DELETE manual demo-card proposal (no subdirectory).

## Constraints

- Route modules export ONLY HTTP handlers, route config and TypeScript types; the consume body schema stays module-private.
- Next.js dynamic params are awaited (`(await ctx.params).id`) via `_lib/types#IdRouteContext`; `_lib` imports are `../../../_lib/...` from the child route folders.
- The client can never supply `userId` or another user's card id.
