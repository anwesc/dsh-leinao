/**
 * 人看的视图：view/PROFILE.md。
 * 派生文件，每次状态变化重写；**不要手改**（下次重放就覆盖了）。
 */
import { AXES, AXIS_LABELS } from './traits.js'
import { band, baseline, decay } from './mood.js'
import { bondLabel, riftLevelLabel } from './bond.js'
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

  const stats = state.stats ?? {}
  lines.push('## 记录', '')
  lines.push(`- 事件 ${stats.events ?? 0} 条 · 对话 ${stats.userTurns ?? 0} 轮 · 设备 ${(stats.devices ?? []).length} 台`)
  lines.push(`- 初见 ${fmtTime(stats.firstEventAt)} · 最近 ${fmtTime(stats.lastEventAt)}`)
  lines.push('')
  lines.push('---', '')
  lines.push(`_由 journal 重放生成于 ${fmtTime(localIso(new Date(nowMs)))}，勿手改。_`, '')
  return lines.join('\n')
}

export function writeProfile(dataDir, state, nowMs = Date.now(), options = {}) {
  const paths = personaPaths(dataDir)
  const text = renderProfile(state, nowMs, options)
  writeFileAtomic(paths.profile, text)
  return text
}
