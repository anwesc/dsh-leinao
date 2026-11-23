/**
 * 工作记录：把「这一轮干了什么」从工具调用里捡出来，攒成一条工作日志。
 *
 * 为什么要有它：记忆原来只有一条路——模型自己判断值得记，然后调 persona_remember。
 * 工作过程中（改文件、跑测试、查资料）这类「过程事实」模型通常不会特意去记，
 * 结果就是聊了很久、库里还是空的。这里改成：只要真的动了手，就自动留一笔。
 *
 * 采集点是宿主的 `tools/result`（一次工具调用结束），按会话攒在内存里，
 * 回合结束时融合成当天、当前仓库的一条 page（`worklog/<日期>/<仓库>`）。
 * 全是结构化的事实，不做语义推断，所以不花钱、也不会编。
 */

export const WORKLOG = {
  /** 少于这么多次「有意义的动作」就不记，避免每轮都冒一条 */
  minActions: 2,
  /** 一条日志最多列多少个动作 */
  maxActions: 12,
  /** 日志正文上限，超出保留最近的 */
  maxContentChars: 2400,
  /** 裁剪后保留的尾部长度 */
  keepChars: 1800,
  /** 只读、检索、导出类工具不算「干了什么」 */
  ignored: new Set([
    'read',
    'ops_inspect_local_file',
    'ops_read_files',
    'ops_grep',
    'ops_glob',
    'glob',
    'grep',
    'list_subagent_models',
    'persona_state',
    'persona_recall',
    'persona_export',
    'persona_observe',
    'persona_remember',
  ]),
}

function baseName(path) {
  const text = String(path ?? '').replace(/\\/g, '/')
  const parts = text.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** 一次工具调用 → 一句人话；不值得记的返回 null。 */
export function describeAction(name, args) {
  const tool = String(name ?? '')
  if (!tool || WORKLOG.ignored.has(tool)) return null
  const a = args && typeof args === 'object' ? args : {}

  if (tool === 'write' || tool === 'edit' || tool === 'ops_write_file' || tool === 'ops_edit_file') {
    const file = baseName(a.file_path ?? a.path)
    return file ? `改 ${file}` : null
  }
  if (tool === 'ops_bash' || tool === 'bash' || tool === 'shell' || tool === 'terminal') {
    const command = clip(a.command ?? a.description ?? '', 60)
    return command ? `跑 ${command}` : null
  }
  if (tool === 'web_fetch') {
    try {
      return `查 ${new URL(String(a.url)).hostname}`
    } catch {
      return '查网页'
    }
  }
  if (tool === 'web_search') {
    const query = Array.isArray(a.queries) ? a.queries[0] : a.query
    return query ? `搜 ${clip(query, 40)}` : '搜资料'
  }
  if (tool === 'subagent' || tool === 'subagent_fork') {
    return `派 ${clip(a.description ?? '子任务', 40)}`
  }
  if (tool === 'workflow') {
    return `跑工作流 ${clip(a.meta?.name ?? '', 40)}`.trim()
  }
  if (tool === 'schedule_create') return `排 ${clip(a.title ?? '定时任务', 40)}`
  return null
}

/** 按会话攒动作；回合结束时取走。 */
export function createWorklogBuffer(limits = WORKLOG) {
  const byAgent = new Map()

  function ensure(agentId) {
    const key = String(agentId ?? '')
    if (!byAgent.has(key)) byAgent.set(key, [])
    return byAgent.get(key)
  }

  return {
    record(agentId, name, args) {
      if (!agentId) return
      const action = describeAction(name, args)
      if (!action) return
      const list = ensure(agentId)
      if (list[list.length - 1] === action) return // 同一个动作连着做，只记一次
      list.push(action)
      if (list.length > limits.maxActions * 3) list.splice(0, list.length - limits.maxActions * 3)
    },
    take(agentId) {
      const list = byAgent.get(String(agentId ?? ''))
      if (!list || list.length === 0) return []
      byAgent.delete(String(agentId ?? ''))
      return list
    },
    peek(agentId) {
      return byAgent.get(String(agentId ?? '')) ?? []
    },
    clear() {
      byAgent.clear()
    },
  }
}

/** 动作列表 → 一段日志（同一天里会往同一条 page 后面追加）。 */
export function buildWorklogSegment(actions, nowMs = Date.now(), limits = WORKLOG) {
  const list = (actions ?? []).filter(Boolean)
  if (list.length === 0) return ''
  const shown = list.slice(-limits.maxActions)
  const stamp = new Date(nowMs)
  const time = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`
  const more = list.length > shown.length ? ` 等 ${list.length} 步` : ''
  return `- ${time} ${shown.join('；')}${more}`
}

/** 追加到已有的工作记录后面，超长时保留最近的部分。 */
export function mergeWorklog(existing, segment, limits = WORKLOG) {
  const head = String(existing ?? '').trimEnd()
  const next = head ? `${head}\n${segment}` : segment
  if (next.length <= limits.maxContentChars) return next
  const tail = next.slice(next.length - limits.keepChars)
  const cut = tail.indexOf('\n')
  // 从半行中间切开就把那半行丢掉，保证每条记录都是一整行
  return `…\n${cut >= 0 ? tail.slice(cut + 1) : tail}`
}

/** 仓库名 / 目录名 → 能放进 path 的 slug（小写、只留字母数字和 -_）。 */
export function worklogSlug(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'workspace'
}

/** 当天 + 当前目录 → 工作记录的 page 路径。 */
export function worklogPath(cwd, nowMs = Date.now()) {
  const day = new Date(nowMs)
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const name = String(cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  return `worklog/${ymd}/${worklogSlug(name)}`
}
