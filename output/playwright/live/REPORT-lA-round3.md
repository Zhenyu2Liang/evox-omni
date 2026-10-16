# LIVE 验收 — 场景 lA（信用卡挂失 → 补办） — ROUND 3 / 3

- 场景 ID：`lA`
- 场景名称：`lA-live-credit-card-report-lost-and-replace`
- 运行入口：`tests/e2e/live-acceptance.e2e.ts`
- 选择方式：`LIVE_SCENARIOS=lA`
- 模式：真实 DeepSeek 模型（`LLM_MODE=live` / `LLM_PROVIDER=deepseek`）+ 真实 headless Chrome + 真实 Next 应用，无 mock、无响应改写
- 隔离数据库：`prisma/live-acceptance.db`（本 worktree，`prisma/dev.db` 与 `prisma/test.db` 未触及）
- 进程退出码：**1**

## 逐场景结果（逐字）

```
FAIL lA-live-credit-card-report-lost-and-replace — 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw4ee600k0lkf8chxhog4f:CREDIT:ACTIVE
```

## 汇总行（逐字）

```
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

## 澄清 / 重试 / 超时 / 网络与控制台

- 澄清：无。超时：无。重试：无（未复跑）。
- `· 累计网络 4xx/5xx：0，console error：0，pageerror：0`
- 服务启动成功：`· next dev (pid=32536) → http://localhost:52635（/api/health 与 /agent 均已就绪）`
- LIVE 数据库重置 / `db push` / probe / seed 全部成功。

## 伪造确认面板守卫

`helpers.ts#assertNoFabricatedConfirmationPanel` **未触发**。模型没有在散文里声称存在确认/MFA 面板而不产生真实 `PendingAction`；实际发生了真实受控工具调用与真实 `PendingAction`，写入真实落库（`card_credit` 变 `LOST` 并生成补办卡行）。

## 失败断言位置与业务不变量

唯一失败断言是 `tests/e2e/live-acceptance.e2e.ts:1287` 的「卡片总数应为 3」。该断言**之前**的全部断言（第 1244–1286 行）全部通过，即本场景要证明的业务目标**全部满足**：

| 目标 | 结果 | 证据 |
| --- | --- | --- |
| 补办新卡继承**同一**已批准信用额度 | 通过 | 新卡 `creditLimitMinor=1800000`（¥18,000.00） |
| 继承**同一**当前可用额度（不翻倍） | 通过 | 新卡 `availableLimitMinor=1800000`（¥18,000.00） |
| 源卡保持 LOST / 终态 | 通过 | `card_credit.status=LOST`，`replacedByCardId` 指向新卡 |
| 资产总览不翻倍 | 通过 | dashboard `creditAvailable=18000.00`（仅统计非 LOST 的 CREDIT 卡） |
| 恰有一张 ACTIVE 补办信用卡 | 通过 | `GET /api/cards` 中唯一 ACTIVE 信用卡 = `cmvaw4ee600k0lkf8chxhog4f` |
| 其余演示卡不受影响 | 通过 | `card_debit`=DEBIT/ACTIVE（无额度字段）、`card_virtual`=VIRTUAL/ACTIVE（月限额 5000.00，绑定 `acct_checking`） |
| `/cards` 真实页面徽标 | 通过 | 新卡显示「正常」，源卡同时显示「已挂失」+「已补卡」 |

## 失败根因（可复现、确定性强）

`replace_card` **按设计新建一张卡**并把源卡的 `replacedByCardId` 指向新卡（`banking-sdk/card.ts:406`）。因此一次成功补办后必然存在 4 行 Card：源 CREDIT(LOST) + 新 CREDIT(ACTIVE) + DEBIT(ACTIVE) + VIRTUAL(ACTIVE)。

- `tests/e2e/live-acceptance.e2e.ts:1287` 的 `cards.length !== 3` 断言形成于种子库只有 2 张卡（CREDIT + DEBIT）时（`git blame` 指向提交 `3dc80a17`）。
- 之后提交 `1cf220d`（`add Card.linkedAccountId, CardConsumption ledger and a virtual-card seed fixture`）向种子加入了第 3 张卡 `card_virtual`，而该断言未同步更新（`3` 应为 `4`）。
- `tests/CONTEXT.md` 已将该「种子 3 张卡 vs 用例按更少张卡断言」列为已知不一致，并标注为**并行工作流、对本节点只读、尚未修复**。

**结论：这是一处过期的测试断言，而非业务缺陷。** 本场景要证明的挂失/补办业务不变量（额度继承、不翻倍、源卡终态、唯一 ACTIVE 补办卡）全部通过。按任务约束（不修改并行工作流的文件、不做范围外改动），本回合**未修改该断言**，仅如实记录。

## 数据库交叉核对（隔离库 `prisma/live-acceptance.db`）

`Card` 表原始行（`CARD_COUNT=4`）：

```
[
  { "id": "card_credit",  "type": "CREDIT",  "status": "LOST",   "creditLimitMinor": "1800000", "availableLimitMinor": "1800000", "monthlyLimitMinor": "1800000", "linkedAccountId": null,             "replacedByCardId": "cmvaw4ee600k0lkf8chxhog4f" },
  { "id": "card_debit",   "type": "DEBIT",   "status": "ACTIVE", "creditLimitMinor": null,      "availableLimitMinor": null,      "monthlyLimitMinor": null,      "linkedAccountId": null,             "replacedByCardId": null },
  { "id": "card_virtual", "type": "VIRTUAL", "status": "ACTIVE", "creditLimitMinor": null,      "availableLimitMinor": null,      "monthlyLimitMinor": "500000",  "linkedAccountId": "acct_checking", "replacedByCardId": null },
  { "id": "cmvaw4ee600k0lkf8chxhog4f", "type": "CREDIT", "status": "ACTIVE", "creditLimitMinor": "1800000", "availableLimitMinor": "1800000", "monthlyLimitMinor": "1800000", "linkedAccountId": null, "replacedByCardId": null }
]
```

Dashboard 汇总（`banking.dashboard.getDashboardSummary('user_liming')`，即 `GET /api/dashboard` 的读模型）：

```
{
  "totalAssets": "96920.07",
  "checkingBalance": "23580.00",
  "creditAvailable": "18000.00",
  "monthSpend": "13936.05",
  "month": "2026-09"
}
```

关键核对：`creditAvailable=18000.00` —— 源卡虽仍保留 `availableLimitMinor=1800000`，但因其 `status=LOST` 被排除，故信用可用额度**未翻倍**；补办卡继承 `creditLimitMinor=availableLimitMinor=monthlyLimitMinor=1800000`（¥18,000.00）。

## 截图

- `output/playwright/live/lA-round3-cards.png`（本回合重命名副本）
- `output/playwright/live/01-lA-cards.png`（harness 原始产物）

## 未决事项

- `tests/e2e/live-acceptance.e2e.ts:1287` 的过期断言（`3` → `4`）未修复：`tests/CONTEXT.md` 标注为并行工作流负责。修复前场景 lA 无法整体 PASS。
- 本回合因该断言在补办腿即失败，场景中的**第二次补办幂等腿**（第 1291–1314 行）未执行到。
