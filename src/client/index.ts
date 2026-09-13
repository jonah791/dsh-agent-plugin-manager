/**
 * 插件管理器 client 插件：$mount remote + 注册会话头「插件」动作（任务板旁边）。
 * @module dsh-agent-plugin-manager/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PluginManagerAction } from './PluginManagerAction.tsx'
import TYPERT_REMOTE from './remote.ts'

export type { PluginManagerActionProps, PluginView } from './PluginManagerAction.tsx'
export { TYPERT_REMOTE }

export const inject = ['slots', 'remote'] as const

export function apply(ctx: ClientContext): void {
  void (async () => {
    // mount 超时重试：connection 未稳期 $mount 可能挂起（无超时）——15s 超时 + 3s 间隔重试
    let mountedOk = false
    for (let attempt = 0; attempt < 8 && !mountedOk; attempt += 1) {
      try {
        await Promise.race([
          ctx.remote.$mount(TYPERT_REMOTE),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('mount timeout')), 15000)),
        ])
        mountedOk = true
      } catch (err) {
        console.warn('[plugin-manager] mount 重试 ' + (attempt + 1) + ': ' + String(err))
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    if (!mountedOk) {
      console.error('[plugin-manager] mount 最终失败（connection 未恢复）')
      return
    }
    try {
      await ctx.plugin({
        name: 'plugin-manager-ui',
        inject: ['slots', 'remote', 'remote.pluginManager'],
        apply: () => {
          // 2026-09-13 撤除 GUI 槽位（主人定调：GUI 只留 1 个入口——面板宿主的「面板」按钮）：
          // 原此处注册 `conversation.session.header.actions` 的「插件」按钮（id=plugin-manager order=40）。
          // 插件管理的界面已迁为面板宿主里的一页（dsh-panel `panels/plugin-manager.ts`，id=plugin-manager）。
          // 保留 $mount 与 typert remote（宿主侧能力不受影响）；要恢复入口即在此重新 register。
        },
      })
      console.info('[plugin-manager] ui ready')
    } catch (err) {
      console.error('[plugin-manager] init fail:', err)
    }
  })()
}
