import {
  A2A_MEDIA_TYPE,
  a2aEventToJson,
  createA2AMessage,
  tryDecodeA2AEvent,
  withAgentCommRouting,
} from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import { freshApp, makeIdentity, signedRequest } from './helpers.js'

describe('relay: A2A HTTP+JSON binding', () => {
  it('keeps the plaintext A2A gateway disabled unless the deployment explicitly trusts it', async () => {
    const app = freshApp()
    expect((await app.request('/.well-known/agent-card.json')).status).toBe(404)
  })

  it('serves a public A2A 1.0 AgentCard', async () => {
    const app = freshApp({ enableA2AIngress: true })

    const response = await app.request('/.well-known/agent-card.json')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(A2A_MEDIA_TYPE)
    expect(response.headers.get('A2A-Version')).toBe('1.0')
    const card = (await response.json()) as {
      name: string
      supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[]
      capabilities: { streaming: boolean }
    }
    expect(card.name).toBe('AgentComm Relay')
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: 'http://localhost/a2a/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    })
    expect(card.capabilities.streaming).toBe(false)
  })

  it('accepts an authenticated A2A SendMessageRequest and stores the canonical frame', async () => {
    const app = freshApp({ enableA2AIngress: true })
    const lead = makeIdentity('a2a-lead')
    const createPath = '/ch/duet/create'
    const createBody = {
      alias: 'lead',
      node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
    }
    expect((await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))).status).toBe(
      200,
    )

    const message = createA2AMessage({
      messageId: 'a2a-message-1',
      role: 'user',
      payload: { intent: 'review', target: 'change-42' },
      contextId: 'a2a-context-1',
      metadata: withAgentCommRouting(undefined, {
        channel: 'duet',
        to: '*',
        taskId: 'a2a-task-1',
      }),
    })
    const sendPath = '/a2a/v1/message:send'
    const body = {
      message: a2aEventToJson({ kind: 'message', value: message }),
      configuration: { returnImmediately: true },
    }
    const response = await app.request(sendPath, signedRequest(lead, 'POST', sendPath, body))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(A2A_MEDIA_TYPE)
    const result = (await response.json()) as {
      task: { id: string; contextId: string; status: { state: string }; metadata: Record<string, unknown> }
    }
    expect(result.task).toMatchObject({
      id: 'a2a-task-1',
      contextId: 'a2a-context-1',
      status: { state: 'TASK_STATE_SUBMITTED' },
      metadata: { transport: 'agentcomm-relay', transportStatus: 'delivered' },
    })

    const pullPath = '/ch/duet/messages?after=0&limit=10'
    const pulledResponse = await app.request(pullPath, signedRequest(lead, 'GET', pullPath))
    const pulled = (await pulledResponse.json()) as {
      messages: { from: string; contentType: string; payload: unknown }[]
    }
    expect(pulled.messages[0]).toMatchObject({ from: 'lead', contentType: A2A_MEDIA_TYPE })
    const event = tryDecodeA2AEvent(pulled.messages[0]?.payload)
    expect(event?.kind).toBe('message')
    if (event?.kind !== 'message') throw new Error('expected A2A message')
    expect(event.value.messageId).toBe('a2a-message-1')
  })

  it('rejects the blocking request mode that a store-and-forward relay cannot honor', async () => {
    const app = freshApp({ enableA2AIngress: true })
    const lead = makeIdentity('a2a-blocking')
    const createPath = '/ch/duet/create'
    const createBody = {
      alias: 'lead',
      node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
    }
    await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))
    const message = createA2AMessage({
      messageId: 'a2a-message-2',
      role: 'user',
      payload: 'work',
      contextId: 'a2a-context-2',
      metadata: withAgentCommRouting(undefined, { channel: 'duet', to: '*' }),
    })
    const path = '/a2a/v1/message:send'
    const body = { message: a2aEventToJson({ kind: 'message', value: message }) }

    const response = await app.request(path, signedRequest(lead, 'POST', path, body))

    expect(response.status).toBe(400)
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('returnImmediately') },
    })
  })
})
