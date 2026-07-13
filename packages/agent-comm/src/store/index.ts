/**
 * W1 实现处:SQLite 持久层(node:sqlite DatabaseSync)。
 * - openStore(path):应用 schema.store.sql,返回各 repo(纯数据存取,无业务规则)
 * - openHubDb(path):应用 schema.hub.sql,返回给 local-home 用的低层句柄
 * 具体实现见同目录 store-repos.ts(私有 store)与 hub-repos.ts(共享 local hub)。
 * 本文件只是这两者的公开面(engine/local-home.ts 从这里 import)。
 */
export * from './hub-repos.js'
export * from './store-repos.js'
