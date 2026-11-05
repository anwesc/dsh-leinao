/**
 * 启发式信号抽取：从一句话里读出"往哪边推"。
 *
 * 这是**便宜的近似**，不是理解。它只推心情，绝不碰性格；
 * 单次幅度 ≤0.10，6 小时半衰期自愈——所以误判的代价是"这半小时语气偏了一点"，
 * 而不是"人格被一句话带歪"。
 *
 * 返回 {v, e, t, why[]}，每轴 [-1, 1]。
 */
const PRAISE = /谢谢|辛苦|不错|很好|真好|太棒|厉害了|靠谱|牛|赞|懂我|贴心|可以啊|行啊|有进步/
const BLAME = /不行|不对|错了|搞错|算了|别这样|好烦|垃圾|离谱|失望|怎么回事|又错了|难用/
const URGENT = /急|马上|赶紧|立刻|尽快|现在就|等你|紧急|线上|挂了|崩了/
const PLAYFUL = /哈哈|嘿嘿|笑死|好玩|有意思|摸鱼|游戏|看剧|开黑|下班/
const ACK = /^(嗯+|好+|行|可以|ok|okay|收到|知道了)[。！!～~]*$/i
const OVERNIGHT_HOURS = [23, 0, 1, 2, 3, 4, 5]
const GAP_MS = 6 * 60 * 60 * 1000

function clampSignal(value) {
  return Math.max(-1, Math.min(1, Number(value.toFixed(3))))
}

function localHour(atMs) {
  return new Date(atMs).getHours()
}

/**
 * @param {{text?:string, role?:'user'|'assistant', at?:number, prevAt?:number|null, toolErrors?:boolean}} input
 */
export function appraise(input = {}) {
  const text = String(input.text ?? '').trim()
  const role = input.role === 'assistant' ? 'assistant' : 'user'
  const at = Number.isFinite(input.at) ? input.at : Date.now()
  const why = []
  let v = 0
  let e = 0
  let t = 0

  if (text) {
    if (PRAISE.test(text)) { v += 0.55; e += 0.2; why.push('praise') }
    if (BLAME.test(text)) { v -= 0.6; t += 0.35; why.push('blame') }
    if (URGENT.test(text)) { t += 0.45; e += 0.15; why.push('urgent') }
    if (PLAYFUL.test(text)) { e += 0.35; v += 0.1; why.push('playful') }
    if (ACK.test(text)) { v += 0.1; e -= 0.1; why.push('ack') }
    if (OVERNIGHT_HOURS.includes(localHour(at))) { e -= 0.35; t += 0.15; why.push('late-night') }
    if (/[!！]/.test(text)) { e += 0.1; why.push('exclaim') }
    if (/[?？]/.test(text)) { e += 0.05; why.push('question') }
    if (text.length >= 240) { e += 0.15; v += 0.05; why.push('long-input') }
    if (text.length <= 8 && role === 'user' && !ACK.test(text)) { e -= 0.12; why.push('terse') }
  }

  if (input.toolErrors) { t += 0.4; v -= 0.2; why.push('tool-error') }
  if (role === 'user' && Number.isFinite(input.prevAt) && at - input.prevAt > GAP_MS) {
    v += 0.15
    why.push('reunion')
  }

  const weight = role === 'assistant' ? 0.5 : 1
  return {
    v: clampSignal(v * weight),
    e: clampSignal(e * weight),
    t: clampSignal(t * weight),
    why,
  }
}
