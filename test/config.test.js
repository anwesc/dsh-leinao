/**
 * 配置读取：leinao.json 覆盖默认值、环境变量换路径、dataDir 展开。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { loadConfig } from '../src/config.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'leinao-config-'))

test('config: 读 $DSH_HOME/leinao.json 并记住实际文件', () => {
  const home = tempHome()
  writeFileSync(join(home, 'leinao.json'), JSON.stringify({ debug: true, mood: { halfLifeHours: 3 } }), 'utf8')

  const cfg = loadConfig({}, { DSH_HOME: home })

  assert.equal(cfg.configFile, join(home, 'leinao.json'))
  assert.equal(cfg.debug, true)
  assert.equal(cfg.mood.halfLifeHours, 3)
  // 没写的键仍然是默认值
  assert.equal(cfg.mood.debounceMs, 2000)
})

test('config: DSH_LEINAO_CONFIG 指定配置文件路径', () => {
  const home = tempHome()
  const file = join(home, 'custom.json')
  writeFileSync(file, JSON.stringify({ prompt: { maxChars: 500 } }), 'utf8')

  const cfg = loadConfig({}, { DSH_HOME: home, DSH_LEINAO_CONFIG: file })

  assert.equal(cfg.configFile, resolve(file))
  assert.equal(cfg.prompt.maxChars, 500)
})

test('config: 行内配置覆盖文件，dataDir 默认 ~/.leinao 且展开 ~', () => {
  const home = tempHome()
  writeFileSync(join(home, 'leinao.json'), JSON.stringify({ prompt: { maxChars: 500 } }), 'utf8')

  const cfg = loadConfig({ prompt: { maxChars: 900 }, dataDir: '~/Custom' }, { DSH_HOME: home })

  assert.equal(cfg.prompt.maxChars, 900)
  assert.equal(cfg.dataDir, join(homedir(), 'Custom'))
  assert.equal(loadConfig({}, { DSH_HOME: home }).dataDir, join(homedir(), '.leinao'))
})

test('config: DSH_LEINAO_DIR 覆盖数据目录', () => {
  const home = tempHome()
  const cfg = loadConfig({}, { DSH_HOME: home, DSH_LEINAO_DIR: home })
  assert.equal(cfg.dataDir, resolve(home))
})
