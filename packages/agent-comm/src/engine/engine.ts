import { AgentCommError } from '@agent-comm/protocol'
import type { ProfilePaths } from '../config.js'
import type { Engine, EngineDeps } from './api.js'

/**
 * W1 实现处:L0 业务核心(DESIGN §3/§4 F1-F5)。
 * 依赖 store/(openStore, openHub)与 local-home.ts;relay 家经 deps.relayDriverFactory。
 */
export function createEngine(_profile: ProfilePaths, _deps: EngineDeps = {}): Promise<Engine> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'engine: W1 尚未实现(见 DESIGN.md §6 W1)')
}
