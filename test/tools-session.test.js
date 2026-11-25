import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionTool } from '../src/tools/session.js'

function makeController(overrides = {}) {
  const calls = []
  const controller = {
    async list(request, signal) {
      calls.push(['list', request, signal])
      return overrides.list ?? { items: [] }
    },
    async search(request, signal) {
      calls.push(['search', request, signal])
      return overrides.search ?? { items: [], hasMore: false }
    },
    async create(request) {
      calls.push(['create', request])
      return overrides.create ?? { sessionId: 'created-1' }
    },
    async rename(request) {
      calls.push(['rename', request])
      return overrides.rename ?? { title: request.title, seq: 7 }
    },
    async fork(request) {
      calls.push(['fork', request])
      return overrides.fork ?? { sessionId: 'fork-1' }
    },
  }
  return { controller, calls }
}

const summaries = [
  {
    sessionId: 's-old',
    updatedAt: 1_000,
    running: false,
    agentAvailable: true,
    cwd: 'F:/work/old',
    projections: { kind: 'cached', asOfSeq: 4, values: { title: 'Old session' } },
  },
  {
    sessionId: 's-new',
    updatedAt: 2_000,
    running: true,
    agentAvailable: true,
    projections: { kind: 'cached', asOfSeq: 9, values: { title: 'New session' } },
  },
]

test('dsh_session list maps projections and sorts by updatedAt descending', async () => {
  const { controller, calls } = makeController({ list: { items: summaries } })
  const tool = createSessionTool(controller)
  const result = await tool.handler({ action: 'list' })
  assert.deepEqual(result.map((row) => row.session_id), ['s-new', 's-old'])
  assert.equal(result[0].title, 'New session')
  assert.equal(result[0].last_seq, 9)
  assert.equal(result[0].updated_at, new Date(2_000).toISOString())
  assert.equal(result[1].cwd, 'F:/work/old')
  assert.equal(calls[0][0], 'list')
})

test('dsh_session defaults a missing action to list', async () => {
  const { controller, calls } = makeController({ list: { items: summaries } })
  const tool = createSessionTool(controller)
  const result = await tool.handler({})

  assert.equal(result.length, 2)
  assert.equal(calls[0][0], 'list')
  assert.equal((tool.inputSchema.required ?? []).includes('action'), false)
})

test('dsh_session list respects the limit and rejects out-of-range limits', async () => {
  const { controller } = makeController({ list: { items: summaries } })
  const tool = createSessionTool(controller)
  const result = await tool.handler({ action: 'list', limit: 1 })
  assert.equal(result.length, 1)
  assert.equal(result[0].session_id, 's-new')

  await assert.rejects(
    () => tool.handler({ action: 'list', limit: 51 }),
    (error) => error.code === -32602 && /at most 50/.test(error.message),
  )
})

test('dsh_session search requires a query and forwards it with the signal', async () => {
  const { controller, calls } = makeController({
    search: { items: [{ sessionId: 's1', snippet: 'needle' }], hasMore: true },
  })
  const tool = createSessionTool(controller)
  const signal = new AbortController().signal

  await assert.rejects(
    () => tool.handler({ action: 'search' }, { signal }),
    (error) => error.code === -32602 && /query/.test(error.message),
  )

  const result = await tool.handler({ action: 'search', query: ' needle ' }, { signal })
  assert.equal(result.query, 'needle')
  assert.equal(result.results[0].session_id, 's1')
  assert.equal(result.has_more, true)
  assert.equal(calls.at(-1)[2], signal)
})

test('dsh_session create validates cwd/workspace exclusivity and applies a title with rename', async () => {
  const { controller, calls } = makeController()
  const tool = createSessionTool(controller)

  await assert.rejects(
    () => tool.handler({ action: 'create', cwd: 'F:/work', workspace_id: 'ws1' }),
    (error) => error.code === -32602 && /mutually exclusive/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ action: 'create', cwd: 'relative/path' }),
    (error) => error.code === -32602 && /absolute path/.test(error.message),
  )

  const result = await tool.handler({ action: 'create', cwd: 'F:/work', title: 'Named' })
  assert.equal(result.session_id, 'created-1')
  assert.equal(result.title, 'Named')
  assert.deepEqual(calls.map(([name]) => name), ['create', 'rename'])
  assert.deepEqual(calls[0][1], { cwd: 'F:/work' })
  assert.deepEqual(calls[1][1], { sessionId: 'created-1', title: 'Named' })
})

test('dsh_session rename and fork forward the required identifiers', async () => {
  const { controller, calls } = makeController()
  const tool = createSessionTool(controller)

  const renamed = await tool.handler({ action: 'rename', session_id: 's1', title: 'New title' })
  assert.equal(renamed.title, 'New title')
  assert.equal(renamed.seq, 7)

  const forked = await tool.handler({ action: 'fork', session_id: 's1', at_seq: 12 })
  assert.equal(forked.session_id, 'fork-1')
  assert.equal(forked.parent_session_id, 's1')
  assert.equal(forked.at_seq, 12)
  assert.deepEqual(calls.at(-1)[1], { sessionId: 's1', atSeq: 12 })
})

test('dsh_session rejects unknown keys instead of ignoring them', async () => {
  const { controller } = makeController()
  const tool = createSessionTool(controller)
  await assert.rejects(
    () => tool.handler({ action: 'list', lmit: 3 }),
    (error) => error.code === -32602 && /unknown argument/.test(error.message),
  )
})

test('dsh_session list resolves workspace membership through the registry', async () => {
  const { controller } = makeController({ list: { items: summaries } })
  const registry = {
    list: () => [{ id: 'ws1', title: 'Alpha', path: 'F:/work', sessionIds: ['s-new'] }],
  }
  const tool = createSessionTool(controller, { workspaceRegistry: () => registry })
  const result = await tool.handler({ action: 'list' })

  assert.equal(result[0].workspace_id, 'ws1')
  assert.equal(result[0].workspace_title, 'Alpha')
  assert.equal(result[1].workspace_id, null)
  assert.equal(result[1].workspace_title, null)
})

test('dsh_session list degrades to null workspace fields without a registry', async () => {
  const { controller } = makeController({ list: { items: summaries } })
  const tool = createSessionTool(controller)
  const result = await tool.handler({ action: 'list' })

  assert.equal(result[0].workspace_id, null)
  assert.equal(result[0].workspace_title, null)
})

test('dsh_session create reuses an existing workspace for cwd', async () => {
  const { controller, calls } = makeController()
  const workspaceCalls = []
  const tool = createSessionTool(controller, {
    workspaceController: () => ({
      async create(request) {
        workspaceCalls.push(request)
        return {
          workspace: { workspaceId: 'ws1', title: 'Alpha', path: 'F:/work', sessionIds: ['s-old'] },
          created: false,
        }
      },
    }),
  })

  const result = await tool.handler({ action: 'create', cwd: 'F:/work' })
  assert.deepEqual(workspaceCalls, [{ path: 'F:/work' }])
  assert.deepEqual(calls[0][1], { workspaceId: 'ws1' })
  assert.equal(result.workspace_id, 'ws1')
  assert.equal(result.workspace_title, 'Alpha')
  assert.equal(result.workspace_created, false)
})

test('dsh_session create reports a newly created workspace', async () => {
  const { controller, calls } = makeController()
  const tool = createSessionTool(controller, {
    workspaceController: () => ({
      async create() {
        return {
          workspace: { workspaceId: 'ws-new', title: 'New', path: 'F:/work/fresh', sessionIds: [] },
          created: true,
        }
      },
    }),
  })

  const result = await tool.handler({ action: 'create', cwd: 'F:/work/fresh' })
  assert.deepEqual(calls[0][1], { workspaceId: 'ws-new' })
  assert.equal(result.workspace_id, 'ws-new')
  assert.equal(result.workspace_created, true)
})

test('dsh_session create falls back to cwd without workspace services', async () => {
  const { controller, calls } = makeController()
  const tool = createSessionTool(controller)
  const result = await tool.handler({ action: 'create', cwd: 'F:/work' })

  assert.deepEqual(calls[0][1], { cwd: 'F:/work' })
  assert.equal(result.workspace_id, null)
  assert.equal(result.workspace_title, null)
  assert.equal(result.workspace_created, false)
})

test('dsh_session create with an explicit workspace_id skips workspace resolution', async () => {
  const { controller, calls } = makeController()
  const workspaceCalls = []
  const tool = createSessionTool(controller, {
    workspaceController: () => ({
      async create(request) {
        workspaceCalls.push(request)
      },
    }),
  })

  const result = await tool.handler({ action: 'create', workspace_id: 'ws-explicit' })
  assert.equal(workspaceCalls.length, 0)
  assert.deepEqual(calls[0][1], { workspaceId: 'ws-explicit' })
  assert.equal(result.workspace_id, 'ws-explicit')
})

test('dsh_session workspaces lists registry entries read-only', async () => {
  const { controller } = makeController()
  const registry = {
    list: () => [{ id: 'ws1', title: 'Alpha', path: 'F:/work', sessionIds: ['a', 'b'] }],
  }
  const tool = createSessionTool(controller, { workspaceRegistry: () => registry })
  const result = await tool.handler({ action: 'workspaces' })

  assert.deepEqual(result.workspaces, [
    { workspace_id: 'ws1', title: 'Alpha', path: 'F:/work', session_count: 2 },
  ])
  assert.equal(result.count, 1)
})

test('dsh_session workspaces degrades to an empty list without a registry', async () => {
  const { controller } = makeController()
  const tool = createSessionTool(controller)
  const result = await tool.handler({ action: 'workspaces' })

  assert.deepEqual(result, { workspaces: [], count: 0 })
})

