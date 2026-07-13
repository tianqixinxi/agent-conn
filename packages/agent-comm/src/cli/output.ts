/**
 * CLI 输出约定:--json 时打印单行可解析 JSON;否则打印人读文本(缺省退化为缩进 JSON)。
 */
export interface Printer {
  json: boolean
  stdout: (chunk: string) => void
}

export function printResult(p: Printer, data: unknown, human?: string): void {
  if (p.json) {
    p.stdout(`${JSON.stringify(data)}\n`)
  } else {
    p.stdout(`${human ?? JSON.stringify(data, null, 2)}\n`)
  }
}

/** doctor 用的逐项 ✓/✗ 行 */
export function checkLine(ok: boolean, label: string, detail?: string): string {
  const mark = ok ? '✓' : '✗'
  return detail ? `${mark} ${label}: ${detail}` : `${mark} ${label}`
}

/** payload 对 L0 不透明(I1):这里只做展示用的原样字符串化,不解析/不按 contentType 分支 */
export function summarizePayload(payload: unknown, maxLen = 200): string {
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    text = String(payload)
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}
