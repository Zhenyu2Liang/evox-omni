# Security Center (`/security`)

## Intent

Display the fixed demo owner's permission tiers, persisted circuit breaker and security events.
The page reads authoritative server state; it never decides banking authorization.

## Controls

`ResetBreakerButton` is visible only when `useDeveloperMode().enabled` is true. It sends a body-less
`POST /api/developer/security/reset`. The route requires the explicit developer preference and
resolves the fixed demo identity itself. This is demo maintenance, not production authentication.

The developer reset needs no credential input. It clears the counter and lock, renews exhausted
challenges and strictly commits a `SECURITY_RESET` event in the same transaction. It never approves
or executes a pending banking action. Audit failure leaves the lock intact.

The separate verified reset domain API retains its verification/cooldown gate; it is not exposed
as a normal page control. The model has no tool that can invoke either reset path.
A reset never reopens an already-locked operation: the gateway persists `PendingAction.status = 'locked'`
(`security/security-gateway.ts` `persistLockedAction`), and the unlock only renews challenges whose action
is still `awaiting_mfa` (`lib/db/repositories/pendingAction.ts` `renewLockedMfaChallenges`, 362-378).
The locked card therefore stays terminal and the user must start a new request.

## Dependencies

- `@/audit`: security event read models.
- `@/security`: authoritative owner-scoped breaker state and reset service.
- `@/app/api/_lib/session`: fixed demo identity.
- `@/lib/developer-mode`: opt-in demo maintenance preference.
- `@/lib/i18n`: bilingual labels, Chinese by default.
- `@/components/security`: presentational legend, breaker and event list.

## Verification

`tests/app/developer-security-http.test.ts` checks the mode gate, strict audit rollback and absence
of banking side effects. Browser journey `j-circuit-breaker-lock` checks normal visibility, three
failed payment challenges, persisted lock state and the single developer reset button.
