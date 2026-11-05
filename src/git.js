/**
 * git：数据仓库的读写。四条底线（方案 v3 §7）：
 *   1. 绝不交互——GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo + ssh BatchMode；
 *   2. 离线可写——先 local commit，pull/push 失败只记日志、退避重试，不阻塞对话；
 *   3. 冲突不猜——pull --rebase 失败就 abort，保留本地，交给人处理，绝不 force；
 *   4. 强制 LF——.gitattributes + core.autocrlf=false，避免 Windows 上每行都变脏。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GITATTRIBUTES = [
  '* text=auto eol=lf',
  '*.jsonl text eol=lf',
  '*.md text eol=lf',
  '',
].join('\n')

/**
 * 派生文件不入库：state.json 和 view/ 都能从 journal 重放出来，
 * 提交它们只会制造无意义的冲突。
 */
const GITIGNORE = [
  '# 派生缓存，可从 journal 重放',
  'state.json',
  'view/',
  '*.tmp',
  '',
].join('\n')

const BACKOFF_MS = 10 * 60 * 1000

export function gitEnv(extra = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GIT_AUTHOR_NAME: 'persona',
    GIT_AUTHOR_EMAIL: 'persona@localhost',
    GIT_COMMITTER_NAME: 'persona',
    GIT_COMMITTER_EMAIL: 'persona@localhost',
    ...extra,
  }
}

export function git(dataDir, args, opts = {}) {
  try {
    const stdout = execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args], {
      cwd: dataDir,
      env: gitEnv(opts.env),
      encoding: 'utf8',
      timeout: opts.timeout ?? 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: String(stdout ?? '').trim(), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === 'number' ? error.status : -1,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message ?? '').trim(),
    }
  }
}

export function isRepo(dataDir) {
  return existsSync(join(dataDir, '.git'))
}

/** 幂等初始化：没有 .git 就建，写 .gitattributes，关掉 autocrlf */
export function ensureRepo(dataDir, { remote } = {}) {
  const created = !isRepo(dataDir)
  if (created) {
    const init = git(dataDir, ['init', '-b', 'main'])
    if (!init.ok) return { ok: false, created, error: init.stderr || 'git init 失败' }
  }
  const attrs = join(dataDir, '.gitattributes')
  if (!existsSync(attrs)) writeFileSync(attrs, GITATTRIBUTES, 'utf8')
  const ignore = join(dataDir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE, 'utf8')
  git(dataDir, ['config', 'core.autocrlf', 'false'])
  git(dataDir, ['config', 'core.safecrlf', 'false'])
  if (remote) {
    const current = git(dataDir, ['remote', 'get-url', 'origin'])
    if (!current.ok) {
      git(dataDir, ['remote', 'add', 'origin', remote])
    } else if (current.stdout !== remote) {
      git(dataDir, ['remote', 'set-url', 'origin', remote])
    }
  }
  return { ok: true, created }
}

export function status(dataDir) {
  const res = git(dataDir, ['status', '--porcelain'])
  if (!res.ok) return { ok: false, dirty: false, lines: [], error: res.stderr }
  const lines = res.stdout.split('\n').filter(Boolean)
  return { ok: true, dirty: lines.length > 0, lines }
}

/** 本地提交。没有改动不算失败。 */
export function commitAll(dataDir, message) {
  if (!isRepo(dataDir)) return { ok: false, code: 'no-repo', message: '还不是 git 仓库' }
  const add = git(dataDir, ['add', '-A'])
  if (!add.ok) return { ok: false, code: 'add-failed', message: add.stderr }
  const st = status(dataDir)
  if (st.ok && !st.dirty) return { ok: true, code: 'nothing', message: '没有改动' }
  const res = git(dataDir, ['commit', '-m', message, '--no-verify'])
  if (!res.ok) {
    if (/nothing to commit|no changes added/i.test(`${res.stdout}\n${res.stderr}`)) {
      return { ok: true, code: 'nothing', message: '没有改动' }
    }
    return { ok: false, code: 'commit-failed', message: res.stderr || res.stdout }
  }
  return { ok: true, code: 'committed', message: res.stdout.split('\n')[0] ?? '' }
}

export function hasRemote(dataDir) {
  const res = git(dataDir, ['remote'])
  return res.ok && res.stdout.split('\n').includes('origin')
}

/**
 * 远端同步。返回结构化结果，调用方决定怎么记日志——不在这里抛。
 * @returns {{ok:boolean, pulled:boolean, pushed:boolean, conflict?:boolean, message:string}}
 */
export function sync(dataDir, { push = true, timeout = 30000 } = {}) {
  if (!hasRemote(dataDir)) return { ok: true, pulled: false, pushed: false, message: '没有远端，只做本地提交' }

  const pull = git(dataDir, ['pull', '--rebase', '--autostash', 'origin', 'main'], { timeout })
  if (!pull.ok) {
    const rebase = git(dataDir, ['rebase', '--abort'])
    void rebase
    return { ok: false, pulled: false, pushed: false, conflict: true, message: `pull --rebase 失败，已 abort 保留本地：${pull.stderr || pull.stdout}` }
  }

  if (!push) return { ok: true, pulled: true, pushed: false, message: '已拉取，未推送' }
  const pushed = git(dataDir, ['push', 'origin', 'main'], { timeout })
  if (!pushed.ok) {
    return { ok: false, pulled: true, pushed: false, conflict: false, message: `push 失败（本地已提交，稍后重试）：${pushed.stderr || pushed.stdout}` }
  }
  return { ok: true, pulled: true, pushed: true, message: '已同步' }
}

/**
 * 退避器：远端失败后 10 分钟内不再碰网络，避免每轮对话都卡一次超时。
 * 状态只存内存——进程重启重试一次是合理的。
 */
export function createBackoff(windowMs = BACKOFF_MS) {
  let nextAt = 0
  let lastError = ''
  return {
    ready(now = Date.now()) {
      return now >= nextAt
    },
    fail(message, now = Date.now()) {
      nextAt = now + windowMs
      lastError = message
    },
    reset() {
      nextAt = 0
      lastError = ''
    },
    get lastError() {
      return lastError
    },
  }
}
