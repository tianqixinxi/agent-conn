# agent-comm 实现架构

> 上游:`../meee2-workspace/doc/prd/agent-comm-mcp-spec.md`(设计基准,§ 编号出处)+ `agent-comm-requirements-handoff.md`(R/S/C)。偏离与拍板见 `DECISIONS.md`(D 编号)。
> 本文是实现的**模块契约**:每个模块的职责、公开面、依赖规则。契约(`packages/protocol` + 各模块 `api.ts`)由架构侧维护,实现方**不得擅改契约**——需要改时在 PR/汇报中提出。

## 1. 总览

一句话:`agent-comm` 是装进 Claude Code / Codex 的 stdio MCP,让 agent 之间经**频道 + 收件箱**收发不透明消息;每个 **profile**(本地 SQLite store + Ed25519 keypair)是一个身份(D1);频道的**家**(排序权威)要么是本机共享 hub 文件(`local:`,D5),要么是远端 relay(M2);所有投递都是**从家拉取**:游标 + `messageId` 去重 + 家内单调 `seq` 全序(C5)。

```
┌─ 机器 A ────────────────────────────────┐
│ profile "default"        profile "bob"  │        ┌─ relay(M2)─────────┐
│ ┌─────────────┐         ┌────────────┐  │  HTTPS │  频道日志(密文)+seq │
│ │ store.db    │         │ store.db   │  │  出站  │  成员表/邀请兑换     │
│ │ identity    │         │ identity   │  │ ─────► │  游标/retention     │
│ └──┬──────┬───┘         └──┬─────────┘  │  (sync)│  限流(破冰)         │
│    │serve │cli             │serve       │        └────────────────────┘
│    ▼      ▼                ▼            │
│  ┌────────────────────────────────┐     │   serve = MCP stdio(宿主起)
│  │ local-hub.db(local 频道的家)   │     │   cli   = 人类治理/诊断(T3)
│  │ 频道日志 + seq + held 消息      │     │   投递 = 成员从家拉进自己 inbox
│  └────────────────────────────────┘     │
└─────────────────────────────────────────┘
```

关键不变量(所有模块必须维护):

- **I1 payload 不透明**(C1):除 L1 可选 intents 外,任何模块不解析/校验 `payload`/`contentType`/`card` 内容。
- **I2 一频道一家**(§2.2):`seq` 只由家赋;成员侧永不生成 seq。
- **I3 at-least-once + 幂等**(C5):跨边界写全部以 `messageId` 幂等;重复拉取/上行必须安全。
- **I4 人类门不给 agent**(C3/§6):T3 动作只存在于 CLI 与 elicitation 响应路径,MCP 工具面不暴露。
- **I5 文件即状态**(C5):serve/cli 进程随时可死,不丢数据;无必需常驻进程,不装定时任务(D8)。
- **I6 审计 append-only**(R9):连接/投递/held/drop/edit 全记 `audit` 表。

## 2. 包结构与依赖规则

pnpm workspace,3 个包(D4/D7):

```
packages/
├── protocol/     @agent-comm/protocol   实体/信封/wire/链接格式/错误码(Zod + 类型)
├── agent-comm/   agent-comm             节点二进制:serve(MCP)/join/cli,内部模块见 §3
└── relay/        @agent-comm/relay      邮箱中继 server(Hono),M2 主体、M1 出契约
```

依赖方向(**只允许向下**):

```
agent-comm/mcp ──┐
agent-comm/cli ──┼──► agent-comm/engine ──► agent-comm/store ──► protocol
agent-comm/sync ─┘         │                                        ▲
agent-comm/crypto ◄────────┘                 relay ─────────────────┘
```

- `protocol` 不依赖任何包;`relay` 只依赖 `protocol`(与节点代码零共享实现)。
- `mcp`/`cli` 是**薄适配器**:不写业务逻辑,只做 IO 变换 + 调 `engine` 公开 API。
- `engine` 不 import `mcp`/`cli`/`sync` 的实现;对家的访问经 `HomeDriver` 接口(local 驱动在 engine 内,relay 驱动由 `sync` 注册进来)。
- 跨模块只许 import 对方的 `api.ts`/`index.ts` 公开面。

## 3. 模块职责与边界

| 模块(目录) | 职责(唯一职责) | 公开面 | 不做(边界) | 里程碑 |
|---|---|---|---|---|
| `protocol/src` | 实体与信封 Zod schema(D1 后字段)、wire 协议(§2.4 三端点 + 限流错误)、邀请链接格式(`https://<relay>/j/<t>#k=` 与 `agentcomm-local:`)、错误码、id 生成与校验 | 全部导出 | 无 IO、无状态、不依赖 node 内建以外任何运行时 | M1 |
| `agent-comm/config` | profile 解析(`--profile`/env/默认,**禁 cwd 派生**,D1)、路径布局(`~/.agent-comm/profiles/<name>/`)、默认值(inbox cap、hub 路径) | `resolveProfile()` | 不碰 db | M1 |
| `agent-comm/store` | 单 store 的 SQLite 持久层:DDL、迁移、各实体 repo(channels/members/messages/inbox/peers/identity/sync_state/audit/invites)、WAL 并发 | `openStore()` + 各 repo 接口 | 无业务规则(不判权限/不算投递);不出网 | M1 |
| `agent-comm/engine` | L0 业务核心:频道 CRUD、邀请铸造/兑换、send 管道(成员校验/信封组装/交给家)、**sync 循环**(对每频道从家拉→inbox 去重落库→ack 游标)、intercept 判定、replyBy 过期、inbox cap 驱逐、audit 记录;`LocalHomeDriver`(共享 hub 文件:赋 seq/成员表/held) | `api.ts` 的 `Engine` 接口 + `HomeDriver` 接口 | 不解析 payload(I1);不做 MCP/CLI IO;relay 网络访问只经注入的 `HomeDriver` | M1 |
| `agent-comm/crypto` | NodeIdentity 生成/加载(Ed25519,私钥文件 0600)、relay 请求签名(M2)、E2E 加解密(AES-256-GCM,M2)、e2eKey 本地保存 | `identity.ts`/`e2e.ts` | 不碰 store 之外的状态;不发明协议(格式定义在 protocol) | M1 骨架/M2 全量 |
| `agent-comm/sync` | `RelayHomeDriver`:实现 §2.4 三端点客户端(批量上行/long-poll 下行/ack)、outbox 断网重试、SSE 存活期推送、E2E 封装(调 crypto) | `createRelayDriver()` | 不直接写 inbox(把消息交回 engine 落库);不管 UI | M2 |
| `agent-comm/mcp` | `agent-comm serve`:stdio MCP server,12 工具(§5 表,D3 后 send 全 T1)→ 映射到 Engine;intercept 消息的 **elicitation** 放行(§7.1);MCP notification(SSE 到货时) | `runServe()` | 工具 handler 里**零业务逻辑**;T3 动作不注册为工具(I4) | M1 |
| `agent-comm/cli` | 人类面:`init`/`join <link>`/`invite`/`channels`/`peers`/`inbox`/`send`(人工注入,`injectedByHuman`)/ T3 `deliver|hold|drop|edit|mode|audit`/`doctor`;R10 的 join 引导(检测宿主、写 mcp 配置) | `runCli()` | 不绕过 engine 直写 db;join 不写宿主持久指令、不装定时任务(D8) | M1(join 的 relay 部分 M2) |
| `relay/src` | 邮箱中继:§2.4 三端点(HTTP)、节点注册/Ed25519 请求验签、`from` 盖戳(§2.3)、频道日志(密文)+seq、成员表、邀请兑换(joinToken 哈希)、retention(全员 ack 或 TTL 30d)、破冰限流(D3.2)、`/j/<token>` 引导页(**不读 fragment**,§2.8) | HTTP API(契约在 protocol/wire) | 不解密、不解析 payload(I1);无审批服务(M3 另立模块);无账号体系 | 契约 M1 / 实现 M2 |

## 4. 关键流程(权威描述)

**F1 send(agent, T1)**:mcp 工具 → `engine.send()`:校验发送方是频道成员、scope(canSendTo/contentTypes,来自兑换时的 InviteScope)、hop≤50 → 组信封(`messageId`、`traceId` 默认=自身、`from`=我的 alias)→ `home.append(envelope)`。local 家:事务内 `seq=MAX+1`,mode=intercept 时标 `held`;relay 家:入 outbox,由 sync 上行。返回 `{messageId, status}`。

**F2 read_inbox(agent, T1)**:mcp → `engine.readInbox()`:先对该 profile 所有频道跑一轮 `syncOnce()`(拉基线 §2.6)→ 按 filter 返回 inbox;`consume: true` 标记 consumedAt。`syncOnce()`:`home.pullAfter(cursor)` → 逐条:messageId 去重、replyBy 过期丢弃(audit)、目标含我(`to` = 我的 alias 或 `*`)则入 inbox → `home.ack(seq)` 更新游标。

**F3 invite/join(人工门,T2)**:`create_invite` → engine 铸 Invite(local:token 存 hub;relay:POST relay 换 joinToken,M2),返回完整链接(e2eKey 只进 fragment)。`connect(link)` → 解析(protocol)→ local:открыть hub 文件、写成员表(alias 唯一)、初始化游标;relay:兑换 joinToken、注册 pubkey、落 e2eKey(M2)。T2 由宿主弹窗保障(D3.1),工具描述里写明后果。

**F4 intercept(人在环,§7.1)**:held 消息在家停住 → 成员 serve 在 sync 时发现 held 队列 → 对**收件侧人类**发 elicitation(accept/edit/reject)→ accept:家中标记 deliver、正常拉取;reject:标 dropped;全程 audit。无 serve 在线时用 CLI `agent-comm deliver|drop <messageId>`。v1 简化:任一人类成员的决定即生效(记录 actor),细化留 M3。

**F5 T3 治理(人类专属)**:CLI 直连 engine(`actor: 'human'`),`audit` 可查全量;这些动词**永不**出现在 MCP 工具列表(I4)。

## 5. 验收与测试

- 每模块:vitest 单测,**只测公开面**;store/engine 用临时目录真 SQLite(不 mock db);relay 用 supertest 式 HTTP 内存实例。
- 集成(M1 收口,architect 负责):`examples/daily-report.sh` —— 同机 3 profile(lead/alice/bob)建「daily」频道 → alice/bob send 简报 → lead read_inbox 汇总 → intercept 模式下 CLI 放行一条。跑通即 M1 验收(S2-lite)。
- 质量门:`pnpm -r typecheck` + `pnpm -r test` + `pnpm -r lint` 全绿才算完成;禁止 `any` 裸奔(biome/tsc strict)。
- `node:sqlite` 为 experimental:所有进程入口统一 `process.removeAllListeners('warning')` 前置过滤该警告(cli 输出整洁),测试不受影响。

## 6. 实现分工(sonnet 执行,architect 收口)

| 工单 | 负责目录/文件 | 依赖 |
|---|---|---|
| W1 store+engine | `agent-comm/src/{store,engine}` + `crypto/identity.ts`(engine 启动需身份) | protocol(已冻结) |
| W2 mcp+cli | `agent-comm/src/{mcp,cli}`(`mcp/tools.ts` 是契约,只读) | engine 的 `api.ts`(已冻结;测试用 fake Engine) |
| W3 e2e+sync | `agent-comm/src/crypto/e2e.ts` + `src/sync` | protocol/wire + `HomeDriver` 接口;签名经工厂注入的 `signRequest`,不依赖 W1 |
| W4 relay | `relay/src` + `relay/test` | protocol/wire(验签用 node:crypto 按 wire.ts 注释的 canonical 格式自实现,不 import 节点包) |

规则:只改自己负责的目录 + 对应测试;`package.json`/tsconfig/契约文件(`protocol/*`、`engine/api.ts`、`mcp/tools.ts`)由 architect 改;缺依赖或契约有问题→在最终汇报中提出,不擅自动。
