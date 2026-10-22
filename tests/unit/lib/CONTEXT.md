# 共享模块测试

## 范围

本目录覆盖身份键、输入摘要、金额和仓储条件更新。

- `ledger-keys.test.ts` 检查节点与转账的执行身份。
- `execution-receipt.test.ts` 检查回执标识与规范化摘要。
- `pendingAction.claim.test.ts` 检查原子认领与所有权。
- `contact.search.test.ts` 检查联系人查询。
- `prisma-cli-env.test.ts` 检查命令环境策略。
- `mask.test.ts` 守住 `lib/mask.ts` 是唯一脱敏实现：账号/卡号保留末 4 位且总长度不变、幂等、过短原样返回，手机号前缀 + `****` + 后缀、缺失值为空串，且 `lib/phone.ts` 的 `maskPhone` 与 `lib/mask.ts` 是同一函数引用。

其他工具和边界用例以目录中的测试文件为准。
计算期望值时，必须使用独立断言。
纯函数测试不访问数据库。
仓储测试使用隔离夹具。

运行：`pnpm exec vitest run tests/unit/lib`。
数据库规则见 [../../CONTEXT.md](../../CONTEXT.md)。
