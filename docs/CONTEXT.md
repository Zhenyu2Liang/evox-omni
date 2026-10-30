# 文档目录

## Intent

开发者与使用者文档的唯一存放处。
中文文档保存在 `docs/cn/`，英文文档保存在 `docs/en/`。
代码、命令、路径与接口名保留原写法。
默认英文入口是 `docs/en/README.md`，中文入口是 `docs/cn/README.md`。

## Constraints

- 写作规则、内容归属与核验命令见 `docs/cn/CONTEXT.md`，修改任何专题前必须先读。
- 每个规则在同一语言中只在一份专题文档中解释，其他文档链接过去。
- 两套文档必须使用相同文件名，全文同步，并在顶部提供语言切换链接。
- 现状描述只写当前契约；变更史由 Git 历史承担。
- 不得读取或复制 `.env`、`.env.local` 或任何密钥。

## Routing Table

- `README.md`：文档入口，提供两种语言的目录链接。
- `docs/cn/`：中文开发文档全部主题（入口 `README.md`、术语 `terms.md`、写作规则 `CONTEXT.md`）。
- `docs/en/`：对应的完整英文文档，使用相同文件名与主题范围。
