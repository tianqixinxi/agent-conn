import { AgentCommError } from '@agent-comm/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type {
  ClientCapabilities,
  ElicitResult,
  LoggingMessageNotification,
} from '@modelcontextprotocol/sdk/types.js'
import { ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { createInboxChangeNotifier, createMcpServer } from '../src/mcp/server.js'
import { TOOL_TIERS } from '../src/mcp/tools.js'
import { FakeEngine, makeHeldMessage } from './fake-engine.js'

/**
 * client.callTool() 的返回类型是 SDK 内部由 zod schema 推导出的匿名类型,其 content 数组元素是
 * text/image/audio/resource/resource_link 等好几种 content block 的并集,和"只取 content[0].text"
 * 这种用法对不上号(tsc 判定结构不兼容)。测试只关心文本,这里用 unknown + 运行时窄化拿到它,
 * 绕开 SDK 内部类型的细节,不引入 any。
 */
function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('expected a CallToolResult-like object')
  }
  const content = (result as { content: unknown }).content
  if (!Array.isArray(content)) throw new Error('expected content to be an array')
  const first: unknown = content[0]
  if (
    typeof first !== 'object' ||
    first === null ||
    (first as { type?: unknown }).type !== 'text' ||
    typeof (first as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('expected text content block')
  }
  return (first as { text: string }).text
}

async function connectClient(
  engine: FakeEngine,
  clientCapabilities: ClientCapabilities = {},
  stderr: (chunk: string) => void = () => {},
): Promise<{ client: Client }> {
  const server = createMcpServer(engine, { stderr })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: clientCapabilities })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('registerAllTools', () => {
  it('registers exactly the 12 tools from the frozen tools.ts contract', async () => {
    const engine = new FakeEngine()
    const { client } = await connectClient(engine)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_TIERS).sort())
  })

  it('send: forwards args to engine.send and resolves actor from the sole membership', async () => {
    const engine = new FakeEngine({ memberships: [{ channel: 'daily', alias: 'me', home: 'local:/x' }] })
    const { client } = await connectClient(engine)

    const result = await client.callTool({
      name: 'send',
      arguments: { to: 'bob', payload: { text: 'hi' }, contentType: 'text/plain' },
    })

    expect(result.isError).toBeFalsy()
    const call = engine.calls.find((c) => c.method === 'send')
    expect(call?.actor).toBe('agent:me')
    expect(call?.args[0]).toMatchObject({ to: 'bob', payload: { text: 'hi' }, contentType: 'text/plain' })
    expect(JSON.parse(firstText(result))).toMatchObject({ status: 'delivered' })
  })

  it('send: explicit channel resolves actor via whoami membership for that channel', async () => {
    const engine = new FakeEngine({
      memberships: [
        { channel: 'daily', alias: 'me-daily', home: 'local:/x' },
        { channel: 'ops', alias: 'me-ops', home: 'local:/x' },
      ],
    })
    const { client } = await connectClient(engine)

    await client.callTool({ name: 'send', arguments: { channel: 'ops', to: '*', payload: 'hi' } })

    const call = engine.calls.find((c) => c.method === 'send')
    expect(call?.actor).toBe('agent:me-ops')
  })

  it('send: falls back to agent:self when alias cannot be resolved', async () => {
    const engine = new FakeEngine() // 无 memberships
    const { client } = await connectClient(engine)

    await client.callTool({ name: 'send', arguments: { to: 'bob', payload: 'hi' } })

    const call = engine.calls.find((c) => c.method === 'send')
    expect(call?.actor).toBe('agent:self')
  })

  it('read_inbox: forwards consume/filter/limit and returns engine result verbatim', async () => {
    const msg = {
      messageId: 'm-1',
      from: 'a',
      to: 'b',
      channel: 'daily',
      traceId: 't-1',
      hop: 0,
      payload: 'x',
      injectedByHuman: false,
      ts: new Date().toISOString(),
      status: 'delivered' as const,
    }
    const engine = new FakeEngine({ inbox: [msg] })
    const { client } = await connectClient(engine)

    const result = await client.callTool({
      name: 'read_inbox',
      arguments: { consume: true, limit: 5, filter: { channel: 'daily' } },
    })

    const call = engine.calls.find((c) => c.method === 'readInbox')
    expect(call?.args[0]).toMatchObject({ consume: true, limit: 5, filter: { channel: 'daily' } })
    expect(JSON.parse(firstText(result))).toEqual([msg])
  })

  it('void-returning engine calls (ack/leave_channel/publish_card) surface as {ok:true}', async () => {
    const engine = new FakeEngine({
      channels: [{ name: 'daily', home: 'local:/x', mode: 'auto', createdAt: new Date().toISOString() }],
      memberships: [{ channel: 'daily', alias: 'me', home: 'local:/x' }],
    })
    const { client } = await connectClient(engine)

    const ackResult = await client.callTool({ name: 'ack', arguments: { messageId: 'm-1' } })
    expect(JSON.parse(firstText(ackResult))).toEqual({ ok: true })

    const leaveResult = await client.callTool({ name: 'leave_channel', arguments: { channel: 'daily' } })
    expect(JSON.parse(firstText(leaveResult))).toEqual({ ok: true })
    expect(engine.calls.find((c) => c.method === 'leaveChannel')?.actor).toBe('agent:me')
  })

  it('AgentCommError from engine maps to isError:true with {code,message}', async () => {
    const engine = new FakeEngine()
    engine.listChannels = async () => {
      throw new AgentCommError('CHANNEL_NOT_FOUND', 'no such channel: nope')
    }
    const { client } = await connectClient(engine)

    const result = await client.callTool({ name: 'list_channels', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.parse(firstText(result))).toEqual({
      code: 'CHANNEL_NOT_FOUND',
      message: 'no such channel: nope',
    })
  })

  it('unexpected (non-AgentCommError) exceptions also become isError, never a bare throw', async () => {
    const engine = new FakeEngine()
    engine.whoami = async () => {
      throw new Error('boom')
    }
    const { client } = await connectClient(engine)

    const result = await client.callTool({ name: 'whoami', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.parse(firstText(result))).toMatchObject({ code: 'INTERNAL_ERROR', message: 'boom' })
  })

  it('create_channel/join_channel/connect resolve actor from the alias in the input itself', async () => {
    const engine = new FakeEngine()
    const { client } = await connectClient(engine)

    await client.callTool({ name: 'create_channel', arguments: { name: 'daily', alias: 'lead' } })
    expect(engine.calls.find((c) => c.method === 'createChannel')?.actor).toBe('agent:lead')

    await client.callTool({ name: 'join_channel', arguments: { channel: 'daily', alias: 'bob' } })
    expect(engine.calls.find((c) => c.method === 'joinChannel')?.actor).toBe('agent:bob')

    await client.callTool({
      name: 'connect',
      arguments: { link: 'agentcomm-local:?path=/x&t=tok', alias: 'carol' },
    })
    expect(engine.calls.find((c) => c.method === 'connect')?.actor).toBe('agent:carol')
  })
})

describe('read_inbox → intercept elicitation (F4/§7.1)', () => {
  it('accept decision calls engine.deliverHeld with human actor', async () => {
    const held = makeHeldMessage({ channel: 'daily' })
    const engine = new FakeEngine({ held: [held] })
    const { client } = await connectClient(engine, { elicitation: { form: {} } })
    client.setRequestHandler(
      ElicitRequestSchema,
      async (): Promise<ElicitResult> => ({
        action: 'accept',
        content: { decision: 'accept' },
      }),
    )

    await client.callTool({ name: 'read_inbox', arguments: {} })
    await waitFor(() => engine.calls.some((c) => c.method === 'deliverHeld'))

    const call = engine.calls.find((c) => c.method === 'deliverHeld')
    expect(call?.actor).toBe('human')
    expect(call?.args[0]).toEqual({ messageId: held.message.messageId })
  })

  it('reject decision calls engine.dropHeld with human actor', async () => {
    const held = makeHeldMessage({ channel: 'daily' })
    const engine = new FakeEngine({ held: [held] })
    const { client } = await connectClient(engine, { elicitation: { form: {} } })
    client.setRequestHandler(
      ElicitRequestSchema,
      async (): Promise<ElicitResult> => ({
        action: 'accept',
        content: { decision: 'reject' },
      }),
    )

    await client.callTool({ name: 'read_inbox', arguments: {} })
    await waitFor(() => engine.calls.some((c) => c.method === 'dropHeld'))

    const call = engine.calls.find((c) => c.method === 'dropHeld')
    expect(call?.actor).toBe('human')
  })

  it('declining the elicitation leaves the message held (no deliver/drop call)', async () => {
    const held = makeHeldMessage({ channel: 'daily' })
    const engine = new FakeEngine({ held: [held] })
    const { client } = await connectClient(engine, { elicitation: { form: {} } })
    client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => ({ action: 'decline' }))

    await client.callTool({ name: 'read_inbox', arguments: {} })
    // 没有确定性事件可等,给放行流程一个 tick 后断言"没发生"
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(engine.calls.some((c) => c.method === 'deliverHeld' || c.method === 'dropHeld')).toBe(false)
  })

  it('host without elicitation capability: prints stderr hint, never calls deliver/dropHeld, does not block the tool result', async () => {
    const held = makeHeldMessage({ channel: 'daily' })
    const engine = new FakeEngine({ held: [held] })
    const stderrLines: string[] = []
    const { client } = await connectClient(engine, {}, (chunk) => stderrLines.push(chunk))

    const result = await client.callTool({ name: 'read_inbox', arguments: {} })
    expect(result.isError).toBeFalsy()

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(engine.calls.some((c) => c.method === 'deliverHeld' || c.method === 'dropHeld')).toBe(false)
    expect(stderrLines.some((l) => l.includes('agent-comm held'))).toBe(true)
  })

  it('no held messages: does not touch elicitInput at all', async () => {
    const engine = new FakeEngine({ held: [] })
    const { client } = await connectClient(engine, { elicitation: { form: {} } })
    let elicited = false
    client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => {
      elicited = true
      return { action: 'decline' }
    })

    await client.callTool({ name: 'read_inbox', arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(elicited).toBe(false)
  })
})

describe('createInboxChangeNotifier', () => {
  it('is a no-op when the server is not connected', () => {
    const engine = new FakeEngine()
    const server = createMcpServer(engine)
    const notify = createInboxChangeNotifier(server)
    expect(() => notify()).not.toThrow()
  })

  it('sends a logging notification once connected', async () => {
    const engine = new FakeEngine()
    const server = createMcpServer(engine)
    const notify = createInboxChangeNotifier(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'c', version: '0' }, { capabilities: {} })
    const received: LoggingMessageNotification[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      received.push(n)
    })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    notify()
    await waitFor(() => received.length > 0)
    expect(received[0]?.params.data).toEqual({ event: 'inbox_changed' })
  })
})
