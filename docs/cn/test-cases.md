# 测试与验收

测试分为离线回归、浏览器验收和真实模型验收。
每次验收都记录模型来源和实际执行范围。
测试数量以当次命令输出为准。

运行环境见[开发指南](development.md)。
恢复规则见[持久化与恢复](agent-durability.md)。
业务限制见[当前限制](known-risks.md)。
名称含义见[术语表](terms.md)。

## 常用命令

在项目根目录执行以下命令。

```sh
pnpm test
pnpm test tests/unit
pnpm test tests/scenarios
pnpm test tests/app tests/integration
pnpm test agent/durable tests/integration/process-restart.test.ts
pnpm typecheck
pnpm lint
pnpm exec tsx tests/e2e/acceptance.e2e.ts
```

`pnpm test` 使用 [Vitest 配置](../../vitest.config.ts)。
配置收集 `tests/` 和 `agent/` 下的测试。
浏览器验收有独立入口，Vitest 不收集浏览器验收。

生产构建单独执行 `pnpm build`。
构建前先准备符合当前 schema 的数据库。
预渲染页面会查询数据库。
准备步骤见[开发指南](development.md)。

## 数据隔离与执行顺序

各测试入口使用独立数据库。

| 测试入口 | 数据库 | 模型来源 |
| --- | --- | --- |
| Vitest | `prisma/test.db` | 离线模拟或受控响应 |
| 离线浏览器验收 | `prisma/e2e.db` | 离线模拟 |
| 真实模型浏览器验收 | `prisma/live-acceptance.db` | DeepSeek |

测试入口在导入应用代码前设置 `DATABASE_URL`。
测试入口生成 Prisma Client，并创建当前 schema。
使用数据库的测试自行创建种子数据。
配置中的 `LLM_MODE=mock` 使 Vitest 默认离线运行。

警告：测试入口会重建表内的隔离数据。
需要保留验收数据时，先保存数据库副本。
不得通过重置 `prisma/dev.db` 处理测试失败。

注意：Vitest 文件共享可重置的 `prisma/test.db`。
同一工作区内的 Vitest 命令必须串行执行。
浏览器验收也必须单独执行。
浏览器验收与开发服务、构建共享 Next.js 生成文件。
并行执行可能干扰生成文件和服务状态。

数据库初始化失败时，查看初始化诊断。
先检查 Prisma Client、schema 和隔离库路径。
测试环境固定 schema engine 的日志级别。
初始化失败会保留 Prisma 命令输出。
代码见[测试初始化](../../tests/setup.ts)。

## 测试层次

| 目录或文件 | 检查内容 |
| --- | --- |
| `tests/unit/` | 金融值、银行事务、权限、计划和界面契约 |
| `agent/**/*.test.ts` | 持久化运行、模型传输和可信金融回复 |
| `tests/scenarios/` | 受控模型驱动的银行智能体场景 |
| `tests/app/` | 实际路由处理器、Cookie 身份和操作控制 |
| `tests/integration/` | 跨模块执行、持久化、恢复和并发约束 |
| `tests/deploy-db-push.test.ts` | 当前 schema 建库、显式重置和目录边界 |
| `tests/e2e/` | 运行中应用的浏览器操作 |

路由测试直接调用实际处理器。
路由测试不检查浏览器渲染和网络传输。
浏览器验收以渲染后的页面为主要证据。
只读接口和数据库用于核对资金事实。

## 核心场景

核心场景文件位于 [tests/scenarios](../../tests/scenarios)。

| 场景 | 测试文件 | 预期行为 |
| --- | --- | --- |
| 余额查询 | `test-01-balance.test.ts` | 绿色查询返回银行 SDK 的事实 |
| 小额转账 | `test-02-transfer-confirm.test.ts` | 确认后扣款，余额与流水一致 |
| 大额转账 | `test-03-transfer-mfa.test.ts` | 红色权限要求多因子认证（MFA）；错码不扣款 |
| 提示词注入 | `test-04-prompt-injection.test.ts` | 用户输入不能绕过权限和验证码 |
| 执行失败 | `test-05-failure-report.test.ts` | 回复保留失败事实，不虚构成功 |
| 消费分析 | `test-06-spending-analysis.test.ts` | 分类金额来自已入账流水 |
| 异常检测 | `test-07-anomaly.test.ts` | 异常结果来自交易数据 |
| 卡片限额 | `test-08-card-limit.test.ts` | 用户确认后修改限额 |
| 理财操作 | `test-09-investment-mfa.test.ts` | 申购经过红色权限和 MFA |
| 熔断锁定 | `test-10-circuit-breaker.test.ts` | 连续错码锁定执行，并保存审计 |
| 条件计划 | `test-11-conditional-dag.test.ts` | 依赖和条件控制后续节点 |
| 生日计划 | `test-12-birthday-plan.test.ts` | 预算和计划记录不代表实际资金冻结 |

`mock-integration.test.ts` 检查完整离线处理流程。
离线测试不需要 API Key。

## 模型适配器回归

适配器测试使用受控请求与测试密钥。
测试检查请求格式，不证明真实模型可用。

| 测试入口 | 检查内容 |
| --- | --- |
| [运行时适配](../../tests/unit/agent/providers/provider-runtime.test.ts) | 原生服务商与 `model`、`streamFn` 配对 |
| [在线适配](../../tests/unit/agent/providers/provider-live.test.ts) | 自定义服务商地址、鉴权和注册模型 |
| [模拟适配](../../tests/unit/agent/providers/provider-mock.test.ts) | 独立脚本模型，不联网 |
| [消息配对](../../tests/unit/agent/message-normalize.test.ts) | 授权结果对应原工具调用 |

## 金融与授权回归

金融回归同时检查输入、计算、入账和执行回执。

| 检查对象 | 必须保持的结果 | 测试入口 |
| --- | --- | --- |
| 金额输入 | JSON 金融值使用十进制字符串；入账金额拒绝分以下小数 | [金融值](../../tests/unit/financial-values.test.ts) |
| 金融计算 | 入账金额使用整数分；利率和未结算估值保留 Decimal 精度 | [投资精度](../../tests/unit/banking-sdk/investment-precision.test.ts) |
| 赎回结算 | 按 HALF_UP 规则结算 1 次；报价变化要求重新授权 | [投资流程](../../tests/unit/banking-sdk/investment-flow.test.ts) |
| 重复转账 | 重复或并发确认只产生 1 笔扣款 | [转账重放](../../tests/integration/transfer-replay.test.ts) |
| 写入事务 | 业务、流水、执行回执和必需审计一起提交或回滚 | [执行审计](../../tests/integration/execution-audit.test.ts) |
| 执行回执 | 回执匹配用户、原请求和账本；身份复用但参数变化时拒绝 | [转账回执](../../tests/integration/transfer-receipts.test.ts) |
| 提交校验 | 先提交的取消阻止后续写入；先提交的交易保留事实 | [事务提交校验](../../tests/integration/sdk-transaction-fences.test.ts) |
| 授权摘要 | 累计转账升级红色权限后，摘要和验证入口一致 | [授权与澄清](../../tests/integration/decision-guidance.test.ts) |
| 卡片与持仓 | 保存月限额，拒绝歧义持仓，保留原赎回报价 | [卡片与持仓回归](../../tests/integration/frontend-followup-fixes.test.ts) |

`annualYieldRate` 是无量纲比例。
仅展示时转换为百分数。
入账金额还受有符号 64 位整数范围限制。

## 持久化与进程恢复回归

恢复测试检查原身份和原资金事实。
完成状态本身不能替代金融回执。

| 检查对象 | 预期行为 | 测试入口 |
| --- | --- | --- |
| Pi 事件 | 生命周期和流式事件按运行序号持久化 | [持久化集成](../../tests/integration/agent-durability.test.ts) |
| 模型检查点 | 保留原请求、次数上限和退避时间；拒绝过时 revision | [模型检查点](../../tests/integration/model-checkpoint-boundaries.test.ts) |
| 模型生成中断 | 从原请求重新生成；不执行半截工具调用 | [进程重启](../../tests/integration/process-restart.test.ts) |
| 完整模型决策 | 执行原调用标识和参数，不重建原决策 | [进程重启](../../tests/integration/process-restart.test.ts) |
| 已提交写入 | 核对原回执后恢复原结果，不重复业务和审计 | [已提交结果](../../tests/integration/committed-outcomes.test.ts) |
| 等待授权 | 保留原确认或 MFA，不替用户授权 | [恢复授权](../../tests/integration/recovery-authorization.test.ts) |
| 工作流子调用 | 保存父调用、节点和执行键；显式重试仍需授权 | [工作流调用](../../tests/integration/workflow-invocations.test.ts) |
| 原图恢复 | 复用原图和已完成节点；保留暂停、取消和人工核对状态 | [独立工作流重启](../../tests/integration/standalone-workflow-restart.test.ts) |
| 失效执行者 | 失去执行租约后，不能提交资金或覆盖结果 | [旧执行者](../../tests/integration/obsolete-executor.test.ts) |
| 恢复 worker | 限制批次数量，隔离单运行失败，退出时等待当前执行完成 | [恢复 worker](../../tests/unit/agent/recovery-worker.test.ts) |

`process-restart.test.ts` 使用真实子进程。
测试在指定执行点发送 `SIGKILL`。
新子进程从数据库恢复原运行。
测试提前设置租约到期，省去到期等待时间。
模型传输受控；Pi、权限和银行事务使用项目代码。

浏览器故障夹具只构造持久化故障状态。
浏览器故障夹具不证明页面触发了真实进程崩溃。

## 计划、回复与界面回归

多步需求必须先保存覆盖全部显式步骤的计划。
计划采用有向无环图（DAG）表示依赖关系。
预检拒绝漏步、重复、对象替换和金额错配。
执行时再次检查本人资源、权限和报价。

| 检查对象 | 预期行为 | 测试入口 |
| --- | --- | --- |
| 完整计划 | 不完整计划不能先创建预算、授权或转账 | [多步计划](../../tests/integration/live-complete-plan.test.ts) |
| 否定与持仓 | 附加否定保留正向步骤；赎回绑定实际本人持仓 | [请求范围与持仓](../../tests/integration/request-scope-holdings.test.ts) |
| 暂停与取消 | 暂停阻止后续节点；取消撤销待处理授权 | [任务控制](../../tests/integration/task-feature-hardening.test.ts) |
| 金融回复 | 只使用服务端业务事实；未知结果不变成成功或失败 | [回复边界](../../tests/integration/financial-response-boundary.test.ts) |
| 实体与页面 | 资源歧义拒绝；异常详情绑定所选流水 | [前端回归](../../tests/integration/frontend-review-fixes.test.ts) |
| 澄清 | 保留已提供产品；拒绝模型伪造状态和金额 | [授权与澄清](../../tests/integration/decision-guidance.test.ts) |
| 模型请求 | 截止时间覆盖停滞流；传输重试有上限；用户取消不重试 | [请求限制](../../agent/providers/request-options.test.ts) |
| 规划重试 | 未执行业务时保留重试入口；新消息使旧入口失效 | [规划恢复](../../tests/integration/live-recovery.test.ts)、[重试界面](../../tests/integration/live-retry-ui.test.ts) |

计划预检不保证整张图原子成功。
后续节点失败不会撤销已入账交易。
人工核对测试见[人工核对 HTTP 测试](../../tests/app/manual-review-http.test.ts)。
调度测试见[定时派发 HTTP 测试](../../tests/app/scheduled-dispatch-http.test.ts)。
操作说明见[人工核对](manual-review.md)和[定时任务](scheduled-tasks.md)。

## 浏览器验收

离线浏览器入口使用系统 Chrome。
找不到 Chrome 时尝试 Edge。
`E2E_BROWSER_PATH` 可指定浏览器可执行文件。
入口选择空闲端口，并启动实际 Next.js 开发服务。
验收结束时关闭浏览器和服务进程树。

当前离线入口注册以下 10 条流程。

| 流程标识 | 主要证据 |
| --- | --- |
| `a-transfer-confirm` | 确认、余额变化和 1 笔新增扣款 |
| `b-transfer-mfa` | 错码不扣款；正确码完成原操作 |
| `c-plan-pause-resume` | 暂停、继续和已完成节点保留 |
| `d-plan-cancel` | 取消后旧确认被拒，资金和限额不变 |
| `e-refresh-action-recovery` | 刷新恢复黄色确认和红色验证 |
| `f-wedge-refresh-recover` | 已提交但未结束的操作恢复，扣款不重复 |
| `g-manual-handoff` | 人工核对刷新保留；继续后仍需授权 |
| `h-investment-flow` | 申购和赎回的持仓、余额及流水一致 |
| `i-anomaly-detection` | 收入不当作异常消费，显示种子异常消费 |
| `j-circuit-breaker-lock` | 刷新后保持锁定；正确解锁留下审计 |

每条流程输出 `PASS`、`FAIL` 或 `SKIP`。
任何 `FAIL` 使入口返回非零退出码。
`SKIP` 不使入口失败，也不算验收通过。
入口见[离线浏览器验收](../../tests/e2e/acceptance.e2e.ts)。

## 真实模型验收

真实模型验收使用 DeepSeek，银行和 MFA 仍为模拟。
入口通过 Next.js 环境加载器使用本地配置。
不得直接读取或显示 `.env.local` 内容。
真实模型请求可能产生费用。

```sh
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
LIVE_SCENARIOS=1,3 pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

`LIVE_SCENARIOS` 选择场景编号。
未设置时执行入口注册的全部场景。
默认保留配置中的模型标识。
`LIVE_FORCE_MODEL` 可显式覆盖模型标识。
覆盖后必须在验收记录中写明模型标识。
入口见[真实模型浏览器验收](../../tests/e2e/live-acceptance.e2e.ts)。

故障注入验收区分错误响应和成功响应来源。
HTTP 503 注入用于检查故障处理。
脚本生成的成功响应仍属于受控模型证据。
正常请求转发至 DeepSeek 时，记录真实上游请求数。

## 验收证据与限制

验收记录至少包含以下信息。

1. 记录提交标识、运行命令和退出码。
2. 记录模型来源、模型标识和实际场景范围。
3. 保存 `PASS`、`FAIL`、`SKIP` 数量及原因。
4. 保存页面证据和操作标识。
5. 核对操作前后的余额、流水、执行回执和审计。
6. 核对刷新和重复操作后是否新增业务记录。
7. 记录模型请求数，区分重新规划和原操作继续。
8. 记录隔离库路径、配置覆盖和故障注入方式。

历史报告记载过真实 DeepSeek 的专项浏览器验收。
场景包括转账、赎回、开卡、解锁和多步计划。
历史验收属于当时提交和指定输入的证据。
历史金额存储、测试总数和构建结果不能代表当前版本。
当前版本是否通过，以重新执行的结果为准。

离线回归检查应用对指定响应的行为。
真实模型验收也不能穷举自然语言表达。
这两类验收都不证明真实银行或短信接入。
多实例部署、跨浏览器、负载和无障碍需另行验收。
开发服务的浏览器通过不替代生产构建验证。
