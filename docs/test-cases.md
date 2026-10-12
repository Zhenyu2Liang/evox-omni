# 测试用例与 Demo 验收

## live 规划与故障恢复

`tests/integration/live-recovery.test.ts` 使用真实 Pi、工具、数据库与确认执行流程，只有模型传输被脚本化。覆盖仅口头回复后的单次规划恢复、查询与工具结果配对、恢复耗尽后的持久化重试入口、有效澄清/产品拒绝/认证错误不重试、预算已提交后不重放、确认后的真实转账只扣款一次且无播报请求。`agent/providers/request-options.test.ts` 验证每请求截止时间（包括响应流停滞）、一次传输重试及独立取消；`tests/integration/live-retry-ui.test.ts` 验证最新回复的按钮与旧入口退出，不代替浏览器点击测试。

专项命令：`npx vitest run tests/integration/live-recovery.test.ts tests/integration/live-retry-ui.test.ts agent/providers/request-options.test.ts`。真实 DeepSeek 前端和故障注入前端的证据另行记录，故障代理返回的错误不冒充真实模型回复。

`tests/integration/request-step-binding.test.ts` 使用真实任务执行器、数据库和确认/MFA 路由，覆盖转账失败后成功条件的下游跳过且无授权、成功后的正常门控、多产品逐笔申购及错码/重放、同金额不同产品代码、错误产品/对调金额/重复/遗漏/未知产品的全计划预检，以及有歧义时未创建任何计划或自动预算。既有 `task-feature-hardening` 保留独立提醒不继承条件跳过的用例。live 验收另通过真实前端按钮执行，不以该集成测试代替浏览器测试。

## 请求约束、取消状态与补偿回退

`tests/integration/task-feature-hardening.test.ts` 经真实路由、执行器和 SQLite 验证：产品不存在/对象替换不产生授权，查询后的明确澄清在 SSE 与持久化对话中一致；显式顺序持久化，条件为假不跳过独立提醒；取消响应的 generation/updatedAt 与 DB 一致，晚到非终态事件不能复活取消计划；连续确认自动返回下一步的 YELLOW/RED 卡及绑定摘要；回退只撤销本人计划的预算/定时记录，保留流水和原节点成功结果。还覆盖并发/重复、跨会话、已使用/身份不符资源及严格审计失败时的事务回滚。

真实 live 前端验收使用隔离库：暂停时确认当前节点后仍暂停，恢复才进入下一节点；取消立即显示终态；回退预算和提醒后刷新结果保留，已确认的小数转账余额与流水保持不变。此为本地有限场景验收，不代表任意自然语言或多实例部署均已验证。

测试按功能分为单元、场景、路由/跨模块集成和浏览器验收；
普通测试只模拟模型响应，银行 SDK、权限控制和数据库使用真实项目实现。

当前验证结果见 [前端修复验收](frontend-repair-report.md)，不以历史测试数量代替当前验收。

`tests/integration/frontend-review-fixes.test.ts` 覆盖名称/尾号归属和歧义、授权摘要、北京时间、条件路径、持仓元数据/重复持仓渲染、MFA 终态、异常确认幂等、密码脱敏及流式卡片收敛。真实前端修复验收使用隔离数据库和真实 DeepSeek，不直接写接口替代按钮操作。
真实浏览器验收为 7 个旅程。

## 运行

    npm run test
    npm run test -- tests/unit
    npm run test -- tests/scenarios
    npm run test -- tests/app tests/integration
    npx tsc --noEmit
    npx tsx tests/e2e/acceptance.e2e.ts

Vitest 与浏览器验收分别运行。测试库 prisma/test.db、浏览器库 prisma/e2e.db 均与开发库隔离。
测试基础设施自举生成客户端和库，不能用清空开发库解决失败。
构建需准备数据库；升级已有库用 npm run db:push -- --skip-generate 增量应用 schema，
只有新建隔离演示库才运行种子。

## 12 个核心演示场景

| 场景 | 测试文件（tests/scenarios/） | 验收要点 |
| --- | --- | --- |
| 查询余额 | test-01-balance.test.ts | GREEN 自动查询，数据来自 SDK |
| 小额转账 | test-02-transfer-confirm.test.ts | 明确确认后执行，余额与流水一致 |
| 大额转账 | test-03-transfer-mfa.test.ts | RED 强验证；错码不扣款 |
| 注入防护 | test-04-prompt-injection.test.ts | 恶意输入不绕过权限/MFA |
| 失败反馈 | test-05-failure-report.test.ts | 如实报告失败，不编造成功 |
| 消费分析 | test-06-spending-analysis.test.ts | 分类汇总与账单匹配 |
| 异常交易 | test-07-anomaly.test.ts | 根据实际交易识别异常 |
| 卡片限额 | test-08-card-limit.test.ts | 修改需用户确认 |
| 理财操作 | test-09-investment-mfa.test.ts | 申购受 RED/MFA 约束 |
| 安全熔断 | test-10-circuit-breaker.test.ts | 连续失败锁定，关键决定入审计 |
| 条件 DAG | test-11-conditional-dag.test.ts | 依赖/条件控制后续工具 |
| 生日计划 | test-12-birthday-plan.test.ts | 预算/计划记录，不宣称资金锁定或真实订购 |

mock-integration.test.ts 补充无需 API Key 的完整流水线。

## 安全与状态一致性

| 目录 | 覆盖 |
| --- | --- |
| tests/unit/security | 权限、累计限额、MFA、熔断、注入、原子授权与审计 |
| tests/unit/planner | DAG、节点执行、独占认领、暂停/恢复/取消/重试 |
| tests/unit/banking-sdk | 转账、订阅、理财、持久幂等和原子性 |
| tests/unit/agent | 确认续跑、计划控制、失败反馈和模拟模型 |
| tests/unit/lib | 账本身份、持久回执、操作认领和 CLI 环境 |
| tests/app | 真实路由的身份、确认/MFA、账本、并发、恢复和人工接管 |
| tests/integration | 跨模块执行围栏、已提交事实、回执、恢复权限、金额与审计 |
| tests/deploy-db-push.test.ts | 真实部署入口在隔离库自举，保持共享库不变 |

跨模块规格按业务命名，索引见 [集成测试索引](../tests/integration/CONTEXT.md)。
核心不变量：

- 日累计恰好 1000 元保持 YELLOW，超过时升级 RED；超两位小数拒绝。
- 并发/重复确认只执行一次；取消先提交阻止新写入，业务先提交保留入账事实。
- 同一执行身份重放原结果，不同请求不能共用授权或回执。
- 旧执行器丢失执行权后不能写入副作用、覆盖结果或发布迟到进度。
- 恢复依据持久证据；未知结果进入人工核对，不臆测成败或重新执行。
- 转账扣款、流水、回执、关键执行审计同事务；审计失败回滚。
- Cookie 所属用户/会话决定授权，客户端参数不能冒充身份。

## 人工接管

tests/app/manual-review-http.test.ts 的 11 项用例覆盖持久记录、刷新读取、人工期间阻止继续/重试、
继续仍需确认/MFA、入账事实保留、余额不足操作入口、未知结果拒绝重跑、跨会话拒绝、
并发决定去重和审计回滚。详见 [人工接管](manual-review.md)。

## 真实浏览器

入口 tests/e2e/acceptance.e2e.ts 使用 playwright-core 和本机 headless Chrome，
启动真实应用、使用隔离库、操作真实页面；不由 Vitest 收集。

| 旅程 | 核对内容 |
| --- | --- |
| a-transfer-confirm | 确认、余额及新增借方流水 |
| b-transfer-mfa | 正确码成功；错码保留验证入口且资金不变 |
| c-plan-pause-resume | 真实暂停/继续；成功节点不重跑 |
| d-plan-cancel | 旧确认被拒；资金、流水和限额不变 |
| e-refresh-action-recovery | 刷新恢复 YELLOW/RED 入口 |
| f-wedge-refresh-recover | 恢复已入账但缺终态操作，不重复扣款 |
| g-manual-handoff | 转人工、刷新保留、记录后继续仍待确认；未知结果只登记/结束 |
| h-investment-subscribe-redeem | 申购与赎回的持仓、余额和投资分类流水 |
| i-bill-anomaly | 正常收入不误报，异常支出样例被识别 |
| j-security-breaker | 锁定跨刷新有效，空/错码不解锁，正确码解锁并审计 |

故障窗口的初始状态可由隔离夹具构造，不声称浏览器制造了真实服务崩溃。
路由集成是进程内调用，不能冒充真实网络/浏览器验收。

## 验证边界

模型使用 LLM_MODE=mock，银行和 MFA 为模拟。真实 LLM 质量、真实资金、多实例、
跨浏览器、性能与无障碍尚未由这些测试验证。全绿不等于生产安全认证。
其余限制见 [安全设计](security.md) 和 [已知风险](known-risks.md)。


## 服务端金融结果输出回归

`agent/financial-response.test.ts`：账户与合计的分值更新、储蓄/活期隔离、同参数不同身份、重放不恢复旧余额、未知结果失效当前快照、重新查询以及计划描述不进入金融结果。

`tests/integration/financial-response-boundary.test.ts`：真实 Pi 回合及续接，覆盖分句错误收款人、错误金额混入正确手续费、确认词掩盖成功、无工具假收款、未知结果假报资金未变、英文变体、伪造校正标签。检查流式消息、UI 持久化、Pi 后续历史、SDK 小数扣款与账本，以及 DAG 实际工具归属。

旧 grounding 集成用例仍保留，依赖模型措辞逐字保留的断言改为服务端输出契约；余额、流水、权限、未知结果和刷新一致性继续检查。旧纯文本规则测试仅用于兼容，生产输出不依赖该规则。

本次另用真实 DeepSeek、真实 Next 服务与独立 `live-repair-841-*.db` 验证 7 项：live 健康检查、余额查询、小数转账确认、转账后当前合计、错误 MFA 无扣款、正确 MFA 大额转账、真实 Chrome 页面查询。¥200.37 转账后活期 ¥23,379.63、合计 ¥73,379.63；再转 ¥5,000 后活期 ¥18,379.63、合计 ¥68,379.63。每笔核对数据库及唯一借方流水。该有限 live 验收未覆盖 UNKNOWN 故障注入或全部模糊意图；这些未知结果边界由脚本化模型集成测试验证。
