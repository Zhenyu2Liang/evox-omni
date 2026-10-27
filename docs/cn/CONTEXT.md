# 文档维护规则

## 适用范围

本规则用于维护 `docs/cn/`。
开发者与 AI 修改文档时，必须遵守本规则。

正文必须使用中文。
正文必须遵守 [STC 技能](../../.agents/skills/stc/SKILL.md)。
代码、命令、文件路径和接口名必须保留准确写法。
代码与注释的语言约定见用户或项目指令。

## 内容归属

每个规则必须只在 1 份专题文档中解释。
其他文档必须链接对应专题。

| 内容 | 文档 |
| --- | --- |
| 文档入口 | [README.md](README.md) |
| 已实现业务、使用入口和竞赛场景覆盖 | [implemented-features.md](implemented-features.md) |
| 名称与定义 | [terms.md](terms.md) |
| 环境、命令、数据库操作 | [development.md](development.md) |
| 模块职责与执行顺序 | [architecture.md](architecture.md) |
| 事件、检查点、重试与恢复 | [agent-durability.md](agent-durability.md) |
| 金融单位与结算 | [financial-values.md](financial-values.md) |
| 理财净值、份额与收益口径 | [investments.md](investments.md) |
| 卡片增删、结算账户绑定与余额展示 | [card-management.md](card-management.md) |
| 号码与卡片的身份判定、候选筛选、完整号码边界与补全 | [identity-resolution.md](identity-resolution.md) |
| 工具参数、报错与模型可见结果 | [tool-contracts.md](tool-contracts.md) |
| 字符串匹配是否参与业务决策 | [string-matching-review.md](string-matching-review.md) |
| 对话卡片与调用详情 | [chat-presentation.md](chat-presentation.md) |
| 对话归档、上下文压缩与原话搜索 | [context-compaction.md](context-compaction.md) |
| 权限、认证与审计 | [security.md](security.md) |
| 人工接管与证据处理 | [manual-review.md](manual-review.md) |
| 定时任务与提醒 | [scheduled-tasks.md](scheduled-tasks.md) |
| 微信登录、对话和确认命令 | [weixin.md](weixin.md) |
| Pi 版本与接口适配 | [pi-integration.md](pi-integration.md) |
| 测试方法与证据范围 | [test-cases.md](test-cases.md) |
| 模拟能力与未验证条件 | [known-risks.md](known-risks.md) |

项目根目录的 `README.md` 必须保留项目入口职责。
详细开发说明必须放在 `docs/cn/`。

## 事实与措辞

- 改动契约时，必须同时更新对应专题。
- 描述功能时，必须区分已提供、模拟和未验证能力。
- 引用测试结果时，必须写清执行范围和证据来源。
- 不得把旧验收数量写成当前测试结果。
- 新增名称前，必须检查并更新术语表。
- 用户只需当前说明时，不得新增重复修复报告。
- 代码不支持的旧格式，不得写成可用功能。
- 文档示例必须使用占位密钥。
- 不得读取或公开 `.env.local` 的凭据。

## 修改与核验步骤

1. 阅读对应代码和现有专题。
2. 检查重叠内容，确定信息归属。
3. 修改事实变化影响的段落。
4. 更新目录和引用路径。
5. 检查句意、术语、单位与权限条件。
6. 运行 STC 检查命令。
7. 核验源码路径与文档链接。

普通专题必须按 `for-document` 检查。
本规则必须按 `for-instruction-writing` 检查。
机器检查报告的错误必须修复。
Anti-Echo 疑点必须删除或记录具体保留理由。
机器检查的 G4「动作藏在套话里」与 G5「事实或数量不清楚」常被本仓库术语命中（「已实现收益」「已实现功能说明」「部分赎回」「实现见」），属误报，记录理由后保留。
文档变化后，必须重新核验疑点。
复核记录可保存到工作区的 `.pnpm-store/`。

```sh
node .agents/skills/stc/tools/cli.mjs check docs/cn/README.md --profile for-document --anti-echo
node .agents/skills/stc/tools/cli.mjs check docs/cn/CONTEXT.md --profile for-instruction-writing --anti-echo
```

临时文件必须保存在当前工作区。
文件日志位置必须遵守[仓库日志规则](../../CONTEXT.md#operation)。
删除旧文件前，必须将独有的有效事实写入专题。
删除旧文件后，必须更新全部引用。
