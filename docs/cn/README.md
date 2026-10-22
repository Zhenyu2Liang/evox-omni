# 开发文档

首次运行项目，先读[开发指南](development.md)。
修改业务前，读[架构设计](architecture.md)。
文档中的名称按[术语表](terms.md)使用。

## 按任务选择文档

| 任务 | 文档 |
| --- | --- |
| 查看已实现业务、使用入口和竞赛场景覆盖 | [已实现功能说明](implemented-features.md) |
| 安装、配置模型或启动服务 | [开发指南](development.md) |
| 通过微信与银行智能体对话 | [微信通道](weixin.md) |
| 核对依赖版本或升级开发工具 | [依赖版本与升级](development.md#依赖版本与升级) |
| 查找模块职责和请求执行流程 | [架构设计](architecture.md) |
| 修改事件日志、重试或崩溃恢复 | [持久化与恢复](agent-durability.md) |
| 修改对话归档、Pi 官方压缩或原话搜索 | [上下文压缩](context-compaction.md) |
| 修改金额、利率、估值或结算 | [金融数值与结算](financial-values.md) |
| 修改业务卡片、工具进度或开发者详情 | [对话业务卡片](chat-presentation.md) |
| 修改卡片增删、结算账户绑定或余额展示 | [卡片管理](card-management.md) |
| 修改收款人或卡片的选择、号码脱敏边界或号码补全 | [号码与卡片身份解析](identity-resolution.md) |
| 判断字符串匹配是否参与业务决策 | [字符串匹配审查](string-matching-review.md) |
| 修改工具参数、报错或模型可见结果 | [银行工具契约](tool-contracts.md) |
| 升级 Pi 或修改流、钩子和工具消息 | [Pi 接口适配](pi-integration.md) |
| 修改权限、确认、认证或审计 | [安全设计](security.md) |
| 区分普通操作记录与开发者操作审计 | [安全设计](security.md#操作记录与操作审计) |
| 在开发者模式模拟后台核对 | [人工核对](manual-review.md) |
| 修改到期提醒或定时转账 | [定时任务](scheduled-tasks.md) |
| 运行测试或判断验收证据 | [测试指南](test-cases.md) |
| 判断模拟能力和部署条件 | [当前限制](known-risks.md) |
| 为项目新增或更新文档 | [文档维护规则](CONTEXT.md) |

## 代码与需求入口

- [项目 README](../../README.md)提供简介和启动命令。
- [赛题要求](../../req.md)提供比赛评估背景。
- [接口契约](../../lib/contracts)定义字段和工具规则。
- [数据库 schema](../../prisma/schema.prisma)定义持久化记录。
- [仓库上下文](../../CONTEXT.md)提供代码目录的维护入口。

功能是否可用，以代码和可重复测试为准。
当前指南描述受支持的契约与限制。
历史修复过程和旧验收数量可查 Git 历史。
