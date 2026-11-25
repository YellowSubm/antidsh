import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  loadOrCreateAutoToken,
  publishRuntimeDiscovery,
  resolveDshHome,
  runtimeFilePath,
  tokenFilePath,
} from '../src/runtime.js'

test('resolveDshHome prefers DSH_HOME over the user home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '  /custom/dsh  ' }), '/custom/dsh')
  assert.ok(tokenFilePath({ DSH_HOME: '/custom/dsh' }).endsWith('antidsh-token'))
  assert.ok(runtimeFilePath({ DSH_HOME: '/custom/dsh' }).endsWith('antidsh-runtime.json'))
  assert.equal(runtimeFilePath({ ANTIDSH_RUNTIME_FILE: '/override/rt.json', DSH_HOME: '/custom/dsh' }), '/override/rt.json')
})

test('loadOrCreateAutoToken generates once and reuses the persisted token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-rt-'))
  try {
    const file = join(dir, 'antidsh-token')
    const first = loadOrCreateAutoToken({ filePath: file })
    assert.equal(first.created, true)
    assert.ok(first.token.length >= 32)
    assert.equal(readFileSync(file, 'utf8').trim(), first.token)

    const second = loadOrCreateAutoToken({ filePath: file })
    assert.equal(second.created, false)
    assert.equal(second.token, first.token)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishRuntimeDiscovery writes discovery JSON and only removes its own record on dispose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-rt-'))
  try {
    const file = join(dir, 'antidsh-runtime.json')
    const published = publishRuntimeDiscovery({
      origin: 'http://127.0.0.1:41234',
      path: '/antidsh/mcp',
      token: 'auto-secret',
      auth: 'bearer',
      pid: 1111,
      filePath: file,
    })

    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.url, 'http://127.0.0.1:41234/antidsh/mcp')
    assert.equal(saved.token, 'auto-secret')
    assert.equal(saved.pid, 1111)

    // A newer instance overwriting the file must not be removed by the older disposer.
    writeFileSync(file, JSON.stringify({ version: 1, url: 'http://127.0.0.1:52000/antidsh/mcp', pid: 2222 }), 'utf8')
    published.dispose()
    assert.equal(existsSync(file), true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 2222)

    // Disposing the owning record removes it cleanly.
    const owned = publishRuntimeDiscovery({
      origin: 'http://127.0.0.1:52000',
      path: '/antidsh/mcp',
      token: 'auto-secret-2',
      auth: 'bearer',
      pid: 2222,
      filePath: file,
    })
    owned.dispose()
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
