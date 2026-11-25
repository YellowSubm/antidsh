import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, apply, inject, name } from '../src/index.js'
import { createTools } from '../src/tools/index.js'

test('the plugin declares the expected identity and injection', () => {
  assert.equal(name, 'dsh-antidsh-mcp')
  assert.deepEqual(inject, ['webServer', 'sessionController'])
})

test('createTools keeps the five advertised tools', () => {
  const tools = createTools({})
  assert.deepEqual(tools.map((tool) => tool.name), [
    'dsh_session',
    'dsh_send',
    'dsh_wait',
    'dsh_inspect',
    'dsh_control',
  ])
})

test('Config applies defaults for an empty config object', () => {
  const config = Config({})
  assert.equal(config.path, '/antidsh/mcp')
  assert.equal(config.token, '')
  assert.equal(config.autoToken, true)
  assert.equal(config.publishRuntimeFile, true)
  assert.equal(config.allowUnauthenticatedLoopback, false)
  assert.equal(config.defaultWaitMs, 0)
})

test('apply registers one anonymous exact route and logs readiness', () => {
  const routes = []
  const logs = []
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      getOrigin: () => 'http://127.0.0.1:3080',
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    effect(callback, label) {
      this.label = label
      return callback()
    },
    get() {
      return undefined
    },
  }

  apply(ctx, Config({ token: 'secret', path: 'antidsh/mcp/', publishRuntimeFile: false }))

  assert.equal(ctx.label, 'dsh-antidsh-mcp: /antidsh/mcp MCP route')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/antidsh/mcp')
  assert.equal(routes[0].auth, 'anonymous')
  assert.equal(typeof routes[0].handler, 'function')
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('http://127.0.0.1:3080/antidsh/mcp')))
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('Bearer authentication is required')))
})

test('apply auto-generates token and publishes runtime discovery file into DSH_HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-apply-'))
  const prevHome = process.env.DSH_HOME
  const prevToken = process.env.ANTIDSH_MCP_TOKEN
  const prevRuntime = process.env.ANTIDSH_RUNTIME_FILE
  process.env.DSH_HOME = dir
  delete process.env.ANTIDSH_MCP_TOKEN
  delete process.env.ANTIDSH_RUNTIME_FILE

  try {
    let unregistered = false
    let disposer = null
    const ctx = {
      webServer: {
        host: '127.0.0.1',
        getOrigin: () => 'http://127.0.0.1:45678',
        register() {
          return () => { unregistered = true }
        },
      },
      logger: { info() {}, warn() {}, error() {} },
      effect(callback) {
        disposer = callback()
        return disposer
      },
      get() {
        return undefined
      },
    }

    apply(ctx, Config({}))

    const tokenFile = join(dir, 'antidsh-token')
    const runtimeFile = join(dir, 'antidsh-runtime.json')
    assert.equal(existsSync(tokenFile), true)
    assert.equal(existsSync(runtimeFile), true)

    const persistedToken = readFileSync(tokenFile, 'utf8').trim()
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    assert.equal(runtime.url, 'http://127.0.0.1:45678/antidsh/mcp')
    assert.equal(runtime.token, persistedToken)
    assert.equal(runtime.auth, 'bearer')

    disposer()
    assert.equal(unregistered, true)
    assert.equal(existsSync(runtimeFile), false)
    assert.equal(existsSync(tokenFile), true)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevToken === undefined) delete process.env.ANTIDSH_MCP_TOKEN
    else process.env.ANTIDSH_MCP_TOKEN = prevToken
    if (prevRuntime === undefined) delete process.env.ANTIDSH_RUNTIME_FILE
    else process.env.ANTIDSH_RUNTIME_FILE = prevRuntime
    rmSync(dir, { recursive: true, force: true })
  }
})
