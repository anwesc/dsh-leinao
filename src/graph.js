/**
 * 记忆图谱的数据整形：从重放后的状态里挑出「值得画」的页和它们之间的关系。
 *
 * 只做数据、不做布局——浏览器那半侧拿不到本地模块，球面坐标和投影都在
 * client.js 里内联实现（和 dsh-plugin-memory 的做法一致）。这里保证的只有：
 * 同样的状态，永远得到同样的节点顺序和边，前端画出来的图才稳定。
 */
import { isVisible, strengthOf, subjectOf } from './memory.js'

export const GRAPH = { maxNodes: 150 }

const clip = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/**
 * @param {object} state 重放后的状态
 * @param {number} [nowMs]
 * @param {{ memory?: object, maxNodes?: number }} [options]
 * @returns {{ nodes: object[], edges: object[], stats: object }}
 */
export function buildGraph(state, nowMs = Date.now(), options = {}) {
  const memory = options.memory ?? {}
  const maxNodes = Math.max(1, Number(options.maxNodes ?? GRAPH.maxNodes))
  const all = Object.values(state?.pages ?? {}).filter((page) => isVisible(page))

  const ranked = all
    .map((page) => ({ page, strength: strengthOf(page, nowMs, memory) }))
    .sort((a, b) => {
      const byStrength = b.strength - a.strength
      if (Math.abs(byStrength) > 1e-9) return byStrength
      return String(a.page.path).localeCompare(String(b.page.path))
    })
    .slice(0, maxNodes)

  const nodes = ranked.map(({ page, strength }) => ({
    id: page.path,
    title: clip(page.title || page.path, 60),
    subject: subjectOf(page),
    strength: Math.round(strength * 1000) / 1000,
    tags: Array.isArray(page.tags) ? page.tags.slice(0, 6) : [],
    gist: clip(page.gist ?? '', 160),
    updatedAt: page.updatedAt ?? page.at ?? null,
    degree: 0,
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const seen = new Set()
  const edges = []
  for (const { page } of ranked) {
    const links = Array.isArray(page.links) ? page.links : []
    for (const link of links) {
      if (!byId.has(link) || link === page.path) continue
      const key = page.path < link ? `${page.path}\u0000${link}` : `${link}\u0000${page.path}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: page.path, target: link, kind: 'link' })
      byId.get(page.path).degree += 1
      byId.get(link).degree += 1
    }
  }

  return {
    nodes,
    edges,
    stats: {
      pages: all.length,
      shown: nodes.length,
      links: edges.length,
      isolated: nodes.filter((node) => node.degree === 0).length,
    },
  }
}
