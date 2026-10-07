# e819d6e 确认与恢复边界修复

本轮在 `genesis/agent_33a59c38` 修复三项已复现缺陷，未改变数据库 schema。

## 修复

1. 普通确认和 MFA 确认原先只在授权阶段检查熔断。现与恢复重放共用 SDK 写事务内的
   `buildConfirmFence`，从持久化操作读取会话，再调用 `security.writePolicy.assertSessionMayWrite`。
   `guardExecutionFence` 保留被工具 runner 归一化的策略拒绝，向 API 传播 `423 CIRCUIT_OPEN`，
   不落成虚假的 executed/failed，不新增扣款、凭证或成功审计。解锁后恢复须重新复核授权。
   已提交事实的只读恢复不受新增写入禁令影响。
2. `postAction` 仅为 `pending/awaiting_mfa` 的明确决策合成 MFA 事件，移除同一终态操作的陈旧事件，
   保留计划下一操作的独立事件。人工核对/失败/取消/锁定显示错误。网关先拒绝已确认及终态操作，
   确认接口只对待决策状态补发 MFA；终态的历史 RED 信息仍如实返回。
3. 恢复授权在 CAS 取得写锁后重读操作风险；恢复落地时在状态/结果/审计同一事务内再次读取当前授权，
   用于审计及返回的 tier/requiresMfa，覆盖发现已入账流水和 CONFLICT/CIRCUIT_OPEN 凭证兜底两条路径。
   原始成功审计不会被修改，严格去重仍拒绝不同业务结果；相同执行身份只扣款一次。

## 回归证据

原始探针逐字节保留为 `tests/review-e819d6e-boundaries.test.ts`，与外部复查源文件 SHA256 均为
`52CFBEB8EAC95284A7B6CDBCBAD7FACF2AB15ABCDBA6438615F84D4E8F24B351`。
修复前 4/4 失败，修复后 4/4 通过，业务断言未改。

新增 `tests/repair-confirmation-boundaries.test.ts` 的 19 例覆盖：

- 普通确认/MFA 已授权后熔断，HTTP 423、余额/流水/凭证不变，操作保留可恢复状态；
  经真实安全重置接口解锁后，恢复和重复确认仅产生一次扣款及一次执行审计。
- 卡片限额写入使用同一熔断围栏。
- 并发 RED 提交后的 CONFLICT/CIRCUIT_OPEN 恢复兜底读取正确授权，成功审计原行不变。
- 审计业务结果不一致仍拒绝恢复，不放宽原有严格校验。
- 前端终态与待验证状态区分、错码错误提示、下一节点 MFA 事件保留、真实确认接口的 RED 终态保护。

上述并发回归经可控屏障驱动真实 route handler、SDK 和隔离 SQLite；前端使用实际响应归一化函数，
这些用例属于进程内集成和函数测试。浏览器验收另列，不能将这些测试称为浏览器测试。

实际验证（2026-10-07）：`npx tsc --noEmit` 退出码 0；`npx vitest run` 107 文件 / 726 用例全部通过，
退出码 0，运行 126.25 秒。与基线相比增加 2 文件 / 23 用例，既有测试未删除、未跳过、未放宽。

`npx tsx tests/e2e/acceptance.e2e.ts` 在真实本机 Chrome、隔离库 `prisma/e2e.db` 上为
PASS 6 / FAIL 0 / SKIP 0，退出码 0。覆盖确认转账、正确/错误 MFA、暂停恢复、取消后的旧入口、
刷新恢复及已入账操作恢复，含余额和流水核对。本轮新增并发和终态回归由上述集成/函数测试验证，
未新增浏览器旅程。

生产构建在仓库外独立 SQLite（`D:/projects/.codex-review/banking-repair-e819d6e/build.db`）执行
`npm run db:push` → `npm run db:seed` → `npx next build`，全部退出码 0。构建使用
`LLM_MODE=mock`、`RUST_LOG=warn` 及对应绝对 `DATABASE_URL`，不依赖开发库。
验证前后 `prisma/dev.db` SHA256 均为
`E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`，内容未改变。
原有未跟踪的 `_envcheck.txt` 保留，不纳入提交。

## 边界

熔断器仍在进程内，重启或多实例共享状态未实现；多进程竞争未压测。银行 SDK 与 MFA 均为模拟。
真实浏览器验收限本机 Chrome 和有限旅程，不证明生产安全闭环。开发库不用于本轮测试或构建。
