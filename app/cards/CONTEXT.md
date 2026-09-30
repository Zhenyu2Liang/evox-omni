# cards — Cards Page (`/cards`)

## Intent

The **cards screen**: the user's debit / credit / virtual cards with their limits and status —
the surface for the money-adjacent card tools (`set_card_limit`, `freeze_card`, `unfreeze_card`,
`report_lost_card`, `apply_virtual_card`) after the agent / confirmation flow.

This node is a **thin Server Component** — it fetches the card read model directly on the server
(no HTTP hop) and composes the UI from `../components`.

## API Surface

- **Page route**: `/cards` — `page.tsx`, default-exported Server Component.
- **Read model** (server-only, via `@/banking-sdk`):
  - `banking.card.getCards(userId)` → `CardView[]`
    (type 储蓄卡/信用卡/虚拟卡 · numberMasked · status · creditLimit / availableLimit · monthlyLimit ·
    per-category limits)
  - User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
- **Composes** (from `../components` — referenced by name only): `CardTile` (储蓄卡 / 信用卡 / 虚拟卡),
  credit-limit display, status badges, and the freeze / unfreeze / set-limit actions.

## Constraints

- **Server Component**; render chrome + `TODO: wire read model` comments — no UI logic.
- **Mutating actions are never performed here** — permission/confirmation/MFA decisions live in
  `../security` and are enforced through the agent's gated tools; the client calls the API instead.
- Pass only **serializable** props to client components (no `Date` — epoch ms; money is CNY `number`).
- **Read via `@/banking-sdk` only** — never import Prisma directly.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/banking-sdk` (sibling — read-only): `banking.card.getCards`; DTOs `CardView`, `CardStatus`, `CardType`.
- `@/lib/config` (sibling — read-only): `getConfig` (demo user resolution).
- `../components` (sibling — read-only): the card tiles / badges / action controls the page composes.
- `../api` (sibling — read-only): `GET /api/cards` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/cards` page (card tiles, limits, statuses, actions)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/cards` refresh endpoint (sibling — read-only)
