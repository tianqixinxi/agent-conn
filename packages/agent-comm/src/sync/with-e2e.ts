import { CipherPayloadSchema } from '@agent-comm/protocol'
import { open, seal } from '../crypto/e2e.js'
import type { TransportBinding } from '../transport/api.js'

/**
 * W3 实现处:E2E 频道包装器(§2.5)。
 *
 * E2E 位于 transport registry 上方，不进入具体 binding 的连接配置。
 * sync 提供 withE2e(driver, key):对任意 TransportBinding 包一层,只改写 append/pullAfter:
 * - append 前:把每条信封的 payload+contentType 封成 CipherPayload,contentType 置 undefined
 *   (JSON.stringify 会自动丢掉值为 undefined 的字段,等价于 wire.ts 注释里的“contentType 省略”)
 * - pullAfter 后:对形如 CipherPayload 的 payload 调 crypto/e2e.open() 还原明文 payload/contentType;
 *   不形如 CipherPayload 的消息原样透传(非 E2E 频道混用同一 driver 时的兜底)
 * - 其余方法(join/members/mintInvite/…)原样透传:路由字段(channel/to/seq/ts)本就不加密(§2.5)
 *
 * v1 范围之外:listHeld/resolveHeld(T3 门)不在此包装——relay 家 v1 本就不支持远程门(NOT_IMPLEMENTED),
 * local 家的 held 消息是否也要 E2E 化是 M3/architect 的开放问题,这里不擅自扩大范围。
 *
 * engine 集成时(何时用哪个 e2eKey、从 store 的 e2e_key_ref 取 key)由 architect 接线。
 */
export function withE2e(driver: TransportBinding, e2eKeyB64url: string): TransportBinding {
  return {
    ...driver,

    async append(channel, envelopes) {
      const sealed = envelopes.map((env) => ({
        ...env,
        payload: seal(e2eKeyB64url, env.payload, env.contentType),
        contentType: undefined,
      }))
      return driver.append(channel, sealed)
    },

    async pullAfter(channel, after, opts) {
      const result = await driver.pullAfter(channel, after, opts)
      const messages = result.messages.map((msg) => {
        const asCipher = CipherPayloadSchema.safeParse(msg.payload)
        if (!asCipher.success) return msg
        const opened = open(e2eKeyB64url, asCipher.data)
        return { ...msg, payload: opened.payload, contentType: opened.contentType }
      })
      return { messages, head: result.head }
    },
  }
}
