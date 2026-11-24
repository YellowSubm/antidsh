import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createInspectTool } from '../src/tools/inspect.js'
import { createControlTool } from '../src/tools/control.js'

function record(type, seq, data) {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000 + seq, data } }
}

function assistant(seq, text, usage) {
  return record('assistant/message', seq, {
    turn: 1,
    step: seq,
    message: { content: [{ type: 'text', text }] },
    usage,
  })
}

function makeInspectController(overrides = {}) {
  const calls = []
  const controller = {
    async state(request, signal) {
      calls.push(['state', request, signal])
      return overrides.state ?? {
        cursor: 4,
        active: true,
        running: true,
        queue: [{ id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'queued prompt' }] }],
        pendingInput: ['approval'],
      }
    },
    async events(request, signal) {
      calls.push(['events', request, signal])
      return overrides.events ?? {
        cursor: 4,
        hasMore: true,
        records: [
          record('user/message', 1, { message: { content: [{ type: 'text', text: 'build it' }] } }),
          assistant(2, 'working', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }),
          record('tool/call', 3, { turn: 1, step: 3, callId: 'c1', name: 'shell', arguments: { command: 'ls' } }),
          assistant(4, 'done', { inputTokens: 0, outputTokens: 3, cacheReadTokens: 30 }),
        ],
      }
    },
    async projections(request, signal) {
      calls.push(['projections', request, signal])
      return overrides.projections ?? {
        kind: 'sequenced',
        asOfSeq: 4,
        values: {
          title: 'Demo session',
          modelSelection: { lastUsed: { provider: 'deepseek', model: 'chat' } },
        },
      }
    },
    async list(request, signal) {
      calls.push(['list', request, signal])
      return overrides.list ?? { items: [{ sessionId: 's1', cwd: 'F:/repo' }] }
    },
  }
  return { controller, calls }
}

test('dsh_inspect summary combines state, model, steps, queue, and recent usage', async () => {
  const { controller, calls } = makeInspectController()
  const tool = createInspectTool(controller)
  const signal = new AbortController().signal
  const result = await tool.handler({ session_id: 's1' }, { signal })

  assert.equal(result.view, 'summary')
  assert.equal(result.title, 'Demo session')
  assert.deepEqual(result.model, { provider: 'deepseek', model: 'chat' })
  assert.equal(result.cursor, 4)
  assert.equal(result.running, true)
  assert.equal(result.queue_length, 1)
  assert.equal(result.queue[0].item_id, 'q1')
  assert.equal(result.queue[0].preview, 'queued prompt')
  assert.equal(result.pending_input[0], 'approval')
  assert.equal(result.usage.cache_hit_rate, 0.75)
  assert.equal(result.usage.scope, 'recent')
  assert.equal(result.events.scanned, 4)
  assert.ok(result.recent_steps.some((step) => step.type === 'tool_call'))
  for (const call of calls) assert.equal(call[2], signal)
})

test('dsh_inspect events pages with before/through/limit and exposes next_before_seq', async () => {
  const long = 'x'.repeat(500)
  const { controller, calls } = makeInspectController({
    events: {
      cursor: 20,
      hasMore: true,
      records: [
        record('tool/result', 19, {
          message: { content: [{ type: 'text', text: long }], toolCallId: 'c1', isError: false },
        }),
        record('assistant/message', 20, { message: { content: [{ type: 'text', text: 'ok' }] } }),
      ],
    },
  })
  const tool = createInspectTool(controller)
  const result = await tool.handler({
    session_id: 's1',
    view: 'events',
    before_seq: 30,
    through_seq: 25,
    limit: 2,
    max_chars: 200,
  })

  assert.deepEqual(calls[0][1], {
    address: { kind: 'session', sessionId: 's1' },
    maxMessages: 2,
    beforeSeq: 30,
    throughSeq: 25,
  })
  assert.equal(result.count, 2)
  assert.equal(result.cursor, 20)
  assert.equal(result.has_more, true)
  assert.equal(result.next_before_seq, 19)
  assert.ok(result.next_before_seq < result.cursor)
  assert.equal(result.events[0].text_truncated, true)
})

test('dsh_inspect diff resolves cwd from list and uses the read-only inspector', async () => {
  const { controller, calls } = makeInspectController()
  let inspected = null
  const tool = createInspectTool(controller, {
    async inspectGit(options) {
      inspected = options
      return { cwd: options.cwd, is_repo: true, status: ' M a.js', diff_stat: '1 file changed' }
    },
  })
  const result = await tool.handler({ session_id: 's1', view: 'diff', path: 'src/a.js' })

  assert.equal(inspected.cwd, 'F:/repo')
  assert.equal(inspected.path, 'src/a.js')
  assert.equal(result.session_id, 's1')
  assert.equal(result.status, ' M a.js')
  assert.match(result.note, /Read-only/)
  assert.equal(calls[0][0], 'list')
})

test('dsh_inspect diff rejects traversal and unknown sessions', async () => {
  const { controller } = makeInspectController()
  const tool = createInspectTool(controller, { async inspectGit() { throw new Error('must not run') } })

  await assert.rejects(
    () => tool.handler({ session_id: 's1', view: 'diff', path: '../secret' }),
    (error) => error.code === -32602 && /\.\./.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', view: 'diff', path: 'C:foo.js' }),
    (error) => error.code === -32602 && /relative/.test(error.message),
  )

  const missing = createInspectTool(makeInspectController({ list: { items: [] } }).controller, {
    async inspectGit() { throw new Error('must not run') },
  })
  await assert.rejects(
    () => missing.handler({ session_id: 'gone', view: 'diff' }),
    (error) => error.code === -32602 && /not found/.test(error.message),
  )
})

test('dsh_inspect diff reports a session without cwd instead of "not found"', async () => {
  const { controller } = makeInspectController({ list: { items: [{ sessionId: 's1' }] } })
  let inspected = false
  const tool = createInspectTool(controller, {
    async inspectGit() {
      inspected = true
      throw new Error('must not run without a cwd')
    },
  })

  const result = await tool.handler({ session_id: 's1', view: 'diff' })

  assert.equal(result.cwd, null)
  assert.equal(result.is_repo, false)
  assert.match(result.error, /working directory/)
  assert.equal(inspected, false)
})

function makeControlController(overrides = {}) {
  const calls = []
  const controller = {
    cancel(request) {
      calls.push(['cancel', request])
      return { accepted: true }
    },
    async prompt(request, signal) {
      calls.push(['prompt', request, signal])
      return { accepted: true }
    },
    async updateQueue(request) {
      calls.push(['updateQueue', request])
      return { accepted: true }
    },
  }
  return { controller, calls }
}

test('dsh_control cancels and continues a session', async () => {
  const { controller, calls } = makeControlController()
  const tool = createControlTool(controller)
  const signal = new AbortController().signal

  const canceled = await tool.handler({ session_id: 's1', action: 'cancel' }, { signal })
  assert.equal(canceled.accepted, true)

  const continued = await tool.handler({ session_id: 's1', action: 'continue' }, { signal })
  assert.equal(continued.accepted, true)
  assert.equal(typeof continued.request_id, 'string')
  assert.deepEqual(calls[1][1].content, [])
  assert.equal(calls[1][1].mode, 'queue')
  assert.equal(calls[1][2], signal)
})

test('dsh_control awaits an asynchronous cancel result', async () => {
  let settled = false
  const controller = {
    async cancel() {
      await Promise.resolve()
      settled = true
      return { accepted: true }
    },
  }
  const tool = createControlTool(controller)
  const result = await tool.handler({ session_id: 's1', action: 'cancel' })

  assert.equal(settled, true)
  assert.equal(result.accepted, true)
})

test('dsh_control maps queue actions to updateQueue payloads', async () => {
  const { controller, calls } = makeControlController()
  const tool = createControlTool(controller)

  await tool.handler({ session_id: 's1', action: 'queue_edit', item_id: 'q1', text: 'new text' })
  assert.deepEqual(calls[0][1], {
    sessionId: 's1',
    itemId: 'q1',
    action: { kind: 'edit', content: [{ type: 'text', text: 'new text' }] },
  })

  await tool.handler({ session_id: 's1', action: 'queue_remove', item_id: 'q1' })
  assert.deepEqual(calls[1][1], { sessionId: 's1', itemId: 'q1', action: { kind: 'remove' } })

  await tool.handler({ session_id: 's1', action: 'queue_steer', item_id: 'q1' })
  assert.deepEqual(calls[2][1], { sessionId: 's1', itemId: 'q1', action: { kind: 'steer' } })
})

test('dsh_control validates item_id/text and unknown actions', async () => {
  const { controller } = makeControlController()
  const tool = createControlTool(controller)
  await assert.rejects(
    () => tool.handler({ session_id: 's1', action: 'queue_remove' }),
    (error) => error.code === -32602 && /item_id/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', action: 'queue_edit', item_id: 'q1' }),
    (error) => error.code === -32602 && /text/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', action: 'explode' }),
    (error) => error.code === -32602 && /must be one of/.test(error.message),
  )
})
