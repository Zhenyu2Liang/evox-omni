# cards — Cards Page (`/cards`)

## Intent

The cards screen displays the fixed demo user's debit, credit and virtual card records.
The user adds or deletes simulated records directly on this page. The banking agent cannot
create or delete cards. Existing supported card controls remain independently gated agent tools.

The server page fetches the initial read model. `CardManager` restores persisted manual proposals
and refreshes card records over HTTP. `CardChangeDialog` handles proposal review, explicit
confirmation, verification, cancellation and keyboard focus in a native modal.

## API Surface

- **Page route**: `/cards` — `page.tsx`, default-exported Server Component.
- **Read model** (server-only, via `@/banking-sdk`):
  - `banking.card.getCards(userId)` → `CardView[]`
    (type DEBIT / CREDIT / VIRTUAL · numberMasked · status · creditLimit / availableLimit · monthlyLimit ·
    per-category limits)
  - User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
- `CardTile` renders status and exact limits; its optional footer holds a manual delete button.
- `GET /api/cards` refreshes the read model.
- `GET /api/cards/changes` restores unfinished manual proposals.
- `POST /api/cards` proposes a new simulated card. `DELETE /api/cards/[id]` proposes deletion.
- `POST /api/cards/changes/[id]/verify` confirms the immutable proposal and verifies a code.
- `POST /api/cards/changes/[id]/cancel` cancels an unexecuted proposal.

## Constraints

- Add and delete require RED verification, enforced server-side by `security/manual-card-management.ts`.
- These are simulated record changes, not real card issuance or account closure. Accept no real PAN,
  payment credentials or passwords. Card numbers are generated and masked server-side.
- Keep pending manual proposals out of agent conversation recovery and tool execution.
- Pass only serializable DTOs. Financial amounts are exact decimal strings; never convert money to `number`.
- Preserve the proposal request ID on network retries. Verify and cancel use the persisted proposal ID.
- Render only the latest refresh response. Busy operations block repeat mutations and modal closure.
- Closing a modal preserves a persisted proposal; cancellation explicitly calls the cancellation API.
- **Read via `@/banking-sdk` only** — never import Prisma directly.
- Never bypass server ownership, conflict checks, transaction fences, MFA or strict audit recording.

## Dependencies

- `@/banking-sdk` (sibling — read-only): `banking.card.getCards`; DTOs `CardView`, `CardStatus`, `CardType`.
- `@/lib/config` (sibling — read-only): `getConfig` (demo user resolution).
- `../components`: card tiles, exact money formatting, buttons and risk badges.
- `lib/contracts/card-management.ts`: manual proposal DTOs.
- `lib/i18n`: Chinese and English page messages.
- `../api`: fixed-owner manual card management endpoints.

## Routing Table

- `./page.tsx` → initial fixed-user read model.
- `./CardManager.tsx` → proposal persistence, HTTP operations and read-model refresh.
- `./CardChangeDialog.tsx` → reviewed add/delete flow and MFA modal.
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/cards/` → manual proposal and read-model endpoints.
