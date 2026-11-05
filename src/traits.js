/**
 * 六轴性格：骨架固定（温度/主动/严谨/活泼/直接/依恋），数值从 0.5 开始、靠证据长。
 * 0.5 = 还不知道；n = 已经吃过多少条成长证据。
 *
 * 这一层只做"接不接受"，不做"怎么来的"——delta 由 agent 在 digest 时提出，
 * 护栏落在代码里，模型说了不算。
 */
export const AXES = ['warmth', 'initiative', 'rigor', 'liveliness', 'directness', 'attachment']

export const AXIS_LABELS = {
  warmth: '温度',
  initiative: '主动',
  rigor: '严谨',
  liveliness: '活泼',
  directness: '直接',
  attachment: '依恋',
}

/** 成长限速：单次 ≤0.03，单日累计 ≤0.06 */
export const GROWTH = {
  maxDelta: 0.03,
  maxDaily: 0.06,
  /** 里程碑台阶 */
  step: 0.2,
  minTurns: 20,
  minAgeMs: 24 * 60 * 60 * 1000,
}

/**
 * 突变（shift）：重大事件可以在一次里推动更多，但必须稀有、有证据、可审计。
 * 慢成长是"日常相处磨出来的"，突变是"某件事改变了什么"——后者不该天天发生。
 */
export const SHIFT = {
  /** 单次单轴上限：是日常成长（0.03）的 1.67 倍，但远不到"换个人" */
  maxDelta: 0.05,
  /** 两次突变之间至少隔这么久 */
  cooldownMs: 7 * 24 * 60 * 60 * 1000,
  /** 90 天内最多几次 */
  maxPerWindow: 4,
  windowMs: 90 * 24 * 60 * 60 * 1000,
  /** 证据至少这么长（防止一句"嗯"当证据） */
  minEvidenceChars: 6,
  /** 证据只在最近这么多轮用户消息里核验 */
  evidenceWindow: 60,
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export function defaultTraits() {
  const traits = {}
  for (const axis of AXES) traits[axis] = { v: 0.5, n: 0, pinned: false }
  return traits
}

export function isAxis(axis) {
  return AXES.includes(axis)
}

/** 从 v0.5 的"未知"长到有把握：n 越多，同样的 delta 越难推动（边际递减）。 */
export function growthResistance(n) {
  return 1 / (1 + 0.1 * Math.max(0, n))
}

/**
 * 成长前置条件：前期先观察，不许一上来就"养成"。
 * 用事件流自己的时间算，保证重放结果确定（不依赖 now）。
 */
export function growthGate(state, nowMs = null) {
  const stats = state.stats ?? { userTurns: 0, firstEventAt: null, lastEventAt: null }
  const turns = stats.userTurns ?? stats.turns ?? 0
  const first = stats.firstEventAt ? Date.parse(stats.firstEventAt) : null
  if (first === null) return { ok: false, code: 'too-early', message: '还没有事件，先聊聊' }
  const last = nowMs !== null
    ? Math.max(nowMs, Date.parse(stats.lastEventAt ?? stats.firstEventAt))
    : Date.parse(stats.lastEventAt ?? stats.firstEventAt)
  const age = Math.max(0, last - first)
  if (turns < GROWTH.minTurns) {
    return { ok: false, code: 'too-early', message: `还要再聊 ${GROWTH.minTurns - turns} 轮才允许成长` }
  }
  if (age < GROWTH.minAgeMs) {
    return { ok: false, code: 'too-early', message: '相处不满 1 天，先别急着定型' }
  }
  return { ok: true }
}

/**
 * 校验一次成长。
 * @param {object} state 重放后的状态
 * @param {{axis:string, delta:number, evidence?:Array<{sessionId:string,seq:number}>, todayTotal?:number}} input
 * @returns {{ok:true, applied:number} | {ok:false, code:string, message:string}}
 */
export function checkGrowth(state, input) {
  const { axis, delta } = input
  if (!isAxis(axis)) return { ok: false, code: 'unknown-axis', message: `没有这根轴：${axis}（可选 ${AXES.join(' / ')}）` }
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, code: 'bad-delta', message: 'delta 必须是有限非零数' }
  if (Math.abs(delta) > GROWTH.maxDelta + 1e-9) {
    return { ok: false, code: 'delta-too-large', message: `单次 |delta| 不能超过 ${GROWTH.maxDelta}` }
  }
  const gate = growthGate(state)
  if (!gate.ok) return gate
  if (state.traits?.[axis]?.pinned) return { ok: false, code: 'pinned', message: `${AXIS_LABELS[axis]}被 pin 住了，先 /persona unpin ${axis}` }
  const todayTotal = Math.abs(input.todayTotal ?? 0) + Math.abs(delta)
  if (todayTotal > GROWTH.maxDaily + 1e-9) {
    return { ok: false, code: 'daily-cap', message: `今天这根轴已经动了 ${(input.todayTotal ?? 0).toFixed(3)}，超过日上限 ${GROWTH.maxDaily}` }
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  if (evidence.length === 0) return { ok: false, code: 'no-evidence', message: '成长必须给 evidence（sessionId + seq），空口无凭不算' }
  return { ok: true, applied: delta * growthResistance(state.traits[axis].n) }
}

/**
 * 校验一次突变。和 checkGrowth 的区别：成长有阻力衰减，突变没有——一次就到位，
 * 但代价是**七天冷却 + 90 天四次 + 证据必须能在最近对话里逐字找到**。
 *
 * @param {object} state 重放后的状态
 * @param {{axis:string, delta:number, evidence?:string, gist?:string}} input
 * @param {{nowMs?:number, verified?:boolean}} opts verified=false 表示证据核验没过
 * @returns {{ok:true, applied:number} | {ok:false, code:string, message:string}}
 */
export function checkShift(state, input, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const axis = input?.axis
  const delta = input?.delta

  if (!isAxis(axis)) return { ok: false, code: 'unknown-axis', message: `没有这根轴：${axis}（可选 ${AXES.join(' / ')}）` }
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, code: 'bad-delta', message: 'delta 必须是有限非零数' }
  if (Math.abs(delta) > SHIFT.maxDelta + 1e-9) {
    return { ok: false, code: 'delta-too-large', message: `突变单次 |delta| 不能超过 ${SHIFT.maxDelta}（日常成长才 0.03）` }
  }
  if (state?.phase !== 'active') return { ok: false, code: 'not-active', message: '还没出生，谈不上性格' }
  const slot = state.traits?.[axis]
  if (!slot) return { ok: false, code: 'unknown-axis', message: `没有这根轴：${axis}` }
  if (slot.pinned) return { ok: false, code: 'pinned', message: `${AXIS_LABELS[axis]}被 pin 住了，突变也不行` }

  const evidence = typeof input?.evidence === 'string' ? input.evidence.trim() : ''
  if (evidence.length < SHIFT.minEvidenceChars) {
    return { ok: false, code: 'no-evidence', message: `突变必须给 evidence：抄一段用户原话（至少 ${SHIFT.minEvidenceChars} 字）` }
  }
  if (opts.verified === false) {
    return { ok: false, code: 'evidence-mismatch', message: '这段证据在最近的对话里找不到原话，不能拿它当理由' }
  }

  const shifts = Array.isArray(state.shifts) ? state.shifts : []
  const last = shifts[shifts.length - 1]
  if (last) {
    const dt = nowMs - Date.parse(last.at)
    if (Number.isFinite(dt) && dt < SHIFT.cooldownMs) {
      const left = Math.ceil((SHIFT.cooldownMs - dt) / 86400000)
      return { ok: false, code: 'cooldown', message: `上次突变才过去 ${Math.floor(dt / 86400000)} 天，还要等 ${left} 天` }
    }
  }
  const recent = shifts.filter((entry) => {
    const t = Date.parse(entry.at)
    return Number.isFinite(t) && nowMs - t <= SHIFT.windowMs
  })
  if (recent.length >= SHIFT.maxPerWindow) {
    return { ok: false, code: 'shift-cap', message: `90 天内已经突变 ${recent.length} 次，够多了——性格不是这么改的` }
  }

  return { ok: true, applied: delta }
}

/** 跨过哪些 0.1 刻度（0.1…0.9；0.5 是起点，不算跨） */export function crossedSteps(from, to) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const out = []
  for (let k = 1; k < 10; k += 1) {
    const mark = k / 10
    if (mark > lo && mark <= hi) out.push(mark)
  }
  return to >= from ? out : out.reverse()
}
