# lG LIVE 验收报告 — round 2（事后重建 / post-hoc reconstruction）

> **本文件为事后重建**：`logs/lG-r2.out`、`logs/lG-r2-db.txt`、`logs/lG-r2.db` 已不存在（全盘检索无结果），且**该轮截图在复制前就被下一轮覆盖**（harness 截图文件名为固定值），因此本轮没有任何截图证据。本报告**不包含 stdout 时刻的验证声明**：退出码、汇总行、时长、模型 id、DB 数字一律记为「not preserved」。

## 概要

| 项 | 值 |
| --- | --- |
| 场景 | `lG` / `lG-live-full-card-loss-replace-chain-single-session` |
| 轮次 | round 2 |
| 产品树提交 | `1c674005`（由报告文件命名约定 `REPORT-lG-head1c674005-round2.md` 推定：round 2 在 round 1 的修复提交上运行） |
| 结果 | **FAIL（TEST/harness 原因）** |
| 工具报告退出码 | not preserved |
| `EXIT=` 行 | not preserved |
| 时长 | not preserved |
| `== 汇总 ==` 行 | not preserved |
| `/api/health` `llmMode` | not preserved |
| 模型 id | not preserved |

## 失败原因与修复

round 2 的 harness 缺陷：**步骤 8 硬编码了 VIRTUAL 卡数量**。种子数据自带 `card_virtual`（VIRTUAL/ACTIVE，绑定 `acct_checking`，月限额 `5000.00`），因此场景内新开一张虚拟卡后总数与硬编码期望不符，步骤 8 的基数断言失败。

修复提交：**`acebc393`**——步骤 8 的 VIRTUAL 卡基数改为按「场景开始时的基线」推导，并固定校验链上的行（`replacedByCardId` 链接、`LOST` 源卡、恰一张新卡）。

## 幸存证据

- 截图：**none**（本轮截图在复制前被 round 3 覆盖）。
- 日志：**none**（`logs/lG-r2.*` 不存在）。

## 逐提示词结果

not preserved —— 无日志，无法逐轮引用模型散文、工具参数、PendingAction/MfaChallenge 行与卡片行。

## 判定

**FAIL（TEST 原因）**，修复提交 `acebc393`。本报告不作通过结论，也不认证任何提交。
