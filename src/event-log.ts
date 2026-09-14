/**
 * event-log.ts — 事件日志的**薄 IO 壳**（准则 C4：观测绝不反噬主流程）。
 *
 * `plugin-manager` 的 `.plugin-manager-events.log` 是并行实例协调的判据来源
 * （AGENTS.md §5.14 §1：动共享资产前先看别人做过什么），所以它必须**写得进就写、写不进也不炸**：
 * 事件行的追加失败绝不能阻断挂载/启停/重启这类主流程。
 */
import { appendFileSync } from 'node:fs'

/** 事件行格式（与既有 `.plugin-manager-events.log` 契约一致：`[ISO 时刻] 消息`）。 */
export function formatEventLine(at: Date, msg: string): string {
  return '[' + at.toISOString() + '] ' + msg + '\n'
}

/**
 * 追加一行事件（失败即吞：父目录不存在/不可写/磁盘满 → 返回 `false`，**不抛**）。
 * @param file - 目标日志文件绝对路径
 * @param line - 已格式化的整行（含换行；用 {@link formatEventLine} 生成）
 * @returns 是否真的写入成功
 */
export function appendLineSafe(file: string, line: string): boolean {
  try {
    appendFileSync(file, line)
    return true
  } catch {
    return false
  }
}
