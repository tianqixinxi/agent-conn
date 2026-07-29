# AgentComm 落地 Milestones

> Milestone 不以“写完某个模块”为完成，而以“真实用户完成真实工作”为完成。代码合并、测试通过和部署上线只是前置条件。

早期 v0.4.x 已经证明两个 Claude Code runtime 可以通过 Channel 连接、委派和回复；当前
v0.8.0 则完成了下列可扩展 foundation，但还没有证明它能在真实 coding team 中完全替代
人工拆解任务、处理 worktree/冲突和汇总 PR 结果。

## P0 foundation（已实现）

- runtime registry、显式 channelId 绑定、trusted auto-resume、heartbeat 和
  launchd/systemd 用户服务；
- Claude Native/Print、Codex App Server/Exec、通用 process adapters 与 outcome 回传；
- application registry/catalog、create/validate/test/search/install/inspect/enable/update/
  disable/remove 生命周期；
- application reducer `resume`：Harness 结果由社区协议翻译为协议原生事件；
- `manager-workers/v1` 与 `request-response/v1` reference applications；
- 本机双 runtime 跨 Harness A2A E2E 与 application protocol E2E；
- transport/application/harness/model/system 五层 benchmark runner、suite 与比较报告。

这完成的是可扩展产品地基，不代表 Milestone 1 的真实 coding team 验收已经完成。

## 架构收口：进入 Milestone 1 前的地基

现有 TransportBinding、Local/HTTP relay 和 E2E 继续使用，不先替换 transport。为了避免把
Milestone 1 的 manager/worker 行为继续写死在 Claude Channel bridge，下列 foundation
已于当前实现完成（逻辑边界和物理包入口均已建立）：

- Communication Core、Agent Application Protocol Foundation/Community Client、Agent
  Harness 三个责任面不交叉依赖。
- A2A 作为默认 application foundation；声明式 extension manifest 和 client SDK 支持社区
  独立维护 application。
- 每次 harness 运行生成 `runtimeInstanceId`，并能恢复同 profile 的历史 application state。
- application event 通过 reducer + effect journal 处理，ACK 不再代表 task 已完成。
- `DeliveryHoldDecision`、`TaskAuthorization` 和 `HostPermission` 使用不同对象和操作。
- terminal/informational event 自动提交和 ACK，不唤醒模型产生回复。

这批工作不能被“NATS、更强 relay 或更聪明模型”替代。当前自动化测试已经覆盖 runtime
归因、重复投递、审批与 task 归属、terminal 吸收、重启恢复和 manager-workers reference
flow。Milestone 1 仍需完成真实 Claude worker 生命周期、worktree 和三个真实 repo task；
foundation 通过不等于产品 milestone 通过。

## Milestone 1：一个 Claude 管理本机 Claude 团队

### 要解决的问题

一个工程师在本机同时运行多个 Claude Code 时，不应该自己充当消息总线和项目经理。工程师只和一个 manager Claude 沟通，由它管理本机所有通过 AgentComm 启动或接入的 worker Claude。

这里的“所有 Claude Code”指所有明确接入 AgentComm local harness 的 runtime；不能扫描、接管或向无关 Claude 会话注入消息。

### 真实验收场景

用 `claude2` 作为 manager，在 AgentComm 仓库中完成一个真实功能：

1. manager 启动或发现两个 worker。
2. manager 把实现和测试/review 分配给不同 worker。
3. worker 在隔离 worktree 中自动执行并持续报告状态。
4. manager 处理依赖关系、冲突和返工，最后汇总可验收的代码、测试结果与风险。
5. 用户只需要描述目标，以及批准真正需要权限的动作。

### 必须补齐

- 本机 runtime registry 已覆盖身份、Harness、显式频道、状态和 last seen；仍需补当前
  coding task/worktree/artifact 的产品视图。
- local harness 已覆盖启动、接入、停止、重启和结果回传；仍需补隔离 worktree 生命周期。
- manager 可以按能力选择空闲 worker，而不是让用户指定 profile/messageId/channel。
- worker 自动接收和执行安全任务；进程重启后恢复未完成任务。
- `manager-workers/v1` 作为第一个独立 reference application，使用公开 extension 规范和
  client SDK 实现，不把 manager 逻辑加入 AgentComm core 或 transport。
- 每个 coding task 绑定独立 worktree，manager 能看到产物、测试结果和冲突。
- 一个面向 manager 的高层控制面；不向模型暴露 poll、ACK、cursor、transport 等工具。

### 完成线

- 从一个干净终端用一条命令启动 manager + 2 个 worker。
- 完成至少 3 个真实 repo tasks，其中至少一个包含 review 后返工。
- 全程不复制邀请链接、不手工转述消息、不手工轮询 inbox。
- 杀掉一个 worker 后重新启动，任务可恢复且不产生重复提交或重复副作用。
- 普通协作消息不打断用户；只有宿主权限、AUTH_REQUIRED 或治理决定需要人处理。
- manager 最终给出可点击的 diff/commit、测试结果和每个 worker 的贡献记录。

### 明确不做

- 跨工程师身份和权限。
- 公网 Relay 扩容。
- NATS、SLIM、swarm 或 debate 协议。

---

## Milestone 2：生产环境中的两个工程师协作

### 要解决的问题

两个工程师各自拥有自己的 Claude Code 和本地权限。双方不再通过聊天软件复制 prompt、代码片段和进度；两个 manager 通过生产 `https://connect.meee1.com` 协调工作，同时权限仍归各自工程师控制。

### 真实验收场景

选择一个真实 GitHub issue 或小功能，由工程师 Alice 和 Bob 完成：

1. Alice 创建一次项目 Channel，Bob 冷启动安装并加入；后续不再重复邀请。
2. Alice 的 manager 把实现任务交给 Alice 的 worker。
3. 实现完成后，通过 commit/PR artifact 自动交给 Bob 的 manager。
4. Bob 的 worker 自动 checkout、运行测试并 review，返回结构化意见。
5. Alice 的 worker 根据意见修改，Bob 复验。
6. merge、发布或云资源操作只通知拥有相应权限的工程师批准。

### 必须补齐

- 生产 Channel 的受控 auto-resume：只恢复用户明确信任的项目频道，不能激活全部历史 membership。
- runtime 身份能表达“属于哪个工程师/设备”，但不共享工程师的本机凭据。
- 任务 artifact 使用 commit、PR、测试报告或可下载文件，不依赖对方机器上的本地绝对路径。
- repo 协作最小协议：proposal、claim、progress、patch ready、review decision、changes requested、completed。
- 跨工程师 TaskAuthorization 只传结构化 scope/receipt；它不能授予对方机器的
  HostPermission。
- 离线积压、重连、重复投递和跨时区 handoff。
- 生产 Relay 的远程治理闭环、审计记录、基本配额和滥用保护。
- 新用户在 10 分钟内完成安装、频道信任和第一次任务，不需要项目维护者远程排错。

### 完成线

- 两名真实工程师在生产 Relay 上连续完成至少 3 个真实 PR，而不是 demo fixture。
- 至少一次工程师离线后由另一方继续工作，并在上线后自动收到完整结果。
- 不通过微信、Slack 或人工复制粘贴转述 agent 工作内容；外部聊天只用于故障兜底。
- 90% 以上普通 Channel 事件自动处理；所有实际权限动作都由正确的工程师批准。
- 没有任务丢失、重复 merge、越权执行或私有内容出现在 public API。
- 每个 PR 都能导出一条人类可读的协作时间线：谁委派、谁执行、谁 review、谁批准。

### 生产验证顺序

1. 先用同一人的两个全新 profile 在生产 Relay 做 smoke test。
2. 再邀请第二名工程师完成一个非关键 issue。
3. 连续完成 3 个 PR 后才宣布 Milestone 2 完成。

### 明确不做

- 组织级 SSO 和复杂 RBAC。
- 多区域部署。
- 为了“看起来可扩展”提前替换 HTTP transport。

---

## Milestone 3：一个小团队完成一周真实开发

### 要解决的问题

证明 AgentComm 不只适合两个人的一次交接，而能让 3–5 名工程师和各自的 agent 在一个真实项目中持续协作，同时不会制造更多协调成本。

### 真实验收场景

一个小团队用 AgentComm 完成一周的真实迭代：任务拆分、并行认领、依赖交接、代码 review、返工、发布审批和结果回顾都通过项目 Channel 发生。

### 必须补齐

- 从前两个 milestone 的真实 trace 中形成社区可独立实现和维护的
  `repo-maintenance/v1` extension，而不是把它写入 AgentComm core。
- 多任务 claim、owner、依赖、冲突检测和取消语义。
- 团队级角色和审批路由；agent 不能把一个工程师的授权转交给另一个工程师。
- 人类可读项目页面：active agents、任务状态、阻塞、artifact、审批和历史。
- retention、moderation、搜索和审计导出。
- 与 GitHub issue/PR 状态建立稳定映射，但 GitHub 不是 AgentComm transport。

### 完成线

- 3–5 名工程师连续使用 5 个工作日，完成至少 10 个真实任务。
- 团队负责人无需逐个询问 agent/工程师即可看到当前 owner、进度和阻塞。
- 同一任务不会被多个 worker 无意重复实现；有意并行时能明确聚合结果。
- 相比团队原有方式，人工转述次数显著下降，并有 trace 数据证明。
- 安全审批零越权，失败任务和离线 runtime 都能被明确发现并恢复。

---

## Milestone 4：把实践沉淀为协议和 Benchmark

### 要解决的问题

前三个 milestone 证明产品有用之后，再回答哪些协作方式、harness 和模型组合更有效，并让第三方能够复现。

### 真实验收场景

把 Milestone 1–3 中脱敏的真实任务整理为 benchmark，对比：

```text
application extension/client × agent harness × model/configuration
```

transport 可靠性和性能单独测量，不把网络失败算成模型能力失败。

### 必须补齐

- 版本化 application extension、conformance runner 和 trace replay。
- transport、protocol conformance、end-to-end 三套指标分开报告。
- repo task 数据集、自动 evaluator、成本/耗时/人工中断指标。
- single-agent、manager-workers、two-engineer 三组基线。
- workflow、swarm、debate、auth grant 只有在真实 workload 有需要时才形成社区
  application extension。

### 完成线

- benchmark 能回答“提升来自协议、harness 还是模型”，而不只是给总分。
- 第三方仅凭公开协议和 fixture 可以复放至少一个完整协作任务。
- 新 application/client 必须在真实任务上优于或补足现有方式，才进入推荐社区索引。

---

## 当前决策

当前只启动 **Milestone 1**。Milestone 1 没有完成前，不投入 NATS、多区域、通用 swarm/debate 或大规模公开频道建设。

Milestone 2 是第一个生产产品验证点；它的完成标准不是“Relay 已部署”，而是“两个真实工程师通过生产 Relay 连续完成 3 个真实 PR”。

应用协议扩展的近期范围也受同一约束：先用独立 reference application 完成
`manager-workers/v1`，再从 Milestone 2/3 真实 trace 形成社区维护的
`repo-maintenance/v1`。AgentComm 只提供声明式规范、client SDK 和 conformance，不提前
发布一个可以远程下载任意协议代码的插件市场，也不在没有 workload 证据时实现通用
workflow/swarm/debate。
