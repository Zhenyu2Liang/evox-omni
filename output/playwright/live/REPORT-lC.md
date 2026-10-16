# Live Acceptance Report — Scenario `lC` (虚拟卡绑定活期账户 / live virtual-card consumption)

Real headless Chrome + real DeepSeek model, 3 independent process invocations.

## Configuration (constant across all rounds)

| Item | Value |
| --- | --- |
| Harness | `tests/e2e/live-acceptance.e2e.ts` |
| Scenario | `lC` — `lC-live-virtual-card-consumption` (`scenarioVirtualCardConsume`) |
| Selection env var | `LIVE_SCENARIOS=lC` |
| Command | `pnpm exec tsx tests/e2e/live-acceptance.e2e.ts` |
| Model mode | provided `.env.local` unchanged (`LLM_MODE=live`, `LLM_PROVIDER=deepseek`) — no `LIVE_FORCE_MODEL` |
| Dev server | real `next dev` on a dynamic free port |
| Browser | real headless Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) |
| Isolated DB | `prisma/live-acceptance.db` (auto reset + `db push` + probe + `tsx prisma/seed.ts` at the start of every run) |
| Seed baseline | `acct_checking` balance = 23,580.00 CNY (2,358,000 minor); `card_virtual` = ACTIVE VIRTUAL, monthly limit 5,000.00 CNY (500,000 minor), linked to `acct_checking` |

Screenshots are written by `captureLive(page, label)` to `output/playwright/live/<NN>-<label>.png`; the three lC labels are
`lC-consume-form`, `lC-consume-success`, `lC-card-tile` (NN = capture order within the run).

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

Screenshots produced (fresh, then copied round-tagged):

- `01-lC-consume-form.png` → `lC-round1-consume-form.png`
- `02-lC-consume-success.png` → `lC-round1-consume-success.png`
- `03-lC-card-tile.png` → `lC-round1-card-tile.png`

Independent SQLite cross-check of `prisma/live-acceptance.db` (throwaway Prisma client):

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

## Rounds 2–3

(recorded below as they complete)