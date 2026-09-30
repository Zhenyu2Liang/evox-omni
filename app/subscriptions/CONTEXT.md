# subscriptions — Subscriptions Page (`/subscriptions`)

## Intent

The **subscriptions screen**: the user's recurring subscriptions (name, fee, cycle, next charge),
an annualised-cost summary, and the reminder-toggle / cancel surface for the
`set_subscription_reminder` / `cancel_subscription` tools.

This node is a **thin Server Component** — it fetches the subscription read model directly on the
server (no HTTP hop) and composes the UI from `../components`.

## API Surface

- **Page route**: `/subscriptions` — `page.tsx`, default-exported Server Component.
- **Read model** (server-only, via `@/banking-sdk`):
  - `banking.subscription.listSubscriptions(userId)` → `SubscriptionView[]`
    (name · amount · cycle · nextChargeAt · status · remind)
  - User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
- **Composes** (from `../components` — referenced by name only): subscription list (name / monthly
  fee / next charge), annual-cost summary, and the reminder-toggle / cancel actions.

## Constraints

- **Server Component**; render chrome + `TODO: wire read model` comments — no UI logic.
- **Mutating actions are never performed here** — tier policy (YELLOW confirm) lives in `../security`
  and is enforced through the agent's gated tools; the client calls the API instead.
- Pass only **serializable** props to client components (no `Date` — epoch ms; money is CNY `number`).
- **Read via `@/banking-sdk` only** — never import Prisma directly.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/banking-sdk` (sibling — read-only): `banking.subscription.listSubscriptions`; DTOs
  `SubscriptionView`, `SubscriptionCycle`, `SubscriptionStatus`.
- `@/lib/config` (sibling — read-only): `getConfig` (demo user resolution).
- `../components` (sibling — read-only): the subscription list / summary / action controls.
- `../api` (sibling — read-only): `GET /api/subscriptions` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/subscriptions` page (list, annual cost, actions)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/subscriptions` refresh endpoint (sibling — read-only)
