import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * client/client.js 是给宿主模块加载器用的 CJS 工厂（`window.__ModuleLoader__.load`），
 * 不能 import 本地模块。这里用最小的 window + React 桩把它跑起来，
 * 只测工厂导出、slot 注册和纯函数（布局 / 投影 / 飞行角度 / 搜索匹配）。
 */
function loadClient({ react } = {}) {
  const source = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  let captured = null
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    devicePixelRatio: 1,
  }
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const stub = react ?? {
    createElement,
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
  }
  const require = (name) => {
    if (name === 'react') return stub
    throw new Error(`unexpected require: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  assert.ok(captured, 'window.__ModuleLoader__.load 必须被调用')
  return captured.factory(require)
}

test('client: 导出 name/inject，并注册设置页与会话 chip 两个 slot', () => {
  const client = loadClient()
  assert.equal(client.name, 'dsh-plugin-leinao')
  assert.deepEqual(client.inject, ['slots', 'locale'])

  const slots = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(meta, component) {
        slots.push({ ...meta, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  const settings = slots.find((slot) => slot.name === 'settings.section')
  assert.ok(settings, '必须注册设置页卡片')
  assert.equal(settings.id, 'dsh-plugin-leinao')
  assert.equal(settings.order, 70)
  assert.equal(typeof settings.component, 'function')

  const chip = slots.find((slot) => slot.name === 'conversation.input.left')
  assert.ok(chip, '必须注册会话内开关')
  assert.equal(chip.id, 'dsh-plugin-leinao-session-toggle')
  assert.equal(chip.order, 100)
})

test('client: 设置菜单按改动频次排，日志放最后', () => {
  const { groupOrder } = loadClient().__test
  assert.deepEqual(groupOrder(), ['basic', 'prompt', 'recall', 'proactive', 'index', 'fold', 'mood', 'journal'])
})

test('client: rowMatches 只匹配标签/键名/说明，忽略大小写', () => {
  const { rowMatches } = loadClient().__test
  const row = { key: 'prompt.maxChars', label: '注入上限', hint: 'Character budget' }

  assert.equal(rowMatches(row, ''), true)
  assert.equal(rowMatches(row, 'maxchars'), true)
  assert.equal(rowMatches(row, '注入'), true)
  assert.equal(rowMatches(row, 'budget'), true)
  assert.equal(rowMatches(row, '不存在'), false)
  assert.equal(rowMatches({ label: '无提示' }, 'prompt'), false)
})

test('client: layoutNodes 按标签聚类、纬度带分布、每个点落在单位球上', () => {
  const { layoutNodes } = loadClient().__test
  const nodes = [
    { id: 'a', tags: ['工作', '约定'], subject: 'self' },
    { id: 'b', tags: ['工作'], subject: 'self' },
    { id: 'c', tags: ['工作'], subject: 'self' },
    { id: 'd', tags: [], subject: 'user' },
  ]
  const points = layoutNodes(nodes)

  assert.equal(points.length, 4)
  assert.deepEqual(points.map((point) => point.node.id).sort(), ['a', 'b', 'c', 'd'])
  for (const point of points) {
    assert.ok(Math.abs(point.x * point.x + point.y * point.y + point.z * point.z - 1) < 1e-9, '必须落在单位球上')
    assert.ok(point.y >= -1 && point.y <= 1)
  }
  // 三个人都归到「工作」，一个人落到 subject:user 带
  assert.deepEqual(
    [...new Set(points.map((point) => point.band))].sort(),
    ['subject:user', '工作'],
  )
  assert.equal(points.filter((point) => point.band === '工作').length, 3)
  // 同一份输入必须给同一份布局（画布每帧重算也不会跳）
  assert.deepEqual(layoutNodes(nodes), points)
  assert.deepEqual(layoutNodes([]), [])
})

test('client: layoutNodes 标签并列时取字典序小的', () => {
  const { layoutNodes } = loadClient().__test
  const points = layoutNodes([
    { id: 'one', tags: ['b', 'a'], subject: 'self' },
    { id: 'two', tags: ['a'], subject: 'self' },
  ])
  assert.deepEqual([...new Set(points.map((point) => point.band))], ['a'])
})

test('client: projectPoint 中心对齐、近大远小、缩放按倍率', () => {
  const { projectPoint } = loadClient().__test
  const width = 520
  const height = 340
  const view = { yaw: 0, pitch: 0, zoom: 1 }

  const center = projectPoint({ node: { id: 'c' }, x: 0, y: 0, z: 0 }, view, width, height)
  assert.equal(center.x, width / 2)
  assert.equal(center.y, height / 2)

  const front = projectPoint({ node: { id: 'f' }, x: 0, y: 0, z: -1 }, view, width, height)
  const back = projectPoint({ node: { id: 'b' }, x: 0, y: 0, z: 1 }, view, width, height)
  assert.ok(front.scale > back.scale, '前面的点看起来更大')
  assert.ok(front.z < back.z, 'z 保留深度用于排序')

  const zoomed = projectPoint({ node: { id: 'z' }, x: 0.5, y: 0, z: 0 }, { ...view, zoom: 2 }, width, height)
  const plain = projectPoint({ node: { id: 'z' }, x: 0.5, y: 0, z: 0 }, view, width, height)
  assert.ok(Math.abs((zoomed.x - width / 2) - (plain.x - width / 2) * 2) < 1e-6)
})

test('client: flyAngles 把节点转到正对镜头', () => {
  const { flyAngles } = loadClient().__test
  const near = (a, b) => Math.abs(a - b) < 1e-9

  assert.ok(near(flyAngles({ x: 0, y: 0, z: 1 }).yaw, 0))
  assert.ok(near(flyAngles({ x: 1, y: 0, z: 0 }).yaw, Math.PI / 2))
  assert.ok(near(flyAngles({ x: 0, y: -1, z: 0 }).pitch, Math.PI / 2))
  assert.ok(near(flyAngles({ x: 0, y: 1, z: 0 }).pitch, -Math.PI / 2))
})
