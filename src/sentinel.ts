/**
 * 哨兵写入：触发 watch 插件执行「预检 → 重启 web → 唤醒 → 清哨兵」。
 * 协议与 dsh-agent-watch 一致（JSON：workspace/sessionId/note）。
 * @module dsh-agent-plugin-manager/sentinel
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface SentinelOpts {
  workspace?: string
  sessionId?: string
  note?: string
}

export function writeSentinel(dshHome: string, opts: SentinelOpts): string {
  const file = join(dshHome || process.cwd(), '.hot-reload-flag')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    workspace: opts.workspace,
    sessionId: opts.sessionId,
    note: opts.note,
  }, null, 2), 'utf8')
  return file
}

export function clearSentinel(dshHome: string): void {
  try { writeFileSync(join(dshHome || process.cwd(), '.hot-reload-flag'), '', 'utf8') } catch { /* 忽略 */ }
}