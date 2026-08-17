/**
 * 插件管理器会话头动作：任务板旁边的「插件」按钮 + 管理面板。
 * 管理范式参照 VS Code 扩展管理：统计条 + 状态分组 + 多维筛选 + 卡片详情 + 排序。
 * @module dsh-agent-plugin-manager/client/PluginManagerAction
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './remote.ts'

export interface PluginView {
  name: string; version: string; source: string; purpose: string;
  category: string; client: boolean;
  tools: string[]; built: boolean; status: string; profiles: string[];
  config?: Record<string, unknown>
}

export type PluginManagerActionProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'pluginManager'>

const C = {
  surface: 'var(--color-surface, #171a21)',
  border: 'rgba(127,127,127,.22)',
  text: 'var(--color-text, #e6e6e6)',
  textDim: 'rgba(140,145,160,.85)',
  primary: '#4a7dff',
  green: '#5fd08a',
  red: '#ff5f56',
  amber: '#ffb057',
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  mounted: { label: '已启用', color: '#5fd08a', bg: 'rgba(95,208,138,.14)' },
  disabled: { label: '已停用', color: '#ffb057', bg: 'rgba(255,176,87,.14)' },
  unmounted: { label: '未挂载', color: '#9aa3b5', bg: 'rgba(154,163,181,.14)' },
}

const CAT_META: Record<string, { label: string; color: string }> = {
  core: { label: '核心', color: '#8ab4ff' }, 'client-ui': { label: '界面', color: '#c4a7ff' },
  tool: { label: '工具', color: '#5fd08a' }, storage: { label: '存储', color: '#ffb057' },
  subagent: { label: '子代理', color: '#7ad0e8' }, llm: { label: '模型', color: '#ff8fa3' },
  session: { label: '会话', color: '#b8a6f5' }, guard: { label: '防护', color: '#ff9f6e' },
  skill: { label: '技能', color: '#a8d8b9' }, other: { label: '其他', color: '#9aa3b5' },
}

const CAT_COLORS = ['#4a7dff', '#7a5cff', '#5fd08a', '#ffb057', '#ff8fa3', '#7ad0e8', '#b8a6f5', '#ff9f6e', '#a8d8b9', '#9aa3b5', '#c4a7ff']

function btnStyle(color: string): any {
  return {
    border: '1px solid ' + color + '66', borderRadius: '6px', padding: '2px 10px', fontSize: '11px',
    cursor: 'pointer', background: color + '14', color, marginRight: '4px', transition: 'background .12s ease',
  }
}
function chipStyle(active: boolean): any {
  return {
    border: '1px solid ' + (active ? C.primary + 'aa' : C.border), borderRadius: '999px',
    padding: '2px 12px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap',
    background: active ? C.primary + '22' : 'transparent', color: active ? '#9db8ff' : C.textDim,
  }
}

/** 名称首字母彩色圆标（无图标时的视觉标识）。 */
function Avatar({ name, seed }: { name: string; seed: number }): any {
  const color = CAT_COLORS[seed % CAT_COLORS.length] ?? '#9aa3b5'
  const letter = (name.replace(/^@deepseek-ai\//, '').replace(/^dsh-/, '').replace(/^cordis-plugin-/, '')[0] ?? '?').toUpperCase()
  return (
    <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg, ' + color + 'cc, ' + color + '66)', boxShadow: '0 2px 6px ' + color + '33' }}>{letter}</div>
  )
}

export function PluginManagerAction({ remote }: PluginManagerActionProps & { remote?: any }) {
  const [open, setOpen] = useState(false)
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterSource, setFilterSource] = useState('all')
  const [filterCat, setFilterCat] = useState('all')
  const [sortBy, setSortBy] = useState('name')
  const [expanded, setExpanded] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await Promise.race([
        remote?.pluginManager.list(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('连接超时（30s）')), 30000)),
      ])
      if (r?.ok) {
        setPlugins(Array.isArray(r.value?.plugins) ? r.value.plugins : [])
        setMsg(null)
      } else {
        setMsg({ ok: false, text: '✗ 数据加载失败（连接可能中断），自动重试中…' })
        setTimeout(() => { void refresh() }, 3000)
      }
    } catch (err) {
      console.error('[plugin-manager] refresh fail:', err)
      setMsg({ ok: false, text: '✗ 连接中断，自动重试中…' })
      setTimeout(() => { void refresh() }, 3000)
    }
  }, [remote])

  useEffect(() => {
    if (!open) return
    void refresh()
    panelRef.current?.animate(
      [{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open, refresh])

  const act = async (label: string, fn: () => Promise<any>) => {
    setMsg(null)
    setBusy(label)
    try {
      const res = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('连接超时（30s）')), 30000)),
      ])
      if (res?.ok) {
        const biz = res.value as { ok?: boolean; error?: string; note?: string } | undefined
        if (biz && biz.ok === false) {
          setMsg({ ok: false, text: '✗ ' + (biz.error ?? label + ' 失败') })
        } else {
          setMsg({ ok: true, text: '✓ ' + ((biz?.note ?? res.note) ?? label) })
          void refresh()
        }
      } else {
        setMsg({ ok: false, text: '✗ ' + (res?.error ?? label + ' 失败') })
      }
    } catch (err) {
      console.error('[plugin-manager] act fail:', label, err)
      setMsg({ ok: false, text: '✗ 异常: ' + String(err) })
    }
    setBusy('')
  }

  // —— 统计 ——
  const stats = useMemo(() => {
    const mounted = plugins.filter((p) => p.status === 'mounted').length
    const disabled = plugins.filter((p) => p.status === 'disabled').length
    const unmounted = plugins.filter((p) => p.status === 'unmounted').length
    return { total: plugins.length, mounted, disabled, unmounted }
  }, [plugins])

  // —— 筛选 + 排序 ——
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    let list = plugins.filter((p) => {
      if (filterStatus !== 'all' && p.status !== filterStatus) return false
      if (filterSource !== 'all' && p.source !== filterSource) return false
      if (filterCat !== 'all' && (p.category ?? '') !== filterCat) return false
      if (kw) {
        const hay = ((p.name ?? '') + ' ' + (p.purpose ?? '') + ' ' + (p.category ?? '') + ' ' + (p.tools ?? []).join(' ')).toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
    if (sortBy === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    else if (sortBy === 'status') list = [...list].sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name))
    return list
  }, [plugins, search, filterStatus, filterSource, filterCat, sortBy])

  // —— 状态分组（VSCode 范式：已启用/已停用/未挂载）——
  const groups = useMemo(() => {
    const byStatus = { mounted: [] as PluginView[], disabled: [] as PluginView[], unmounted: [] as PluginView[] }
    for (const p of filtered) (byStatus[p.status as keyof typeof byStatus] ?? byStatus.unmounted).push(p)
    return [
      { key: 'mounted', label: '已启用', count: byStatus.mounted.length, items: byStatus.mounted },
      { key: 'disabled', label: '已停用', count: byStatus.disabled.length, items: byStatus.disabled },
      { key: 'unmounted', label: '未挂载', count: byStatus.unmounted.length, items: byStatus.unmounted },
    ].filter((g) => g.count > 0)
  }, [filtered])

  // 分类选项（面板内出现的分类）
  const catOptions = useMemo(() => {
    const set = new Set<string>()
    for (const p of plugins) if (p.category) set.add(p.category)
    return [...set].sort()
  }, [plugins])

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '6px' }}>
      <button
        style={{ border: '1px solid ' + C.border, borderRadius: '8px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', background: 'transparent', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'border-color .12s ease, background .12s ease' }}
        onClick={() => setOpen((v) => !v)}
        title="插件管理"
      >
        插件
        {stats.total > 0 && (
          <span style={{ background: 'linear-gradient(135deg, #4a7dff, #7a5cff)', color: '#fff', fontSize: '10px', fontWeight: 700, borderRadius: '9px', padding: '0 6px', minWidth: '16px', textAlign: 'center' }}>{stats.total}</span>
        )}
      </button>
      {open && (
        <div ref={panelRef} style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '0', zIndex: 40,
          width: '560px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(640px, calc(100vh - 120px))', overflowY: 'auto',
          border: '1px solid ' + C.border, borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(255,255,255,.03), transparent 40%), ' + C.surface,
          boxShadow: '0 16px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset',
          padding: '12px 14px', fontSize: '13px', color: C.text,
        }}>
          {/* 标题 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, letterSpacing: '.03em', background: 'linear-gradient(90deg, #8ab4ff, #c4a7ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>插件管理</span>
            <button onClick={() => setOpen(false)} style={{ border: 'none', background: 'transparent', color: C.textDim, fontSize: '14px', cursor: 'pointer', borderRadius: '6px', width: '24px', height: '24px', lineHeight: '20px' }}>✕</button>
          </div>

          {/* 统计条 */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <div onClick={() => { setFilterStatus('all') }} style={{ flex: '1 1 auto', minWidth: '70px', padding: '6px 10px', borderRadius: 10, border: '1px solid ' + (filterStatus === 'all' ? C.primary + '88' : C.border), cursor: 'pointer', background: filterStatus === 'all' ? C.primary + '14' : 'rgba(127,127,127,.05)', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{stats.total}</div>
              <div style={{ fontSize: 10, color: C.textDim }}>全部</div>
            </div>
            <div onClick={() => { setFilterStatus('mounted') }} style={{ flex: '1 1 auto', minWidth: '70px', padding: '6px 10px', borderRadius: 10, border: '1px solid ' + (filterStatus === 'mounted' ? C.green + '88' : C.border), cursor: 'pointer', background: filterStatus === 'mounted' ? C.green + '14' : 'rgba(127,127,127,.05)', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{stats.mounted}</div>
              <div style={{ fontSize: 10, color: C.textDim }}>已启用</div>
            </div>
            <div onClick={() => { setFilterStatus('disabled') }} style={{ flex: '1 1 auto', minWidth: '70px', padding: '6px 10px', borderRadius: 10, border: '1px solid ' + (filterStatus === 'disabled' ? C.amber + '88' : C.border), cursor: 'pointer', background: filterStatus === 'disabled' ? C.amber + '14' : 'rgba(127,127,127,.05)', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.amber }}>{stats.disabled}</div>
              <div style={{ fontSize: 10, color: C.textDim }}>已停用</div>
            </div>
            <div onClick={() => { setFilterStatus('unmounted') }} style={{ flex: '1 1 auto', minWidth: '70px', padding: '6px 10px', borderRadius: 10, border: '1px solid ' + (filterStatus === 'unmounted' ? '#9aa3b5' + '88' : C.border), cursor: 'pointer', background: filterStatus === 'unmounted' ? 'rgba(154,163,181,.14)' : 'rgba(127,127,127,.05)', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#b9c1d0' }}>{stats.unmounted}</div>
              <div style={{ fontSize: 10, color: C.textDim }}>未挂载</div>
            </div>
          </div>

          {/* 搜索 + 筛选 */}
          <input
            placeholder="搜索插件（名称/用途/工具）"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 12px', borderRadius: 10, border: '1px solid ' + C.border, background: 'rgba(0,0,0,.2)', color: C.text, fontSize: 12, marginBottom: 8, outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={chipStyle(filterSource === 'all')} onClick={() => setFilterSource('all')}>全部来源</span>
            <span style={chipStyle(filterSource === 'self')} onClick={() => setFilterSource('self')}>自研</span>
            <span style={chipStyle(filterSource === 'official')} onClick={() => setFilterSource('official')}>官方</span>
            <select
              value={filterCat}
              onChange={(e) => setFilterCat(e.target.value)}
              style={{ border: '1px solid ' + C.border, borderRadius: 8, padding: '2px 6px', fontSize: 11, background: 'rgba(0,0,0,.2)', color: C.text, outline: 'none' }}
            >
              <option value="all">全部分类</option>
              {catOptions.map((c) => (
                <option key={c} value={c}>{CAT_META[c]?.label ?? c}</option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={{ border: '1px solid ' + C.border, borderRadius: 8, padding: '2px 6px', fontSize: 11, background: 'rgba(0,0,0,.2)', color: C.text, outline: 'none' }}
            >
              <option value="name">按名称</option>
              <option value="status">按状态</option>
            </select>
          </div>

          {msg && (
            <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8, fontSize: 12, color: msg.ok ? C.green : C.red, background: msg.ok ? 'rgba(95,208,138,.08)' : 'rgba(255,95,86,.08)' }}>
              {msg.text}
            </div>
          )}

          {/* 分组列表 */}
          {groups.length === 0 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: C.textDim, fontSize: 12 }}>没有匹配的插件——换个搜索词或筛选条件试试</div>
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 2px' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#d4d8e0' }}>{g.label}</span>
                <span style={{ fontSize: 10.5, color: C.textDim, background: 'rgba(127,127,127,.1)', borderRadius: 8, padding: '0 7px' }}>{g.count}</span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>
              {g.items.map((p, idx) => {
                const st = STATUS_META[p.status] ?? { label: p.status, color: C.textDim, bg: 'transparent' }
                const cat = CAT_META[p.category] ?? (p.category ? { label: p.category, color: '#9aa3b5' } : null)
                const isOpen = expanded === p.name
                return (
                  <div
                    key={p.name}
                    style={{ border: '1px solid ' + (isOpen ? C.primary + '66' : C.border), borderRadius: 12, padding: '8px 10px', marginBottom: 6, background: isOpen ? 'rgba(74,125,255,.05)' : 'rgba(127,127,127,.04)', cursor: 'pointer', transition: 'border-color .12s ease' }}
                    onClick={() => setExpanded(isOpen ? null : p.name)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={p.name} seed={idx} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{p.name}</span>
                          {p.version && <span style={{ color: C.textDim, fontSize: 10.5 }}>{p.version}</span>}
                          <span style={{ color: st.color, background: st.bg, borderRadius: 4, padding: '0 6px', fontSize: 10.5 }}>{st.label}</span>
                          {cat && <span style={{ color: cat.color, border: '1px solid ' + cat.color + '55', borderRadius: 4, padding: '0 5px', fontSize: 10 }}>{cat.label}</span>}
                          {p.source === 'self' && <span style={{ color: '#8ab4ff', fontSize: 10 }}>自研</span>}
                          {p.client && <span style={{ color: '#c4a7ff', fontSize: 10 }}>浏览器端</span>}
                        </div>
                        <div style={{ color: C.textDim, fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.purpose || '(暂无简介)'}</div>
                      </div>
                      <span style={{ color: C.textDim, fontSize: 11, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' }}>›</span>
                    </div>
                    {isOpen && (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed ' + C.border }}>
                        {p.purpose && <div style={{ color: C.textDim, fontSize: 11.5, marginBottom: 6 }}>{p.purpose}</div>}
                        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 3 }}>
                          来源: {p.source === 'self' ? '自研' : '官方'}{p.profiles.length ? ' · 挂载: ' + p.profiles.join(', ') : ''}
                        </div>
                        {p.tools.length > 0 && (
                          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 3 }}>工具: {p.tools.join(' / ')}</div>
                        )}
                        {p.config && Object.keys(p.config).length > 0 && (
                          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 3 }}>配置: {JSON.stringify(p.config).slice(0, 120)}</div>
                        )}
                        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                          {p.status === 'unmounted' && p.source === 'self' && <button style={btnStyle(C.primary)} disabled={busy !== ''} onClick={() => void act('挂载 ' + p.name, () => remote.pluginManager.start({ name: p.name }))}>{busy === '挂载 ' + p.name ? '处理中…' : '挂载'}</button>}
                          {p.status === 'mounted' && <button style={btnStyle(C.amber)} disabled={busy !== ''} onClick={() => void act('停用 ' + p.name, () => remote.pluginManager.stop({ name: p.name }))}>{busy === '停用 ' + p.name ? '处理中…' : '停用'}</button>}
                          {p.status === 'disabled' && <button style={btnStyle(C.green)} disabled={busy !== ''} onClick={() => void act('启用 ' + p.name, () => remote.pluginManager.start({ name: p.name }))}>{busy === '启用 ' + p.name ? '处理中…' : '启用'}</button>}
                          {p.status !== 'unmounted' && <button style={btnStyle(C.red)} disabled={busy !== ''} onClick={() => { if (window.confirm('卸载 ' + p.name + '？（数据目录保留）')) void act('删除 ' + p.name, () => remote.pluginManager.unmount({ name: p.name })) }}>{busy === '删除 ' + p.name ? '处理中…' : '删除'}</button>}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {/* 创建区 */}
          <div style={{ marginTop: 10, borderTop: '1px solid ' + C.border, paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>创建新插件（脚手架）</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                placeholder="插件名（如 dsh-my-plugin）"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: 'rgba(0,0,0,.2)', color: C.text, fontSize: 11.5, width: 150, outline: 'none' }}
              />
              <input
                placeholder="一句话用途（可选）"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: 'rgba(0,0,0,.2)', color: C.text, fontSize: 11.5, width: 190, outline: 'none' }}
              />
              <button style={btnStyle(C.green)} disabled={busy !== ''} onClick={() => {
                const name = createName.trim()
                if (!name) { setMsg({ ok: false, text: '✗ 请输入插件名' }); return }
                void act('创建 ' + name, () => remote.pluginManager.create({ name, description: createDesc.trim() || undefined }))
              }}>{busy === '创建 ' + createName.trim() ? '处理中…' : '创建'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
