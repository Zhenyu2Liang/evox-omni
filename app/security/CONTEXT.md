# security — Security Center Page (`/security`)

## Intent

The **security centre screen**: the visible face of the code-enforced permission model — the
🟢/🟡/🔴 tier legend, the session's recent verifications, the circuit-breaker status, and the
`SecurityEvent` stream (injection attempts, MFA failures, breaker trips, blocked high-risk ops).
It also hosts the ONLY runtime unlock path for a tripped breaker (the client `ResetBreakerButton`).
It demonstrates that permission is decided by `../security`, not by the model.

This node is a **thin Server Component** (`page.tsx`) — it fetches the security read models directly
on the server (no HTTP hop) and composes the UI from `../components` plus the local client control.

## API Surface

- **Page route**: `/security` — `page.tsx`, default-exported Server Component (reads the request
  cookie + live Prisma data, so it is `export const dynamic = 'force-dynamic'`).
- **Read models** (server-only, via `@/audit`):
  - `audit.getSecurityStatus(sessionId)` → `SecurityStatus` (`{ locked, recentEvents }`)
  - `audit.listSecurityEvents({ sessionId })` → `SecurityEvent[]`
  - Session id: the `banking_session` cookie (`SESSION_COOKIE`).
- **Composes** (from `../components` — referenced by name only): the `RISK_LABEL` legend
  (🟢/🟡/🔴), recent verifications, circuit-breaker status, and the `SecurityEvents` table.
- **Local client control** `./ResetBreakerButton.tsx` (`'use client'`): the GATED breaker unlock.
  It POSTs `{ verificationCode }` to `POST /api/security/reset` (envelope `{ ok, data }` / `{ ok, error }`).
  **The 6-digit code input starts EMPTY and is NEVER prefilled or revealed** — unlocking is an ACTIVE
  user action; the empty case is blocked in the UI (button disabled + guard) and the correct mock code
  is never shown. While the account is locked a correct mock code is REQUIRED server-side, otherwise the
  route refuses with HTTP `423 CIRCUIT_OPEN` and that refusal message is surfaced verbatim (safe text,
  never the code). Keep the input's `aria-label="6 位验证码"` — an e2e selector keys on it.

## Constraints

- **Server Component** (`page.tsx`); it only displays read models — no security logic here.
  The circuit-breaker lock state is authoritative in `../security`; this page only displays it.
- Pass only **serializable** props to client components (no `Date` — epoch ms).
- **Read via `@/audit` only** — never import Prisma directly, never import `../security` internals.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- `ResetBreakerButton.tsx` is a client component: it may import only React/`next/navigation` and talk to
  `/api/*` — **no Prisma / no server-only imports**, and all error text must be safe user-facing copy.
- Status renders via `RISK_LABEL` from `@/lib/constants` (🟢/🟡/🔴).
- Keep `page.tsx` ≲ ~120 lines.

## Dependencies

- `@/audit` (sibling — read-only): `getSecurityStatus`, `listSecurityEvents`; types `SecurityStatus`.
- `@/lib/contracts/audit` (sibling — read-only): `SecurityEvent`, `SecurityEventKind`.
- `@/lib/contracts/risk` + `@/lib/constants` (sibling — read-only): `RiskLevel`, `RISK_LABEL`, `SESSION_COOKIE`, `MFA_MAX_ATTEMPTS`.
- `next/headers` — read the `banking_session` cookie for the session id.
- `../components` (sibling — read-only): legend, verification list, breaker status, events table.
- `../api` (sibling — read-only): `GET /api/security` (client refresh) + `POST /api/security/reset` (unlock).

## Routing Table

- `./page.tsx` → the `/security` page (legend, verifications, breaker, security events)
- `./ResetBreakerButton.tsx` → the GATED breaker-unlock client control (active code entry; never prefilled)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/security` refresh + `POST /api/security/reset` unlock (sibling — read-only)
