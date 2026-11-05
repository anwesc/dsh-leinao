/**
 * 关系层：我们之间处在哪一档。
 *
 * 为什么和性格分开：
 *   性格回答"我是什么样的人"，只能慢慢变（一次 ≤0.03，一天 ≤0.06）；
 *   关系回答"我们之间怎么样"，可以在一件事上跳——吵架、和好、托付、食言。
 *   吵一次架不该让我变成另一个人，但可以让关系出现裂痕；这就是两层存在的理由。
 *
 * 关系是一级一级往上走的台阶，不连续、可回退；
 * 退的时候掉一级 + 留一道裂痕。
 *
 * 裂痕不是一道开关，是一团"热度"（heat 0..1）：
 *   对话里出现道歉、示好、给台阶，会自动把它一点点浇灭——不需要谁去点"修复"按钮；
 *   真的把话说开了（repair）可以一次性清零；
 *   但它不会凭空自己好：没人理它，它就一直在那儿。
 */
export const BOND_LEVELS = [
  { key: 'stranger', label: '生疏' },
  { key: 'acquainted', label: '熟络' },
  { key: 'close', label: '亲近' },
  { key: 'trusted', label: '信任' },
]

export const BOND = {
  /** 最高一级（信任） */
  maxLevel: BOND_LEVELS.length - 1,
  /** 升一级的门槛：距上次关系变化至少这么多轮、这么久 */
  minTurnsPerLevel: 30,
  minDaysPerLevel: 3,
  /** 每一级对亲密度的加成 */
  intimacyPerLevel: 0.06,
  /** 裂痕最重时对亲密度的折扣（比升级加成重：信任掉得比涨得快） */
  riftIntimacy: 0.12,
  /** 证据最短字数 */
  minEvidenceChars: 4,
}

/** 裂痕的浇水机制：一句话浇一点，浇空了才算解开 */
export const MEND = {
  /** 用户道歉：最有效 */
  userApology: 0.3,
  /** 用户示好 / 给台阶 */
  userWarmth: 0.2,
  /** 自己道歉：有用，但比对方给台阶轻 */
  assistantApology: 0.15,
  /** 一次 rift 的初始热度 */
  riftHeat: 0.6,
  /** 一次 down（掉级）的初始热度，更烫 */
  downHeat: 0.9,
  /** 低于这个就算解开了 */
  clearBelow: 0.02,
}

/** 给 PROFILE 看的缓和理由 */
export const MEND_LABELS = {
  'apology:user': '老大先道的歉',
  'warmth:user': '老大给了台阶',
  'apology:self': '我认了错',
}

export const BOND_ACTIONS = ['up', 'down', 'rift', 'repair', 'mend']

const USER_APOLOGY = /对不起|抱歉|是我不好|我错了|我的错|别生气|原谅我|惹你生气/
const USER_WARMTH = /和好吧|翻篇|别放在心[上里]|不生气了|好好说|坐下来聊|没事了|我不怪你/
const ASSISTANT_APOLOGY = /对不起|抱歉|是我不好|我错了|让你失望|我没做好|是我的问题/

export function clampHeat(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function defaultBond(seededAt = null) {
  return { level: 0, since: seededAt, turnsAt: 0, rift: null }
}

export function bondLabel(level) {
  return (BOND_LEVELS[level] ?? BOND_LEVELS[0]).label
}

export function bondKey(level) {
  return (BOND_LEVELS[level] ?? BOND_LEVELS[0]).key
}

/** 给人和模型看的程度词 */
export function riftLevelLabel(heat) {
  const h = clampHeat(heat)
  if (h <= 0) return '没有'
  if (h < 0.35) return '轻微'
  if (h < 0.7) return '中度'
  return '很深'
}

/** 关系对亲密度的偏移：升级加成，裂痕按热度打折 */
export function bondOffset(bond) {
  const level = Math.max(0, Math.min(BOND.maxLevel, bond?.level ?? 0))
  const base = level * BOND.intimacyPerLevel
  const penalty = bond?.rift ? BOND.riftIntimacy * clampHeat(bond.rift.heat ?? 0) : 0
  return base - penalty
}

/**
 * 从一句话里认出"在缓和关系"的行为。
 * 只做识别，不判断真假——写不写进 journal 由调用方决定（且只在有裂痕时才记）。
 * @param {string} text
 * @param {'user'|'assistant'} role
 * @returns {{delta:number, why:string} | null}
 */
export function detectMend(text, role = 'user') {
  const s = typeof text === 'string' ? text : ''
  if (!s.trim()) return null
  if (role === 'assistant') {
    return ASSISTANT_APOLOGY.test(s) ? { delta: MEND.assistantApology, why: 'apology:self' } : null
  }
  if (USER_APOLOGY.test(s)) return { delta: MEND.userApology, why: 'apology:user' }
  if (USER_WARMTH.test(s)) return { delta: MEND.userWarmth, why: 'warmth:user' }
  return null
}

/**
 * 校验一次关系变化（工具调用的那几条路径；mend 是自动记录，不走这里）。
 * @param {object} state 重放后的状态
 * @param {{action:string, why?:string, evidence?:string}} input
 * @param {number} nowMs 真实时钟（只用来判断"多久没动关系了"，不参与重放）
 * @returns {{ok:true, next:object} | {ok:false, code:string, message:string}}
 */
export function checkBond(state, input, nowMs = Date.now()) {
  const action = String(input?.action ?? '')
  if (!BOND_ACTIONS.includes(action) || action === 'mend') {
    return { ok: false, code: 'unknown-action', message: `action 只能是 ${BOND_ACTIONS.filter((a) => a !== 'mend').join(' / ')}（mend 自动记，不用手动调）` }
  }
  if (state?.phase !== 'active') {
    return { ok: false, code: 'not-active', message: '还没出生，谈不上关系' }
  }
  const evidence = typeof input?.evidence === 'string' ? input.evidence.trim() : ''
  if (evidence.length < BOND.minEvidenceChars) {
    return { ok: false, code: 'no-evidence', message: '关系变化必须给 evidence：把用户原话里的一小段抄进来' }
  }

  const bond = state.bond ?? defaultBond()
  const since = bond.since ? Date.parse(bond.since) : null
  const days = since ? Math.max(0, (nowMs - since) / 86400000) : 0
  const turns = Math.max(0, (state.stats?.userTurns ?? 0) - (bond.turnsAt ?? 0))

  if (action === 'up') {
    if (bond.rift) {
      return { ok: false, code: 'rift-pending', message: '之间还有疙瘩没解开——急不得，等它凉下来再说走近' }
    }
    if (bond.level >= BOND.maxLevel) {
      return { ok: false, code: 'max-level', message: '已经是最高一档（信任），再上是没有的' }
    }
    if (turns < BOND.minTurnsPerLevel) {
      return { ok: false, code: 'too-soon', message: `距离上次关系变化才 ${turns} 轮，至少要 ${BOND.minTurnsPerLevel} 轮` }
    }
    if (days < BOND.minDaysPerLevel) {
      return { ok: false, code: 'too-soon', message: `距离上次关系变化才 ${days.toFixed(1)} 天，至少要 ${BOND.minDaysPerLevel} 天` }
    }
  }

  if (action === 'rift') {
    if (bond.rift) return { ok: false, code: 'rift-exists', message: '已经有一道没解开的疙瘩了，同一道别记两遍' }
  }

  if (action === 'repair') {
    if (!bond.rift) return { ok: false, code: 'no-rift', message: '现在没有疙瘩，不需要修复' }
  }

  if (action === 'down') {
    if (bond.level === 0 && bond.rift) {
      return { ok: false, code: 'already-lowest', message: '已经在最低一档，且疙瘩还没解开' }
    }
  }

  return { ok: true, next: { action } }
}
