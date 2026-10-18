# Presentation message catalogs

## Intent

Server-authored user-facing text for the agent runtime. The model never supplies this wording: it can only name a code from a closed vocabulary, and the server prints the template below verbatim.

## API Surface

- `conversation.zh-CN.json`: the conversation-guidance vocabulary. `guidance-messages.ts` derives `ConversationGuidanceCode` as every key except `unverified`/`unavailable`, so `isConversationGuidanceCode` + `renderConversationGuidance` accept and print exactly these keys.
- `banking-guidance.ts` additionally maps `capabilities` from this file and validates model-emitted `{ "guidance": { "code": ..., "fields": [...] } }` envelopes; only `code` and `fields` travel.
- `dialogue.zh-CN.json`: dialogue fallbacks — empty reply, format failure, generation failure, and the per-domain invalid-amount replies (`invalidAmount.transfer/purchase/redemption/budget/limit/generic`, `{amount}` placeholder).

## Constraints

- Keys are a public contract. Code and the e2e helpers (`tests/e2e/card-management.e2e-helper.ts`, `tests/e2e/shared-demo.e2e-helper.ts`) import them by name; `ConversationGuidanceCode` is derived from the key set. Adding, removing or renaming a key changes the accepted vocabulary — do not do it for a wording fix.
- Text is rendered as-is to the user. It must be customer-facing zh-CN, short, and must never promise a specific panel, button or success state.
- A rendered guidance envelope is FINAL: `agent/write-continuation.ts` returns early on a guidance envelope, so a false statement here can never be self-corrected inside the turn.
- Therefore capability claims here must match server truth (`lib/contracts/tool-catalog.ts`, `agent/tools/`): the assistant CAN `apply_virtual_card`, and CAN `replace_card` (补办) an already-`LOST` card of any type, both RED writes needing confirmation and strong verification. Only brand-new physical card creation and card deletion are manual-only on the「卡片」page, which has no 补办 action.
- Only this zh-CN catalog set exists; there is no English twin for these templates. `lib/i18n/messages/*` is a separate presentation vocabulary (labels, tool names) and is not the source of these sentences.
- Keep the files valid JSON with the same key set; they are imported directly by TypeScript modules.

## Notes for Agents

`conversation.zh-CN.json` `card_management_required` fires from `agent/providers/mock/conversation-guidance.ts` on an issuance/removal verb plus a card noun, which is also why its wording is limited to card creation and deletion rather than describing assistant limits. There is no routing table below this directory: both files are single-file catalogs, and consumers live in `../` (`guidance-messages.ts`, `banking-guidance.ts`, `turns/buffer.ts`, `financial-response.ts`, `conversational-response.ts`, `providers/mock/`).
