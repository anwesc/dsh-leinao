/**
 * 人看的视图：view/PROFILE.md。
 * 派生文件，每次状态变化重写；**不要手改**（下次重放就覆盖了）。
 */
import { AXES, AXIS_LABELS } from './traits.js'
import { band, baseline, decay } from './mood.js'
import { bondLabel, riftLevelLabel } from './bond.js'
import { isVisible, memoryStats, subjectOf } from './memory.js'
import { observationList, observationStats } from './observations.js'
import { writeFileAtomic } from './store.js'
import { personaPaths } from './store.js'
import { localIso } from './journal.js'

const BOND_LABELS = { up: '关系走近一步', down: '关系退了一步', rift: '起了疙瘩', repair: '疙瘩解开了', mend: '疙瘩解开了' }

function ageDays(iso, nowMs) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / 86400000))
}

function milestoneText(m) {
  if (m.kind === 'bond') return `${BOND_LABELS[m.label] ?? m.label}${m.gist ? `：${m.gist}` : ''}`
  if (m.kind === 'shift') return `${AXIS_LABELS[m.axis] ?? m.axis}突变，跨过 ${m.step}${m.gist ? `：${m.gist}` : ''}`
  if (m.kind === 'growth') return `${AXIS_LABELS[m.axis] ?? m.axis}长到 ${m.step}${m.gist ? `：${m.gist}` : ''}`
  return m.gist ?? m.label ?? (m.axis ? `${AXIS_LABELS[m.axis] ?? m.axis} 跨过 ${m.step}` : 'milestone')
}

function bar(value, width = 10) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function fmt(value) {
  return Number(value).toFixed(2)
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : localIso(d).slice(0, 16).replace('T', ' ')
}

export function renderProfile(state, nowMs = Date.now(), options = {}) {
  const mood = decay(state.mood, baseline(state.traits), nowMs, options.mood?.halfLifeHours)
  const b = band(mood)
  const lines = []
  const name = state.profile?.name ?? '（还没起名字）'
  const call = state.profile?.userCall ? `，我称他「${state.profile.userCall}」` : ''

  lines.push(`# ${name}`, '')
  lines.push(`> 我是${name}${call}。`)
  lines.push(`> 阶段：${state.phase === 'seed' ? '等待出生' : '相处中'} · 心情：${b.label} · 亲密度 ${fmt(state.intimacy)}`)
  lines.push('')

  lines.push('## 性格', '')
  lines.push('| 轴 | 值 | 观察次数 | 状态 |', '| --- | --- | --- | --- |')
  for (const axis of AXES) {
    const slot = state.traits[axis]
    lines.push(`| ${AXIS_LABELS[axis]} | \`${bar(slot.v)}\` ${fmt(slot.v)} | ${slot.n} | ${slot.pinned ? 'pinned' : '—'} |`)
  }
  lines.push('')

  lines.push('## 心情', '')
  lines.push(`当前：**${b.label}**（愉悦 ${fmt(mood.v)} / 精力 ${fmt(mood.e)} / 紧绷 ${fmt(mood.t)}）`)
  lines.push('')
  lines.push(`- 愉悦 \`${bar(mood.v, 12)}\` ${fmt(mood.v)}`)
  lines.push(`- 精力 \`${bar(mood.e, 12)}\` ${fmt(mood.e)}`)
  lines.push(`- 紧绷 \`${bar(mood.t, 12)}\` ${fmt(mood.t)}`)
  lines.push('')

  const bond = state.bond ?? { level: 0, since: null, rift: null }
  lines.push('## 关系', '')
  lines.push(`- 当前：**${bondLabel(bond.level)}**${bond.since ? `（${ageDays(bond.since, nowMs) === 0 ? '今天' : `${ageDays(bond.since, nowMs)} 天前`}变的）` : ''}`)
  if (bond.rift) {
    const heat = bond.rift.heat ?? 1
    lines.push(`- 疙瘩：**未解 · ${riftLevelLabel(heat)}** \`${bar(heat, 10)}\` ${Math.round(heat * 100)}%`)
    lines.push(`  - 起因：${bond.rift.gist ?? bond.rift.why ?? '没说清'}（${fmtTime(bond.rift.at)}）`)
  } else {
    lines.push('- 疙瘩：没有')
  }
  if (state.shifts?.length) {
    lines.push(`- 突变：${state.shifts.length} 次（最近 ${fmtTime(state.shifts[state.shifts.length - 1].at)}）`)
  }
  lines.push('')

  if (state.milestones.length) {
    lines.push('## 里程碑', '')
    for (const m of state.milestones.slice(-8)) {
      lines.push(`- ${fmtTime(m.at)} · ${milestoneText(m)}`)
    }
    lines.push('')
  }

  const memory = memoryStats(state, 'self')
  if (memory.visible) {
    lines.push('## 记忆', '')
    lines.push(
      `- 在册 **${memory.visible}** 条${memory.folded ? `（整理页 ${memory.folded}）` : ''} · 有互链 ${memory.linked} 条 · 孤立 ${memory.isolated} 条`,
    )
    const recent = Object.values(state.pages)
      .filter((page) => isVisible(page) && subjectOf(page) === 'self')
      .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
      .slice(0, 5)
    for (const page of recent) {
      const links = page.links ?? []
      lines.push(`- ${page.title}（\`${page.path}\`）${links.length ? ` → ${links.map((link) => `\`${link}\``).join('、')}` : ''}`)
    }
    lines.push('')
  }

  const userModel = memoryStats(state, 'user')
  const observed = observationStats(state)
  lines.push('## 关于老大', '')
  lines.push(
    `- 观察 **${observed.count}** 条（较确定 ${observed.confident} 条） · 记忆页 ${userModel.visible} 条（单独一份：\`view/USER.md\`）`,
  )
  const observations = Object.values(state.pages)
    .filter((page) => isVisible(page) && subjectOf(page) === 'user')
    .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
    .slice(0, 5)
  for (const page of observations) {
    const gist = page.gist ?? String(page.content ?? '').split('\n')[0]
    lines.push(`- ${page.title}（\`${page.path}\`）${gist ? `：${String(gist).slice(0, 60)}` : ''}`)
  }
  lines.push('')

  const stats = state.stats ?? {}
  lines.push('## 记录', '')
  lines.push(`- 事件 ${stats.events ?? 0} 条 · 对话 ${stats.userTurns ?? 0} 轮 · 设备 ${(stats.devices ?? []).length} 台`)
  lines.push(`- 初见 ${fmtTime(stats.firstEventAt)} · 最近 ${fmtTime(stats.lastEventAt)}`)
  lines.push('')
  lines.push('---', '')
  lines.push(`_由 journal 重放生成于 ${fmtTime(localIso(new Date(nowMs)))}，勿手改。_`, '')
  return lines.join('\n')
}

/**
 * 用户模型单独一份：可读、可删、可直接拷走。
 * 只收 subject=user 的页；人格记忆一条都不混进来。
 */
export function renderUserModel(state, nowMs = Date.now()) {
  const pages = Object.values(state?.pages ?? {})
    .filter((page) => isVisible(page) && subjectOf(page) === 'user')
    .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
  const stats = memoryStats(state, 'user')
  const observed = observationList(state)
  const lines = []
  lines.push('# 关于老大（用户模型）', '')
  lines.push('> 类脑从对话里攒下的观察，可以单独拿走。')
  lines.push('> 观察不是他的自我描述；删掉之后重放 journal 仍会重新生成。')
  lines.push(`> 生成于 ${fmtTime(localIso(new Date(nowMs)))} · 勿手改`, '')
  if (!pages.length && !observed.length) {
    lines.push('（还没有观察。）', '')
    return lines.join('\n')
  }
  if (observed.length) {
    lines.push('## 观察', '')
    for (const item of observed) {
      const evidence = item.evidence ? `（原话「${String(item.evidence).slice(0, 60)}」）` : ''
      lines.push(`- **${item.key}**：${item.value} · 置信度 ${Number(item.confidence ?? 0).toFixed(2)}${evidence}`)
    }
    lines.push('')
  }
  if (pages.length) {
    lines.push(`记忆页在册 **${stats.visible}** 条 · 有互链 ${stats.linked} 条 · 孤立 ${stats.isolated} 条`, '')
    for (const page of pages) {
      lines.push(`## ${page.title}（\`${page.path}\`）`, '')
      if (page.gist) lines.push(`> ${page.gist}`, '')
      if (page.tags?.length) lines.push(`- 标签：${page.tags.join('、')}`)
      lines.push(`- 更新：${fmtTime(page.updatedAt ?? page.at)}`)
      const links = (page.links ?? []).filter((path) => isVisible(state.pages[path]))
      if (links.length) lines.push(`- 相关：${links.map((path) => `\`${path}\``).join('、')}`)
      lines.push('')
      if (page.content) lines.push(String(page.content).trim(), '')
    }
  }
  return lines.join('\n')
}

export function writeUserModel(dataDir, state, nowMs = Date.now()) {
  const paths = personaPaths(dataDir)
  const text = renderUserModel(state, nowMs)
  writeFileAtomic(paths.userModel, text)
  return text
}

export function writeProfile(dataDir, state, nowMs = Date.now(), options = {}) {
  const paths = personaPaths(dataDir)
  const text = renderProfile(state, nowMs, options)
  writeFileAtomic(paths.profile, text)
  writeUserModel(dataDir, state, nowMs)
  return text
}
