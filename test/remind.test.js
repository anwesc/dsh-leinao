import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO, AUTO_KEYS, REMIND, SIGNALS, autoDraft, detectMemorySignal, hasSensitive, nudgeLine, shouldNudge } from '../src/remind.js'

const NOW = 1_800_000_000_000

test('remind: 识别「以后 / 偏好 / 边界 / 记住」四类信号', () => {
  assert.equal(detectMemorySignal('以后周末别排活').key, 'future-rule')
  assert.equal(detectMemorySignal('我不喜欢太长的回复').key, 'preference')
  assert.equal(detectMemorySignal('别再提醒我喝水了').key, 'boundary')
  assert.equal(detectMemorySignal('记住这个仓库叫 dsh-leinao').key, 'remember')
  assert.equal(detectMemorySignal('今天天气不错'), null)
  assert.equal(detectMemorySignal(''), null)
  assert.equal(SIGNALS.length, 4)
})

test('remind: 同类信号只提一次，冷却期不提', () => {
  const base = { signalKey: 'preference', now: NOW, config: {} }
  assert.equal(shouldNudge({ ...base, nudgedKeys: new Set(['preference']) }), false)
  assert.equal(shouldNudge({ ...base, lastNudgeAt: NOW - 5 * 60_000 }), false)
  assert.equal(shouldNudge({ ...base, lastNudgeAt: NOW - 31 * 60_000 }), true)
  // 换成另一类信号，不受冷却限制以外的影响
  assert.equal(shouldNudge({ ...base, signalKey: 'future-rule', nudgedKeys: new Set(['preference']) }), true)
})

test('remind: 最近写过记忆就不提；上限 0 表示不限', () => {
  const base = { signalKey: 'boundary', now: NOW, config: {} }
  assert.equal(shouldNudge({ ...base, lastWriteAt: NOW - 3_600_000 }), false)
  assert.equal(shouldNudge({ ...base, lastWriteAt: NOW - 25 * 3_600_000 }), true)
  assert.equal(shouldNudge({ ...base, config: { nudgeMaxPerSession: 2 }, count: 2 }), false)
  assert.equal(shouldNudge({ ...base, config: { nudgeMaxPerSession: 0 }, count: 99 }), true)
  assert.equal(shouldNudge({ ...base, config: { nudgeEnabled: false } }), false)
})

test('remind: 注入文案只给动作，不替模型判断', () => {
  const line = nudgeLine('你的偏好')
  assert.match(line, /persona_remember/)
  assert.match(line, /闲聊，不用记/)
  assert.ok(REMIND.cooldownMinutes >= 0)
})

test('remind: 自动草稿用原话当 value 和证据，置信度低', () => {
  const signal = detectMemorySignal('以后周末别给我排活')
  const draft = autoDraft(signal, '以后周末别给我排活，我周末要休息')
  assert.equal(draft.key, AUTO_KEYS['future-rule'])
  assert.equal(draft.value, '以后周末别给我排活，我周末要休息')
  assert.equal(draft.evidence, '以后周末别给我排活，我周末要休息')
  assert.equal(draft.confidence, AUTO.confidence)
  assert.ok(draft.confidence < 0.5, '自动草稿应当标成不太确定')

  const long = autoDraft(signal, '以后'.repeat(200))
  assert.ok(long.value.length <= AUTO.maxValueChars)
  assert.ok(long.evidence.length <= AUTO.maxEvidenceChars)
})

test('remind: 敏感信息不自动写进 journal', () => {
  assert.equal(hasSensitive('以后用 sk-abcdefgh12345678 这个 key'), true)
  assert.equal(hasSensitive('记住 password: hunter2'), true)
  assert.equal(hasSensitive('我身份证 110101199001011234'), true)
  assert.equal(hasSensitive('以后周末别给我排活'), false)

  const signal = detectMemorySignal('以后用 sk-abcdefgh12345678 这个 key')
  assert.equal(autoDraft(signal, '以后用 sk-abcdefgh12345678 这个 key'), null)
})
