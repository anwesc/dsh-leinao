/**
 * 模型可调用的工具。
 *
 * 设计原则：
 * - 写操作全部走**事件**，不直接改 state.json——工具只负责"记下发生了什么"。
 * - 能给用户看的，一律返回人话 + 路径；不返回 JSON 大对象。
 * - reset 要 confirm=true，避免模型顺手把人格清了。
 */
import { AXES, AXIS_LABELS, SHIFT, checkShift, isAxis } from './traits.js'
import { bondLabel, checkBond, riftLevelLabel } from './bond.js'
import { baseline, decay, moodLabel } from './mood.js'
import { describeTraits } from './prompt.js'
import { isVisible, memoryStats, normalizeLinks, normalizeTags, searchPages } from './memory.js'

const SHIFT_MAX = SHIFT.maxDelta

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function fmt(value) {
  return Number(value).toFixed(2)
}

function cleanText(value, max = 2000) {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function firstLine(value, max = 40) {
  const line = String(value ?? '').split('\n').find((item) => item.trim()) ?? ''
  return cleanText(line, max)
}

function formatPage(page, state) {
  const head = `【${page.path}】${page.title}${page.supersededBy ? `（已整理进 ${page.supersededBy}）` : ''}`
  const body = cleanText(page.content, 700)
  const meta = [
    page.gist,
    (page.tags ?? []).join('、'),
    page.salience === 1 ? '永远记得' : null,
  ].filter(Boolean).join(' · ')
  const links = (page.links ?? []).filter((path) => !state || isVisible(state.pages?.[path]))
  const related = links.length ? `相关：${links.join('、')}` : ''
  return [head, body, meta ? `（${meta}）` : '', related].filter(Boolean).join('\n')
}

/** 折叠页的 path：digest/<tag 或标题的 ascii 化>，重名加序号 */
function uniquePath(state, seed) {
  const base = String(seed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const stem = base ? `digest/${base}` : `digest/${Date.now().toString(36)}`
  let path = stem
  let n = 2
  while (state.pages[path]) {
    path = `${stem}-${n}`
    n += 1
  }
  return path
}

function moodLine(state, nowMs = Date.now(), halfLifeHours) {
  const mood = decay(state.mood, baseline(state.traits), nowMs, halfLifeHours)
  return `${moodLabel(mood)}（愉悦 ${fmt(mood.v)} / 精力 ${fmt(mood.e)} / 紧绷 ${fmt(mood.t)}）`
}

/**
 * @param {object} ctx cordis 上下文
 * @param {Function} defineTool @deepseek-ai/dsh-tools 的 defineTool
 * @param {object} rt 运行时钩子：{ dataDir, deviceId, state(), record(event), commit() }
 */
export function registerPersonaTools(ctx, defineTool, rt) {
  const tools = []

  tools.push(defineTool({
    name: 'persona_state',
    description: '查看当前人格状态：名字、六轴性格、此刻心情、相处轮次与亲密度。用户问"你现在什么状态/什么心情"，或你要校准语气时调用。',
    parameters: {},
    output: TEXT_OUTPUT,
    execute() {
      const { state } = rt.refresh()
      if (state.phase === 'seed') {
        return Promise.resolve('还没有出生：没有人格数据，也没有名字。先自然地问问用户希望怎么称呼你。')
      }
      const pinned = AXES.filter((axis) => state.traits[axis].pinned).map((axis) => AXIS_LABELS[axis])
      const bond = state.bond ?? { level: 0, rift: null }
      const memory = memoryStats(state)
      const lines = [
        `名字：${state.profile.name}${state.profile.userCall ? `；称呼对方「${state.profile.userCall}」` : ''}`,
        `性格：${describeTraits(state.traits)}`,
        `关系：${bondLabel(bond.level)}${bond.rift ? `（有未解的疙瘩：${bond.rift.gist ?? bond.rift.why ?? '没说清'}，程度${riftLevelLabel(bond.rift.heat)}）` : ''}`,
        `心情：${moodLine(state, Date.now(), rt.getConfig?.()?.mood?.halfLifeHours)}`,
        `相处：${state.stats.userTurns} 轮 · 亲密度 ${fmt(state.intimacy)} · ${state.stats.events} 条事件`,
        `记忆：${memory.visible} 条在册${memory.folded ? `（${memory.folded} 条整理页）` : ''}${memory.isolated ? `，${memory.isolated} 条还没有互链` : ''}${memory.forgotten ? `，忘了 ${memory.forgotten} 条` : ''}`,
        state.shifts?.length ? `突变：${state.shifts.length} 次` : null,
        pinned.length ? `固定：${pinned.join('、')}` : null,
      ].filter(Boolean)
      return Promise.resolve(lines.join('\n'))
    },
  }))

  tools.push(defineTool({
    name: 'persona_seed',
    description: '人格出生：记下名字、性别、对用户的称呼。用户已经明确告诉你这些之后调用一次；之后不要再调用。',
    parameters: {
      name: { type: 'string', required: true, description: '用户给你起的名字' },
      gender: { type: 'string', description: '性别或性别气质（可空）' },
      user_call: { type: 'string', description: '你称呼用户的方式，如"老大"（可空）' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      if (state.phase !== 'seed') {
        return Promise.resolve(`已经出生过了，名字是「${state.profile.name}」。改名字不是 v0.1 的能力，需要的话先重置（persona_reset scope=all）。`)
      }
      const name = String(args?.name ?? '').trim()
      if (!name) return Promise.resolve('name 不能为空。')
      rt.record({
        kind: 'seed',
        name,
        gender: args?.gender ? String(args.gender).trim() : null,
        userCall: args?.user_call ? String(args.user_call).trim() : null,
      })
      const call = args?.user_call ? `，以后叫你「${args.user_call}」` : ''
      return Promise.resolve(`记住了：我叫${name}${call}。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_pin',
    description: '固定/解固一根性格轴：固定的轴不再随对话变化（比如用户要求"别再变得更主动"）。',
    parameters: {
      axis: { type: 'string', required: true, description: `轴名：${AXES.join(' / ')}` },
      pinned: { type: 'boolean', description: 'true 固定（默认），false 解固' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const axis = String(args?.axis ?? '')
      if (!isAxis(axis)) return Promise.resolve(`没有这根轴：${axis || '(空)'}。可选 ${AXES.join(' / ')}`)
      const pinned = args?.pinned !== false
      rt.record({ kind: 'pin', axis, pinned })
      return Promise.resolve(`${AXIS_LABELS[axis]}已${pinned ? '固定' : '解固'}。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_bond',
    description: `关系台阶变动（重大事件用）：up 走近一级，down 退一级并留裂痕，rift 只留一道疙瘩，repair 表示"把话说开了"、一次性解开。平时对话里的道歉、示好、给台阶会自动让疙瘩一点点凉下去，不用调用本工具。信任掉得比涨得快，没人理裂痕它不会自己好。证据 evidence 必须是用户原话里的一小段。`,
    parameters: {
      action: { type: 'string', required: true, description: 'up / down / rift / repair' },
      why: { type: 'string', required: true, description: '发生了什么，一句话' },
      evidence: { type: 'string', required: true, description: '用户原话里的一段，逐字抄（≥4 字）' },
      gist: { type: 'string', description: '给以后看的短标签（可空）' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      if (state.phase !== 'active') return Promise.resolve('还没出生，谈不上关系。')
      const action = String(args?.action ?? '')
      const evidence = String(args?.evidence ?? '').trim()
      const why = String(args?.why ?? '').trim()
      const gist = args?.gist ? String(args.gist).trim() : null
      const verdict = checkBond(state, { action, evidence, why }, Date.now())
      if (!verdict.ok) return Promise.resolve(`没有执行：${verdict.message}（${verdict.code}）`)
      if (rt.verifyEvidence && !rt.verifyEvidence(evidence)) {
        return Promise.resolve('没有执行：这段证据在最近的对话里找不到原话（重启后只认本次会话里说过的话），不能拿它当理由。')
      }
      rt.record({ kind: 'bond', action, evidence, why: why || null, gist })
      const after = rt.refresh().state
      const rift = after.bond?.rift ? `，还留着疙瘩（${after.bond.rift.gist ?? after.bond.rift.why ?? '没说清'}）` : ''
      return Promise.resolve(`记下了：关系现在是「${bondLabel(after.bond.level)}」${rift}。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_shift',
    description: `性格突变（重大事件用，不是日常成长）：某件真的改变了什么的时候，一次性把一根轴推动多一点（|delta|≤${SHIFT_MAX}）。七天内只能一次、90 天最多四次；evidence 必须能在最近对话里逐字找到。`,
    parameters: {
      axis: { type: 'string', required: true, description: `轴名：${AXES.join(' / ')}` },
      delta: { type: 'number', required: true, description: `变化量，±${SHIFT_MAX} 以内；涨为正、跌为负` },
      evidence: { type: 'string', required: true, description: '用户原话里的一段，逐字抄（≥6 字）' },
      gist: { type: 'string', description: '一句话：为什么变（会显示在 PROFILE 里）' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      const axis = String(args?.axis ?? '')
      const delta = Number(args?.delta)
      const evidence = String(args?.evidence ?? '').trim()
      const gist = args?.gist ? String(args.gist).trim() : null
      const verified = rt.verifyEvidence ? rt.verifyEvidence(evidence) : true
      const verdict = checkShift(state, { axis, delta, evidence, gist }, { verified, nowMs: Date.now() })
      if (!verdict.ok) return Promise.resolve(`没有执行：${verdict.message}（${verdict.code}）`)
      const before = state.traits[axis]?.v ?? 0.5
      rt.record({ kind: 'shift', axis, delta, evidence, gist })
      const after = rt.refresh().state
      return Promise.resolve(`记下了：${AXIS_LABELS[axis]} ${fmt(before)} → ${fmt(after.traits[axis].v)}。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_remember',
    description: '把一件值得长期记住的事写进记忆（关于老大、约定、重要经历、你自己的判断）。同一 path 再写就是更新。用 links 把它和相关旧记忆连起来（比如「换工作」连到「老大」），以后一条被想起，另一条更容易跟着出现。日常寒暄不用记。',
    parameters: {
      title: { type: 'string', required: true, description: '一句话标题，≤40 字' },
      content: { type: 'string', required: true, description: '正文；以后每轮只看得到索引里的一行，细节要靠这里' },
      path: { type: 'string', description: '稳定 id：小写字母/数字/斜杠，如 people/laoda、events/job-change；不填自动生成 notes/xxx' },
      gist: { type: 'string', description: '索引里显示的一句话，≤40 字；不填取正文首行' },
      tags: { type: 'string', description: '逗号分隔的标签，如 老大,工作；折叠时按第一个标签归类' },
      links: { type: 'string', description: '相关的记忆 path，逗号分隔，最多 5 条；不填保留原有关系，填空字符串则清空' },
      salience: { type: 'number', description: '1 永远记得 / 2 正常（默认）/ 3 容易忘' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      const title = cleanText(args?.title, 40)
      const content = cleanText(args?.content, 2000)
      if (!title) return Promise.resolve('没有记：title 不能为空。')
      if (!content) return Promise.resolve('没有记：content 不能为空。')
      let path = String(args?.path ?? '').trim().toLowerCase()
      if (!path) path = `notes/${Date.now().toString(36)}`
      if (!/^[a-z0-9][a-z0-9/_-]{0,79}$/.test(path)) {
        return Promise.resolve('没有记：path 只能用 小写字母/数字/斜杠/下划线/短横，如 people/laoda。')
      }
      const existed = Boolean(state.pages[path])
      const level = Number(args?.salience)
      const salience = [1, 2, 3].includes(level) ? level : 2
      const tags = normalizeTags(args?.tags)
      const wanted = normalizeLinks(args?.links)
      const links = wanted.filter((link) => link !== path && isVisible(state.pages[link]))
      const dropped = wanted.length - links.length
      const draft = {
        kind: 'page',
        path,
        title,
        content,
        gist: cleanText(args?.gist, 40) || firstLine(content),
        tags,
        salience,
        source: 'tool',
      }
      if (args?.links !== undefined && args?.links !== null) draft.links = links
      rt.record(draft)
      const related = links.length ? `，关联 ${links.length} 条` : ''
      const miss = dropped > 0 ? `其中 ${dropped} 个 path 没有对应的记忆，已忽略。` : ''
      return Promise.resolve(
        `${existed ? '更新了' : '记下了'}「${title}」（${path}${salience === 1 ? '，永远记得' : ''}${related}）。${miss}`,
      )
    },
  }))

  tools.push(defineTool({
    name: 'persona_recall',
    description: '按关键词或 path 查记忆全文。命中会记一次召回，让这条以后更容易被想起来。',
    parameters: {
      query: { type: 'string', description: '关键词，空格分隔，全部命中才算；和 path 二选一' },
      path: { type: 'string', description: '直接取某一条，优先于 query' },
      limit: { type: 'number', description: '最多几条，默认 3、上限 5' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      const path = String(args?.path ?? '').trim()
      const limit = Math.min(5, Math.max(1, Number(args?.limit) || 3))
      if (path) {
        const page = state.pages[path]
        if (!page || page.forgottenAt) return Promise.resolve(`没有「${path}」这条记忆。`)
        rt.record({ kind: 'recall', path, via: 'tool' })
        return Promise.resolve(formatPage(page, state))
      }
      const query = String(args?.query ?? '').trim()
      if (!query) return Promise.resolve('给个 query（关键词）或 path。')
      const pages = searchPages(state, query, limit)
      if (!pages.length) return Promise.resolve(`没找到和「${query}」有关的记忆。`)
      for (const page of pages) rt.record({ kind: 'recall', path: page.path, via: 'tool' })
      return Promise.resolve(pages.map((page) => formatPage(page, state)).join('\n\n'))
    },
  }))

  tools.push(defineTool({
    name: 'persona_digest',
    description: '把几条旧记忆合成一条摘要：原条目标记为已整理，不再单独出现。注入里提示「可以整理」时调用；paths 至少一条。',
    parameters: {
      paths: { type: 'string', required: true, description: '要整理的 path，逗号或空格分隔' },
      title: { type: 'string', required: true, description: '整理后的标题，≤40 字' },
      content: { type: 'string', description: '整理后的正文；不填则按各条标题+gist 串成清单' },
      gist: { type: 'string', description: '索引里显示的一句话，≤40 字' },
      tag: { type: 'string', description: '归类标签；不填取第一条记忆的标签' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      const title = cleanText(args?.title, 40)
      if (!title) return Promise.resolve('没有整理：title 不能为空。')
      const paths = String(args?.paths ?? '')
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
      const pages = paths.map((path) => state.pages[path]).filter((page) => page && !page.forgottenAt)
      if (!pages.length) {
        return Promise.resolve(`没有整理：这些 path 都没有对应的记忆（${paths.join('、') || '空'}）。`)
      }
      const tag = cleanText(args?.tag, 20) || (pages[0].tags ?? [])[0] || null
      const content =
        cleanText(args?.content, 2000) ||
        pages.map((page) => `- ${page.title}：${page.gist ?? firstLine(page.content, 60)}`).join('\n')
      const gist = cleanText(args?.gist, 40) || `${pages.length} 条整理：${pages.map((page) => page.title).join('、')}`
      const into = uniquePath(state, tag || title)
      rt.record({
        kind: 'fold',
        into,
        from: pages.map((page) => page.path),
        title,
        content,
        gist,
        tags: tag ? [tag] : [],
        source: args?.content ? 'digest' : 'rule',
      })
      return Promise.resolve(`整理好了：「${title}」（${into}），${pages.length} 条旧记忆收进去了。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_forget',
    description: '忘掉一条记忆：从索引和检索里移除，原文仍留在事件流里可复盘。只有老大明确说「忘掉 / 别再提」时才用。',
    parameters: {
      path: { type: 'string', required: true, description: '要忘掉的 path' },
      why: { type: 'string', description: '为什么忘，一句话' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const { state } = rt.refresh()
      const path = String(args?.path ?? '').trim()
      const page = state.pages[path]
      if (!page) return Promise.resolve(`没有「${path}」这条记忆。`)
      if (page.forgottenAt) return Promise.resolve(`「${page.title}」已经忘了。`)
      rt.record({ kind: 'forget', path, why: cleanText(args?.why, 80) || null })
      return Promise.resolve(`忘了「${page.title}」。以后不会再想起它（原文仍留在事件流里）。`)
    },
  }))

  tools.push(defineTool({
    name: 'persona_reset',
    description: '重置：mood 只清当前心情，traits 清性格（回到全 0.5），all 连名字一起清（回到出生前）。不可逆，必须 confirm=true。',
    parameters: {
      scope: { type: 'string', required: true, description: 'mood / traits / all' },
      confirm: { type: 'boolean', required: true, description: '确认执行，必须为 true' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const scope = String(args?.scope ?? '')
      if (!['mood', 'traits', 'all'].includes(scope)) return Promise.resolve('scope 只能是 mood / traits / all。')
      if (args?.confirm !== true) return Promise.resolve('没有执行：confirm 必须显式传 true。')
      rt.record({ kind: 'reset', scope })
      return Promise.resolve(scope === 'all' ? '已重置到出生前，名字也清了。' : scope === 'traits' ? '性格已回到全 0.5，心情跟着回到基线。' : '心情已回到基线。')
    },
  }))

  tools.push(defineTool({
    name: 'persona_export',
    description: '导出当前人格为 markdown（给人看/备份），返回文件路径。',
    parameters: {},
    output: TEXT_OUTPUT,
    execute() {
      const { state } = rt.refresh()
      const text = rt.render(state)
      const path = rt.writeExport(text)
      return Promise.resolve(`已导出到 ${path}。\n\n${text}`)
    },
  }))

  for (const tool of tools) ctx.tools.register(tool)
  return tools
}
