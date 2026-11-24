/**
 * Read-only git inspection for `dsh_inspect(view="diff")`.
 *
 * Every invocation uses `child_process.execFile('git', [...])` with an
 * argument vector: no shell string is ever built, so a repository path or a
 * session working directory can never become shell syntax. The commands are
 * limited to status and diff and opt out of external diff drivers, textconv
 * filters, pagers, and optional locks, so inspecting a session never mutates
 * its worktree.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { clip } from './format.js'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 8_000
const GIT_MAX_BUFFER_BYTES = 1024 * 1024
const DIFF_BASE = ['--no-optional-locks', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv']

/**
 * @typedef {object} GitRunOptions
 * @property {string} cwd
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} GitRunResult
 * @property {boolean} ok
 * @property {string} stdout
 * @property {string} stderr
 * @property {number | null} [code]
 * @property {string} [error]
 */

/**
 * @param {readonly string[]} args
 * @param {GitRunOptions} options
 * @returns {Promise<GitRunResult>}
 */
async function defaultRunGit(args, options) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (error) {
    if (options.signal?.aborted === true || error?.name === 'AbortError') throw error
    const code = typeof error?.code === 'number' ? error.code : null
    const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
    const notFound = error?.code === 'ENOENT'
    return {
      ok: false,
      stdout: '',
      stderr,
      code,
      error: notFound
        ? 'git executable was not found on PATH'
        : (stderr.trim() || (typeof error?.message === 'string' ? error.message : 'git command failed')),
    }
  }
}

/**
 * `git diff HEAD` fails with an "unborn HEAD" error when the repository has no
 * commits yet. Only that case falls back to the index/worktree diff; any other
 * failure (not a repository, bad revision, permission) is returned as-is.
 *
 * @param {GitRunResult} result
 * @returns {boolean}
 */
function isUnbornHead(result) {
  const text = `${result.error ?? ''}\n${result.stderr ?? ''}`.toLowerCase()
  return /unknown revision|ambiguous argument ['"]?head|not a valid object name|bad revision|does not have any commits yet|needed a single revision/.test(text)
}

/**
 * Prefer `git diff HEAD` so staged changes are visible. Insert `HEAD` before
 * the optional `-- <path>` suffix, and retry without it only for an unborn HEAD.
 *
 * @param {(args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>} run
 * @param {readonly string[]} prefix
 * @param {readonly string[]} suffix
 * @param {GitRunOptions} options
 * @returns {Promise<GitRunResult>}
 */
async function runDiffWithHead(run, prefix, suffix, options) {
  const withHead = await run([...prefix, 'HEAD', ...suffix], options)
  if (withHead.ok || !isUnbornHead(withHead)) return withHead
  return run([...prefix, ...suffix], options)
}

/**
 * @param {{
 *   cwd: string,
 *   path?: string,
 *   maxChars?: number,
 *   signal?: AbortSignal,
 *   run?: (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>,
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function inspectGit(options) {
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 6000
  const run = options.run ?? defaultRunGit
  const cwd = options.cwd

  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { cwd: null, is_repo: false, error: 'the session has no working directory' }
  }

  const status = await run(['--no-optional-locks', 'status', '--short', '--untracked-files=normal'], {
    cwd,
    signal: options.signal,
  })
  if (!status.ok) {
    return {
      cwd,
      is_repo: false,
      git_available: !String(status.error ?? '').includes('not found'),
      error: clip(status.error ?? 'git status failed', 500),
    }
  }

  const stat = await runDiffWithHead(
    run,
    [...DIFF_BASE, '--stat'],
    [],
    { cwd, signal: options.signal },
  )

  const statusText = truncateSection(status.stdout.trimEnd(), maxChars)
  const statText = stat.ok
    ? truncateSection(stat.stdout.trimEnd(), maxChars)
    : { text: '', truncated: false, error: clip(stat.error ?? 'git diff --stat failed', 500) }

  /** @type {Record<string, unknown>} */
  const result = {
    cwd,
    is_repo: true,
    status: statusText.text,
    status_truncated: statusText.truncated,
    diff_stat: statText.text,
    diff_stat_truncated: statText.truncated,
  }
  if (statText.error !== undefined) result.diff_stat_error = statText.error

  if (options.path !== undefined) {
    const diff = await runDiffWithHead(
      run,
      DIFF_BASE,
      ['--', options.path],
      { cwd, signal: options.signal },
    )
    result.path = options.path
    if (diff.ok) {
      const diffText = truncateSection(diff.stdout.trimEnd(), maxChars)
      result.diff = diffText.text
      result.diff_truncated = diffText.truncated
      if (diffText.text.length === 0) {
        result.diff_note =
          'No diff for this path against HEAD. It may be untracked or unchanged; this diff includes staged and unstaged changes, so check `status` above.'
      }
    } else {
      result.diff = ''
      result.diff_truncated = false
      result.diff_error = clip(diff.error ?? 'git diff failed', 500)
    }
  }

  return result
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateSection(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  return { text: clip(text, maxChars), truncated: Array.from(text).length > maxChars }
}

export { GIT_MAX_BUFFER_BYTES, GIT_TIMEOUT_MS }
