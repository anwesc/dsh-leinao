/**
 * 类脑的客户端半侧：在 DSH「设置」里加一张「类脑」卡片。
 *
 * 手写、不打包：DSH 的模块加载器按约定加载 `client.js`（package.json 的
 * `exports["./client"]`），内容就是 `window.__ModuleLoader__.load({ id, factory })`
 * 包一层 CJS 工厂；React 由宿主通过 `require('react')` 提供，不需要 node_modules。
 *
 * 数据全部走宿主同源的 `/dsh-leinao/config`（服务端在 src/settings.js 里注册）：
 * GET 拿「生效配置 + 默认值 + 运行状态 + 重启项」，PUT 只提交改动过的键，
 * 宿主写进 $DSH_HOME/leinao.json 后立刻热重载；标了「重启」的项下一轮 DSH 启动才生效。
 *
 * 布局（设置页通常很窄，移动端优先）：
 * - 顶部一条运行状态，收起时也知道这崽子现在什么阶段；
 * - 每个分组一张可折叠卡片，标题右边显示「改了几项」；
 * - 开关/短数字用紧凑行（说明在左、控件在右），长文本整行；
 * - 底部粘一条保存栏，随时能看到「有未保存的改动」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-leinao',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-plugin-leinao'
    const API = '/dsh-leinao/config'
    const SESSION_API = '/dsh-leinao/session'

    // 用宿主主题变量（--dsw-alias-*），跟随明暗主题；fallback 只兜底老版本。
    const BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))'
    const ACCENT = 'var(--dsw-alias-brand-primary, #4c6ef5)'
    const SURFACE = 'var(--dsw-alias-bg-base, transparent)'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    /** 字段表：一行一个可配项。`key` 与服务端 EDITABLE 白名单一一对应。 */
    const GROUPS = [
      {
        id: 'basic',
        title: '基本',
        hint: '总开关与排查日志。关掉再打开需要重启 DSH。',
        open: true,
        rows: [
          { key: 'enabled', kind: 'switch', label: '启用类脑', hint: '关掉后不再注入人格，也不记事件', restart: true },
          { key: 'userName', kind: 'text', label: '默认称呼', hint: '怎么称呼用户；seed 时问到的称呼优先，这里只是兜底', placeholder: '老大' },
          { key: 'debug', kind: 'switch', label: '调试日志', hint: '把每条事件写进宿主日志，排查用' },
        ],
      },
      {
        id: 'journal',
        title: '日记与同步',
        hint: '事件流按设备分文件存在数据目录里，可选 git 自动提交和推送。',
        rows: [
          { key: 'journal.git', kind: 'switch', label: '用 git 记录', hint: '关闭后只写文件，不做提交', restart: true },
          { key: 'journal.push', kind: 'switch', label: '自动推送', hint: '提交后按下面的间隔推送远程' },
          { key: 'journal.remote', kind: 'text', label: '远程仓库', hint: '留空沿用数据目录里已有的 origin', placeholder: 'https://github.com/you/persona.git' },
          { key: 'journal.commitDebounceMs', kind: 'number', label: '提交防抖', hint: '安静这么久再提交一次', unit: '毫秒', min: 0, max: 120000, step: 500 },
          { key: 'journal.pushDebounceMs', kind: 'number', label: '推送防抖', hint: '连着聊几轮只推一次', unit: '毫秒', min: 0, max: 3600000, step: 5000 },
          { key: 'journal.pullTimeoutMs', kind: 'number', label: '同步超时', hint: 'git 拉取最多等多久', unit: '毫秒', min: 1000, max: 300000, step: 1000 },
        ],
      },
      {
        id: 'mood',
        title: '心情',
        hint: '心情是快变量：每轮浮动，随后慢慢回到性格基线。',
        rows: [
          { key: 'mood.halfLifeHours', kind: 'number', label: '回基线半衰期', hint: '越多小时，情绪退得越慢', unit: '小时', min: 1, max: 72, step: 0.5 },
          { key: 'mood.debounceMs', kind: 'number', label: '落盘防抖', hint: '状态写盘的安静间隔', unit: '毫秒', min: 0, max: 120000, step: 500 },
        ],
      },
      {
        id: 'prompt',
        title: '注入',
        hint: '每轮塞进 system prompt 的那段人格文本。',
        rows: [
          { key: 'prompt.maxChars', kind: 'number', label: '注入上限', hint: '超过就截断，宁短勿长', unit: '字符', min: 200, max: 8000, step: 100 },
          { key: 'prompt.order', kind: 'number', label: '注入顺序', hint: '数值小的排前面；改完需要重启', unit: '序号', min: 0, max: 1000, step: 10, restart: true },
          { key: 'prompt.userMaxChars', kind: 'number', label: '用户模型上限', hint: '用户模型的观察单独一块，0 表示关掉', unit: '字符', min: 0, max: 4000, step: 50 },
          { key: 'prompt.userOrder', kind: 'number', label: '用户模型顺序', hint: '通常紧跟人格块；改完需要重启', unit: '序号', min: 0, max: 1000, step: 10, restart: true },
        ],
      },
      {
        id: 'index',
        title: '记忆索引',
        hint: '每轮只带一小段目录：重要的常驻，不重要的自己淡出。',
        open: true,
        rows: [
          { key: 'memory.indexMaxLines', kind: 'number', label: '索引行数', hint: '每轮最多带几条记忆', unit: '行', min: 1, max: 20, step: 1 },
          { key: 'memory.indexMaxChars', kind: 'number', label: '索引字数', hint: '目录总长度上限', unit: '字', min: 40, max: 4000, step: 20 },
          { key: 'memory.halfLifeDays', kind: 'number', label: '记忆半衰期', hint: '强度多久减半', unit: '天', min: 1, max: 365, step: 1 },
          { key: 'memory.strongThreshold', kind: 'number', label: '常驻阈值', hint: '强度高于此值每轮都在索引里', unit: '0–1', min: 0.05, max: 1, step: 0.05 },
          { key: 'memory.hideBelow', kind: 'number', label: '淡出阈值', hint: '低于此值退出索引，只能显式召回', unit: '0–1', min: 0, max: 0.99, step: 0.05 },
        ],
      },
      {
        id: 'fold',
        title: '整理与召回',
        hint: '旧记忆攒够了，就在注入末尾提醒模型调 persona_digest 压成一条。',
        rows: [
          { key: 'memory.foldAfterDays', kind: 'number', label: '多久没提', hint: '超过这些天没被召回才算旧', unit: '天', min: 0, max: 3650, step: 1 },
          { key: 'memory.foldBelowStrength', kind: 'number', label: '旧到什么程度', hint: '强度低于此值才进候选', unit: '0–1', min: 0.05, max: 1, step: 0.05 },
          { key: 'memory.foldMinGroup', kind: 'number', label: '成组条数', hint: '同一标签至少几条才提醒', unit: '条', min: 2, max: 50, step: 1 },
          { key: 'memory.foldEveryTurns', kind: 'number', label: '提醒间隔', hint: '每多少轮提一次；0 表示不提醒', unit: '轮', min: 0, max: 1000, step: 10 },
          { key: 'memory.foldMaxPrompts', kind: 'number', label: '每次会话上限', hint: '提醒最多提几次，免得烦', unit: '次', min: 0, max: 100, step: 1 },
          { key: 'memory.weakRecallHours', kind: 'number', label: '弱召回冷却', hint: '同一页多久内不重复记召回', unit: '小时', min: 0, max: 720, step: 1 },
        ],
      },
      {
        id: 'proactive',
        title: '主动开口',
        hint: '对话安静下来后，自己想起一件事说一句。宁缺毋滥，挑不出合适的就不说话。',
        rows: [
          { key: 'proactive.enabled', kind: 'switch', label: '允许主动开口', hint: '关掉后只在你说话时才回应' },
          { key: 'proactive.minMinutes', kind: 'number', label: '最短间隔', hint: '两次主动开口之间至少隔多久', unit: '分钟', min: 0, max: 1440, step: 5 },
          { key: 'proactive.maxMinutes', kind: 'number', label: '最长间隔', hint: '实际间隔在这两个值之间随机', unit: '分钟', min: 0, max: 1440, step: 5 },
          { key: 'proactive.maxPerSession', kind: 'number', label: '每次会话上限', hint: '一次会话最多主动几次', unit: '次', min: 0, max: 10, step: 1 },
          { key: 'proactive.cooldownSeconds', kind: 'number', label: '跨插件冷却', hint: '别的插件刚说过话就让一让', unit: '秒', min: 0, max: 3600, step: 30 },
          { key: 'proactive.minStrength', kind: 'number', label: '最低记忆强度', hint: '太弱的旧事不主动提', unit: '0–1', min: 0, max: 1, step: 0.05 },
          { key: 'proactive.rementionDays', kind: 'number', label: '重提间隔', hint: '同一条记忆隔多少天才能再主动提', unit: '天', min: 0, max: 365, step: 1 },
          { key: 'proactive.sessionTtlDays', kind: 'number', label: '会话开关保质期', hint: '会话级开关记多久；0 表示永不过期', unit: '天', min: 0, max: 365, step: 1 },
        ],
      },
    ]

    const ROW_INDEX = new Map(GROUPS.flatMap((group) => group.rows.map((row) => [row.key, row])))

    const PHASE_LABEL = { seed: '等待出生', active: '相处中' }

    const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    /** 嵌套配置 → 扁平 { 'a.b': value }；只收叶子。 */
    function flatten(object, prefix = '', out = {}) {
      if (!isPlain(object)) return out
      for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (isPlain(value)) flatten(value, path, out)
        else out[path] = value
      }
      return out
    }

    function writePath(object, path, value) {
      const parts = path.split('.')
      let cursor = object
      for (const part of parts.slice(0, -1)) {
        if (!isPlain(cursor[part])) cursor[part] = {}
        cursor = cursor[part]
      }
      cursor[parts[parts.length - 1]] = value
      return object
    }

    /** 只把改动过的键拼成 patch：没动过的键不写进配置文件。 */
    function changesOf(base, draft) {
      const patch = {}
      let count = 0
      for (const [key, value] of Object.entries(draft)) {
        if (String(value) === String(base[key])) continue
        const row = ROW_INDEX.get(key)
        if (!row) continue
        writePath(patch, key, row.kind === 'number' ? Number(value) : value)
        count += 1
      }
      return { patch, count }
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 2px 6px' },
      intro: { margin: 0, fontSize: 13, lineHeight: 1.7, opacity: 0.86 },
      status: {
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px',
        borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
      },
      chips: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
        borderRadius: 999, fontSize: 12, border: `1px solid ${BORDER}`, whiteSpace: 'nowrap',
      },
      chipAccent: { borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4c6ef5) 45%, transparent)', color: ACCENT },
      path: { margin: 0, fontSize: 11.5, lineHeight: 1.5, opacity: 0.6, fontFamily: MONO, wordBreak: 'break-all' },

      card: { border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' },
      cardHeader: {
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px',
        border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
      },
      cardText: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 },
      cardTitle: { fontSize: 13.5, fontWeight: 700 },
      cardHint: { fontSize: 11.5, lineHeight: 1.5, opacity: 0.62 },
      cardCount: { fontSize: 11.5, color: ACCENT, whiteSpace: 'nowrap' },
      caret: { fontSize: 10, opacity: 0.5, transform: 'rotate(0deg)', transition: 'transform .15s ease' },
      caretOpen: { transform: 'rotate(90deg)' },

      body: { display: 'flex', flexDirection: 'column', borderTop: `1px solid ${BORDER}` },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
        borderTop: '1px solid rgba(127,127,127,.12)',
      },
      rowFirst: { borderTop: 0 },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 },
      label: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 },
      rowHint: { fontSize: 11.5, lineHeight: 1.5, opacity: 0.6 },
      restartBadge: {
        fontSize: 10, padding: '0 6px', borderRadius: 999, lineHeight: '16px',
        border: '1px solid rgba(214,140,60,.55)', color: 'rgba(214,140,60,.95)',
      },

      control: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 },

      switch: {
        position: 'relative', width: 38, height: 22, borderRadius: 999, border: `1px solid ${BORDER}`,
        background: 'rgba(127,127,127,.18)', cursor: 'pointer', padding: 0, transition: 'background .15s ease',
      },
      switchOn: { background: ACCENT, borderColor: ACCENT },
      thumb: {
        position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'transform .15s ease', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
      },
      thumbOn: { transform: 'translateX(16px)' },

      input: {
        width: 96, padding: '5px 8px', borderRadius: 8, border: `1px solid ${BORDER}`,
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12.5, textAlign: 'right',
      },
      inputWide: { width: '100%', textAlign: 'left' },
      unit: { fontSize: 11.5, opacity: 0.55, minWidth: 26 },

      notice: { margin: 0, fontSize: 11.5, lineHeight: 1.6, opacity: 0.8 },
      error: { margin: 0, fontSize: 12, color: 'rgba(214,80,80,.95)', lineHeight: 1.6 },

      footer: {
        position: 'sticky', bottom: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 2px', background: SURFACE,
        borderTop: '1px solid rgba(127,127,127,.12)', flexWrap: 'wrap',
      },
      footerState: { flex: '1 1 auto', fontSize: 12, opacity: 0.65 },
      button: {
        padding: '7px 16px', borderRadius: 10, border: 0, background: ACCENT, color: '#fff',
        font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      buttonGhost: {
        padding: '7px 12px', borderRadius: 10, border: `1px solid ${BORDER}`, background: 'transparent',
        color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
    }

    function Switch({ id, checked, onChange }) {
      return h(
        'button',
        {
          id, type: 'button', role: 'switch', 'aria-checked': checked,
          style: { ...S.switch, ...(checked ? S.switchOn : null) },
          onClick: () => onChange(!checked),
        },
        h('span', { style: { ...S.thumb, ...(checked ? S.thumbOn : null) } }),
      )
    }

    function Row({ row, value, onChange }) {
      const id = `leinao-${row.key.replace(/\./g, '-')}`
      const control = row.kind === 'switch'
        ? h(Switch, { id, checked: Boolean(value), onChange })
        : h('input', {
            id,
            type: row.kind === 'number' ? 'number' : 'text',
            value: value ?? '',
            min: row.min,
            max: row.max,
            step: row.step,
            placeholder: row.placeholder ?? '',
            style: { ...S.input, ...(row.kind === 'text' ? S.inputWide : null) },
            onChange: (event) => onChange(event.target.value),
          })

      if (row.kind === 'text') {
        return h(
          'div',
          { style: { ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
          h('div', { style: S.rowMain }, h('label', { htmlFor: id, style: S.label }, row.label, row.restart ? h('span', { style: S.restartBadge }, '重启') : null), row.hint ? h('span', { style: S.rowHint }, row.hint) : null),
          control,
        )
      }

      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.rowMain },
          h('label', { htmlFor: id, style: S.label }, row.label, row.restart ? h('span', { style: S.restartBadge }, '重启') : null),
          row.hint ? h('span', { style: S.rowHint }, row.hint) : null,
        ),
        h('div', { style: S.control }, control, row.kind === 'number' && row.unit ? h('span', { style: S.unit }, row.unit) : null),
      )
    }

    const rowMatches = (row, needle) => {
      if (!needle) return true
      const haystack = `${row.label ?? ''} ${row.key ?? ''} ${row.hint ?? ''}`.toLowerCase()
      return haystack.includes(needle)
    }

    /**
     * 标签聚类布局（纯函数，供 GraphCard 与单测共用）：
     * 每个节点归到它最「大众」的标签下，标签按人数占纬度带；带内再按环排开。
     */
    const layoutNodes = (source) => {
    const nodes = source ?? []
    if (nodes.length === 0) return []
    const tagCount = new Map()
    for (const node of nodes) {
      for (const tag of node.tags ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
    }
    const bandOf = (node) => {
      let best = null
      let bestCount = 0
      for (const tag of node.tags ?? []) {
        const count = tagCount.get(tag) ?? 0
        if (count > bestCount || (count === bestCount && best !== null && tag < best)) {
          best = tag
          bestCount = count
        }
    }
    return best ?? `subject:${node.subject ?? 'self'}`
  }
  const bands = new Map()
  for (const node of nodes) {
    const key = bandOf(node)
    if (!bands.has(key)) bands.set(key, [])
    bands.get(key).push(node)
  }
  const ordered = [...bands.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    return a[0].localeCompare(b[0])
  })
  const gap = 0.06
  const usable = Math.max(0.2, 2 - gap * Math.max(0, ordered.length - 1))
  const result = []
  let cursor = 1
  ordered.forEach(([key, members], bandIndex) => {
    const height = (members.length / nodes.length) * usable
    const center = cursor - height / 2
    cursor -= height + gap
    members.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const perRow = 12
    const rows = Math.max(1, Math.ceil(members.length / perRow))
    for (let row = 0; row < rows; row += 1) {
      const slice = members.slice(row * perRow, (row + 1) * perRow)
      const y = rows === 1 ? center : center + ((row + 0.5) / rows - 0.5) * height
      const ring = Math.sqrt(Math.max(0.02, 1 - y * y))
      slice.forEach((node, index) => {
        const angle = (index / Math.max(1, slice.length)) * Math.PI * 2 + row * 0.7 + bandIndex * 0.9
        result.push({ node, band: key, x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring })
      })
    }
  })
  return result
    }

    /** 3D 投影：把旋转后的球坐标落到画布像素上（radius 由画布尺寸推）。 */
    const projectPoint = (point, view, width, height) => {
      const radius = Math.min(width, height) * 0.4
      const focal = 900
      const camera = radius * 2.4
      const cy = Math.cos(view.yaw)
      const sy = Math.sin(view.yaw)
      const cp = Math.cos(view.pitch)
      const sp = Math.sin(view.pitch)
      const x1 = point.x * cy - point.z * sy
      const z1 = point.x * sy + point.z * cy
      const y2 = point.y * cp - z1 * sp
      const z2 = point.y * sp + z1 * cp
      const scale = (focal / Math.max(60, focal + z2 * radius + camera)) * view.zoom
      return {
        id: point.node.id,
        x: width / 2 + x1 * radius * scale,
        y: height / 2 + y2 * radius * scale,
        z: z2,
        scale,
      }
    }

    /** 把某个节点转到正对镜头需要的 yaw/pitch。 */
    const flyAngles = (point) => ({
      yaw: Math.atan2(point.x, point.z),
      pitch: Math.atan2(-point.y, -Math.hypot(point.x, point.z)),
    })

    function Card({ group, draft, changed, onToggle, filter = '', openSignal = 0, registerRef, alwaysOpen = false }) {
      const [open, setOpen] = React.useState(() => {
        try {
          const saved = window.localStorage?.getItem(`dsh-leinao:card:${group.id}`)
          if (saved === '1') return true
          if (saved === '0') return false
        } catch {
          /* 隐私模式下 localStorage 可能不可用 */
        }
        return Boolean(group.open)
      })
      const needle = String(filter ?? '').trim().toLowerCase()
      const rows = needle ? group.rows.filter((row) => rowMatches(row, needle)) : group.rows

      React.useEffect(() => {
        if (openSignal) setOpen(true)
      }, [openSignal])

      const toggle = () => {
        const next = !open
        setOpen(next)
        try {
          window.localStorage?.setItem(`dsh-leinao:card:${group.id}`, next ? '1' : '0')
        } catch {
          /* 忽略 */
        }
      }
      if (needle && rows.length === 0) return null
      const expanded = needle || alwaysOpen ? true : open

      return h(
        'section',
        { id: `dsh-leinao-group-${group.id}`, ref: registerRef, style: S.card },
        alwaysOpen
          ? h(
              'div',
              { style: S.cardHeader },
              h(
                'span',
                { style: S.cardText },
                h('span', { style: S.cardTitle }, group.title),
                h('span', { style: S.cardHint }, group.hint),
              ),
              changed > 0 ? h('span', { style: S.cardCount }, `改 ${changed} 项`) : null,
            )
          : h(
          'button',
          { type: 'button', style: S.cardHeader, onClick: toggle, 'aria-expanded': expanded },
          h('span', { style: { ...S.caret, ...(expanded ? S.caretOpen : null) } }, '▶'),
          h(
            'span',
            { style: S.cardText },
            h('span', { style: S.cardTitle }, group.title),
            h('span', { style: S.cardHint }, group.hint),
          ),
          changed > 0 ? h('span', { style: S.cardCount }, `改 ${changed} 项`) : null,
        ),
        expanded
          ? h(
              'div',
              { style: S.body },
              rows.map((row, index) => h(Row, {
                key: row.key,
                row,
                value: draft[row.key],
                onChange: (value) => onToggle(row.key, value),
              })),
            )
          : null,
      )
    }

    const GRAPH_API = '/dsh-leinao/graph'

    /**
     * 记忆图谱：一张零依赖的 3D 球（canvas，不引任何库）。
     * 节点按 subject 排成两条带（自己 / 老大），连线就是页之间的 links；
     * 拖动旋转、滚轮缩放、点节点看详情。数据每次点「刷新」现算，不吃缓存。
     */
    function GraphCard() {
      const [graph, setGraph] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const canvasRef = React.useRef(null)
      const viewRef = React.useRef({ yaw: 0.45, pitch: 0.2, zoom: 1 })
      const pointsRef = React.useRef([])
      const dragRef = React.useRef(null)
      const flyRef = React.useRef(0)

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const response = await fetch(GRAPH_API)
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setGraph(body)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      // 标签聚类：每个节点归到它最「大众」的标签下（实现在 layoutNodes，纯函数好测）
      const positions = React.useMemo(() => layoutNodes(graph?.nodes ?? []), [graph])

      const matches = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return []
        return (graph?.nodes ?? [])
          .filter((node) =>
            node.id.toLowerCase().includes(needle)
            || String(node.title ?? '').toLowerCase().includes(needle)
            || (node.tags ?? []).some((tag) => String(tag).toLowerCase().includes(needle)))
          .slice(0, 8)
      }, [graph, query])

      const draw = React.useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const width = canvas.clientWidth || 520
        const height = canvas.clientHeight || 340
        const dpr = window.devicePixelRatio || 1
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
        const ink = getComputedStyle(canvas).color || '#888'
        const view = viewRef.current
        const project = (point) => projectPoint(point, view, width, height)
        const projected = positions.map(project)
        const byId = new Map(projected.map((point) => [point.id, point]))
        pointsRef.current = projected

        for (const edge of graph?.edges ?? []) {
          const from = byId.get(edge.source)
          const to = byId.get(edge.target)
          if (!from || !to) continue
          const depth = Math.max(0, Math.min(1, (2 - (from.z + to.z)) / 4))
          ctx.strokeStyle = `rgba(140,140,140,${(0.08 + depth * 0.32).toFixed(3)})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(from.x, from.y)
          ctx.lineTo(to.x, to.y)
          ctx.stroke()
        }

        const nodeById = new Map(positions.map((item) => [item.node.id, item.node]))
        const matchIds = new Set(matches.map((node) => node.id))
        const ordered = [...projected].sort((a, b) => a.z - b.z)
        for (const point of ordered) {
          const node = nodeById.get(point.id)
          if (!node) continue
          const depth = Math.max(0, Math.min(1, (1 - point.z) / 2))
          const r = (3.4 + Math.min(6, Math.sqrt(node.degree ?? 0) * 2.4)) * point.scale
          const matched = matchIds.has(node.id)
          const dimmed = matchIds.size > 0 && !matched
          ctx.globalAlpha = (0.3 + depth * 0.7) * (dimmed ? 0.22 : 1)
          ctx.fillStyle = node.subject === 'user' ? '#e8590c' : '#4c6ef5'
          ctx.beginPath()
          ctx.arc(point.x, point.y, r, 0, Math.PI * 2)
          ctx.fill()
          if (matched && !dimmed) {
            ctx.globalAlpha = 0.95
            ctx.strokeStyle = '#f0a020'
            ctx.lineWidth = 1.8
            ctx.beginPath()
            ctx.arc(point.x, point.y, r + 4, 0, Math.PI * 2)
            ctx.stroke()
          }
          if (selected === node.id) {
            ctx.globalAlpha = 1
            ctx.strokeStyle = ink
            ctx.lineWidth = 1.6
            ctx.beginPath()
            ctx.arc(point.x, point.y, r + 3.5, 0, Math.PI * 2)
            ctx.stroke()
          }
          if (selected === node.id || matched || (node.degree ?? 0) >= 2) {
            ctx.globalAlpha = 0.35 + depth * 0.5
            ctx.fillStyle = ink
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            const label = node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title
            ctx.fillText(label, point.x + r + 4, point.y + 3.5)
          }
        }
        // 带名：取每条带里最左边、且朝前的那个点，把标签挂在它左边。
        const bandById = new Map(positions.map((item) => [item.node.id, item.band]))
        const bandBest = new Map()
        for (const point of projected) {
          const band = bandById.get(point.id)
          if (!band) continue
          const best = bandBest.get(band)
          if (!best || point.x < best.x) bandBest.set(band, point)
        }
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        for (const [band, point] of bandBest) {
          if (point.z > 0.15) continue
          const label = band.startsWith('subject:')
            ? (band === 'subject:user' ? '观察页' : '人格记忆')
            : `#${band}`
          const depth = Math.max(0, Math.min(1, (1 - point.z) / 2))
          ctx.globalAlpha = 0.3 + depth * 0.45
          ctx.fillStyle = ink
          const left = point.x - 6
          ctx.textAlign = left > 8 ? 'right' : 'left'
          ctx.fillText(label, left > 8 ? left : 8, point.y + 3)
        }
        ctx.textAlign = 'start'
        ctx.globalAlpha = 1

        if (!graph || (graph.nodes ?? []).length === 0) {
          ctx.fillStyle = ink
          ctx.globalAlpha = 0.55
          ctx.font = '12px system-ui, -apple-system, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('还没有记忆页。先记两页，再回来看它们连起来。', width / 2, height / 2)
          ctx.textAlign = 'start'
          ctx.globalAlpha = 1
        }
      }, [graph, positions, selected, matches])

      React.useEffect(() => {
        if (open) draw()
      }, [draw, open])

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const view = viewRef.current
          view.zoom = Math.min(2.6, Math.max(0.55, view.zoom * Math.exp(-event.deltaY * 0.0012)))
          draw()
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [draw])

      const onPointerDown = (event) => {
        const view = viewRef.current
        dragRef.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, moved: 0 }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        const view = viewRef.current
        view.yaw = drag.yaw + dx * 0.007
        view.pitch = Math.max(-1.25, Math.min(1.25, drag.pitch + dy * 0.007))
        drag.moved = Math.abs(dx) + Math.abs(dy)
        draw()
      }

      const onPointerUp = (event) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || drag.moved > 6) return
        const rect = event.currentTarget.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const hit = [...pointsRef.current]
          .sort((a, b) => b.z - a.z)
          .find((point) => Math.hypot(point.x - x, point.y - y) <= 8 + 6 * point.scale)
        setSelected(hit ? hit.id : null)
      }

      // 把某个节点转到正对镜头：yaw 先把它转到 z 轴，pitch 再抬到球心高度。
      const flyTo = (id) => {
        const item = positions.find((point) => point.node.id === id)
        if (!item) return
        const target = flyAngles(item)
        const view = viewRef.current
        let delta = target.yaw - view.yaw
        delta = Math.atan2(Math.sin(delta), Math.cos(delta))
        const fromYaw = view.yaw
        const fromPitch = view.pitch
        const started = performance.now()
        const token = (flyRef.current += 1)
        const step = (now) => {
          if (flyRef.current !== token) return
          const t = Math.min(1, (now - started) / 480)
          const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          view.yaw = fromYaw + delta * ease
          view.pitch = fromPitch + (target.pitch - fromPitch) * ease
          draw()
          if (t < 1) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
        setSelected(id)
      }

      const node = selected ? (graph?.nodes ?? []).find((item) => item.id === selected) : null
      const stats = graph?.stats ?? {}

      return h(
        'div',
        { style: S.card },
        h(
          'button',
          { type: 'button', style: S.cardHeader, onClick: () => setOpen((value) => !value) },
          h(
            'span',
            { style: S.cardText },
            h('span', { style: S.cardTitle }, '记忆图谱'),
            h('span', { style: S.cardHint }, '同一标签的页聚成一条带；拖动旋转、滚轮缩放、搜到哪就飞到哪。'),
          ),
          h('span', { style: S.cardCount }, `${stats.shown ?? 0}/${stats.pages ?? 0} 页 · ${stats.links ?? 0} 条关系`),
          h('span', { style: { ...S.caret, ...(open ? S.caretOpen : null) } }, '▶'),
        ),
        open
          ? h(
              'div',
              { style: S.body },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' } },
                h('input', {
                  type: 'search',
                  value: query,
                  placeholder: '搜标题 / 路径 / 标签，回车飞过去',
                  onChange: (event) => setQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && matches.length) flyTo(matches[0].id)
                  },
                  style: { ...S.input, flex: '1 1 auto', width: 'auto', textAlign: 'left', padding: '6px 10px' },
                }),
                h(
                  'button',
                  { type: 'button', style: S.buttonGhost, onClick: () => void load(), disabled: loading },
                  loading ? '刷新中…' : '刷新',
                ),
              ),
              matches.length
                ? h(
                    'div',
                    { style: { display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 14px 8px' } },
                    matches.map((match) => h(
                      'button',
                      {
                        key: match.id,
                        type: 'button',
                        onClick: () => flyTo(match.id),
                        style: { ...S.chip, cursor: 'pointer', borderColor: 'rgba(240,160,32,.55)' },
                      },
                      match.title,
                    )),
                  )
                : null,
              h('canvas', {
                ref: canvasRef,
                style: {
                  display: 'block',
                  width: '100%',
                  height: 340,
                  cursor: 'grab',
                  touchAction: 'none',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                },
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel: () => {
                  dragRef.current = null
                },
              }),
              node
                ? h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        padding: '10px 14px',
                        borderTop: `1px solid ${BORDER}`,
                      },
                    },
                    h('span', { style: S.label }, node.title),
                    h('span', { style: S.path }, `${node.id} · 强度 ${node.strength.toFixed(2)} · ${node.degree} 条关系`),
                    node.gist ? h('span', { style: S.rowHint }, node.gist) : null,
                    node.tags.length ? h('span', { style: S.path }, node.tags.map((tag) => `#${tag}`).join(' ')) : null,
                  )
                : null,
              error ? h('p', { style: { ...S.error, padding: '0 14px 10px' } }, `图谱读不出来：${error}`) : null,
            )
          : null,
      )
    }

    const HEALTH_BUCKETS = [
      ['today', '今天'],
      ['week', '7 天'],
      ['month', '30 天'],
      ['quarter', '90 天'],
      ['older', '更早'],
      ['never', '没日期'],
    ]

    /**
     * 记忆健康：体检结果直接吃配置接口里的 `status.health`，不额外发请求。
     * 分数只是提示，不拦任何操作——该记还是记，只是告诉你哪里在漏。
     */
    function HealthCard({ health }) {
      const [open, setOpen] = React.useState(false)
      if (!health) return null
      const score = health.score ?? 0
      const tone = score >= 85 ? '#2f9e44' : score >= 70 ? '#f0a020' : '#e5484d'
      const buckets = HEALTH_BUCKETS.filter(([key]) => (health.freshness?.[key] ?? 0) > 0)
      const bad = (health.checks ?? []).filter((check) => !check.ok).length
      return h(
        'div',
        { style: S.card },
        h(
          'button',
          { type: 'button', style: S.cardHeader, onClick: () => setOpen((value) => !value), 'aria-expanded': open },
          h('span', { style: { ...S.caret, ...(open ? S.caretOpen : null) } }, '▶'),
          h(
            'span',
            { style: S.cardText },
            h('span', { style: S.cardTitle }, '记忆健康'),
            h('span', { style: S.cardHint }, bad ? `${bad} 项可以修` : '索引、关系、新鲜度都还行。'),
          ),
          h('span', { style: { ...S.cardCount, color: tone } }, `${score} 分 · ${health.grade ?? ''}`),
        ),
        open
          ? h(
              'div',
              { style: S.body },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px' } },
            h(
              'div',
              { style: { height: 6, borderRadius: 999, background: 'rgba(127,127,127,.18)', overflow: 'hidden' } },
              h('div', { style: { width: `${score}%`, height: '100%', background: tone, borderRadius: 999 } }),
            ),
            h(
              'div',
              { style: S.chips },
              ...buckets.map(([key, label]) => h('span', { key, style: S.chip }, `${label} ${health.freshness[key]}`)),
              h(
                'span',
                { style: S.chip },
                `${health.size?.pages ?? 0} 页 · ${health.size?.observations ?? 0} 条观察 · ${health.size?.chars ?? 0} 字`,
              ),
            ),
            ...(health.checks ?? []).map((check) => h(
              'div',
              { key: check.id, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
              h('span', { style: { fontSize: 11, width: 12, color: check.ok ? '#2f9e44' : '#e5484d' } }, check.ok ? '✓' : '!'),
              h('span', { style: S.rowHint }, `${check.label}：${check.detail}`),
            )),
            health.stale?.length
              ? h('span', { style: S.rowHint }, `可以重读或整理：${health.stale.map((item) => item.title).join('、')}`)
              : null,
          ),
        )
          : null,
      )
    }

    const USER_MODEL_API = '/dsh-leinao/user-model'

    /**
     * 用户模型：把「关于老大」的东西摊开看、能删。
     * 删除走宿主的事件接口（不是直接改文件），所以 journal 里留痕、重放能重建。
     */
    function UserModelCard() {
      const [model, setModel] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [pending, setPending] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(USER_MODEL_API)
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setModel(body)
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const post = async (payload, mark) => {
        setBusy(mark)
        setError('')
        try {
          const response = await fetch(USER_MODEL_API, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setModel(body)
          setPending('')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      const counts = model?.counts ?? {}
      const observations = model?.observations ?? []
      const pages = model?.pages ?? []
      const needle = query.trim().toLowerCase()
      const shown = needle
        ? observations.filter((item) => `${item.key} ${item.value} ${item.evidence ?? ''}`.toLowerCase().includes(needle))
        : observations

      const smallButton = (label, onClick, disabled) => h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: { ...S.chip, cursor: disabled ? 'default' : 'pointer', fontSize: 11, background: 'transparent', color: 'inherit', font: 'inherit' },
        },
        label,
      )

      const sectionLabel = (text, total) => h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10, fontSize: 11.5, opacity: 0.72 } },
        h('span', null, text),
        h('span', { style: { ...S.cardCount, fontSize: 10 } }, String(total)),
      )

      // 单条删除改成两段：先「删」、再「确认删」，避免误点直接丢。
      const actions = (id, run) => (
        pending === id
          ? [smallButton('确认删', run, Boolean(busy)), smallButton('取消', () => setPending(''))]
          : [smallButton('删', () => setPending(id), Boolean(busy))]
      )

      return h(
        'div',
        { style: S.card },
        h(
          'button',
          { type: 'button', style: S.cardHeader, onClick: () => setOpen((value) => !value) },
          h(
            'span',
            { style: S.cardText },
            h('span', { style: S.cardTitle }, '用户模型'),
            h('span', { style: S.cardHint }, '它眼里的你：观察必须带原话，删掉的留一条事件，重放能重建。'),
          ),
          h('span', { style: S.cardCount }, `${counts.observations ?? 0} 条观察 · ${counts.pages ?? 0} 条页`),
          h('span', { style: { ...S.caret, ...(open ? S.caretOpen : null) } }, '▶'),
        ),
        open ? h(
          'div',
          { style: { ...S.body } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px' } },
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              smallButton('刷新', () => void load(), Boolean(busy)),
              pending === 'clear'
                ? smallButton('再点一次清空', () => void post({ action: 'clear-observations' }, 'clear'), Boolean(busy))
                : smallButton('清空观察', () => setPending('clear'), observations.length === 0 || Boolean(busy)),
              pending === 'clear' ? smallButton('取消', () => setPending(''), false) : null,
              observations.length > 6 ? h('input', {
                type: 'search',
                value: query,
                placeholder: '搜观察',
                onChange: (event) => setQuery(event.target.value),
                style: { ...S.input, flex: '1 1 120px', minWidth: 0, textAlign: 'left', padding: '4px 8px', fontSize: 12 },
              }) : null,
            ),

            sectionLabel('观察', observations.length),
            shown.length
              ? shown.map((item) => h(
                  'div',
                  { key: item.key, style: { display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' } },
                  h(
                    'span',
                    { style: S.rowHint, flex: '1 1 auto', minWidth: 0 },
                    h('strong', null, item.key),
                    `：${item.value}`,
                    Number(item.confidence ?? 0) < 0.5
                      ? h('span', { style: { ...S.chip, fontSize: 10, padding: '1px 6px', marginLeft: 6, opacity: 0.8 } }, '不太确定')
                      : null,
                    h('span', { style: { opacity: 0.55 } }, ` · 置信度 ${Number(item.confidence ?? 0).toFixed(2)}`),
                    h('span', { style: { display: 'block', opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.evidence ?? '' }, item.evidence ? `原话「${item.evidence}」` : '（没有原话）'),
                  ),
                  ...actions(`obs:${item.key}`, () => void post({ action: 'drop-observation', key: item.key }, `drop-${item.key}`)),
                ))
              : h('span', { style: S.rowHint }, observations.length ? '没有匹配的观察。' : '还没有观察。聊天里说过的话，可以让它用 persona_observe 记下来（必须带原话）。'),

            pages.length ? sectionLabel('记忆页', pages.length) : null,
            pages.length
              ? pages.map((page) => h(
                  'div',
                  { key: page.path, style: { display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' } },
                  h(
                    'span',
                    { style: S.rowHint, flex: '1 1 auto', minWidth: 0 },
                    h('strong', null, page.title),
                    h('span', { style: S.path }, ` ${page.path}`),
                    page.gist ? ` —— ${page.gist}` : null,
                  ),
                  ...actions(`page:${page.path}`, () => void post({ action: 'forget-page', path: page.path }, `page-${page.path}`)),
                ))
              : null,

            error ? h('p', { style: S.error }, `用户模型读不出来：${error}`) : null,
          ),
        ) : null,
      )
    }

    function Section() {
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [base, setBase] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(null)
      const [savedAt, setSavedAt] = React.useState(null)
      const [filter, setFilter] = React.useState('')
      const [jump, setJump] = React.useState({ id: null, n: 0 })
      const [active, setActive] = React.useState(GROUPS[0].id)
      const [wide, setWide] = React.useState(() => {
        try {
          return window.innerWidth >= 760
        } catch {
          return true
        }
      })
      const cardsRef = React.useRef({})

      React.useEffect(() => {
        const onResize = () => {
          try {
            setWide(window.innerWidth >= 760)
          } catch {
            /* 忽略 */
          }
        }
        window.addEventListener?.('resize', onResize)
        return () => window.removeEventListener?.('resize', onResize)
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          const flat = flatten(payload?.config ?? {})
          setSnapshot(payload)
          setBase(flat)
          setDraft(flat)
          setSaveError(null)
          setSavedAt(null)
        } catch (error) {
          setLoadError(String(error?.message ?? error))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const { patch, count } = React.useMemo(() => changesOf(base, draft), [base, draft])

      const change = (key, value) => {
        setDraft((current) => ({ ...current, [key]: value }))
        setSaveError(null)
      }

      const save = async () => {
        if (!count || saving) return
        setSaving(true)
        setSaveError(null)
        try {
          const response = await fetch(API, {
            method: 'PUT',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          const flat = flatten(payload?.config ?? {})
          setSnapshot(payload)
          setBase(flat)
          setDraft(flat)
          setSavedAt(new Date())
        } catch (error) {
          setSaveError(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }

      const restartChanged = React.useMemo(() => {
        const list = Array.isArray(snapshot?.restart) ? snapshot.restart : []
        return list.filter((key) => String(draft[key]) !== String(base[key]))
      }, [draft, base, snapshot])

      const needle = filter.trim().toLowerCase()
      const visibleGroups = needle
        ? GROUPS.filter((group) => group.rows.some((row) => rowMatches(row, needle)))
        : GROUPS

      const activeGroupId = visibleGroups.some((group) => group.id === active) ? active : visibleGroups[0]?.id

      const jumpTo = (id) => {
        setJump((prev) => ({ id, n: prev.n + 1 }))
        // 等这一帧把卡片展开后再滚，位置才准。
        window.setTimeout(() => {
          cardsRef.current[id]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        }, 0)
      }

      const status = snapshot?.status ?? {}
      const overridden = Array.isArray(snapshot?.overridden) ? snapshot.overridden : []
      const statusLine = savedAt
        ? `已保存 · ${savedAt.toLocaleTimeString()}`
        : count
          ? `${count} 项未保存`
          : '暂无改动'

      return h(
        'div',
        { style: S.root },
        h('p', { style: S.intro }, '从名字开始，慢慢长成自己。这里改的是这台机器上的运行参数，保存后大多下一轮就生效。'),

        h('input', {
          type: 'search',
          value: filter,
          placeholder: '搜配置项：标签 / 键名 / 说明',
          onChange: (event) => setFilter(event.target.value),
          style: { ...S.input, width: '100%', textAlign: 'left', padding: '7px 10px', boxSizing: 'border-box' },
        }),

        wide ? null : h(
          'div',
          { style: { ...S.chips, gap: 6 } },
          GROUPS.map((group) => h(
            'button',
            {
              key: group.id,
              type: 'button',
              onClick: () => jumpTo(group.id),
              style: { ...S.chip, cursor: 'pointer', background: 'transparent', color: 'inherit', font: 'inherit' },
            },
            group.title,
          )),
        ),

        loadError
          ? h('p', { style: S.error }, `读不到配置：${loadError}`)
          : loading
            ? h('p', { style: S.notice }, '正在读取配置…')
            : h(
                'div',
                { style: S.status },
                h(
                  'div',
                  { style: S.chips },
                  h('span', { style: { ...S.chip, ...S.chipAccent } }, `阶段 ${PHASE_LABEL[status.phase] ?? status.phase ?? '—'}`),
                  h('span', { style: S.chip }, `${status.turns ?? 0} 轮对话`),
                  h('span', { style: S.chip }, `${status.memories ?? 0} 条记忆`),
                  h('span', { style: S.chip }, `${(status.userMemories ?? 0) + (status.observations ?? 0)} 条观察`),
                  h('span', { style: S.chip }, `${status.events ?? 0} 条事件`),
                ),
                h('p', { style: S.path }, `数据目录：${status.dataDir ?? '—'}`),
                h('p', { style: S.path }, `配置文件：${snapshot?.file ?? '—'}`),
                status.deviceId ? h('p', { style: S.path }, `设备：${status.deviceId}`) : null,
              ),

        !loading && !loadError
          ? wide && !needle
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h(
                  'nav',
                  {
                    style: {
                      position: 'sticky',
                      top: 8,
                      zIndex: 1,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      paddingBottom: 4,
                      background: SURFACE,
                    },
                  },
                  ...visibleGroups.map((group) => {
                    const isActive = group.id === activeGroupId
                    const groupChanged = group.rows.filter((row) => String(draft[row.key]) !== String(base[row.key])).length
                    return h(
                      'button',
                      {
                        key: group.id,
                        type: 'button',
                        onClick: () => setActive(group.id),
                        style: {
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '5px 10px',
                          borderRadius: 999,
                          border: `1px solid ${isActive ? ACCENT : BORDER}`,
                          background: isActive ? 'rgba(76,110,245,.10)' : 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: 12,
                          textAlign: 'left',
                          cursor: 'pointer',
                        },
                      },
                      h('span', null, group.title),
                      groupChanged ? h('span', { style: { ...S.cardCount, fontSize: 10 } }, String(groupChanged)) : null,
                    )
                  }),
                ),
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0 } },
                  visibleGroups
                    .filter((group) => group.id === activeGroupId)
                    .map((group) => h(Card, {
                      key: group.id,
                      group,
                      draft,
                      filter,
                      alwaysOpen: true,
                      registerRef: (node) => {
                        if (node) cardsRef.current[group.id] = node
                        else delete cardsRef.current[group.id]
                      },
                      changed: group.rows.filter((row) => String(draft[row.key]) !== String(base[row.key])).length,
                      onToggle: change,
                    })),
                ),
              )
            : visibleGroups.map((group) => h(Card, {
                key: group.id,
                group,
                draft,
                filter,
                openSignal: jump.id === group.id ? jump.n : 0,
                registerRef: (node) => {
                  if (node) cardsRef.current[group.id] = node
                  else delete cardsRef.current[group.id]
                },
                changed: group.rows.filter((row) => String(draft[row.key]) !== String(base[row.key])).length,
                onToggle: change,
              }))
          : null,

        !loading && !loadError ? h(UserModelCard) : null,

        !loading && !loadError ? h(GraphCard) : null,

        !loading && !loadError ? h(HealthCard, { health: snapshot?.status?.health }) : null,

        !loading && !loadError && needle && visibleGroups.length === 0
          ? h('p', { style: S.notice }, `没有匹配「${filter.trim()}」的配置项。`)
          : null,

        saveError ? h('p', { style: S.error }, `保存失败：${saveError}`) : null,
        overridden.length
          ? h('p', { style: S.notice }, `这些键在插件配置里被行内 config 覆盖，改文件不会生效：${overridden.join('、')}`)
          : null,
        restartChanged.length
          ? h('p', { style: S.notice }, `有 ${restartChanged.length} 项要重启 DSH 才生效：${restartChanged.join('、')}`)
          : null,

        h(
          'div',
          { style: S.footer },
          h('span', { style: S.footerState }, statusLine),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => void load(), disabled: saving }, '重新读取'),
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => setDraft(base), disabled: !count || saving }, '撤销'),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, ...(saving || !count ? S.buttonDisabled : null) },
                disabled: saving || !count,
                onClick: () => void save(),
              },
              saving ? '保存中…' : '保存',
            ),
          ),
        ),
      )
    }

    // ---------------- 会话内开关（composer 工具行左侧） ----------------
    // 与内置 Plan 开关同构：状态来自宿主 /dsh-leinao/session，点击展开下拉，
    // 分别设置「本会话」与「此工作区默认」。宿主拒绝时把原因显示在菜单底部。
    const CHIP_BTN = (enabled) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '4px 8px',
      fontSize: 13,
      lineHeight: '18px',
      borderRadius: 6,
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #888)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      opacity: enabled ? 1 : 0.55,
    })
    const CHIP_MENU = {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: 0,
      zIndex: 40,
      minWidth: 156,
      padding: 6,
      borderRadius: 8,
      border: `1px solid ${BORDER}`,
      background: 'var(--dsw-alias-bg-layer-2, #fff)',
      boxShadow: '0 6px 20px rgba(0,0,0,.12)',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }
    const CHIP_HEAD = { padding: '4px 8px 2px', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)' }
    const CHIP_ITEM = (active) => ({
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 8px',
      fontSize: 12,
      lineHeight: '16px',
      borderRadius: 5,
      border: 'none',
      textAlign: 'left',
      background: active ? 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.12))' : 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
    })

    function SessionChip(props) {
      const sessionId = props?.sessionId
      const [state, setState] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const read = React.useCallback(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        fetch(`${SESSION_API}?sessionId=${encodeURIComponent(sessionId)}`)
          .then((response) => response.json())
          .then((value) => setState(value))
          .catch(() => setError('读不到开关状态'))
      }, [sessionId])

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        read()
        const timer = setInterval(read, 10000)
        return () => clearInterval(timer)
      }, [sessionId, read])

      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const close = () => setOpen(false)
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [open])

      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const effective = state === undefined ? true : state.ok !== false && state.effective !== false
      const workspaceDisabled = state?.workspaceDisabled === true

      const act = (action) => {
        setBusy(true)
        setError('')
        fetch(SESSION_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, sessionId }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
            if (body.ok === false) throw new Error('这个会话已经不在运行了')
            setState(body)
            setOpen(false)
          })
          .catch((err) => setError(String(err?.message ?? err)))
          .finally(() => setBusy(false))
      }

      const item = (label, action, active) => h('button', {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': active,
        disabled: busy,
        onClick: (event) => {
          event.stopPropagation()
          act(action)
        },
        style: CHIP_ITEM(active),
      }, active ? `\u2713 ${label}` : `  ${label}`)

      const menu = open
        ? h('div', { role: 'menu', style: CHIP_MENU, onMouseDown: (event) => event.stopPropagation() },
            h('div', { style: CHIP_HEAD }, '本会话'),
            item('开', 'on', effective),
            item('关', 'off', !effective),
            h('div', { style: { height: 1, margin: '4px 6px', background: BORDER } }),
            h('div', { style: CHIP_HEAD }, '此工作区默认'),
            item('开', 'workspace-on', !workspaceDisabled),
            item('关', 'workspace-off', workspaceDisabled),
            error ? h('div', { role: 'alert', style: { padding: '4px 8px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #e5484d)' } }, error) : null,
          )
        : null

      return h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          title: '类脑：本会话 / 此工作区的主动开口开关',
          'aria-label': '类脑主动开口开关',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => setOpen((value) => !value),
          style: CHIP_BTN(effective),
        }, `\u25cf 类脑${effective ? '' : ' · 关'}`),
        menu,
      )
    }

    const name = 'dsh-plugin-leinao'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: { nav: '类脑 · 人格' },
        en: { nav: 'Leinao · Persona' },
      }), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: NS,
          order: 70,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t, locale: ctx.locale }),
        },
        () => h(Section, { t: ctx.locale.bind(NS) }),
      ))
      // 会话内开关（composer 工具行左侧）。旧宿主可能不声明该 slot：
      // 注册失败只影响 chip，/leinao 命令与设置面板仍然可用。
      try {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: `${NS}-session-toggle`,
            order: 100,
            locale: NS,
          },
          SessionChip,
        ))
      } catch {
        // 没有 composer slot 就算了
      }
    }

    // 纯逻辑给单测用；运行时形态不变（客户端拿不到本地模块，只能这样暴露）
    const __test = { rowMatches, layoutNodes, projectPoint, flyAngles }

    return { name, inject, apply, __test }
  },
})
