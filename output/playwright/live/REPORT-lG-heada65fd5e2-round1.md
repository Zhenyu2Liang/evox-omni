# lG LIVE 验收报告 — round 1（事后重建 / post-hoc reconstruction）

> **本文件为事后重建**：`logs/lG-r1.out`、`logs/lG-r1-db.txt`、`logs/lG-r1.db` 已不存在（对 `D:/projects/banking-agent` 做过三次全盘检索，包括 `dir /s /b`、`-Recurse -Force -Filter 'lG-r*'`，均无结果）。因此本报告**不包含任何 stdout 时刻的验证声明**：退出码、汇总行、时长、模型 id、DB 数字一律记为「not preserved」。本报告只陈述**幸存的截图证据**与会话中已记录的失败原因。

## 概要

| 项 | 值 |
| --- | --- |
| 场景 | `lG` / `lG-live-full-card-loss-replace-chain-single-session` |
| 轮次 | round 1 |
| 产品树提交 | `a65fd5e2`（由证据目录名 `lG-heada65fd5e2-round1` 推定） |
| 结果 | **FAIL（TEST/harness 原因）** |
| 工具报告退出码 | not preserved |
| `EXIT=` 行 | not preserved |
| 时长 | not preserved |
| `== 汇总 ==` 行 | not preserved |
| `/api/health` `llmMode` | not preserved（当时以 live 模式运行） |
| 模型 id | not preserved |

## 失败原因与修复

round 1 的两处 harness 缺陷（均在本轮之后修复，产品代码未改动）：

1. **步骤 1 提示词未固定**：`applyVirtualCardViaAgent` 没有 `opts.turns` 入口，lG 无法发送其固定的第 1 句提示词 `请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。`，导致整条链在第一条腿就偏离场景剧本。
2. **步骤 8 的「最终确认」回合未能进入 `/agent`**：`sendFinalConfirmTurn` 未重新进入 `/agent` 页面即发送提示词，`/cards` 页面没有输入框，最终确认腿无法执行。

修复提交：**`1c674005`**（`sendFinalConfirmTurn` 重新进入 `/agent`；`applyVirtualCardViaAgent` 增加 `opts.turns`，使 lG 发送其固定提示词）。

## 幸存证据

- `output/playwright/live/lG-heada65fd5e2-round1/01-lG-virtual-replacement.png`（88766 B）
- `output/playwright/live/lG-heada65fd5e2-round1/02-lG-virtual-refusal.png`（105609 B）
- `output/playwright/live/lG-heada65fd5e2-round1/03-lG-credit-replacement.png`（97399 B）

截图覆盖到第 8 步之前的产品状态（虚拟卡补办、超限拒绝、信用卡补办），说明业务腿本身跑到了较后阶段；失败发生在 harness 步骤而非业务断言。

## 逐提示词结果

not preserved —— 日志未保留，无法逐轮引用模型散文、工具参数、PendingAction/MfaChallenge 行与卡片行。

## 判定

**FAIL（TEST 原因）**，修复提交 `1c674005`。本报告不作通过结论，也不认证任何提交。
