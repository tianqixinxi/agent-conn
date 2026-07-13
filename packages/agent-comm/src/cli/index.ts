import type { ChannelMode } from '@agent-comm/protocol'
import { AgentCommError, isAgentCommError } from '@agent-comm/protocol'
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
 * W2 实现处:CLI 伴侣(人类面,T3 + 引导;DESIGN §3)。commander(实测 v14.0.3)。
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
    if (actionCommand.name() === 'doctor') return
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
        ? list.map((ch) => `- ${ch.name}  home=${ch.home}  mode=${ch.mode}`).join('\n')
        : '(未加入任何频道)'
      printResult(c, list, human)
    })

  channels
    .command('create')
    .description('创建一个新频道(默认以本机共享 hub 为家)')
    .argument('<name>', '频道名')
    .argument('<alias>', '我在频道内的别名')
    .option('--display-name <name>', '展示名')
    .option('--mode <mode>', `投递模式:${MODES.join('|')}`)
    .option('--description <text>', '描述')
    .action(
      async (
        name: string,
        alias: string,
        cmdOpts: { displayName?: string; mode?: string; description?: string },
      ) => {
        const c = requireCtx()
        const mode = cmdOpts.mode === undefined ? undefined : parseMode(cmdOpts.mode)
        const channel = await c.engine.createChannel(
          { name, alias, displayName: cmdOpts.displayName, mode, description: cmdOpts.description },
          'human',
        )
        printResult(c, channel, `已创建频道 ${channel.name}(mode=${channel.mode})`)
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

  // —— doctor(不走 preAction 建的 ctx:engine 起不来也要把其余项跑完)——
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
