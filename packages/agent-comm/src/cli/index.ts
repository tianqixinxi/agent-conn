import type { ChannelMode } from '@agent-comm/core'
import { AgentCommError, isAgentCommError } from '@agent-comm/core'
import { Command, CommanderError } from 'commander'
import type { ProfilePaths } from '../config.js'
import { resolveProfile } from '../config.js'
import type { Engine } from '../engine/api.js'
import type { CliContext } from './context.js'
import { createCliContext, productionEngineFactory } from './context.js'
import type { HostEnv } from './host.js'
import { defaultHostEnv, detectHostRegistrations } from './host.js'
import { checkLine, printResult, summarizePayload } from './output.js'

/**
 * W2 实现处:CLI 伴侣(人类面,T3 + 引导;DESIGN §3)。commander 15。
 *
 * 命令树(全局 --profile <name>,--json;默认 profile = env AGENT_COMM_PROFILE 或 'default'):
 *   init                                     生成/加载身份(幂等),打印 nodeId
 *   join <link> [--alias <a>] [--register]   兑换邀请 + 打印(或 --register 时执行)宿主注册命令
 *   invite <channel> [--ttl <ms>] [--max-uses <n>]   铸邀请链接
 *   channels ls | create <name> <alias> [...] | mode <channel> <mode>
 *   peers <channel>
 *   inbox [--consume] [--channel] [--trace-id] [--content-type] [--limit]
 *   send <channel> <to> <text> [--content-type] [--reply-to] [--reply-by]   人工注入
 *   held [ls] [--channel]                    待放行消息列表
 *   deliver <messageId> / drop <messageId> / edit <messageId> --payload <json>   T3
 *   audit [--channel] [--since] [--limit]
 *   doctor                                   环境诊断,逐项 ✓/✗(即使 engine 起不来也要跑完)
 *
 * 退出码:成功 0 / AgentCommError 1 / 用法错误(commander 检测到的)2。
 * 人类操作 actor 一律 'human'(T3 方法在 engine 侧强制要求,见 engine/api.ts I4 注释)。
 *
 * 契约问题(engine.send 没有 injectedByHuman 参数):
 * SendInput 没有单独的 injectedByHuman 字段;这里的处理是让 actor='human' 本身承担这个语义
 * ——engine 组信封时可以从 actor 是否为 'human' 推出 MessageEnvelope.injectedByHuman,不需要
 * 调用方再显式传一遍。若 W1/architect 的设计不是这样,请在契约里加字段,这里再对应调整。
 */

export interface RunCliOptions {
  /** 测试注入:跳过生产的 createEngine(profile) */
  engineFactory?: ((profile: ProfilePaths) => Promise<Engine>) | undefined
  /** 测试用:覆盖 ~/.agent-comm 根目录 */
  rootDir?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  stdout?: ((chunk: string) => void) | undefined
  stderr?: ((chunk: string) => void) | undefined
  /** 测试注入:替换宿主探测/注册(join --register、doctor 的宿主 CLI 检查都用它) */
  hostEnv?: HostEnv | undefined
}

const MODES: readonly ChannelMode[] = ['auto', 'intercept', 'paused']

function parseMode(raw: string): ChannelMode {
  if (!(MODES as readonly string[]).includes(raw)) {
    throw new AgentCommError('INVALID_INPUT', `invalid mode: ${raw}(须为 ${MODES.join('|')})`)
  }
  return raw as ChannelMode
}

function parseIntOption(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) throw new AgentCommError('INVALID_INPUT', `not a number: ${value}`)
  return n
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<void> {
  process.removeAllListeners('warning')
  process.exitCode = 0

  const stdout = opts.stdout ?? ((chunk: string) => void process.stdout.write(chunk))
  const stderr = opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk))
  const hostEnv = opts.hostEnv ?? defaultHostEnv

  let ctx: CliContext | undefined

  const program = new Command()
  program
    .name('agent-comm')
    .description('agent-comm 人类操作面:身份 / 频道 / 收件箱治理 + T3 放行 + 宿主接入引导')
    .option('--profile <name>', 'profile 名(默认 AGENT_COMM_PROFILE 环境变量或 default)')
    .option('--json', '以可解析 JSON 输出结果', false)
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr })
    .showHelpAfterError(false)

  program.hook('preAction', async (thisCommand, actionCommand) => {
    // doctor 必须在 engine 起不来时也能跑完诊断,不走这条会硬抛的路径(见下方 doctor 命令自身实现)
    if (
      actionCommand.name() === 'doctor' ||
      actionCommand.name() === 'install-launcher' ||
      actionCommand.parent?.name() === 'app' ||
      actionCommand.parent?.name() === 'runtime' ||
      actionCommand.parent?.name() === 'daemon' ||
      actionCommand.parent?.name() === 'benchmark'
    ) {
      return
    }
    const globals = thisCommand.opts<{ profile?: string; json?: boolean }>()
    ctx = await createCliContext({
      profile: globals.profile,
      json: globals.json ?? false,
      rootDir: opts.rootDir,
      env: opts.env,
      engineFactory: opts.engineFactory,
      stdout,
      stderr,
      hostEnv,
    })
  })

  function requireCtx(): CliContext {
    if (!ctx) throw new Error('agent-comm: internal error: cli context not initialized')
    return ctx
  }

  function utilityProfile(): ProfilePaths {
    const globals = program.opts<{ profile?: string }>()
    return resolveProfile({
      profile: globals.profile,
      rootDir: opts.rootDir,
      env: opts.env,
    })
  }

  function utilityResult(value: unknown, human: string): void {
    const globals = program.opts<{ json?: boolean }>()
    stdout(globals.json ? `${JSON.stringify(value)}\n` : `${human}\n`)
  }

  // —— init ——
  program
    .command('init')
    .description('生成/加载本机身份(幂等),打印 nodeId')
    .action(async () => {
      const c = requireCtx()
      const identity = await c.engine.identity()
      printResult(c, identity, `nodeId: ${identity.nodeId}\npublicKey: ${identity.publicKey}`)
    })

  // —— join <link> ——
  program
    .command('join')
    .description('兑换邀请链接加入频道;并探测宿主给出 MCP 注册建议(默认只打印,不改宿主配置)')
    .argument('<link>', '邀请链接(https://…/j/<token>#k=… 或 agentcomm-local:…)')
    .option('--alias <alias>', '我在该频道内的别名(默认用 profile 名)')
    .option('--register', '探测到受支持的宿主(目前只有 Claude Code)时真的执行注册命令', false)
    .action(async (link: string, cmdOpts: { alias?: string; register?: boolean }) => {
      const c = requireCtx()
      const alias = cmdOpts.alias ?? c.profile.name
      const result = await c.engine.connect({ link, alias }, 'human')

      const registrations = detectHostRegistrations(c.hostEnv)
      for (const reg of registrations) {
        if (!c.json) c.stdout(`${reg.instructions}\n`)
        if (cmdOpts.register && reg.run) {
          c.hostEnv.exec(reg.run.bin, reg.run.args)
          if (!c.json) c.stdout(`已执行:${reg.run.bin} ${reg.run.args.join(' ')}\n`)
        }
      }
      if (registrations.length === 0 && !c.json) {
        c.stdout('未检测到已知宿主(claude/codex)的可执行文件,请手动把 agent-comm 注册为 MCP server。\n')
      }

      printResult(
        c,
        { ...result, hostsDetected: registrations.map((r) => r.host) },
        `已加入频道 ${result.channel},别名 ${result.myAlias};当前 ${result.peers.length} 位成员`,
      )
    })

  // —— invite <channel> ——
  program
    .command('invite')
    .description('为频道铸一次性邀请链接(打印出来,由你转发给对方)')
    .argument('<channel>', '频道名')
    .option('--ttl <ms>', '有效期毫秒,缺省不过期', (v: string) => parseIntOption(v))
    .option('--max-uses <n>', '限次,缺省 1', (v: string) => parseIntOption(v))
    .action(async (channel: string, cmdOpts: { ttl?: number; maxUses?: number }) => {
      const c = requireCtx()
      const result = await c.engine.createInvite(
        { channel, ttlMs: cmdOpts.ttl, maxUses: cmdOpts.maxUses },
        'human',
      )
      printResult(
        c,
        result,
        `邀请链接:${result.link}${result.expiresAt ? `\n过期时间:${result.expiresAt}` : ''}`,
      )
    })

  // —— channels ls|create|mode ——
  const channels = program.command('channels').description('频道:列出 / 建立 / 改投递模式')

  channels
    .command('ls', { isDefault: true })
    .description('列出我加入的频道')
    .action(async () => {
      const c = requireCtx()
      const list = await c.engine.listChannels()
      const human = list.length
        ? list
            .map(
              (ch) => `- ${ch.name}  channelId=${ch.channelId ?? ch.name}  home=${ch.home}  mode=${ch.mode}`,
            )
            .join('\n')
        : '(未加入任何频道)'
      printResult(c, list, human)
    })

  channels
    .command('create')
    .description('创建一个新频道(默认以本机共享 hub 为家)')
    .argument('<name>', '频道名')
    .argument('<alias>', '我在频道内的别名')
    .option('--home <url>', '频道 home;缺省为本机 hub')
    .option('--display-name <name>', '展示名')
    .option('--mode <mode>', `投递模式:${MODES.join('|')}`)
    .option('--visibility <visibility>', '可见性:private|public', 'private')
    .option('--description <text>', '描述')
    .action(
      async (
        name: string,
        alias: string,
        cmdOpts: {
          home?: string
          displayName?: string
          mode?: string
          visibility?: string
          description?: string
        },
      ) => {
        const c = requireCtx()
        const mode = cmdOpts.mode === undefined ? undefined : parseMode(cmdOpts.mode)
        if (cmdOpts.visibility !== 'private' && cmdOpts.visibility !== 'public') {
          throw new AgentCommError('INVALID_INPUT', 'visibility must be private or public')
        }
        const channel = await c.engine.createChannel(
          {
            name,
            alias,
            home: cmdOpts.home,
            displayName: cmdOpts.displayName,
            mode,
            visibility: cmdOpts.visibility,
            description: cmdOpts.description,
          },
          'human',
        )
        printResult(
          c,
          channel,
          `已创建频道 ${channel.name} [channelId=${channel.channelId ?? channel.name}](mode=${channel.mode}, visibility=${channel.visibility})`,
        )
      },
    )

  channels
    .command('mode')
    .description('修改频道投递模式(T3)')
    .argument('<channel>', '频道名')
    .argument('<mode>', MODES.join('|'))
    .action(async (channel: string, modeRaw: string) => {
      const c = requireCtx()
      const mode = parseMode(modeRaw)
      await c.engine.setChannelMode({ channel, mode }, 'human')
      printResult(c, { ok: true, channel, mode }, `频道 ${channel} 的模式已改为 ${mode}`)
    })

  // —— peers <channel> ——
  program
    .command('peers')
    .description('列出频道成员')
    .argument('<channel>', '频道名')
    .action(async (channel: string) => {
      const c = requireCtx()
      const peers = await c.engine.listPeers({ channel })
      const human = peers.length
        ? peers
            .map((p) => {
              const online = p.online === undefined ? '' : `  online=${p.online}`
              const card = p.card?.name ? `  card=${p.card.name}` : ''
              return `- ${p.alias}  nodeId=${p.nodeId}${online}${card}`
            })
            .join('\n')
        : '(该频道没有其他成员)'
      printResult(c, peers, human)
    })

  // —— inbox ——
  program
    .command('inbox')
    .description('人读收件箱(会先与各频道的家同步一轮)')
    .option('--consume', '标记已读', false)
    .option('--channel <channel>', '只看某个频道')
    .option('--trace-id <traceId>', '只看某条会话')
    .option('--content-type <type>', '只看某种 contentType')
    .option('--limit <n>', '', (v: string) => parseIntOption(v))
    .action(
      async (cmdOpts: {
        consume?: boolean
        channel?: string
        traceId?: string
        contentType?: string
        limit?: number
      }) => {
        const c = requireCtx()
        const messages = await c.engine.readInbox({
          consume: cmdOpts.consume,
          filter: { channel: cmdOpts.channel, traceId: cmdOpts.traceId, contentType: cmdOpts.contentType },
          limit: cmdOpts.limit,
        })
        const human = messages.length
          ? messages
              .map(
                (m) =>
                  `[seq=${m.seq ?? '-'}] ${m.ts} from=${m.from} to=${m.to} channel=${m.channel} ` +
                  `contentType=${m.contentType ?? '-'} status=${m.status}\n` +
                  `  payload: ${summarizePayload(m.payload)}`,
              )
              .join('\n')
          : '(收件箱为空)'
        printResult(c, messages, human)
      },
    )

  // —— send <channel> <to> <text> ——
  program
    .command('send')
    .description('人工往频道发一条消息(injectedByHuman)')
    .argument('<channel>', '频道名')
    .argument('<to>', "目标别名,或 '*' 广播全频道")
    .argument('<text>', '消息文本(作为 payload 原样送达)')
    .option('--content-type <type>', 'contentType', 'text/plain')
    .option('--reply-to <messageId>', '回复某条消息')
    .option('--reply-by <iso>', 'ISO8601 响应截止')
    .action(
      async (
        channel: string,
        to: string,
        text: string,
        cmdOpts: { contentType?: string; replyTo?: string; replyBy?: string },
      ) => {
        const c = requireCtx()
        const result = await c.engine.send(
          {
            channel,
            to,
            payload: text,
            contentType: cmdOpts.contentType,
            replyTo: cmdOpts.replyTo,
            replyBy: cmdOpts.replyBy,
          },
          'human',
        )
        printResult(c, result, `已发送(${result.status}):${result.messageId}`)
      },
    )

  // —— held [ls] ——
  program
    .command('held')
    .description('列出待人工放行的消息(intercept 模式停住的)')
    .argument('[ls]', "占位子命令,固定写 'ls' 或不写都可以")
    .option('--channel <channel>', '只看某个频道')
    .action(async (lsArg: string | undefined, cmdOpts: { channel?: string }) => {
      const c = requireCtx()
      if (lsArg !== undefined && lsArg !== 'ls') {
        throw new AgentCommError('INVALID_INPUT', `unknown held subcommand: ${lsArg}`)
      }
      const list = await c.engine.listHeld(cmdOpts.channel)
      const human = list.length
        ? list
            .map(
              ({ message, channel }) =>
                `${message.messageId}  channel=${channel}  from=${message.from} to=${message.to} ` +
                `contentType=${message.contentType ?? '-'}\n  payload: ${summarizePayload(message.payload)}`,
            )
            .join('\n')
        : '(没有待放行的消息)'
      printResult(c, list, human)
    })

  // —— deliver / drop / edit(T3)——
  program
    .command('deliver')
    .description('放行一条 held 消息(T3)')
    .argument('<messageId>')
    .action(async (messageId: string) => {
      const c = requireCtx()
      await c.engine.deliverHeld({ messageId }, 'human')
      printResult(c, { ok: true, messageId }, `已放行 ${messageId}`)
    })

  program
    .command('drop')
    .description('丢弃一条 held 消息(T3)')
    .argument('<messageId>')
    .action(async (messageId: string) => {
      const c = requireCtx()
      await c.engine.dropHeld({ messageId }, 'human')
      printResult(c, { ok: true, messageId }, `已丢弃 ${messageId}`)
    })

  program
    .command('edit')
    .description('修改一条 held 消息的 payload/contentType 后放行(T3)')
    .argument('<messageId>')
    .requiredOption('--payload <json>', 'JSON 字符串,作为新的 payload')
    .option('--content-type <type>', '新的 contentType')
    .action(async (messageId: string, cmdOpts: { payload: string; contentType?: string }) => {
      const c = requireCtx()
      let payload: unknown
      try {
        payload = JSON.parse(cmdOpts.payload)
      } catch {
        throw new AgentCommError('INVALID_INPUT', '--payload 不是合法 JSON')
      }
      await c.engine.editHeld({ messageId, payload, contentType: cmdOpts.contentType }, 'human')
      printResult(c, { ok: true, messageId }, `已编辑并放行 ${messageId}`)
    })

  // —— audit ——
  program
    .command('audit')
    .description('查审计记录(append-only,I6)')
    .option('--channel <channel>')
    .option('--since <iso>', 'ISO8601,只看这之后的')
    .option('--limit <n>', '', (v: string) => parseIntOption(v))
    .action(async (cmdOpts: { channel?: string; since?: string; limit?: number }) => {
      const c = requireCtx()
      const entries = await c.engine.auditQuery({
        channel: cmdOpts.channel,
        sinceTs: cmdOpts.since,
        limit: cmdOpts.limit,
      })
      const human = entries.length
        ? entries
            .map((e) => {
              const parts = [`${e.ts} [${e.event}] actor=${e.actor}`]
              if (e.channel) parts.push(`channel=${e.channel}`)
              if (e.messageId) parts.push(`messageId=${e.messageId}`)
              if (e.from) parts.push(`from=${e.from}`)
              if (e.to) parts.push(`to=${e.to}`)
              if (e.detail) parts.push(`detail=${e.detail}`)
              return parts.join(' ')
            })
            .join('\n')
        : '(无审计记录)'
      printResult(c, entries, human)
    })

  // —— community application lifecycle ——
  const app = program.command('app').description('社区协作协议:创建 / 校验 / 搜索 / 安装 / 启用 / 更新')

  app
    .command('list', { isDefault: true })
    .description('列出已安装协议及频道启用状态')
    .action(async () => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const applications = applicationCatalog(profile.rootDir).list()
      utilityResult(
        applications,
        applications.length
          ? applications
              .map(
                (item) =>
                  `- ${item.name} ${item.version}\n  ${item.uri}\n  enabled=${
                    item.enabled.map((enabled) => enabled.channelId).join(',') || '(none)'
                  }`,
              )
              .join('\n')
          : '(未安装任何社区协议)',
      )
    })

  app
    .command('pending')
    .description('列出尚待输入、审批或完成的 application contexts')
    .option('--channel <channelId>')
    .action(async (cmdOpts: { channel?: string }) => {
      const profile = utilityProfile()
      const { openStore } = await import('../store/index.js')
      const store = openStore(profile.storePath)
      try {
        const pending = store.applicationRuntime.listUnfinished(cmdOpts.channel)
        utilityResult(
          pending,
          pending.length
            ? pending
                .map(
                  (item) =>
                    `- ${item.extensionUri}\n  channel=${item.channelId} context=${item.contextId} state=${item.taskState}`,
                )
                .join('\n')
            : '(没有待处理的 application context)',
        )
      } finally {
        store.close()
      }
    })

  app
    .command('search')
    .description('搜索公开协议索引')
    .argument('[query]', '名称、URI 或描述关键词', '')
    .option(
      '--registry <url>',
      '协议索引 URL',
      process.env.AGENT_COMM_APPLICATION_REGISTRY ?? 'https://connect.meee1.com/api/public/applications',
    )
    .action(async (query: string, cmdOpts: { registry: string }) => {
      const { searchApplicationRegistry } = await import('@agent-comm/application-catalog')
      const result = await searchApplicationRegistry(cmdOpts.registry, query)
      utilityResult(
        result,
        result.length
          ? result
              .map((item) => `- ${item.name} ${item.version}\n  ${item.uri}\n  manifest=${item.manifestUrl}`)
              .join('\n')
          : '(没有匹配协议)',
      )
    })

  app
    .command('install')
    .description('安装本地目录或 HTTPS manifest;不会因远端消息自动执行')
    .argument('<source>', '协议目录、manifest 文件或 HTTPS manifest URL')
    .option('--allow-code', '审查后允许安装包内声明的可执行 consumer', false)
    .action(async (source: string, cmdOpts: { allowCode?: boolean }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const installed = await applicationCatalog(profile.rootDir).install(source, {
        allowCode: cmdOpts.allowCode,
      })
      utilityResult(
        installed,
        `已安装 ${installed.name} ${installed.version}\n${installed.uri}\n尚未启用；使用 app enable 绑定频道。`,
      )
    })

  app
    .command('inspect')
    .description('查看已安装协议的 manifest、信任与频道绑定')
    .argument('<uri>', '协议 URI')
    .option('--version <version>')
    .action(async (uri: string, cmdOpts: { version?: string }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const catalog = applicationCatalog(profile.rootDir)
      const installed = catalog.get(uri, cmdOpts.version)
      if (!installed) throw new Error(`application is not installed: ${uri}`)
      const manifest = catalog.manifest(installed)
      utilityResult(
        { installed, manifest },
        [
          `${installed.name} ${installed.version}`,
          installed.uri,
          `source=${installed.source}`,
          `executableTrusted=${installed.executableTrusted}`,
          `enabled=${installed.enabled.map((item) => item.channelId).join(',') || '(none)'}`,
          `events=${Object.keys(manifest.eventSchemas).join(',')}`,
        ].join('\n'),
      )
    })

  app
    .command('update')
    .description('从原始来源或公开索引更新；保留显式频道绑定并保留旧版用于回滚')
    .argument('<uri>', '已安装协议 URI')
    .option('--source <source>', '覆盖原始来源')
    .option('--registry <url>', '从协议索引选择同 URI 的最新版本')
    .option('--allow-code', '审查后允许新版可执行 consumer', false)
    .action(async (uri: string, cmdOpts: { source?: string; registry?: string; allowCode?: boolean }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const catalog = applicationCatalog(profile.rootDir)
      const current = catalog.get(uri)
      if (!current) throw new Error(`application is not installed: ${uri}`)
      let source = cmdOpts.source ?? current.source
      if (cmdOpts.registry) {
        const { compareApplicationVersions, fetchApplicationRegistry } = await import(
          '@agent-comm/application-catalog'
        )
        const candidates = (await fetchApplicationRegistry(cmdOpts.registry))
          .filter((item) => item.uri === uri)
          .sort((a, b) => compareApplicationVersions(b.version, a.version))
        const candidate = candidates[0]
        if (!candidate) throw new Error(`application is not present in registry: ${uri}`)
        source = candidate.manifestUrl
      }
      const updated = await catalog.update(source, { allowCode: cmdOpts.allowCode })
      utilityResult(
        updated,
        `已更新 ${updated.name}: ${current.version} -> ${updated.version}; 频道绑定已保留`,
      )
    })

  app
    .command('enable')
    .description('为指定频道启用一个已安装协议')
    .argument('<uri>', '协议 URI')
    .requiredOption('--channel <channelId>', 'opaque channelId；可用 * 作为所有频道')
    .option('--config <json>', 'consumer 配置 JSON')
    .action(async (uri: string, cmdOpts: { channel: string; config?: string }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const config = cmdOpts.config === undefined ? undefined : JSON.parse(cmdOpts.config)
      const enabled = applicationCatalog(profile.rootDir).enable(uri, cmdOpts.channel, config)
      utilityResult(enabled, `已为频道 ${cmdOpts.channel} 启用 ${enabled.name} ${enabled.version}`)
    })

  app
    .command('disable')
    .description('从指定频道禁用协议')
    .argument('<uri>', '协议 URI')
    .requiredOption('--channel <channelId>', 'opaque channelId')
    .action(async (uri: string, cmdOpts: { channel: string }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const changed = applicationCatalog(profile.rootDir).disable(uri, cmdOpts.channel)
      utilityResult({ changed, uri, channel: cmdOpts.channel }, changed ? '已禁用' : '未找到启用记录')
    })

  app
    .command('remove')
    .description('删除已安装协议；不会删除历史 application state')
    .argument('<uri>', '协议 URI')
    .option('--version <version>')
    .action(async (uri: string, cmdOpts: { version?: string }) => {
      const profile = utilityProfile()
      const { applicationCatalog } = await import('../runtime/daemon.js')
      const removed = applicationCatalog(profile.rootDir).remove(uri, cmdOpts.version)
      utilityResult({ removed, uri, version: cmdOpts.version }, removed ? '已删除' : '未找到协议')
    })

  app
    .command('create')
    .description('创建一个社区协议包模板')
    .argument('<directory>')
    .requiredOption('--name <name>')
    .requiredOption('--uri <uri>')
    .option('--description <description>')
    .action(async (directory: string, cmdOpts: { name: string; uri: string; description?: string }) => {
      const { scaffoldApplicationPackage } = await import('@agent-comm/application-catalog')
      const target = scaffoldApplicationPackage(directory, cmdOpts)
      utilityResult({ target }, `已创建协议模板: ${target}`)
    })

  app
    .command('validate')
    .description('验证 manifest 与 portable conformance fixtures')
    .argument('<source>')
    .action(async (source: string) => {
      const { validateApplicationPackage } = await import('@agent-comm/application-catalog')
      const result = validateApplicationPackage(source)
      utilityResult(
        { manifest: result.manifest, fixtureCount: result.fixtures.length },
        `协议有效: ${result.manifest.name} ${result.manifest.version}; ${result.fixtures.length} 个 fixture`,
      )
    })

  app
    .command('test')
    .description('运行内置 reference consumer 的 conformance；其他协议执行 portable 校验')
    .argument('<source>')
    .action(async (source: string) => {
      const { validateApplicationPackage } = await import('@agent-comm/application-catalog')
      const { ApplicationConsumerRegistry, assertApplicationConformance } = await import(
        '@agent-comm/client-sdk'
      )
      const validated = validateApplicationPackage(source)
      const registry = new ApplicationConsumerRegistry()
      if (validated.manifest.uri === 'https://agentcomm.dev/community/manager-workers/v1') {
        const { createManagerWorkersConsumer } = await import('@agent-comm/manager-workers')
        registry.register(
          createManagerWorkersConsumer({
            role: 'manager',
            alias: 'manager',
            managerAlias: 'manager',
            autoResult: { summary: 'three verified points' },
          }),
        )
      } else if (validated.manifest.uri === 'https://agentcomm.dev/community/request-response/v1') {
        const { createRequestResponseConsumer } = await import('@agent-comm/request-response')
        registry.register(createRequestResponseConsumer({ alias: 'requester' }))
      }
      const results =
        registry.supportedExtensions().length === 0
          ? []
          : await Promise.all(
              validated.fixtures.map((fixture) => assertApplicationConformance(fixture, registry)),
            )
      utilityResult(
        {
          valid: true,
          executableConformance: results,
          fixtureCount: validated.fixtures.length,
        },
        results.length > 0
          ? `${results.length} 个 conformance fixture 全部通过`
          : `portable package 校验通过；${validated.fixtures.length} 个 fixture 由第三方 consumer conformance runner 执行`,
      )
    })

  // —— runtime registry and daemon ——
  const runtime = program.command('runtime').description('管理本机受信任 Agent Runtime')

  runtime
    .command('list', { isDefault: true })
    .description('列出已注册 runtime 与在线状态')
    .action(async () => {
      const profile = utilityProfile()
      const { runtimeRegistry } = await import('../runtime/daemon.js')
      const registry = runtimeRegistry(profile.rootDir)
      const statuses = new Map(registry.statuses().map((item) => [item.id, item]))
      const registrations = registry.registrations()
      utilityResult(
        { registrations, statuses: [...statuses.values()] },
        registrations.length
          ? registrations
              .map((item) => {
                const status = statuses.get(item.id)
                return `- ${item.id}  harness=${item.harness}  state=${status?.state ?? 'registered'}\n  profile=${item.profile} channels=${item.channels.join(',')}`
              })
              .join('\n')
          : '(未注册 runtime)',
      )
    })

  runtime
    .command('add')
    .description('注册一个只恢复明确频道的 Runtime')
    .argument('<id>')
    .requiredOption('--channel <channelIds...>', '一个或多个 opaque channelId')
    .option('--harness <harness>', 'auto|claude-code|codex-app-server|codex-exec|process', 'auto')
    .option('--runtime-profile <profile>', 'Runtime 身份 profile')
    .option('--cwd <path>')
    .option('--command <path>')
    .option('--arg <args...>')
    .option('--application <uris...>')
    .option('--trusted-auto-resume', '允许 daemon 恢复这些明确列出的频道', false)
    .action(
      async (
        id: string,
        cmdOpts: {
          channel: string[]
          harness: string
          runtimeProfile?: string
          cwd?: string
          command?: string
          arg?: string[]
          application?: string[]
          trustedAutoResume?: boolean
        },
      ) => {
        const profile = utilityProfile()
        const { RuntimeHarnessSchema } = await import('@agent-comm/runtime-supervisor')
        const { normalizeRuntimeRegistration, runtimeRegistry } = await import('../runtime/daemon.js')
        const registration = runtimeRegistry(profile.rootDir).register(
          normalizeRuntimeRegistration({
            id,
            profile: cmdOpts.runtimeProfile ?? profile.name,
            harness: RuntimeHarnessSchema.parse(cmdOpts.harness),
            channels: cmdOpts.channel,
            cwd: cmdOpts.cwd,
            command: cmdOpts.command,
            args: cmdOpts.arg ?? [],
            applications: cmdOpts.application ?? [],
            trustedAutoResume: cmdOpts.trustedAutoResume ?? false,
          }),
        )
        utilityResult(
          registration,
          `已注册 runtime ${id}; daemon 只会恢复: ${registration.channels.join(', ')}`,
        )
      },
    )

  runtime
    .command('remove')
    .argument('<id>')
    .action(async (id: string) => {
      const profile = utilityProfile()
      const { runtimeRegistry } = await import('../runtime/daemon.js')
      const removed = runtimeRegistry(profile.rootDir).remove(id)
      utilityResult({ removed, id }, removed ? '已删除 runtime' : '未找到 runtime')
    })

  const daemon = program.command('daemon').description('运行本机 AgentComm Runtime Supervisor')

  daemon
    .command('install')
    .description('安装 launchd/systemd 用户服务；仅恢复已显式信任的频道')
    .option('--no-start', '只写服务定义，不立即启动')
    .action(async (cmdOpts: { start: boolean }) => {
      const profile = utilityProfile()
      const { runtimeRegistry } = await import('../runtime/daemon.js')
      if (
        cmdOpts.start &&
        !runtimeRegistry(profile.rootDir)
          .registrations()
          .some((item) => item.trustedAutoResume)
      ) {
        throw new Error(
          'register at least one runtime with --trusted-auto-resume before starting the service',
        )
      }
      const { installDaemonService } = await import('../runtime/service.js')
      const installed = installDaemonService({ profile, start: cmdOpts.start })
      utilityResult(installed, `daemon 服务已安装: ${installed.path}${installed.started ? '（已启动）' : ''}`)
    })

  daemon
    .command('uninstall')
    .description('停止并移除 launchd/systemd 用户服务；保留 profile 数据')
    .action(async () => {
      const { uninstallDaemonService } = await import('../runtime/service.js')
      const result = uninstallDaemonService()
      utilityResult(result, result.removed ? `已移除 ${result.path}` : '未找到 daemon 服务')
    })

  daemon
    .command('run', { isDefault: true })
    .description('前台运行；由 launchd/systemd 可转为登录常驻服务')
    .option('--once', '启动、同步一次并退出（验收用）', false)
    .action(async (cmdOpts: { once?: boolean }) => {
      const profile = utilityProfile()
      const { runRuntimeDaemon } = await import('../runtime/daemon.js')
      await runRuntimeDaemon({ rootDir: profile.rootDir, once: cmdOpts.once })
    })

  daemon
    .command('status')
    .description('读取持久 registry 与 daemon heartbeat')
    .action(async () => {
      const profile = utilityProfile()
      const { runtimeRegistry } = await import('../runtime/daemon.js')
      const registry = runtimeRegistry(profile.rootDir)
      const statuses = registry.statuses().map((item) => {
        let processAlive = false
        if (item.pid) {
          try {
            process.kill(item.pid, 0)
            processAlive = true
          } catch {
            processAlive = false
          }
        }
        return { ...item, processAlive }
      })
      utilityResult(
        statuses,
        statuses.length
          ? statuses
              .map(
                (item) =>
                  `- ${item.id} ${item.state} adapter=${item.adapterId ?? '-'} pid=${item.pid ?? '-'} alive=${item.processAlive}`,
              )
              .join('\n')
          : '(daemon 尚无 runtime 状态)',
      )
    })

  daemon
    .command('stop')
    .description('向当前 registry 中的 daemon 进程发送 SIGTERM')
    .action(async () => {
      const profile = utilityProfile()
      const { runtimeRegistry, stoppableRuntimePids } = await import('../runtime/daemon.js')
      const pids = stoppableRuntimePids(runtimeRegistry(profile.rootDir).statuses())
      const stopped: number[] = []
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
          stopped.push(pid)
        } catch {
          // Stale heartbeat; daemon status will report it offline.
        }
      }
      utilityResult(
        { stopped },
        stopped.length ? `已停止 daemon pid=${stopped.join(',')}` : '没有在线 daemon',
      )
    })

  const benchmark = program
    .command('benchmark')
    .description('分层评测 transport / application / harness / model / system')

  benchmark
    .command('validate')
    .argument('<suite>', 'benchmark suite JSON')
    .action(async (suite: string) => {
      const { readFileSync } = await import('node:fs')
      const { BenchmarkSuiteSchema } = await import('@agent-comm/benchmark')
      const parsed = BenchmarkSuiteSchema.parse(JSON.parse(readFileSync(suite, 'utf8')))
      utilityResult(parsed, `benchmark suite 有效: ${parsed.name}; ${parsed.cases.length} cases`)
    })

  benchmark
    .command('run')
    .argument('<suite>', 'benchmark suite JSON')
    .requiredOption('--runner <absolute-path>', '受信任 runner 的绝对可执行路径')
    .option('--allow-runner-exec', '确认允许执行这个本机 runner', false)
    .option('--arg <args...>')
    .option('--cwd <path>')
    .option('--output <path>', '写入完整 JSON report')
    .action(
      async (
        suite: string,
        cmdOpts: {
          runner: string
          allowRunnerExec?: boolean
          arg?: string[]
          cwd?: string
          output?: string
        },
      ) => {
        if (!cmdOpts.allowRunnerExec) {
          throw new Error('benchmark runner execution requires --allow-runner-exec')
        }
        const { readFileSync, writeFileSync } = await import('node:fs')
        const { BenchmarkSuiteSchema, createProcessBenchmarkExecutor, runBenchmarkSuite } = await import(
          '@agent-comm/benchmark'
        )
        const parsed = BenchmarkSuiteSchema.parse(JSON.parse(readFileSync(suite, 'utf8')))
        const report = await runBenchmarkSuite(
          parsed,
          createProcessBenchmarkExecutor({
            command: cmdOpts.runner,
            args: cmdOpts.arg,
            cwd: cmdOpts.cwd,
            authorizedByOperator: true,
          }),
        )
        if (cmdOpts.output) writeFileSync(cmdOpts.output, `${JSON.stringify(report, null, 2)}\n`)
        process.exitCode = report.passed ? 0 : 1
        utilityResult(
          report,
          [
            `${report.passed ? 'PASS' : 'FAIL'} ${report.suite}`,
            ...report.cases.map(
              (item) =>
                `${item.passed ? '✓' : '✗'} ${item.layer}/${item.id}: success=${item.successRate} correctness=${item.correctnessRate ?? '-'} p95=${item.latencyMs.p95}ms`,
            ),
          ].join('\n'),
        )
      },
    )

  benchmark
    .command('compare')
    .argument('<baseline>')
    .argument('<candidate>')
    .action(async (baseline: string, candidate: string) => {
      const { readFileSync } = await import('node:fs')
      const { compareBenchmarkReports } = await import('@agent-comm/benchmark')
      const result = compareBenchmarkReports(
        JSON.parse(readFileSync(baseline, 'utf8')),
        JSON.parse(readFileSync(candidate, 'utf8')),
      )
      utilityResult(
        result,
        result.cases
          .map(
            (item) =>
              `- ${item.id}: success ${item.successRateDelta >= 0 ? '+' : ''}${item.successRateDelta}; p95 ${item.p95LatencyDeltaMs >= 0 ? '+' : ''}${item.p95LatencyDeltaMs}ms`,
          )
          .join('\n') || '(没有可比较的 case)',
      )
    })

  // —— doctor(不走 preAction 建的 ctx:engine 起不来也要把其余项跑完)——
  program
    .command('install-launcher')
    .description('安装 macOS agentcomm:// 浏览器入口（一键启动启用 Channel 的 Claude Code）')
    .option('--runtime-profile <name>', '固定浏览器 runtime 身份；默认 auto=按 Claude session 隔离', 'auto')
    .action(async (cmdOpts: { runtimeProfile: string }) => {
      const { installMacLauncher } = await import('../launcher/macos.js')
      const appPath = installMacLauncher({ profile: cmdOpts.runtimeProfile })
      stdout(`已安装 AgentComm 浏览器启动器：${appPath}\n`)
    })

  program
    .command('doctor')
    .description('环境诊断:profile 路径 / store 可开 / hub 可达 / 宿主 CLI 存在性,逐项 ✓/✗')
    .action(async () => {
      const globals = program.opts<{ profile?: string; json?: boolean }>()
      const json = globals.json ?? false
      const items: { ok: boolean; label: string; detail?: string }[] = []
      const add = (ok: boolean, label: string, detail?: string): void => {
        items.push({ ok, label, detail })
      }

      let profile: ProfilePaths | undefined
      try {
        profile = resolveProfile({ profile: globals.profile, rootDir: opts.rootDir, env: opts.env })
        add(true, 'profile 路径', profile.dir)
      } catch (err) {
        add(false, 'profile 路径', err instanceof Error ? err.message : String(err))
      }

      let engine: Engine | undefined
      if (profile) {
        try {
          const engineFactory = opts.engineFactory ?? productionEngineFactory
          engine = await engineFactory(profile)
          add(true, 'store 可开')
        } catch (err) {
          add(false, 'store 可开', err instanceof Error ? err.message : String(err))
        }
      }

      if (engine) {
        try {
          const who = await engine.whoami()
          add(true, 'hub 可达', `nodeId=${who.nodeId},${who.memberships.length} 条频道成员关系`)
        } catch (err) {
          add(false, 'hub 可达', err instanceof Error ? err.message : String(err))
        }
      } else {
        add(false, 'hub 可达', '(store 未打开,跳过)')
      }

      for (const bin of ['claude', 'codex'] as const) {
        add(hostEnv.detect(bin), `宿主 CLI: ${bin}`)
      }

      if (engine) {
        await engine.close().catch(() => {})
      }

      const allOk = items.every((i) => i.ok)
      process.exitCode = allOk ? 0 : 1
      if (json) {
        stdout(`${JSON.stringify({ ok: allOk, checks: items })}\n`)
      } else {
        stdout(`${items.map((i) => checkLine(i.ok, i.label, i.detail)).join('\n')}\n`)
      }
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander 自己已经把提示写到 writeErr(=我们注入的 stderr)了,这里只定退出码:
      // help/version 视为成功(0),其余 commander 判定的用法问题一律 2。
      process.exitCode = err.exitCode === 0 ? 0 : 2
    } else if (isAgentCommError(err)) {
      stderr(`agent-comm: ${err.code}: ${err.message}\n`)
      process.exitCode = 1
    } else {
      stderr(`agent-comm: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  } finally {
    if (ctx) {
      await ctx.engine.close().catch(() => {})
    }
  }
}
