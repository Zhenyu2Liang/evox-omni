# Demo 人工接管

异常任务不再只有“联系客服”的提示。导航中的 **人工处理**（`/manual`）提供最小处理闭环：

1. 失败任务、运行中的计划、暂停计划或等待确认的计划 → 转人工处理，填写原因。
2. 系统持久化处理记录和当前会话对应的处理人。运行中的计划进入暂停状态，在途命令保留执行权限和真实结果；接管显示为 `human_review_requested`，直到当前命令到达安全检查点。后续步骤停止自动推进。
3. 到达检查点后，填写核对说明，选择 **记录并结束自动处理**、**恢复已暂停任务** 或 **重试明确失败步骤**。在途命令尚未结束时，不能提前结束或恢复任务。
4. 恢复暂停任务保持原步骤和原授权，不把等待确认变成已确认。重试仅适用于明确失败且不存在未决执行的任务，系统重试失败节点和其依赖节点，保留已成功节点；涉及写操作仍产生原有确认/MFA。
5. 接管和处理结论分别写入审计，和人工记录/任务状态同事务提交。审计失败则回滚该次处理。

## 事实与边界

- 人工说明不会把操作改成 `executed`，不会补造流水或修改余额。
- 结束自动处理会取消计划的剩余未执行步骤和未执行授权，保留已成功节点和已入账交易。
- `needs_reconciliation` 表示执行结果不明，只能登记说明并结束自动处理；其交易状态继续保持待核对。**关闭人工处理记录不代表金融事实已经核清**。
- 失败的写节点必须有明确失败的操作结果；已提交转账凭证、未决确认、活跃执行和未知结果都会阻止人工选择重试。没有充分证据时，可停止并重新提出新的请求，不能从未知执行位置重跑。
- 在接管请求提交前已取得执行权限的命令可以完成并记录原子凭证；接管后不能新认领确认或 MFA 执行。人工页面依据服务端检查点状态提供按钮，不靠页面隐藏控制执行。
- 对等待确认的计划释放人工控制后，仍使用原待授权操作；确认过期、MFA 到期和重新评估风险继续按原安全机制处理。
- 当前是同一可信 Demo 会话中的人工操作席位，处理人从服务端会话/User 读取。没有真实银行客服、独立员工登录、角色分权或真实冲正流程。
- 独立操作的明确失败（如余额不足）也会出现在人工处理页，可记录说明并结束；调整金额等需求后由用户重新发起，不能在人工说明中修改原授权。
- 执行前若要修改金额/收款人，取消原确认并重新描述需求；已执行操作不提供账本“回退”。

## 实现与升级

- `agent/manual-review.ts`：人工处理业务与严格事务审计。
- `ManualReview`：处理人、原因、说明、结论、时间和关联任务/操作；`activeKey` 唯一约束限制一个目标只有一个活动处理记录。
- 计划状态认领、节点认领及确认/MFA 的新执行认领都在数据库条件中排除活动人工处理记录。在途命令以原 claim 和 generation 记录结果，不能据此继续后继步骤。
- `GET/POST /api/manual-reviews` 和 `POST /api/manual-reviews/[id]`：仅 Cookie 身份，校验会话与用户所有权，不注册为模型工具。
- Apply the current schema with `pnpm db:generate` and `pnpm db:push --skip-generate`. Only the current model is supported; initialization and explicit demo reset are documented in [Development](development.md#database-lifecycle).

## 验证

`tests/app/manual-review-http.test.ts` 经真实路由/DB/执行器验证人工接管、持久化、确认/MFA 保持、终态与余额/流水保持、跨会话拒绝、并发决定和审计回滚，也覆盖自动命令及已认领确认在接管期间提交一次、后继步骤停住和保留在途金融事实。

The browser entry point `pnpm exec tsx tests/e2e/acceptance.e2e.ts` includes `g-manual-handoff`: requesting review, retaining it after refresh, recording notes, continuing through authorization and recording or ending unknown outcomes. It starts from seeded failure or unknown-state fixtures in an isolated database; it does not induce a real service crash.

测试布局与浏览器验收说明见 [测试用例](test-cases.md)。数据库升级和验收使用隔离库；新增接管行为以本次运行的测试结果为准。
