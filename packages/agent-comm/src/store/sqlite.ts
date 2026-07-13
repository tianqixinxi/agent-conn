import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SQLOutputValue } from 'node:sqlite'
import { DatabaseSync } from 'node:sqlite'

/**
 * 底层 SQLite 帮助函数(node:sqlite 的 DatabaseSync),store-repos.ts / hub-repos.ts 共用。
 * - openDb:确保父目录存在、设置 busy_timeout(>=2000ms)、应用 schema(CREATE TABLE IF NOT EXISTS,幂等)
 * - withTx:单连接同步事务包装(BEGIN IMMEDIATE/COMMIT/ROLLBACK),多语句写全部经此包裹(I5)
 * - row 帮助函数:node:sqlite 返回列值类型是 SQLOutputValue 联合(null|number|bigint|string|Uint8Array),
 *   这里做运行时窄化,全程不用 any(严格类型)
 */

export function openDb(path: string, schemaSql: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec(schemaSql)
  return db
}

/** 单连接同步事务:fn 内只应调用同一个 db 上的 prepare/run/get/all,不得跨连接 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已因原始错误自动结束;吞掉回滚失败,保留原始错误
    }
    throw err
  }
}

export type Row = Record<string, SQLOutputValue>

export function reqStr(row: Row, key: string): string {
  const v = row[key]
  if (typeof v !== 'string') throw new TypeError(`column ${key} expected string, got ${typeof v}`)
  return v
}

export function optStr(row: Row, key: string): string | undefined {
  const v = row[key]
  return typeof v === 'string' ? v : undefined
}

export function reqNum(row: Row, key: string): number {
  const v = row[key]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  throw new TypeError(`column ${key} expected number, got ${typeof v}`)
}

export function optNum(row: Row, key: string): number | undefined {
  const v = row[key]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return undefined
}

export function reqBool(row: Row, key: string): boolean {
  return reqNum(row, key) !== 0
}

export function parseJson<T>(s: string): T {
  return JSON.parse(s) as T
}

export function parseJsonOpt<T>(s: string | undefined): T | undefined {
  return s === undefined ? undefined : (JSON.parse(s) as T)
}

export function toJsonOpt(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v)
}

export function toJson(v: unknown): string {
  return JSON.stringify(v)
}
