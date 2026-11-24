import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bearerToken,
  hostnameOf,
  isCrossSiteRequest,
  isLoopbackHostname,
  isLoopbackPeer,
  isTrustedHost,
  isTrustedOrigin,
  resolveToken,
  secureEquals,
} from '../src/security.js'

test('hostnameOf extracts authorities from Host headers', () => {
  assert.equal(hostnameOf('127.0.0.1:3080'), '127.0.0.1')
  assert.equal(hostnameOf('LOCALHOST:3080'), 'localhost')
  assert.equal(hostnameOf('[::1]:3080'), '[::1]')
  assert.equal(hostnameOf('example.test'), 'example.test')
  assert.equal(hostnameOf(''), null)
  assert.equal(hostnameOf(undefined), null)
  assert.equal(hostnameOf(':'), null)
})

test('isLoopbackHostname accepts only loopback literals', () => {
  for (const value of ['localhost', '127.0.0.1', '127.42.0.7', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHostname(value), true, value)
  }
  for (const value of ['example.test', 'localhost.example.test', '10.0.0.1', '::2', '128.0.0.1', '']) {
    assert.equal(isLoopbackHostname(value), false, value)
  }
})

test('isTrustedHost requires a loopback or configured listener authority', () => {
  assert.equal(isTrustedHost({ headers: { host: '127.0.0.1:3080' } }), true)
  assert.equal(isTrustedHost({ headers: { host: 'rebind.example:3080' } }), false)
  assert.equal(isTrustedHost({ headers: {} }), false)
  assert.equal(isTrustedHost({ headers: { host: 'rebind.example:3080' } }, ['rebind.example']), true)
  assert.equal(isTrustedHost({ headers: { host: '[::1]:3080' } }, []), true)
})

test('isLoopbackPeer recognizes socket addresses', () => {
  assert.equal(isLoopbackPeer({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackPeer({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackPeer({ headers: {}, socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackPeer({ headers: {}, socket: { remoteAddress: '192.168.1.4' } }), false)
  assert.equal(isLoopbackPeer({ headers: {} }), false)
})

test('isTrustedOrigin allows native clients and loopback origins only', () => {
  assert.equal(isTrustedOrigin({ headers: {} }), true)
  assert.equal(isTrustedOrigin({ headers: { origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(isTrustedOrigin({ headers: { origin: 'http://localhost:3080' } }), true)
  assert.equal(isTrustedOrigin({ headers: { origin: 'https://[::1]:3080' } }), true)
  assert.equal(isTrustedOrigin({ headers: { origin: 'http://evil.example' } }), false)
  assert.equal(isTrustedOrigin({ headers: { origin: 'null' } }), false)
  assert.equal(isTrustedOrigin({ headers: { origin: 'file:///tmp/x' } }), false)
  assert.equal(isTrustedOrigin({ headers: { origin: 'not a url' } }), false)
})

test('isCrossSiteRequest only flags the explicit cross-site value', () => {
  assert.equal(isCrossSiteRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), true)
  assert.equal(isCrossSiteRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), false)
  assert.equal(isCrossSiteRequest({ headers: {} }), false)
})

test('resolveToken prefers config, then environment, then null', () => {
  assert.equal(resolveToken(' config-token ', 'env-token'), 'config-token')
  assert.equal(resolveToken('', 'env-token'), 'env-token')
  assert.equal(resolveToken('   ', '  '), null)
  assert.equal(resolveToken(undefined, undefined), null)
})

test('bearerToken parses the Authorization header strictly', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer secret' } }), 'secret')
  assert.equal(bearerToken({ headers: { authorization: 'bearer   secret  ' } }), 'secret')
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), '')
  assert.equal(bearerToken({ headers: { authorization: 'Bearer' } }), '')
  assert.equal(bearerToken({ headers: {} }), '')
})

test('secureEquals accepts only the exact token', () => {
  assert.equal(secureEquals('secret', 'secret'), true)
  assert.equal(secureEquals('secreT', 'secret'), false)
  assert.equal(secureEquals('', 'secret'), false)
  assert.equal(secureEquals(undefined, 'secret'), false)
  assert.equal(secureEquals('secret', 'secret '), false)
})
