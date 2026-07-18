# AgentComm 落地 Milestones

> Milestone 不以“写完某个模块”为完成，而以“真实用户完成真实工作”为完成。代码合并、测试通过和部署上线只是前置条件。

当前 v0.4.x 已经证明两个 Claude Code runtime 可以通过 Channel 连接、委派和回复，但还没有证明它能替代人工复制链接、转述任务、轮询进度和汇总结果。

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

- 本机 runtime registry：alias、能力、状态、当前任务、worktree、last seen。
- local harness：启动、接入、停止和重启 Claude worker。
- manager 可以按能力选择空闲 worker，而不是让用户指定 profile/messageId/channel。
- worker 自动接收和执行安全任务；进程重启后恢复未完成任务。
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

- 从前两个 milestone 的真实 trace 中固化 `repo-maintenance/v1`，而不是凭空设计通用协议。
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
collaboration profile × agent harness × model/configuration
```

transport 可靠性和性能单独测量，不把网络失败算成模型能力失败。

### 必须补齐

- 版本化 collaboration profile、conformance runner 和 trace replay。
- repo task 数据集、自动 evaluator、成本/耗时/人工中断指标。
- single-agent、manager-workers、two-engineer 三组基线。
- workflow、swarm、debate、auth grant 只有在真实 workload 有需要时才成为正式 profile。

### 完成线

- benchmark 能回答“提升来自协议、harness 还是模型”，而不只是给总分。
- 第三方仅凭公开协议和 fixture 可以复放至少一个完整协作任务。
- 新 profile 必须在真实任务上优于或补足现有方式，才能进入正式产品。

---

## 当前决策

当前只启动 **Milestone 1**。Milestone 1 没有完成前，不投入 NATS、多区域、通用 swarm/debate 或大规模公开频道建设。

Milestone 2 是第一个生产产品验证点；它的完成标准不是“Relay 已部署”，而是“两个真实工程师通过生产 Relay 连续完成 3 个真实 PR”。
