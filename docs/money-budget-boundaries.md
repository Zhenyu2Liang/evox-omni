# 金额与预算安全边界

## 金额契约

转账授权、待处理操作持久化、执行时累计复核、可能新增扣款的恢复，以及 SDK 新转账共用
`lib/money.ts` 的 `normalizeTransferAmount`。金额必须为正数且可表示为安全整数分；
`999.995`、`0.005`、非有限值均拒绝，不在扣款时悄悄四舍五入。普通数值的 IEEE-754 表示误差
（例如 `0.29 * 100`）允许规范化，确认金额与实际写入金额保持一致。

已执行流水与已授权在途动作都按整数分累计。总额恰好 ¥1000 保持 YELLOW；¥1000.01 必须 MFA。
无法核验金额的历史在途动作使新授权失败，不将其遗漏以降低累计额。
已提交事实的只读核验保留历史金额规范化能力，不能因此产生第二笔扣款。

## 自动写入契约

`buildAutomaticWriteFence` 由服务端注入会话，组合计划/节点执行权检查与当前熔断检查。
独立 `executeGatedTool`、计划 GREEN 节点和生产 Pi runtime 的 `AgentTool.execute` 均接入。
SDK 在写事务内执行检查，期间已触发熔断的预算操作返回失败且不新增预算；后续依赖节点不执行。
模型不能通过 JSON 参数提供或替换此检查。

熔断状态持久化于数据库并按用户（`CircuitBreakerState`，owner key `user:<userId>` / `session:<actor>`），跨新会话与进程重启留存；剩余边界是按 DB，多实例各自持有独立库时不互相协调。
已提交转账的凭证读取与状态回填继续使用原有恢复通道。

## 预算幂等与索引升级

预算使用 `@@unique([userId, idempotencyKey])`。同一用户与 key 重放自己的原记录；不同用户的
相同本地 key 分别创建记录。初次查询和 P2002 唯一冲突回查共用复合选择条件，不返回其他用户的数据。
计划节点 key 仍为 `nxe:<taskId>:<nodeId>`，不同计划独立；无 key 的调用保持独立创建。

仓库继续采用 `db push`，没有 migrations 目录。升级既有业务库：

1. 保存数据库备份，核对这次 schema 差异仅将 Budget 全局 key 唯一约束改为用户与 key 的复合约束。
2. 执行 `npm run db:generate`。
3. 执行 `npm run db:push -- --skip-generate --accept-data-loss`。Prisma 对新增唯一索引发出通用警告，
   旧全局唯一数据已满足新的复合约束；仅在确认差异后接受该警告。
4. 既有数据升级不运行 `db:seed` 或 `db:reset`，不使用 `--force-reset`。

隔离旧 schema 数据库已验证：升级后原预算 ID、金额、用途保留；另一用户可使用相同 key，
同一用户重复 key 仍由数据库拒绝。开发库未应用 schema、未清理或重灌。

## 验证范围

`tests/integration/money-budget.test.ts` 包含 17 条进程内集成回归，调用真实 HTTP route handler、
Pi runtime、网关、SDK 和 SQLite；仅用可控屏障安排竞争时序。覆盖非法金额拒绝、历史非法动作、
合法分值并发/MFA、三种自动预算写入路径的熔断、跨用户同 key 和同用户并发去重。

原有两条“允许缺金额/允许四舍五入”的测试契约改为拒绝非法输入，并保留合法金额与余额/流水断言；
原有“跳过非法在途金额”改为失败关闭。幂等 helper 单测只适配复合查询形状，业务断言保留。

验证使用隔离 test/E2E/build/upgrade 数据库。真实浏览器覆盖现有 7 个旅程；
上述新竞争和跨用户场景由集成测试覆盖，不宣称已经浏览器或多实例验收。

| 验证命令/场景 | 本地结果 |
| --- | --- |
| `npx prisma generate` | exit 0 |
| `npx tsc --noEmit` | exit 0，0 错误 |
| `npx vitest run`（与 E2E 串行） | 108 文件 / 743 用例通过，0 失败、0 跳过 |
| `npx next build`（预先 provision + seed 隔离 build 库） | exit 0 |
| `npx tsx tests/e2e/acceptance.e2e.ts` | 真实 Chrome，PASS 7 / FAIL 0 / SKIP 0 |
| 旧 schema → 当前 schema 的隔离升级验证 | 原预算内容保留；跨用户同 key 独立，同用户唯一约束有效 |

测试运行顺序要求：E2E 初始化会重置 `prisma/e2e.db`，部署保护测试会检查该共享文件的时间戳。
两者必须串行执行，不能将并行重置引起的文件变化当作产品回归，也不能放宽原断言。
