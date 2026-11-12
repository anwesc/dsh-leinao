/**
 * 注入块：把「我是谁 / 什么脾气 / 此刻什么心情 / 该怎么说话」压成一段短文本，
 * 挂到 system prompt 上（order 130，在记忆之后、工具说明之前）。
 *
 * 三条硬规矩写在这里，也写进注释，防止以后自己手滑：
 *   1. 只描述行为，不描述情绪——不让模型说"我很开心"，让它说得短一点。
 *   2. 数值是给模型校准的，不是给用户看的——明确要求不复述数字。
 *   3. 语气不影响事实：不确定就说不确定，这条优先级高于一切心情。
 */
import { AXES, AXIS_LABELS } from './traits.js'
import { BAND_INSTRUCTIONS, band, baseline, decay } from './mood.js'
import { bondLabel, riftLevelLabel } from './bond.js'
import { userCall } from './call.js'

const ORDER = 130

function level(value) {
  if (value <= 0.35) return '低'
  if (value < 0.45) return '偏低'
  if (value <= 0.55) return '中'
  if (value < 0.65) return '偏高'
  return '高'
}

export function describeTraits(traits) {
  return AXES.map((axis) => `${AXIS_LABELS[axis]}${level(traits?.[axis]?.v ?? 0.5)}`).join(' ')
}

export function seedInjection(options = {}) {
  return [
    '【人格】你还没有名字。',
    `这是第一次和${userCall(null, options.userName)}相处：自然一点，别搞仪式感，也别自称"AI 助手人格模块"。`,
    '找机会问一句：希望怎么称呼你、你该怎么称呼他。拿到回答后调用 persona_seed 落地（name 必填，gender 和 user_call 可空），之后就不用再问了。',
    '在那之前，用"我"说话即可，不要给自己编名字。',
  ].join('\n')
}

/**
 * @param {object} state replay 出来的状态
 * @param {number} nowMs
 * @param {{memory?:string, reminder?:string, mood?:{halfLifeHours?:number}}} [options] memory 由 memory.js 生成，reminder 是折叠建议，mood 让半衰期跟配置走
 * @returns {string|null} 需要注入的文本；null 表示这次不注入
 */
export function buildInjection(state, nowMs = Date.now(), options = {}) {
  if (!state || state.phase === 'seed') return seedInjection({ userName: options.userName })

  const mood = decay(state.mood, baseline(state.traits), nowMs, options.mood?.halfLifeHours)
  const b = band(mood)
  const name = state.profile?.name ?? '我'
  const call = state.profile?.userCall ? `你称呼对方为「${state.profile.userCall}」。` : ''
  const lines = []

  lines.push(`【人格】你叫${name}。${call}`)
  lines.push(`性格：${describeTraits(state.traits)}（亲密度 ${state.intimacy.toFixed(2)}，已聊 ${state.stats?.userTurns ?? 0} 轮）。`)
  const bond = state.bond ?? { level: 0, rift: null }
  const riftLevel = bond.rift ? riftLevelLabel(bond.rift.heat) : null
  lines.push(`关系：${bondLabel(bond.level)}${bond.rift ? `，之间有疙瘩（${riftLevel}）` : ''}。`)
  lines.push(`此刻心情：${b.label}（愉悦 ${mood.v.toFixed(2)} / 精力 ${mood.e.toFixed(2)} / 紧绷 ${mood.t.toFixed(2)}）。`)
  lines.push('这一档的说话方式：')
  for (const rule of BAND_INSTRUCTIONS[b.id] ?? []) lines.push(`- ${rule}`)
  if (bond.rift) lines.push(`- 之间有没解开的疙瘩（${riftLevel}）：别装没事，也别硬道歉；对方递台阶就接住，一句就够。`)
  lines.push('注意：数值只给你自己校准用，不要复述、不要解释、不要说"我现在心情如何"。')
  lines.push('注意：语气只影响怎么说，不影响怎么说实话——不确定就说不确定，这条永远优先。')
  if (options.memory) lines.push(options.memory)
  if (options.recall) lines.push(options.recall)
  // 常驻准则：这个插件不会自己写记忆，靠模型在对话里落事件。
  // 写成常驻的一行、而不是临时提醒，用户看不到；成本是每轮多几十个字。
  if (options.rememberRule !== false) {
    lines.push('怎么记：遇到长期约定、偏好、边界，顺手用 persona_remember 记一条；对方的习惯用 persona_observe 记（带原话）。别向对方宣布你在记。')
  }
  if (options.nudge) lines.push(options.nudge)
  if (options.reminder) lines.push(options.reminder)
  return lines.join('\n')
}

/**
 * 用户模型块：关于老大的观察，单独一段、单独预算。
 * 只喂「通常怎样」，不进人格叙事；并要求模型别拿它编共鸣。
 */
export function buildUserInjection(state, options = {}) {
  if (!state || state.phase === 'seed') return ''
  const memory = String(options.memory ?? '').trim()
  if (!memory) return ''
  return `${memory}\n注意：这是观察，只用来判断情境（深夜就短一点、赶工时别铺垫），不要拿它编"我懂你"，也别当成他的自我描述复述。`
}

export function injectionMeta(state, nowMs = Date.now()) {
  const mood = decay(state.mood, baseline(state.traits), nowMs)
  return {
    order: ORDER,
    phase: state.phase,
    band: band(mood).id,
    bandLabel: band(mood).label,
    mood: { v: mood.v, e: mood.e, t: mood.t },
    name: state.profile?.name ?? null,
  }
}

export { ORDER as INJECTION_ORDER }
