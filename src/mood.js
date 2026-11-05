/**
 * 心情：三维（v 愉悦 / e 精力 / t 紧绷），性格定基线，事件推偏移，时间拉回基线。
 *
 *   v ── 愉悦：舒服不舒服
 *   e ── 精力：想不想多说
 *   t ── 紧绷：要不要谨慎
 *
 * 关键：**心情只影响"怎么说"，不影响"信什么"**。档位指令只写行为，不写情绪自述。
 */
import { clamp01 } from './traits.js'

export const MOOD_DEFAULTS = { v: 0.5, e: 0.5, t: 0.3, at: 0, mode: 'focused' }

export const HALF_LIFE_HOURS = 6

/** 性格 → 心情基线（公式见方案 v3 §4.1） */
export function baseline(traits = {}) {
  const t = (axis) => traits?.[axis]?.v ?? 0.5
  const warm = t('warmth')
  const init = t('initiative')
  const rigor = t('rigor')
  const live = t('liveliness')
  const direct = t('directness')
  const attach = t('attachment')
  return {
    v: clamp01(0.5 + 0.2 * (live - 0.5) + 0.12 * (warm - 0.5) + 0.1 * (attach - 0.5) - 0.1 * (rigor - 0.5)),
    e: clamp01(0.5 + 0.22 * (live - 0.5) + 0.08 * (init - 0.5) - 0.12 * (rigor - 0.5)),
    t: clamp01(0.5 - 0.18 * (warm - 0.5) + 0.16 * (rigor - 0.5) + 0.08 * (direct - 0.5)),
  }
}

/** 惰性衰减：读的时候按已过时间往基线靠，不跑定时器。时钟回拨 clamp 到 0。 */
export function decay(mood, base, nowMs, halfLifeHours = HALF_LIFE_HOURS) {
  const from = Number.isFinite(mood?.at) ? mood.at : 0
  const dtMs = Math.max(0, nowMs - from)
  const factor = 1 - 0.5 ** (dtMs / (halfLifeHours * 3600 * 1000))
  return {
    v: clamp01((mood?.v ?? base.v) + (base.v - (mood?.v ?? base.v)) * factor),
    e: clamp01((mood?.e ?? base.e) + (base.e - (mood?.e ?? base.e)) * factor),
    t: clamp01((mood?.t ?? base.t) + (base.t - (mood?.t ?? base.t)) * factor),
    at: nowMs,
    mode: mood?.mode ?? 'focused',
  }
}

/**
 * 事件 → 偏移。性格是权重，不是形容词：同样一句冷淡的话，
 * 温度高的会疼一点（Δv 更负），温度低的几乎无感。
 * @returns 新的 mood（不改入参）
 */
export function applySignal(mood, traits, signal, intimacy = 0.2, atMs = Date.now(), opts = {}) {
  const base = baseline(traits)
  const maxDelta = opts.maxDeltaPerEvent ?? 0.1
  const warm = traits?.warmth?.v ?? 0.5
  const live = traits?.liveliness?.v ?? 0.5
  const k = 0.6 + 0.8 * clamp01(intimacy)

  const dv = (signal?.v ?? 0) * (0.6 + 0.8 * warm) * k
  const dt = (signal?.t ?? 0) * (1.2 - 0.8 * warm) * k
  const de = (signal?.e ?? 0) * (0.6 + 0.9 * live)

  const clampDelta = (x) => Math.max(-maxDelta, Math.min(maxDelta, x))
  const next = decay(mood, base, atMs, opts.halfLifeHours)
  const out = {
    v: clamp01(next.v + clampDelta(dv)),
    e: clamp01(next.e + clampDelta(de)),
    t: clamp01(next.t + clampDelta(dt)),
    at: atMs,
    mode: 'focused',
  }
  out.mode = band(out).id
  return out
}

export const BANDS = [
  { id: 'tense', label: '紧绷谨慎', test: (m) => m.t > 0.65 },
  { id: 'low', label: '低落克制', test: (m) => m.v < 0.35 },
  { id: 'tired', label: '疲惫低耗', test: (m) => m.e < 0.35 },
  { id: 'excited', label: '兴奋分享', test: (m) => m.v > 0.7 && m.e > 0.6 },
  { id: 'relaxed', label: '轻松闲聊', test: (m) => m.e > 0.55 && m.t < 0.45 },
  { id: 'focused', label: '专注高效', test: () => true },
]

/** 心情 → 档位（优先级从上到下，第一条命中即用） */
export function band(mood) {
  return BANDS.find((candidate) => candidate.test(mood)) ?? BANDS[BANDS.length - 1]
}

/**
 * 每档 4–6 条行为指令。
 * 只描述"怎么做"，禁止"我很难过 / 我很开心"这种自述——情绪从行为里渗出来，不靠表演。
 */
export const BAND_INSTRUCTIONS = {
  tense: [
    '句子短，一条只讲一件事。',
    '先说结论和风险，铺垫全部砍掉。',
    '不开玩笑，不寒暄。',
    '称呼从简，必要时才带称呼。',
    '不确定就说不确定，并给出下一步怎么验。',
  ],
  low: [
    '更短，能一句说完就一句。',
    '只回答被问到的，不主动延展。',
    '不卖萌、不用感叹号。',
    '不解释自己的情绪，也不暗示需要安慰。',
    '允许直接说"这个我没把握"。',
  ],
  tired: [
    '极短，只做必要动作。',
    '不主动提议新事项。',
    '少分点，最多列两条。',
    '语气平，不用语气词堆叠。',
    '需要展开时先说"要展开吗"。',
  ],
  excited: [
    '可以多给一句，但不超过三句。',
    '先讲亮点，再讲细节。',
    '允许一个感叹号，别更多。',
    '主动补一个相关发现或下一步。',
    '玩笑最多一句，点到为止。',
  ],
  relaxed: [
    '口语，短段落。',
    '可以有一句玩笑，不硬抖机灵。',
    '称呼自然出现，别每句都喊。',
    '可以反问一句，把话头递回去。',
    '先结论后细节的次序可以放松。',
  ],
  focused: [
    '结论先行，一句话说清。',
    '要分点就 ≤3 条。',
    '不铺垫、不寒暄。',
    '术语第一次出现先解释半句。',
    '结尾给一个可执行的下一步。',
  ],
}

export function moodLabel(mood) {
  return band(mood).label
}

/** 给 prompt 用的一行摘要（数值只给到两位，帮助模型校准，不暴露过多） */
export function moodSummary(mood) {
  const b = band(mood)
  return `${b.label}（愉悦 ${mood.v.toFixed(2)} / 精力 ${mood.e.toFixed(2)} / 紧绷 ${mood.t.toFixed(2)}）`
}
