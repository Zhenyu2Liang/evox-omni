# tests/unit/banking-sdk — domain-invariant unit specs

## Intent

Prove the Banking SDK enforces its **domain invariants** (independent of the security policy): fund
sufficiency, product `minAmount`, recipient resolution & ambiguity, and legal state transitions.
These run against the test SQLite via `../../helpers/db` + `../../helpers/fixtures`.

## API Surface

Spec files (all `it.todo` scaffolds today), targeting `@/banking-sdk` (`banking.<domain>.*`):

- `transfer.test.ts` — `banking.transfer.createTransfer(input)`: funds invariant (¥200, 23580→23380),
  recipient resolution by `contactId`/`phone`/`name`, ambiguous name → `CONFLICT` (`detail.candidates`),
  unknown → `NOT_FOUND`, short funds → `INSUFFICIENT_FUNDS`, bad amount → `VALIDATION`.
- `subscription.test.ts` — `banking.subscription.listSubscriptions/cancelSubscription/setSubscriptionReminder`:
  ACTIVE→CANCELLED transition, reminder toggle, unknown id → `NOT_FOUND`.
- `investment.test.ts` — `banking.investment.listProducts/compareInvestments/listHoldings/subscribeInvestment/redeemInvestment`:
  `minAmount` enforcement, ¥5000 into 稳健理财A succeeds + debits, `NOT_FOUND`/`INSUFFICIENT_FUNDS`,
  HOLDING→REDEEMED, `highestRateId`/`lowestRiskId`.

## Constraints

- The SDK is **execute-only**: assert invariants here; permission/confirmation/MFA are NOT SDK concerns
  (they live in the gateway and are covered elsewhere).
- Use `useFreshDatabase()` / `resetDatabase()` so each case starts from the canonical fixtures.
- Assert thrown `AppError.code` (and `detail` where relevant), never a silent sentinel.
- Import DTO types from `@/banking-sdk` (view models) — Prisma model types must never appear.

## Routing Table

- `./transfer.test.ts` · `./subscription.test.ts` · `./investment.test.ts`
- `../../helpers` → test-DB lifecycle + fixtures (sibling — this node)
