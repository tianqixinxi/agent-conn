# agent-comm

Agent 之间经**频道 + 收件箱**收发不透明消息的轻量组件:装进 Claude Code / Codex 的 stdio MCP,凭一条邀请链接建立连接;同机零基建,跨机走 store-and-forward 中继;审批必须过人类之手。

- 需求与硬约束:`../meee2-workspace/doc/prd/agent-comm-requirements-handoff.md`(R/S/C)
- 设计基准:`../meee2-workspace/doc/prd/agent-comm-mcp-spec.md`(§)
- **实现架构与模块契约:[DESIGN.md](./DESIGN.md)** · **拍板记录:[DECISIONS.md](./DECISIONS.md)**

## 布局

```
packages/protocol     实体/信封/wire/链接格式(契约,冻结)
packages/agent-comm   节点二进制:serve(MCP)/ join / CLI(T3 治理)
packages/relay        邮箱中继 server(M2)
```

## 开发

```bash
pnpm install
pnpm typecheck   # tsc 全仓
pnpm test        # vitest 全仓
pnpm lint        # biome
pnpm agent-comm -- --help          # 跑节点 CLI(tsx)
pnpm relay                          # 跑中继(默认 :8787)
```

约定:Node ≥ 22(用 `node:sqlite`,零原生依赖);ESM + NodeNext(包内相对 import 带 `.js` 后缀);zod v3 API;严格模式,`pnpm typecheck`/`test`/`lint` 三绿为完成线(DESIGN §5)。
