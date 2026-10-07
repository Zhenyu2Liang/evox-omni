# 测试用例与 Demo 验收

测试按功能维护，历史重复审查探针已清理。保留单元、场景、路由/跨模块集成和浏览器验收；
普通测试只模拟模型响应，银行 SDK、权限控制和数据库使用真实项目实现。

本次清理后实测：类型检查通过，Vitest **100 文件 / 716 用例全部通过**。
26 个移动整理的测试文件经语法树比较，可执行代码与断言不变；业务逻辑未修改。
浏览器 7 个旅程保留，上次功能交付已验收通过；本次仅整理测试，未重复运行浏览器或生产构建。

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

故障窗口的初始状态可由隔离夹具构造，不声称浏览器制造了真实服务崩溃。
路由集成是进程内调用，不能冒充真实网络/浏览器验收。

## 验证边界

模型使用 LLM_MODE=mock，银行和 MFA 为模拟。真实 LLM 质量、真实资金、多实例、
跨浏览器、性能与无障碍尚未由这些测试验证。全绿不等于生产安全认证。
其余限制见 [安全设计](security.md) 和 [已知风险](known-risks.md)。
