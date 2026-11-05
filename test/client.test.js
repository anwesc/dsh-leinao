/**
 * 客户端半侧冒烟：不渲染 React 树，只确认「模块能被宿主加载器接住，
 * 并正确注册 settings.section + 词典」。渲染逻辑靠 DSH 设置页实机验证。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

function loadModule() {
  let loaded = null
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client/client.js' })
  assert.ok(loaded, '应该调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-plugin-leinao')
  const mod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
  return mod
}

test('client: 工厂导出 name / inject / apply', () => {
  const mod = loadModule()
  assert.equal(mod.name, 'dsh-plugin-leinao')
  assert.deepEqual([...mod.inject], ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('client: 注册 settings.section 与中英词典', () => {
  const mod = loadModule()
  const effectFns = []
  const registrations = []
  const dictionaries = []
  const ctx = {
    effect(fn, label) {
      assert.match(label, /dictionaries/)
      effectFns.push(fn)
      return fn()
    },
    locale: {
      register(namespace, dict) {
        assert.equal(namespace, 'dsh-plugin-leinao')
        dictionaries.push(dict)
        return () => {}
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`
      },
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, 'settings.section')
        fn()
      },
      register(spec, render) {
        registrations.push({ spec, render })
        return () => {}
      },
    },
  }
  mod.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].zh.nav, '类脑 · 人格')
  assert.equal(dictionaries[0].en.nav, 'Leinao · Persona')

  assert.equal(registrations.length, 1)
  const { spec, render } = registrations[0]
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'dsh-plugin-leinao')
  assert.equal(spec.order, 70)
  assert.equal(spec.locale, 'dsh-plugin-leinao')
  assert.equal(spec.label(), 'dsh-plugin-leinao:nav')
  assert.equal(typeof render, 'function')
})
