import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, apply, inject, name } from '../src/index.js'

test('the plugin declares the expected identity and injection', () => {
  assert.equal(name, 'dsh-antidsh-mcp')
  assert.deepEqual(inject, ['webServer', 'sessionController'])
})

test('Config applies defaults for an empty config object', () => {
  const config = Config({})
  assert.equal(config.path, '/antidsh/mcp')
  assert.equal(config.token, '')
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
  }

  apply(ctx, Config({ token: 'secret', path: 'antidsh/mcp/' }))

  assert.equal(ctx.label, 'dsh-antidsh-mcp: /antidsh/mcp MCP route')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/antidsh/mcp')
  assert.equal(routes[0].auth, 'anonymous')
  assert.equal(typeof routes[0].handler, 'function')
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('http://127.0.0.1:3080/antidsh/mcp')))
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('Bearer authentication is required')))
})
