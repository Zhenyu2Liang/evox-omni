# Live Acceptance Report — Scenario `lC` (虚拟卡绑定活期账户 / live virtual-card consumption)

Real headless Chrome + real DeepSeek model, 3 independent process invocations (one OS process per round).

- Overall commit SHA (this report + all three rounds' screenshots): `1dcd1a95979c55056964d98810ba8dd5921228d3`
- Work branch: `evogit-agent-T4-A103`
- Unresolved items: none (see "Unresolved" at the end).

## Configuration (constant across all rounds)

| Item | Value |
| --- | --- |
| Harness | `tests/e2e/live-acceptance.e2e.ts` |
| Scenario | `lC` — `lC-live-virtual-card-consumption` (`scenarioVirtualCardConsume`) |
| Selection env var | `LIVE_SCENARIOS=lC` |
| Command | `$env:LIVE_SCENARIOS='lC'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts` |
| Model mode | provided `.env.local` unchanged (`LLM_MODE=live`, `LLM_PROVIDER=deepseek`) — no `LIVE_FORCE_MODEL` |
| Dev server | real `next dev` on a dynamic free port |
| Browser | real headless Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) |
| Isolated DB | `prisma/live-acceptance.db` (auto reset + `db push` ladder + probe + `tsx prisma/seed.ts` at the start of every run) |
| Seed baseline | `acct_checking` balance = 23,580.00 CNY (2,358,000 minor); `card_virtual` = ACTIVE VIRTUAL, monthly limit 5,000.00 CNY (500,000 minor), linked to `acct_checking` |

Screenshots are written by `captureLive(page, label)` to `output/playwright/live/<NN>-<label>.png`; the three lC labels are
`lC-consume-form`, `lC-consume-success`, `lC-card-tile` (NN = capture order within the run).

## Summary

| Round | Outcome | Exit code | Fresh screenshots | Notes |
| --- | --- | --- | --- | --- |
| 1 | **PASS** | 0 | `01-lC-consume-form.png`, `02-lC-consume-success.png`, `03-lC-card-tile.png` | no clarification / retry / timeout / nudge |
| 2 | **PASS** | 0 | same three fresh names | no clarification / retry / timeout / nudge |
| 3 | **PASS** | 0 | same three fresh names | no clarification / retry / timeout / nudge |

Across all three runs the summary line was identical: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` and each process exited `0`.
Every round produced exactly ONE new `channel=CARD`/`direction=DEBIT` ledger row and exactly ONE `CardConsumption`
(unique ids per run, see below), so the writes were genuinely repeated three times, not replayed.

---

## Round 1 — **PASS** (exit code 0)

Verbatim scenario line:

```
PASS lC-live-virtual-card-consumption — C1 实际发送：「我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？」 → 「那我这张虚拟卡当前最多可以支付多少钱？」 → 仍恰 1 张 VIRTUAL 卡（card_virtual，未被重复开通）；C2 前端消费弹窗（绑定 card_virtual，月限额 ¥5,000.00、关联账户 ****8821、消费前当前可支付金额 ¥5,000.00）提交 ¥88.00（购物/虚拟卡消费验证）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 -8800（cmvaw2x0y00nzmcf8vwa0a32d）、1 条 CardConsumption amountMinor=8800（cmvaw2x0z00o0mcf8mwgm3v3u）；活期余额 23580.00 → 23492.00（恰扣一次）；card_virtual.payableAmount 5000.00 → 4912.00 = min(可用余额 23492.00、剩余月限额 4912.00)；卡片「当前可支付金额」=¥4,912.00
```

Verbatim summary line:

```
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

Exit code: `0`. Clarifications / retries / timeouts / nudges: none.
Run banner: `next dev (pid=58676) → http://localhost:64839`, `/api/health={"ok":true,...,"llmMode":"live"}`.
Network 4xx/5xx: 0, console error: 0, pageerror: 0.

Screenshots produced (fresh, then copied round-tagged):

- `01-lC-consume-form.png` (81,786 B) → `lC-round1-consume-form.png`
- `02-lC-consume-success.png` (83,200 B) → `lC-round1-consume-success.png`
- `03-lC-card-tile.png` (66,623 B) → `lC-round1-card-tile.png`

Independent SQLite cross-check of `prisma/live-acceptance.db` (throwaway Prisma client, run after the round and before the next round's reset):

| Check | Observed |
| --- | --- |
| `acct_checking.balanceMinor` | `2349200` (CNY 23492.00) = 2,358,000 − 8,800 → reduced **exactly once** |
| New `Transaction` channel=CARD / direction=DEBIT | exactly **1**: `cmvaw2x0y00nzmcf8vwa0a32d`, `amountMinor=-8800`, category `购物`, merchant `虚拟卡消费验证` |
| `Transaction` merchant = 虚拟卡消费验证 | exactly **1** (no duplicate charge) |
| `CardConsumption` for `card_virtual` | exactly **1**: `cmvaw2x0z00o0mcf8mwgm3v3u`, cardId `card_virtual`, accountId `acct_checking`, `amountMinor=8800`, category `购物`, merchant `虚拟卡消费验证` |
| `card_virtual` | ACTIVE / VIRTUAL, `monthlyLimitMinor=500000`, `linkedAccountId=acct_checking` |
| `card_virtual.payableAmount` (API) | `4912.00` = min(available cash 23492.00, remaining limit 5000.00−88.00=4912.00) |
| Card rows | exactly **3** (`card_credit` CREDIT ACTIVE, `card_debit` DEBIT ACTIVE, `card_virtual` VIRTUAL ACTIVE) → no duplicate virtual card |

---

## Round 2 — **PASS** (exit code 0)

Verbatim scenario line:

```
PASS lC-live-virtual-card-consumption — C1 实际发送：「我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？」 → 「那我这张虚拟卡当前最多可以支付多少钱？」 → 仍恰 1 张 VIRTUAL 卡（card_virtual，未被重复开通）；C2 前端消费弹窗（绑定 card_virtual，月限额 ¥5,000.00、关联账户 ****8821、消费前当前可支付金额 ¥5,000.00）提交 ¥88.00（购物/虚拟卡消费验证）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 -8800（cmvaw7v4o00niv8f83vwzd64w）、1 条 CardConsumption amountMinor=8800（cmvaw7v4o00njv8f87fz93pmk）；活期余额 23580.00 → 23492.00（恰扣一次）；card_virtual.payableAmount 5000.00 → 4912.00 = min(可用余额 23492.00、剩余月限额 4912.00)；卡片「当前可支付金额」=¥4,912.00
```

Verbatim summary line:

```
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

Exit code: `0`. Clarifications / retries / timeouts / nudges: none.
Run banner: `next dev (pid=14864) → http://localhost:52288`, `/api/health={"ok":true,...,"llmMode":"live"}`.
Network 4xx/5xx: 0, console error: 0, pageerror: 0.

Screenshots produced (fresh, then copied round-tagged):

- `01-lC-consume-form.png` (81,786 B) → `lC-round2-consume-form.png`
- `02-lC-consume-success.png` (83,211 B) → `lC-round2-consume-success.png`
- `03-lC-card-tile.png` (66,790 B) → `lC-round2-card-tile.png`

Independent SQLite cross-check of `prisma/live-acceptance.db`:

| Check | Observed |
| --- | --- |
| `acct_checking.balanceMinor` | `2349200` (CNY 23492.00) = 2,358,000 − 8,800 → reduced **exactly once** |
| New `Transaction` channel=CARD / direction=DEBIT | exactly **1**: `cmvaw7v4o00niv8f83vwzd64w`, `amountMinor=-8800`, category `购物`, merchant `虚拟卡消费验证` |
| `Transaction` merchant = 虚拟卡消费验证 | exactly **1** (no duplicate charge) |
| `CardConsumption` for `card_virtual` | exactly **1**: `cmvaw7v4o00njv8f87fz93pmk`, cardId `card_virtual`, accountId `acct_checking`, `amountMinor=8800`, category `购物`, merchant `虚拟卡消费验证` |
| `card_virtual` | ACTIVE / VIRTUAL, `monthlyLimitMinor=500000`, `linkedAccountId=acct_checking` |
| `card_virtual.payableAmount` (API) | `4912.00` = min(available cash 23492.00, remaining limit 5000.00−88.00=4912.00) |
| Card rows | exactly **3** (`card_credit` CREDIT ACTIVE, `card_debit` DEBIT ACTIVE, `card_virtual` VIRTUAL ACTIVE) → no duplicate virtual card |

---

## Round 3 — **PASS** (exit code 0)

Verbatim scenario line:

```
PASS lC-live-virtual-card-consumption — C1 实际发送：「我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？」 → 「那我这张虚拟卡当前最多可以支付多少钱？」 → 仍恰 1 张 VIRTUAL 卡（card_virtual，未被重复开通）；C2 前端消费弹窗（绑定 card_virtual，月限额 ¥5,000.00、关联账户 ****8821、消费前当前可支付金额 ¥5,000.00）提交 ¥88.00（购物/虚拟卡消费验证）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 -8800（cmvaw9e4r00jy5gf8wg61aw61）、1 条 CardConsumption amountMinor=8800（cmvaw9e4s00jz5gf8l2zy6t9b）；活期余额 23580.00 → 23492.00（恰扣一次）；card_virtual.payableAmount 5000.00 → 4912.00 = min(可用余额 23492.00、剩余月限额 4912.00)；卡片「当前可支付金额」=¥4,912.00
```

Verbatim summary line:

```
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

Exit code: `0`. Clarifications / retries / timeouts / nudges: none.
Run banner: `next dev (pid=26696) → http://localhost:63371`, `/api/health={"ok":true,...,"llmMode":"live"}`.
Network 4xx/5xx: 0, console error: 0, pageerror: 0.

Screenshots produced (fresh, then copied round-tagged):

- `01-lC-consume-form.png` (81,786 B) → `lC-round3-consume-form.png`
- `02-lC-consume-success.png` (83,177 B) → `lC-round3-consume-success.png`
- `03-lC-card-tile.png` (66,623 B) → `lC-round3-card-tile.png`

Independent SQLite cross-check of `prisma/live-acceptance.db` (`checkingBalanceMinor=2349200`, `cardDebitCount_total=91`):

| Check | Observed |
| --- | --- |
| `acct_checking.balanceMinor` | `2349200` (CNY 23492.00) = 2,358,000 − 8,800 → reduced **exactly once** |
| `Transaction` merchant = 虚拟卡消费验证 | exactly **1**: `cmvaw9e4r00jy5gf8wg61aw61`, `amountMinor=-8800`, channel `CARD`, direction `DEBIT`, category `购物` |
| `CardConsumption` for `card_virtual` | exactly **1**: `cmvaw9e4s00jz5gf8l2zy6t9b`, cardId `card_virtual`, accountId `acct_checking`, `amountMinor=8800`, category `购物`, merchant `虚拟卡消费验证` |
| `card_virtual` | ACTIVE / VIRTUAL, `monthlyLimitMinor=500000`, `linkedAccountId=acct_checking` |
| `card_virtual.payableAmount` (API) | `4912.00` = min(available cash 23492.00, remaining limit 5000.00−88.00=4912.00) |
| Card rows | exactly **3** → no duplicate virtual card |

---

## Unresolved

None. All three rounds passed on the first attempt of each process with no clarification, retry, timeout, nudge or
fabricated-confirmation-panel failure. The `assertNoFabricatedConfirmationPanel` guard (applied inside `driveRedTool`)
never tripped: the model answered the two informational Chinese turns with prose only and never claimed a
confirmation/MFA panel, and it minted no second virtual card.

## Per-round screenshots (committed)

| Round | consume-form | consume-success | card-tile |
| --- | --- | --- | --- |
| 1 | `output/playwright/live/lC-round1-consume-form.png` | `output/playwright/live/lC-round1-consume-success.png` | `output/playwright/live/lC-round1-card-tile.png` |
| 2 | `output/playwright/live/lC-round2-consume-form.png` | `output/playwright/live/lC-round2-consume-success.png` | `output/playwright/live/lC-round2-card-tile.png` |
| 3 | `output/playwright/live/lC-round3-consume-form.png` | `output/playwright/live/lC-round3-consume-success.png` | `output/playwright/live/lC-round3-card-tile.png` |

## Evidence artifacts (logs/, gitignored)

- `logs/live-lC-round1.log`, `logs/live-lC-round2.log`, `logs/live-lC-round3.log` — full harness stdout per round
- `logs/live-lC-round{1,2,3}-exit.txt` — captured process exit codes
- `logs/dbcheck-round{1,2,3}.txt` — independent SQLite cross-check output per round