import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitAll, createBackoff, ensureRepo, git, hasRemote, isRepo, sync } from '../src/git.js'

// 沙箱里有些环境禁止插件进程 spawn 子进程（EPERM）。那种情况下 git 相关断言没法验证，
// 明确 skip 而不是假装通过——真实运行时由 DSH 宿主进程执行，不受这层限制。
const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const SKIP = GIT_AVAILABLE ? false : '当前环境不允许 spawn git（EPERM）'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-git-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('git: ensureRepo 幂等，带 .gitattributes/.gitignore', { skip: SKIP }, () => {
  const { dir, cleanup } = tmp()
  try {
    const first = ensureRepo(dir)
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    assert.equal(isRepo(dir), true)
    assert.match(readFileSync(join(dir, '.gitattributes'), 'utf8'), /eol=lf/)
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(ignore, /state\.json/)
    assert.match(ignore, /view\//)

    const second = ensureRepo(dir)
    assert.equal(second.created, false)
  } finally {
    cleanup()
  }
})

test('git: commitAll 提交一次，没改动返回 nothing', { skip: SKIP }, () => {
  const { dir, cleanup } = tmp()
  try {
    ensureRepo(dir)
    writeFileSync(join(dir, 'x.jsonl'), '{"a":1}\n', { encoding: 'utf8', flag: 'w' })
    const first = commitAll(dir, 'leinao: test')
    assert.equal(first.ok, true)
    assert.equal(first.code, 'committed')

    const second = commitAll(dir, 'leinao: again')
    assert.equal(second.ok, true)
    assert.equal(second.code, 'nothing')
  } finally {
    cleanup()
  }
})

test('git: 没有远端时 sync 直接成功且不联网', { skip: SKIP }, () => {
  const { dir, cleanup } = tmp()
  try {
    ensureRepo(dir)
    assert.equal(hasRemote(dir), false)
    const res = sync(dir)
    assert.equal(res.ok, true)
    assert.equal(res.pulled, false)
  } finally {
    cleanup()
  }
})

test('git: 命令失败返回结构化错误而不是抛异常', { skip: SKIP }, () => {
  const { dir, cleanup } = tmp()
  try {
    const res = git(dir, ['definitely-not-a-command'])
    assert.equal(res.ok, false)
    assert.ok(res.code !== 0)
  } finally {
    cleanup()
  }
})

test('backoff: 失败后窗口内不再重试，reset 后恢复', () => {
  const backoff = createBackoff(60_000)
  assert.equal(backoff.ready(0), true)
  backoff.fail('boom', 0)
  assert.equal(backoff.ready(30_000), false)
  assert.equal(backoff.ready(60_001), true)
  backoff.reset()
  assert.equal(backoff.ready(0), true)
  assert.equal(backoff.lastError, '')
})
