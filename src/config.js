/**
 * 配置：默认值 + $DSH_HOME/leinao.json 覆盖。
 *
 * 刻意不用 schemastery：一个小插件只需要一个 JSON 文件，少一个运行时依赖。
 * 读取顺序：默认值 ← $DSH_HOME/leinao.json（或 DSH_LEINAO_CONFIG 指定） ← 行内 config。
 * 环境变量 DSH_LEINAO_DIR 可直接改数据目录（测试用）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 数据目录（git 仓库）：跨端同步的就是它 */
  dataDir: join(homedir(), '.leinao'),
  /** DSH home；留空自动取 $DSH_HOME 或 ~/.dsh */
  dshHome: '',
  /** 设备 id；留空自动生成并写入 $DSH_HOME/leinao/device.json */
  deviceId: '',
  journal: {
    git: true,
    push: false,
    remote: '',
    pullTimeoutMs: 20_000,
    commitDebounceMs: 5_000,
    pushDebounceMs: 60_000,
  },
  mood: {
    debounceMs: 2_000,
    halfLifeHours: 6,
  },
  prompt: {
    order: 130,
    maxChars: 1_200,
  },
  memory: {
    /** 强度减半天数 */
    halfLifeDays: 21,
    /** 索引：最多几行、总字数（每轮注入的记忆目录） */
    indexMaxLines: 3,
    indexMaxChars: 300,
    /** 强度 ≥ 此值常驻索引；低于 hideBelow 只能显式召回 */
    strongThreshold: 0.5,
    hideBelow: 0.2,
    /** 折叠建议：多久没召回、强度低到多少、同 tag 至少几条 */
    foldAfterDays: 30,
    foldBelowStrength: 0.4,
    foldMinGroup: 3,
    /** 每多少轮提一次整理建议、一次会话最多提几次 */
    foldEveryTurns: 30,
    foldMaxPrompts: 3,
    /** 注入命中后多久内不重复记 recall */
    weakRecallHours: 6,
  },
  /** 首次引导的默认值；正式使用应通过 persona_seed 写入 seed 事件 */
  seed: { name: '', gender: '', userCall: '' },
  /** 打开后把主要动作写进日志（排查用） */
  debug: false,
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 深合并 plain object；数组和标量直接覆盖 */
export function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    out[key] = isPlain(value) && isPlain(base[key]) ? mergeConfig(base[key], value) : value
  }
  return out
}

export function resolveDshHome(config = {}, env = process.env) {
  if (config.dshHome) return resolve(config.dshHome.replace(/^~(?=$|[\\\\/])/, homedir()))
  if (env.DSH_HOME) return resolve(env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** 配置文件位置：DSH_LEINAO_CONFIG 优先，否则 $DSH_HOME/leinao.json。设置页要用同一个路径。 */
export function configFilePath(config = {}, env = process.env) {
  const explicit = env.DSH_LEINAO_CONFIG
  if (explicit) return resolve(explicit)
  return join(resolveDshHome(config, env), 'leinao.json')
}

export function loadConfig(inline = {}, env = process.env) {
  const dshHome = resolveDshHome(inline, env)
  const file = configFilePath(inline, env)
  let fromFile = {}
  try {
    fromFile = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 配置坏了不应该让插件起不来：退回默认值，并在启动日志里留一条。
      console.warn(`[leinao] 读取 ${file} 失败，使用默认配置：${error.message}`)
    }
  }
  const merged = mergeConfig(mergeConfig(DEFAULT_CONFIG, fromFile), inline)
  merged.dshHome = dshHome
  if (env.DSH_LEINAO_DIR) merged.dataDir = env.DSH_LEINAO_DIR
  merged.dataDir = resolve(String(merged.dataDir).replace(/^~(?=$|[\\\\/])/, homedir()))
  /** 实际读到的配置文件；设置页写回同一处 */
  merged.configFile = file
  return merged
}
