# agent/providers/mock — deterministic offline model script

## Intent

Pure, offline scripted decision layer that drives the mock provider. `respond` / `respondWithGuidance` (in `../mock-responder.ts`) classify the last user message into tool proposals; the real Agent, tools and security gateway run unchanged. `classify` (classifier.ts) dispatches direct action matchers before broad read intents and never authorizes writes. Every module must stay free of database, banking-SDK, filesystem, network, `Date.now()` and `Math.random()`; tool-call ids are explicit.

## No card-consumption capability

The mock has NO card-consumption / card-spend / card-purchase / card-payment / card-debit intent, helper, type, function, tool or scenario anywhere in this directory.
The only card tool calls the mock can ever emit are the catalog card set: `get_cards` (read), `set_card_limit`, `freeze_card`, `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`.
`card-intents.ts` matches only virtual-card application, category-limit adjustment and freeze (incl. bulk-freeze plans); it contains no pay/consume/charge matcher.
`analyze_spending` (classifier.ts:73), `detect_anomaly` (classifier.ts:71) and `get_transactions` (classifier.ts:72) are READ-only analysis of already-booked transactions, never a spend.
`set_card_limit` is a WRITE that only configures a per-category limit; it does not deduct money.
"The spending" wording elsewhere — routing subjects (`conversation-policy.ts`), narration leads (`narration.ts`), reply prose (`replies.ts`) and message catalogs — is presentation only.
`付款账户` (classifier.ts:40) and the `fundingAccount` message explain transfer funding, not card payment.
`subscribe_investment` (investment purchase) and `transfer_money` are RED/YELLOW writes that move account cash, but neither is card-based consumption.

## Handler map

- `card-intents.ts`, `investment-intents.ts`, `subscription-intents.ts`, `transfer-intents.ts`, `plan-intents.ts`: family classifiers producing tool proposals.
- `request-command-patterns.ts` / `request-steps.ts`: bounded explicit-command parsing; never proof of authorization.
- `resource-resolution.ts`: binds real card/product/holding/subscription IDs from registered read results before any write.
- `turn-declaration.ts`: emits the `describe_turn` control call; `declaration` result is interpretation, never authorization.
- `conversation-guidance.ts`, `conversation-policy.ts`, `advisory-policy.ts`, `discussion.ts`: presentation/purpose selection only.
- `narration.ts`, `replies.ts`, `messages.zh-CN.json`, `sequence-messages.zh-CN.json`: server-authored reply text.
- `amount-parser.ts`, `request-amounts.ts`, `request-conditions.ts`, `names.ts`, `history.ts`, `compaction.ts`, `invalid-amount-response.ts`, `conversation.ts`, `action-follow-up.ts`: pure helpers.

## Tests

`conversation-guidance.test.ts` and `investment-intents.test.ts` cover the closed guidance vocabulary and partial redemption; root Vitest discovers them via `pnpm test`.

## See Also

`../CONTEXT.md` (provider wiring, live/mock policy) and `../../CONTEXT.md` (agent runtime contracts).
