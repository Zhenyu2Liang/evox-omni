# agent/providers/mock — deterministic offline model script

## Intent

`turn-declaration.ts` emits explicit `needsInput:false` for ready scripted requests. This fixture
choice does not change the production `describe_turn` default for omitted readiness. Missing-choice
tests must explicitly set `needsInput:true` or send a raw declaration that omits it.

Pure, offline scripted decision layer that drives the mock provider. `respond` / `respondWithGuidance` (in `../mock-responder.ts`) classify the last user message into tool proposals; the real Agent, tools and security gateway run unchanged. `classify` (classifier.ts) dispatches direct action matchers before broad read intents and never authorizes writes. Every module must stay free of database, banking-SDK, filesystem, network, `Date.now()` and `Math.random()`; tool-call ids are explicit.

## No card-consumption capability

The mock has NO card-consumption / card-spend / card-purchase / card-payment / card-debit intent, helper, type, function, tool or scenario anywhere in this directory.
The only card tool calls the mock can ever emit are `get_cards` (read), `set_card_limit`, `freeze_card` and `apply_virtual_card`.
`unfreeze_card`, `report_lost_card` and `replace_card` have reply labels (`replies.ts:32-33`, `narration.ts:55-56,69`), a `REQUEST_COMMANDS` entry (`request-command-patterns.ts:12-13`) and resource binding (`resource-resolution.ts:13`), but no classifier emits them: `classifyCardAction` ends at `freeze_card`, 补办/挂失 requests fall through to `get_cards`, the plain conversation reply or `help` (`classifier.ts:76,46,85`), and a multi-step sequence containing them aborts with `missingDetails` (`plan-intents.ts:104-106`).
`card_management_required` is produced only by `conversation-guidance.ts:33-35` (issuance/removal verb + card noun incl. 实体; 虚拟 is deliberately excluded at `conversation-guidance.ts:27-28`), EXCEPT when `cardReissue` (`conversation-guidance.ts:29-35`) is true: a card word plus 补办/补卡/补发/补领, or replace/reissue/replacement card, never yields that code because 补办 of an already-lost card is an agent capability (`replace_card`).
`请为刚挂失的尾号6688信用卡补办新卡。` then reaches the read intents (`get_cards`, `classifier.ts:76`).
`办理一张信用卡补办` is answered from the plain conversation branch (`classifier.ts:46`).
`classifier.ts:24-26` renders the closed page-only template before any tool proposal, and `card-intents.ts:53-55` repeats the same code on a path `classify` never reaches.
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

## Notes

- The `name` of every plan node emitted by `plan-intents.ts` is a user-facing Chinese display label rendered verbatim through `localizeToolLabel` (e.g. `查询消费情况`, `查询账户余额`, `判断是否超过阈值`, `发送提醒`, `汇总结果`, `执行计划`, `调整「…」消费限额`). These names must not be English literals: an unknown label matches neither `chat.tool.<name>` nor display-sources `tools`, so it passes through unchanged and renders without word spacing.

## Tests

`conversation-guidance.test.ts` covers the closed guidance vocabulary and reissue routing: page-only replies stay green for brand-new issuance/deletion (incl. the English list), virtual-card application is not page-only, and 补办/补卡/replace of an already-lost card (e.g. 请为刚挂失的尾号6688信用卡补办新卡。, 办理一张信用卡补办, Replace my lost credit card) is never `card_management_required`; `investment-intents.test.ts` covers partial redemption; `plan-node-label.test.ts` asserts each `analyze_spending` plan node label localizes through the real `localizeToolLabel`. Root Vitest discovers them via `pnpm test`.

## See Also

`../CONTEXT.md` (provider wiring, live/mock policy) and `../../CONTEXT.md` (agent runtime contracts).
