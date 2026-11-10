/**
 * 重放：事件流 → 当前状态。
 *
 * 状态里的每个数值都必须能由「事件 + 时间」重算出来；state.json 只是缓存，
 * 删掉它、从 git 拉一份 journal，能重放出同样的结果——这是"真源只有一个"的检验方式。
 *
 * 重放不读 now：心情的衰减在渲染时按当前时间算，所以同一份 journal 永远折叠出同一份状态。
 */
import { applySignal, baseline, MOOD_DEFAULTS } from './mood.js'
import { clamp01, defaultTraits, growthResistance, crossedSteps, isAxis } from './traits.js'
import { BOND, BOND_ACTIONS, MEND, MEND_LABELS, bondOffset, clampHeat, defaultBond } from './bond.js'
import { isVisible, normalizeLinks, normalizeTags } from './memory.js'
import { OBSERVATION, normalizeObservationKey } from './observations.js'

export const STATE_VERSION = 2

export function emptyState() {
  const traits = defaultTraits()
  return {
    version: STATE_VERSION,
    phase: 'seed',
    profile: { name: null, gender: null, userCall: null, createdAt: null, seededAt: null },
    traits,
    mood: { ...MOOD_DEFAULTS, ...baseline(traits) },
    bond: defaultBond(null),
    shifts: [],
    pages: {},
    observations: {},
    milestones: [],
    stats: {
      events: 0,
      userTurns: 0,
      firstEventAt: null,
      lastEventAt: null,
      seededAt: null,
      devices: [],
    },
    intimacy: 0.15,
  }
}

/** 亲密度：聊得越多、相处越久越高（0.15 起步，0.9 封顶），影响心情幅度也影响语气 */
export function intimacyOf(state) {
  const turns = state.stats?.userTurns ?? 0
  const seeded = state.stats?.seededAt ? Date.parse(state.stats.seededAt) : null
  const last = state.stats?.lastEventAt ? Date.parse(state.stats.lastEventAt) : null
  const days = seeded && last ? Math.max(0, (last - seeded) / 86400000) : 0
  const byTurns = 1 - Math.exp(-turns / 60)
  const byDays = 1 - Math.exp(-days / 14)
  return Math.min(0.95, clamp01(0.15 + 0.45 * byTurns + 0.2 * byDays + bondOffset(state.bond)))
}

function touch(state, event) {
  const stats = state.stats
  stats.events += 1
  if (!stats.firstEventAt) stats.firstEventAt = event.at
  const at = Date.parse(event.at)
  if (!stats.lastEventAt || at >= Date.parse(stats.lastEventAt)) stats.lastEventAt = event.at
  const device = typeof event.id === 'string' ? event.id.split('-')[0] : null
  if (device && !stats.devices.includes(device)) stats.devices.push(device)
}

/**
 * 单条事件。不认识/不合法的返回 false，由 fold 计入 diagnostics。
 * 注意：这里**不做**成长合法性判断（那是写入时的护栏），只做"能不能应用"。
 */
export function applyEvent(state, event) {
  if (!event || typeof event.kind !== 'string') return false
  const atMs = Date.parse(event.at)
  if (Number.isNaN(atMs)) return false

  switch (event.kind) {
    case 'seed': {
      const name = typeof event.name === 'string' ? event.name.trim() : ''
      if (!name) return false
      state.profile.name = name
      state.profile.gender = event.gender ?? null
      state.profile.userCall = event.userCall ?? null
      state.profile.seededAt = event.at
      state.profile.createdAt = state.profile.createdAt ?? event.at
      state.phase = 'active'
      state.stats.seededAt = event.at
      if (!state.bond?.since) state.bond = defaultBond(event.at)
      break
    }
    case 'observation': {
      const key = normalizeObservationKey(event.key)
      const value = typeof event.value === 'string' ? event.value.trim() : ''
      if (!key || !value || value.length > OBSERVATION.maxValueChars) return false
      if (!state.observations) state.observations = {}
      const prev = state.observations[key]
      state.observations[key] = {
        key,
        value,
        confidence: Number.isFinite(event.confidence) ? clamp01(event.confidence) : 0.6,
        evidence: typeof event.evidence === 'string' ? event.evidence.trim().slice(0, 200) : null,
        at: prev?.at ?? event.at,
        updatedAt: event.at,
        count: (prev?.count ?? 0) + 1,
      }
      break
    }
    case 'observation-drop': {
      const key = normalizeObservationKey(event.key)
      if (!key || !state.observations?.[key]) return false
      delete state.observations[key]
      break
    }
    case 'observation-clear': {
      if (!state.observations || Object.keys(state.observations).length === 0) return false
      state.observations = {}
      break
    }
    case 'affect': {
      const signal = event.signal
      if (!signal || ![signal.v, signal.e, signal.t].every((x) => Number.isFinite(x))) return false
      state.mood = applySignal(state.mood, state.traits, signal, state.intimacy, atMs)
      if (event.role !== 'assistant') state.stats.userTurns += 1
      break
    }
    case 'growth': {
      if (!isAxis(event.axis) || !Number.isFinite(event.delta)) return false
      const slot = state.traits[event.axis]
      const before = slot.v
      const next = clamp01(before + event.delta * growthResistance(slot.n))
      slot.v = next
      slot.n += 1
      for (const step of crossedSteps(before, next)) {
        state.milestones.push({ at: event.at, kind: 'growth', axis: event.axis, step, gist: event.gist ?? null })
      }
      break
    }
    case 'shift': {
      if (!isAxis(event.axis) || !Number.isFinite(event.delta)) return false
      const slot = state.traits[event.axis]
      const before = slot.v
      const next = clamp01(before + event.delta)
      slot.v = next
      state.shifts.push({
        at: event.at,
        axis: event.axis,
        delta: event.delta,
        gist: event.gist ?? null,
        why: event.why ?? null,
      })
      for (const step of crossedSteps(before, next)) {
        state.milestones.push({ at: event.at, kind: 'shift', axis: event.axis, step, gist: event.gist ?? null })
      }
      break
    }
    case 'bond': {
      const action = event.action
      if (!BOND_ACTIONS.includes(action)) return false
      const bond = state.bond ?? (state.bond = defaultBond(state.stats.seededAt))
      if (action === 'up') {
        if (bond.level >= BOND.maxLevel) return false
        bond.level += 1
        bond.since = event.at
        bond.turnsAt = state.stats.userTurns
      } else if (action === 'down') {
        bond.level = Math.max(0, bond.level - 1)
        bond.rift = { at: event.at, why: event.why ?? null, gist: event.gist ?? null, heat: MEND.downHeat }
        bond.since = event.at
        bond.turnsAt = state.stats.userTurns
      } else if (action === 'rift') {
        if (bond.rift) return false
        bond.rift = { at: event.at, why: event.why ?? null, gist: event.gist ?? null, heat: MEND.riftHeat }
      } else if (action === 'mend') {
        if (!bond.rift) return false
        const delta = Number(event.delta)
        if (!Number.isFinite(delta) || delta <= 0) return false
        const heat = clampHeat((bond.rift.heat ?? MEND.riftHeat) - delta)
        if (heat <= MEND.clearBelow) {
          bond.rift = null
          bond.since = event.at
          bond.turnsAt = state.stats.userTurns
          state.milestones.push({ at: event.at, kind: 'bond', label: 'mend', gist: MEND_LABELS[event.why] ?? '疙瘩解开了' })
        } else {
          bond.rift.heat = heat
        }
      } else if (action === 'repair') {
        if (!bond.rift) return false
        bond.rift = null
        bond.since = event.at
        bond.turnsAt = state.stats.userTurns
      }
      if (action !== 'mend') {
        state.milestones.push({
          at: event.at,
          kind: 'bond',
          label: `${event.action}`,
          gist: event.gist ?? event.why ?? null,
        })
      }
      break
    }
    case 'page': {
      if (typeof event.path !== 'string' || !event.path) return false
      const prev = state.pages[event.path] ?? {}
      const title =
        typeof event.title === 'string' && event.title.trim() ? event.title.trim() : (prev.title ?? event.path)
      state.pages[event.path] = {
        ...prev,
        path: event.path,
        title,
        content: typeof event.content === 'string' ? event.content : (prev.content ?? ''),
        gist: typeof event.gist === 'string' ? event.gist : (prev.gist ?? null),
        tags: Array.isArray(event.tags)
          ? normalizeTags(event.tags)
          : (prev.tags ?? []),
        salience: [1, 2, 3].includes(event.salience) ? event.salience : (prev.salience ?? 2),
        source: typeof event.source === 'string' ? event.source : (prev.source ?? 'tool'),
        pinned: event.pinned === undefined ? Boolean(prev.pinned) : Boolean(event.pinned),
        at: prev.at ?? event.at,
        updatedAt: event.at,
        recallCount: prev.recallCount ?? 0,
        lastRecallAt: prev.lastRecallAt ?? null,
        lastRecallVia: prev.lastRecallVia ?? null,
        supersededBy: prev.supersededBy ?? null,
        sources: prev.sources ?? [],
        kind: prev.kind ?? 'page',
        subject: event.subject === undefined ? (prev.subject ?? 'self') : event.subject === 'user' ? 'user' : 'self',
        links: event.links === undefined ? (prev.links ?? []) : normalizeLinks(event.links),
        forgottenAt: null,
        forgottenWhy: null,
      }
      break
    }
    case 'recall': {
      const page = typeof event.path === 'string' ? state.pages[event.path] : null
      if (!page || page.forgottenAt) return false
      page.recallCount = (page.recallCount ?? 0) + 1
      page.lastRecallAt = event.at
      page.lastRecallVia = event.via === 'tool' ? 'tool' : 'inject'
      break
    }
    case 'fold': {
      const into = typeof event.into === 'string' ? event.into : ''
      const from = Array.isArray(event.from) ? event.from.filter((path) => typeof path === 'string' && path) : []
      if (!into || !from.length) return false
      const sources = []
      const inherited = []
      for (const path of from) {
        const page = state.pages[path]
        if (!page || page.forgottenAt || path === into) continue
        inherited.push(...(page.links ?? []))
        page.supersededBy = into
        sources.push(path)
      }
      if (!sources.length) return false
      const prev = state.pages[into] ?? {}
      const merged = [...new Set([...(prev.sources ?? []), ...sources])]
      const links = normalizeLinks([...(prev.links ?? []), ...inherited]).filter(
        (link) => link !== into && isVisible(state.pages[link]),
      )
      const subjects = new Set(sources.map((path) => (state.pages[path]?.subject === 'user' ? 'user' : 'self')))
      const subject = subjects.size === 1 ? (subjects.has('user') ? 'user' : 'self') : (prev.subject ?? 'self')
      state.pages[into] = {
        ...prev,
        path: into,
        title: typeof event.title === 'string' && event.title.trim() ? event.title.trim() : (prev.title ?? into),
        content:
          typeof event.content === 'string'
            ? event.content
            : (prev.content ?? merged.map((path) => `- ${path}`).join('\n')),
        gist: typeof event.gist === 'string' ? event.gist : (prev.gist ?? null),
        tags: event.tags ? normalizeTags(event.tags) : (prev.tags ?? []),
        salience: [1, 2, 3].includes(event.salience) ? event.salience : (prev.salience ?? 2),
        source: event.source === 'rule' ? 'rule' : 'digest',
        pinned: Boolean(prev.pinned),
        at: prev.at ?? event.at,
        updatedAt: event.at,
        recallCount: prev.recallCount ?? 0,
        lastRecallAt: prev.lastRecallAt ?? null,
        lastRecallVia: prev.lastRecallVia ?? null,
        supersededBy: prev.supersededBy ?? null,
        forgottenAt: null,
        forgottenWhy: null,
        kind: 'fold',
        subject,
        sources: merged,
        links,
      }
      break
    }
    case 'forget': {
      const page = typeof event.path === 'string' ? state.pages[event.path] : null
      if (!page || page.forgottenAt) return false
      page.forgottenAt = event.at
      page.forgottenWhy = typeof event.why === 'string' ? event.why : null
      break
    }
    case 'pin': {
      if (!isAxis(event.axis)) return false
      if (!state.traits[event.axis]) return false
      state.traits[event.axis].pinned = Boolean(event.pinned)
      break
    }
    case 'reset': {
      const scope = event.scope === 'all' ? 'all' : event.scope
      if (scope === 'mood') {
        state.mood = { ...baseline(state.traits), at: atMs, mode: 'focused' }
      } else if (scope === 'traits') {
        state.traits = defaultTraits()
        state.mood = { ...baseline(state.traits), at: atMs, mode: 'focused' }
      } else if (scope === 'all') {
        state.traits = defaultTraits()
        state.mood = { ...baseline(state.traits), at: atMs, mode: 'focused' }
        state.pages = {}
        state.observations = {}
        state.milestones = []
        state.bond = defaultBond(null)
        state.shifts = []
        state.profile.name = null
        state.profile.gender = null
        state.profile.userCall = null
        state.phase = 'seed'
        state.stats.seededAt = null
        state.profile.seededAt = null
      } else {
        return false
      }
      break
    }
    case 'milestone': {
      state.milestones.push({ at: event.at, kind: event.kind, gist: event.gist ?? null, label: event.label ?? null })
      break
    }
    default:
      return false
  }

  touch(state, event)
  state.intimacy = intimacyOf(state)
  return true
}

/**
 * 全量重放。
 * @returns {{state:object, diagnostics:{applied:number, skipped:number, skippedKinds:Record<string,number>}}}
 */
export function fold(events = []) {
  const state = emptyState()
  const diagnostics = { applied: 0, skipped: 0, skippedKinds: {} }
  for (const event of events) {
    if (applyEvent(state, event)) {
      diagnostics.applied += 1
    } else {
      diagnostics.skipped += 1
      const kind = event?.kind ?? '(none)'
      diagnostics.skippedKinds[kind] = (diagnostics.skippedKinds[kind] ?? 0) + 1
    }
  }
  state.intimacy = intimacyOf(state)
  return { state, diagnostics }
}

/** 阶段只看 seed 事件：有名字才算"出生" */
export function computePhase(events = []) {
  return events.some((event) => event?.kind === 'seed' && typeof event.name === 'string' && event.name.trim())
    ? 'active'
    : 'seed'
}
