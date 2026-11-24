import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inspectGit } from '../src/git.js'

test('inspectGit runs only read-only status/diff commands with an argument vector', async () => {
  const calls = []
  const run = async (args, options) => {
    calls.push({ args, options })
    if (args.includes('status')) return { ok: true, stdout: ' M src/a.js\n?? notes.md\n', stderr: '' }
    if (args.includes('--stat')) return { ok: true, stdout: ' src/a.js | 2 +-\n 1 file changed\n', stderr: '' }
    return { ok: true, stdout: 'diff --git a/src/a.js b/src/a.js\n+hello\n', stderr: '' }
  }

  const result = await inspectGit({ cwd: 'F:/repo', path: 'src/a.js', maxChars: 100, run })

  assert.equal(result.is_repo, true)
  assert.equal(result.status, ' M src/a.js\n?? notes.md')
  assert.match(result.diff_stat, /1 file changed/)
  assert.match(result.diff, /\+hello/)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].args, ['--no-optional-locks', 'status', '--short', '--untracked-files=normal'])
  assert.deepEqual(calls[1].args, ['--no-optional-locks', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD'])
  assert.deepEqual(calls[2].args, ['--no-optional-locks', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src/a.js'])
  assert.equal(calls[0].options.cwd, 'F:/repo')
})

test('inspectGit explains an empty single-file diff instead of silently returning nothing', async () => {
  const run = async (args) => {
    if (args.includes('status')) return { ok: true, stdout: '?? new-file.txt\\n', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }

  const result = await inspectGit({ cwd: 'F:/repo', path: 'new-file.txt', run })

  assert.equal(result.diff, '')
  assert.match(result.diff_note, /untracked or unchanged/)
  assert.match(result.diff_note, /status/)
})

test('inspectGit retries without HEAD only when HEAD is unborn', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args.includes('status')) return { ok: true, stdout: '', stderr: '' }
    if (args.includes('HEAD')) {
      return {
        ok: false,
        stdout: '',
        stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
        error: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
        code: 128,
      }
    }
    return { ok: true, stdout: ' staged.txt | 1 +\n', stderr: '' }
  }

  const result = await inspectGit({ cwd: 'F:/repo', run })

  assert.equal(result.diff_stat, ' staged.txt | 1 +')
  assert.equal(calls.length, 3)
  assert.equal(calls[1].includes('HEAD'), true)
  assert.equal(calls[2].includes('HEAD'), false)
})

test('inspectGit does not hide a non-unborn diff failure behind the fallback', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args.includes('status')) return { ok: true, stdout: '', stderr: '' }
    return {
      ok: false,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories)',
      error: 'fatal: not a git repository (or any of the parent directories)',
      code: 128,
    }
  }

  const result = await inspectGit({ cwd: 'F:/repo', run })

  assert.match(result.diff_stat_error, /not a git repository/)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].includes('HEAD'), true)
})

test('inspectGit truncates each section and reports the cut', async () => {
  const run = async (args) => {
    if (args.includes('status')) return { ok: true, stdout: '1234567890', stderr: '' }
    return { ok: true, stdout: 'abcdefghij', stderr: '' }
  }
  const result = await inspectGit({ cwd: 'F:/repo', maxChars: 5, run })
  assert.equal(result.status, '1234…')
  assert.equal(result.status_truncated, true)
  assert.equal(result.diff_stat, 'abcd…')
  assert.equal(result.diff_stat_truncated, true)
})

test('inspectGit reports a missing git or a non-repository without throwing', async () => {
  const missing = await inspectGit({
    cwd: 'F:/repo',
    run: async () => ({ ok: false, stdout: '', stderr: '', error: 'git executable was not found on PATH' }),
  })
  assert.equal(missing.is_repo, false)
  assert.equal(missing.git_available, false)
  assert.match(missing.error, /not found/)

  const broken = await inspectGit({
    cwd: 'F:/repo',
    run: async () => ({ ok: false, stdout: '', stderr: 'not a git repository', error: 'not a git repository' }),
  })
  assert.equal(broken.is_repo, false)
  assert.equal(broken.git_available, true)
})

test('inspectGit requires a session working directory', async () => {
  const result = await inspectGit({ cwd: '', run: async () => { throw new Error('must not run') } })
  assert.equal(result.is_repo, false)
  assert.match(result.error, /working directory/)
})
