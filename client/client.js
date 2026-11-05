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

    function Card({ group, draft, changed, onToggle }) {
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
      const toggle = () => {
        const next = !open
        setOpen(next)
        try {
          window.localStorage?.setItem(`dsh-leinao:card:${group.id}`, next ? '1' : '0')
        } catch {
          /* 忽略 */
        }
      }
      return h(
        'section',
        { style: S.card },
        h(
          'button',
          { type: 'button', style: S.cardHeader, onClick: toggle, 'aria-expanded': open },
          h('span', { style: { ...S.caret, ...(open ? S.caretOpen : null) } }, '▶'),
          h(
            'span',
            { style: S.cardText },
            h('span', { style: S.cardTitle }, group.title),
            h('span', { style: S.cardHint }, group.hint),
          ),
          changed > 0 ? h('span', { style: S.cardCount }, `改 ${changed} 项`) : null,
        ),
        open
          ? h(
              'div',
              { style: S.body },
              group.rows.map((row, index) => h(Row, {
                key: row.key,
                row,
                value: draft[row.key],
                onChange: (value) => onToggle(row.key, value),
              })),
            )
          : null,
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
                  h('span', { style: S.chip }, `${status.events ?? 0} 条事件`),
                ),
                h('p', { style: S.path }, `数据目录：${status.dataDir ?? '—'}`),
                h('p', { style: S.path }, `配置文件：${snapshot?.file ?? '—'}`),
                status.deviceId ? h('p', { style: S.path }, `设备：${status.deviceId}`) : null,
              ),

        !loading && !loadError
          ? GROUPS.map((group) => h(Card, {
              key: group.id,
              group,
              draft,
              changed: group.rows.filter((row) => String(draft[row.key]) !== String(base[row.key])).length,
              onToggle: change,
            }))
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
    }

    return { name, inject, apply }
  },
})
