# LIVE acceptance evidence — lB（理财部分赎回 / investment partial redemption）

本文件是 `tests/e2e/live-acceptance.e2e.ts` 场景 `lB`（注册名 `lB-live-investment-partial-redemption`，函数
`scenarioPartialRedeem`）的**真实模型 + 真实浏览器**运行证据，用于验收回归
「理财页面金额显示统一保留两位小数」。

- 运行提交：`8a639048f03a1dd6fd072dbb3ecbdced7607ad75`（短 SHA `8a63904`，分支 `evogit-agent-T4-A107`）
- 运行入口：`tests/e2e/live-acceptance.e2e.ts`（`LIVE_SCENARIOS=lB`，每个 round 独立进程）
- 模型：真实 DeepSeek（`LLM_MODE=live` / `LLM_PROVIDER=deepseek`，来自本 worktree 的 `.env.local`，未使用 `LIVE_FORCE_MODEL`，模型值不显示）
- 浏览器：真实无头 Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`（harness 自动探测）
- 数据库：隔离库 `prisma/live-acceptance.db`（由 harness 自行 `db push` + `seed`，未触碰 `prisma/dev.db` / `prisma/test.db` 或任何备份）
- 运行时间：2026-10-16 19:37–19:41 (+08:00)

## 三轮汇总（顺序执行，每轮独立进程）

| Round | PASS/FAIL/SKIP 行 | 退出码 | 截图（已重命名保存） |
| --- | --- | --- | --- |
| 1 | `PASS lB-live-investment-partial-redemption` | 0 | `output/playwright/live/lB-round1.png` |
| 2 | `PASS lB-live-investment-partial-redemption` | 0 | `output/playwright/live/lB-round2.png` |
| 3 | `PASS lB-live-investment-partial-redemption` | 0 | `output/playwright/live/lB-round3.png` |

每轮汇总行均为 `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`。三轮均为真实通过（PASS），无 FAIL、无 SKIP、无超时。
（`lB-round*.png` 由每轮 harness 生成的 `output/playwright/live/01-lB-investments.png` 复制而来；因每轮进程内截图序号重置，
原始文件名每轮相同，故必须重命名保存。文件时间戳与各轮结束时间一致。）

## 逐轮 verbatim 证据行

### Round 1（`logs/lB-round1.log`，退出码 0）

```
PASS lB-live-investment-partial-redemption — B1 实际发送：「追加申购稳健理财A 1000元」 → MFA 123456 → DB principalAmountMinor=600000（¥6,000.00）；B2 实际发送：「我持有的稳健理财A部分赎回2000元本金」 → MFA 123456 → DB principalAmountMinor=400000（¥4,000.00）、estimatedMarketValue=4118.906666666666666667（全精度）；/investments 显示 持有金额=¥4,000.00、市值=¥4,118.91、收益=+¥118.91；账本新增 DEBIT -1000.00（cmvaw860o0076y4f8lsfinh5g，认购稳健理财A/投资）与 CREDIT 2059.45（cmvaw89t200dzy4f8ckeljg0j，赎回/投资）；活期余额 23580.00 → 24639.45
```

### Round 2（`logs/lB-round2.log`，退出码 0）

```
PASS lB-live-investment-partial-redemption — B1 实际发送：「追加申购稳健理财A 1000元」 → MFA 123456 → DB principalAmountMinor=600000（¥6,000.00）；B2 实际发送：「我持有的稳健理财A部分赎回2000元本金」 → MFA 123456 → DB principalAmountMinor=400000（¥4,000.00）、estimatedMarketValue=4118.906666666666666667（全精度）；/investments 显示 持有金额=¥4,000.00、市值=¥4,118.91、收益=+¥118.91；账本新增 DEBIT -1000.00（cmvawaxmf00bzgcf8zrimoy5g，认购稳健理财A/投资）与 CREDIT 2059.45（cmvawb5hh00j3gcf8alkijq16，赎回/投资）；活期余额 23580.00 → 24639.45
```

### Round 3（`logs/lB-round3.log`，退出码 0）

```
PASS lB-live-investment-partial-redemption — B1 实际发送：「追加申购稳健理财A 1000元」 → 「确认，请办理」 → MFA 123456 → DB principalAmountMinor=600000（¥6,000.00）；B2 实际发送：「我持有的稳健理财A部分赎回2000元本金」 → MFA 123456 → DB principalAmountMinor=400000（¥4,000.00）、estimatedMarketValue=4118.906666666666666667（全精度）；/investments 显示 持有金额=¥4,000.00、市值=¥4,118.91、收益=+¥118.91；账本新增 DEBIT -1000.00（cmvawci9u00my0of89kh8qpvh，认购稳健理财A/投资）与 CREDIT 2059.45（cmvawclg700ss0of8nqfl7q2w，赎回/投资）；活期余额 23580.00 → 24639.45
```

## 模型澄清 / 重试 / 超时观察

- Round 1、Round 2：B1 与 B2 各在**一条**自然语言轮次内直接停放了受控工具（MFA 卡片），无澄清、无重试、无超时。
- Round 3：B1 的**第一条**轮次（`追加申购稳健理财A 1000元`）未停放受控工具，模型以散文回复（`driveRedTool` 判定为
  plain 追问，未被 `assertNoFabricatedConfirmationPanel` 判为「伪造面板」），因此按 `driveRedTool` 的设计发送了
  下一条催促 `确认，请办理` 后停放 MFA 卡片；这是真实模型的正常行为差异，非失败。B2 仍在一条轮次内完成。
- 三轮 `driveRedTool` 均未触发 `等待 LIVE 模型调用受控工具` 超时（`perTurnTimeoutMs=30s`），未走到未削弱的兜底 `awaitMfaCard`。
- 三轮均 `累计网络 4xx/5xx：0，console error：0，pageerror：0`；MFA 均为 `123456`（一次成功，无错误码重试）。
- 三轮均 `【证据】持久化的 transfer_money / search_contact 工具调用：（无持久化的 transfer_money/search_contact 调用）`——本场景不使用这两个工具，符合预期。

## 场景自身断言（harness 内）

- B1：DB `holding_wenjiana.principalAmountMinor === 600000`（¥6,000.00）。
- B2：DB `principalAmountMinor === 400000` 且 `estimatedMarketValue` 以 `4118.90666` 开头（全精度存储）。
- `/investments` 页真实渲染：`持有金额=¥4,000.00`、`市值=¥4,118.91`、`收益=+¥118.91`，逐项通过
  `/^[+-]?¥[\d,]+\.\d{2}$/` 且**拒绝** `/\.\d{6,}/`（回归断言：页面金额恰好两位小数、含千分位与符号），
  「稳健理财A」持仓卡片恰 1 张。
- 账本新增恰 1 条 DEBIT −1000.00（`认购稳健理财A`/`投资`）与恰 1 条 CREDIT +2059.45（`赎回`/`投资`）。
- 活期余额 `23580.00 → 24639.45`（= before −1000.00 +2059.45）。

## 独立 DB 交叉核对（每轮额外执行，权威来源）

方法：以 `DATABASE_URL=file:live-acceptance.db` 直接读取隔离库（`lib/db/database.ts#createDatabaseClient`），
不经 UI、不经 SDK 变更。逐轮输出见 `logs/lB-round{1,2,3}.dbcheck.log`（脚本见文末附录）。

| Round | `holding_wenjiana.principalAmountMinor` | `holding_wenjiana.estimatedMarketValue` | `acct_checking.balanceMinor` | 投资类 Transaction（amountMinor / direction / merchant / category） |
| --- | --- | --- | --- | --- |
| 1 | `400000` | `4118.906666666666666667` | `2463945` | `-100000 / DEBIT / 认购稳健理财A / 投资`；`205945 / CREDIT / 赎回 / 投资` |
| 2 | `400000` | `4118.906666666666666667` | `2463945` | `-100000 / DEBIT / 认购稳健理财A / 投资`；`205945 / CREDIT / 赎回 / 投资` |
| 3 | `400000` | `4118.906666666666666667` | `2463945` | `-100000 / DEBIT / 认购稳健理财A / 投资`；`205945 / CREDIT / 赎回 / 投资` |

三轮完全一致，且与 harness 断言一致：DB 中保留全精度 `4118.906666666666666667`，而页面展示为两位小数 `¥4,118.91`
（存储全精度 / 展示两位小数，符合不变量）。

## 资源清理

- 每轮结束后核对：本 worktree 相关 `node.exe` 与 `chrome.exe` 进程数为 0；各轮 `next dev` 端口处于 TimeWait（连接关闭中）。
- harness 在 `finally` 中 `await teardown()`（先停 dev server 再关浏览器），未留下锁定的 `live-acceptance.db`。
- 三轮顺序执行，无并发运行同一 SQLite 库。

## 未解决项 / 说明

- 本场景（lB）三轮全部真实通过，无未解决项。
- **BUG 策略**：未发现该旅程或金额格式化中的真实可复现缺陷；**未修改任何断言、未削弱任何校验、未跳过任何用例**。
  因此本次提交不改动任何源码。
- 目录内存在一张**先于本次运行**的陈旧截图 `output/playwright/live/01-lA-cards.png`（时间戳 19:31:05，早于本任务第一轮 19:37 的
  运行；本次仅以 `LIVE_SCENARIOS=lB` 运行，未执行 lA）。它不是本次运行的产物，未纳入本证据，也未删除。
- `tests/CONTEXT.md` 记录的 mock 入口（`acceptance.e2e.ts`）已知失败断言与卡片数量断言等属其他并行工作流范围，
  不在本任务（lB live 验收）范围内，未做改动。

## 附录：独立 DB 交叉核对脚本

以下脚本以临时文件 `_lb_dbcheck.ts`（仓库根，运行后已删除）执行；`DATABASE_URL=file:live-acceptance.db`：

```ts
import { createDatabaseClient } from './lib/db/database.ts';

const db = createDatabaseClient();
try {
  const holding = await db.investmentHolding.findUnique({
    where: { id: 'holding_wenjiana' },
    select: { id: true, principalAmountMinor: true, estimatedMarketValue: true },
  });
  const account = await db.account.findUnique({
    where: { id: 'acct_checking' },
    select: { id: true, balanceMinor: true },
  });
  const investmentTxs = await db.transaction.findMany({
    where: { accountId: 'acct_checking', category: '投资' },
    orderBy: { occurredAt: 'asc' },
    select: { id: true, amountMinor: true, direction: true, merchant: true, category: true },
  });
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
  console.log(JSON.stringify({ holding: plain(holding), account: plain(account), investmentTxs: plain(investmentTxs) }, null, 2));
} finally {
  await db.$disconnect();
}
```