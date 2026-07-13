/**
 * sync 模块公开面(DESIGN §2:跨模块只许 import 对方的 api.ts/index.ts)。
 * engine 与 relay 家的接线(何时建 relay driver、何时套 withE2e)由 architect 在 engine 侧完成。
 */
export { createRelayDriver } from './relay-driver.js'
export { withE2e } from './with-e2e.js'
