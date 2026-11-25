import test from 'node:test'
import assert from 'node:assert/strict'
import { NotionAiAuthPlugin } from '../index.mjs'
import { buildPrompt } from '../lib/handler.mjs'
import { clearPinnedModelCache } from '../lib/notion.mjs'
import { createToolCallParser, unescapeNotionText } from '../lib/tools.mjs'

function sseResponse(events) {
  const payload = events
    .map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('')
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

const MORNING_BRIEF_ID = '11111111-2222-3333-4444-555555555555'

function makeFakeNotionFetch() {
  const calls = []
  let failNextReuse = false
  let nextReply = 'Hello\\_from\\_Notion!'

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
    const body = !isForm && typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers, body, isForm })

    if (u.endsWith('/users/me')) {
      if (init.headers?.Authorization !== 'Bearer ntn_valid_token_12345') {
        return new Response(JSON.stringify({ message: 'Unauthorized', code: 'unauthorized' }), { status: 401 })
      }
      return new Response(
        JSON.stringify({ id: 'user-1', name: 'Test User', type: 'person', person: { email: 'test@example.com' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.endsWith('/agents/query')) {
      return new Response(
        JSON.stringify({
          results: [
            { id: MORNING_BRIEF_ID, name: 'Morning brief', status: 'active', is_favorited: true, model: { mode: 'auto' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.endsWith('/agents/notion_ai') && (init.method || 'GET') === 'GET') {
      return new Response(
        JSON.stringify({ id: 'notion_ai', name: 'Personal', model: { mode: 'pinned', id: 'claude-opus-5-5' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.includes('/agents/') && init.method === 'PATCH') {
      return new Response(
        JSON.stringify({ id: MORNING_BRIEF_ID, model: body?.model }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.endsWith('/file_uploads')) {
      return new Response(
        JSON.stringify({ id: 'upload-file-1', status: 'pending' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.endsWith('/file_uploads/upload-file-1/send')) {
      return new Response(
        JSON.stringify({ id: 'upload-file-1', status: 'uploaded' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (u.endsWith('/sessions')) {
      if (body?.session_id && failNextReuse) {
        failNextReuse = false
        return new Response(JSON.stringify({ message: 'Session expired', code: 'object_not_found' }), { status: 404 })
      }
      const sid = body?.session_id || 'sess-abc-123'
      const half = nextReply.slice(0, Math.max(1, Math.floor(nextReply.length / 2)))
      return sseResponse([
        { event: 'session.snapshot', data: { type: 'session.snapshot', session: { object: 'session', id: sid, status: 'in_progress' } } },
        { event: 'event.provisional', data: { type: 'event.provisional', event: { object: 'session_event', id: 'stream_1', session_id: sid, type: 'agent.message', content: [{ type: 'text', text: half }] } } },
        { event: 'event.provisional', data: { type: 'event.provisional', event: { object: 'session_event', id: 'stream_1', session_id: sid, type: 'agent.message', content: [{ type: 'text', text: nextReply }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'event_1', session_id: sid, type: 'agent.message', content: [{ type: 'text', text: nextReply }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'event_2', session_id: sid, type: 'session.status', status: 'completed' } } },
        { event: 'stream.end', data: { type: 'stream.end', session_id: sid, status: 'completed' } },
      ])
    }

    return new Response('not found', { status: 404 })
  }

  fetchImpl.calls = calls
  fetchImpl.setFailNextReuse = (v) => { failNextReuse = v }
  fetchImpl.setNextReply = (v) => { nextReply = v }
  return fetchImpl
}

test('buildPrompt formats fresh vs reused conversations cleanly', () => {
  const msgs = [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Next question' },
  ]
  assert.match(buildPrompt(msgs, { reuse: false }), /System Instructions:\nBe concise\./)
  assert.equal(buildPrompt(msgs, { reuse: true }), 'Next question')
})

test('unescapeNotionText unescapes prose without mangling fenced code blocks', () => {
  const sample = 'HELLO\\_WORLD\n```js\nconst a = "a\\_b";\n```\nDone\\!'
  const res = unescapeNotionText(sample)
  assert.match(res, /^HELLO_WORLD/)
  assert.match(res, /const a = "a\\_b";/)
})

test('streaming tool call parser extracts split and escaped <tool_call> tags', () => {
  const parser = createToolCallParser({ enabled: true })
  const items = [
    ...parser.push('Checking '),
    ...parser.push('\\<tool\\_ca'),
    ...parser.push('ll\\>{"name":"read\\_file","arguments":{"path":"a\\_b.js"}}</tool\\_call>'),
    ...parser.flush(),
  ]
  const textPart = items.filter((i) => i.type === 'text').map((i) => i.text).join('')
  const calls = items.filter((i) => i.type === 'tool_call').map((i) => i.call)
  assert.equal(textPart, 'Checking ')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read_file')
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a_b.js' })
})

test('plugin pins requested model on Morning brief, streams cleanly, and supports tool_calls', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: false })

  const models = await plugin.provider.models({ models: {} }, { auth: { type: 'api', key: 'ntn_valid_token_12345' } })
  assert.ok(models['claude-opus-5-5'])
  assert.ok(models['gpt-5.5'])
  assert.ok(models[MORNING_BRIEF_ID])
  assert.equal(models['claude-opus-5-5'].tool_call, true)

  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  // 1) Normal streaming text + model pinning to claude-opus-5-5
  const r1 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: true,
      messages: [{ role: 'user', content: 'Say hi' }],
    }),
  })
  assert.equal(r1.status, 200)
  const rawSse = await r1.text()
  const joinedText = rawSse
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || '')
    .join('')
  assert.equal(joinedText, 'Hello_from_Notion!')
  assert.match(rawSse, /data: \[DONE\]/)

  const patchCalls = fakeFetch.calls.filter((c) => c.method === 'PATCH')
  assert.equal(patchCalls.length, 1)
  assert.deepEqual(patchCalls[0].body, { model: { mode: 'pinned', id: 'claude-opus-5-5' } })

  // 2) Tool calling in streaming mode
  fakeFetch.setNextReply('<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>')
  const r2 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: true,
      tools: [{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
      messages: [{ role: 'user', content: 'List files' }],
    }),
  })
  const toolSse = await r2.text()
  assert.match(toolSse, /"tool_calls"/)
  assert.match(toolSse, /"name":"Bash"/)
  assert.match(toolSse, /"finish_reason":"tool_calls"/)
})

test('inline bidirectional packing fits up to ~19.6k chars across prompt_context and message without file upload', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: false })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  // Case B: 14,000-char user prompt with small system prompt -> spills into prompt_context, 0 file uploads
  const mediumPrompt = 'U'.repeat(14000)
  const res1 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/gpt-5.5',
      stream: false,
      messages: [{ role: 'user', content: mediumPrompt }],
    }),
  })
  assert.equal(res1.status, 200)
  assert.equal(fakeFetch.calls.filter((c) => c.url.includes('/file_uploads')).length, 0)
  const sess1 = fakeFetch.calls.find((c) => c.url.endsWith('/sessions'))
  assert.ok(sess1.body.prompt_context.length <= 9800 && sess1.body.prompt_context.length > 3500)
  assert.ok(sess1.body.message.length <= 9800 && sess1.body.message.length > 9000)
  assert.equal(sess1.body.attachments, undefined)

  // Case A: 13,000-char system prompt with short user prompt -> spills tail of system prompt into message, 0 file uploads
  const res2 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/gpt-5.5',
      stream: false,
      messages: [
        { role: 'system', content: 'S'.repeat(13000) },
        { role: 'user', content: 'Say OK' },
      ],
    }),
  })
  assert.equal(res2.status, 200)
  assert.equal(fakeFetch.calls.filter((c) => c.url.includes('/file_uploads')).length, 0)
  const sessCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/sessions'))
  const sess2 = sessCalls[1]
  assert.ok(sess2.body.prompt_context.length <= 9800 && sess2.body.prompt_context.length > 9000)
  assert.ok(sess2.body.message.length <= 9800 && sess2.body.message.includes('Say OK'))
  assert.equal(sess2.body.attachments, undefined)
})

test('oversized prompt (>19.6k chars) automatically uploads via /v1/file_uploads and attaches file', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: false })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  const hugePrompt = 'X'.repeat(22000)
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/gpt-5.5',
      stream: false,
      messages: [{ role: 'user', content: hugePrompt }],
    }),
  })
  assert.equal(res.status, 200)
  const uploadCalls = fakeFetch.calls.filter((c) => c.url.includes('/file_uploads'))
  assert.equal(uploadCalls.length, 2)
  const sessionCall = fakeFetch.calls.find((c) => c.url.endsWith('/sessions'))
  assert.equal(sessionCall.body.attachments[0].file_upload.id, 'upload-file-1')
  assert.ok(sessionCall.body.message.length <= 9800)
})

test('auto-continues Notion 120s stream.end (in_progress) via continue_from with keepalive and dedupe', async () => {
  clearPinnedModelCache()
  const sessionBodies = []
  let sessionCallCount = 0

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (u.endsWith('/agents/query')) {
      return new Response(
        JSON.stringify({ results: [{ id: MORNING_BRIEF_ID, name: 'Morning brief', status: 'active', is_favorited: true, model: { mode: 'pinned', id: 'claude-opus-5-5' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.includes('/agents/') && init.method === 'PATCH') {
      return new Response(JSON.stringify({ id: MORNING_BRIEF_ID, model: body?.model }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/sessions')) {
      sessionBodies.push(body)
      sessionCallCount++
      if (sessionCallCount === 1) {
        return sseResponse([
          { event: 'session.snapshot', data: { type: 'session.snapshot', session: { object: 'session', id: 'sess-long-1', status: 'in_progress' } } },
          { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_user_1', session_id: 'sess-long-1', type: 'user.message' } } },
          { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_tool_1', session_id: 'sess-long-1', type: 'agent.tool_use' } } },
          { event: 'stream.end', data: { type: 'stream.end', session_id: 'sess-long-1', status: 'in_progress' } },
        ])
      }
      return sseResponse([
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_tool_1', session_id: 'sess-long-1', type: 'agent.tool_use' } } },
        { event: 'event.provisional', data: { type: 'event.provisional', event: { object: 'session_event', id: 'stream_2', session_id: 'sess-long-1', type: 'agent.message', content: [{ type: 'text', text: 'Long task ' }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_msg_1', session_id: 'sess-long-1', type: 'agent.message', content: [{ type: 'text', text: 'Long task finished!' }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_msg_1', session_id: 'sess-long-1', type: 'agent.message', content: [{ type: 'text', text: 'Long task finished!' }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_done_1', session_id: 'sess-long-1', type: 'session.status', status: 'completed' } } },
        { event: 'stream.end', data: { type: 'stream.end', session_id: 'sess-long-1', status: 'completed' } },
      ])
    }
    return new Response('not found', { status: 404 })
  }

  const plugin = await NotionAiAuthPlugin({}, { fetchImpl, sessionReuse: false })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: true,
      messages: [{ role: 'user', content: 'Run long reasoning task' }],
    }),
  })
  assert.equal(res.status, 200)
  const rawSse = await res.text()
  assert.match(rawSse, /: keepalive/)
  const joinedText = rawSse
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || '')
    .join('')
  assert.equal(joinedText, 'Long task finished!')
  assert.equal(sessionBodies.length, 2)
  assert.deepEqual(sessionBodies[1], { session_id: 'sess-long-1', continue_from: 'ev_tool_1' })
})

test('maps Notion AI credit/quota stream error cleanly to 429 rate_limit_error', async () => {
  clearPinnedModelCache()
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (u.endsWith('/agents/query')) {
      return new Response(
        JSON.stringify({ results: [{ id: MORNING_BRIEF_ID, name: 'Morning brief', status: 'active', is_favorited: true, model: { mode: 'pinned', id: 'claude-opus-5-5' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.includes('/agents/') && init.method === 'PATCH') {
      return new Response(JSON.stringify({ id: MORNING_BRIEF_ID, model: body?.model }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/sessions')) {
      return sseResponse([
        { event: 'error', data: { type: 'error', error: { message: 'AI credit usage limit reached. Please try again later.' } } },
      ])
    }
    return new Response('not found', { status: 404 })
  }

  const plugin = await NotionAiAuthPlugin({}, { fetchImpl, sessionReuse: false })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(res.status, 429)
  const payload = await res.json()
  assert.equal(payload.error.type, 'rate_limit_error')
  assert.equal(payload.error.code, 429)
})

test('session continuity reuses session_id and retries on expired session', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: true, sessionDir: '' })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'conv-1' },
    body: JSON.stringify({ model: 'notion-ai/auto', stream: false, messages: [{ role: 'user', content: 'Turn 1' }] }),
  })

  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'conv-1' },
    body: JSON.stringify({
      model: 'notion-ai/auto',
      stream: false,
      messages: [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Hello_from_Notion!' },
        { role: 'user', content: 'Turn 2' },
      ],
    }),
  })

  const sessionCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/sessions'))
  assert.equal(sessionCalls[1].body.session_id, 'sess-abc-123')

  fakeFetch.setFailNextReuse(true)
  const r3 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'conv-1' },
    body: JSON.stringify({
      model: 'notion-ai/auto',
      stream: false,
      messages: [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Hello_from_Notion!' },
        { role: 'user', content: 'Turn 3' },
      ],
    }),
  })
  assert.equal(r3.status, 200)
  const afterCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/sessions'))
  assert.equal(afterCalls[afterCalls.length - 1].body.agent_id, MORNING_BRIEF_ID)
})

test('parallel subagents sharing x-magpie-session on Turn 1 never collide on the same Notion session', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: true, sessionDir: '' })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'parent-workflow-1' },
    body: JSON.stringify({ model: 'notion-ai/auto', stream: false, messages: [{ role: 'user', content: 'Subagent A: design 3D iPhone' }] }),
  })
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'parent-workflow-1' },
    body: JSON.stringify({ model: 'notion-ai/auto', stream: false, messages: [{ role: 'user', content: 'Subagent B: design Persian keyboard' }] }),
  })

  const sessionCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/sessions'))
  assert.equal(sessionCalls.length, 2)
  assert.equal(sessionCalls[0].body.session_id, undefined)
  assert.equal(sessionCalls[1].body.session_id, undefined)
  assert.equal(sessionCalls[0].body.agent_id, MORNING_BRIEF_ID)
  assert.equal(sessionCalls[1].body.agent_id, MORNING_BRIEF_ID)
})

test('continue_from fallback picks newest post-prior event and never splices Turn 1 text onto Turn 2', async () => {
  clearPinnedModelCache()
  const sessionBodies = []
  let callNum = 0

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (u.endsWith('/agents/query')) {
      return new Response(
        JSON.stringify({ results: [{ id: MORNING_BRIEF_ID, name: 'Morning brief', status: 'active', is_favorited: true, model: { mode: 'pinned', id: 'claude-opus-5-5' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.includes('/agents/') && init.method === 'PATCH') {
      return new Response(JSON.stringify({ id: MORNING_BRIEF_ID, model: body?.model }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/events/query')) {
      // Simulate Notion returning events in descending (newest-first) order across Turn 1 & Turn 2!
      return new Response(
        JSON.stringify({
          results: [
            { id: 'ev_t2_user', type: 'user.message', sequence: 10 },
            { id: 'ev_t1_done', type: 'session.status', status: 'completed', sequence: 6 },
            { id: 'ev_t1_msg', type: 'agent.message', sequence: 5 },
            { id: 'ev_t1_user', type: 'user.message', sequence: 4 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.endsWith('/sessions')) {
      sessionBodies.push(body)
      callNum++
      if (callNum === 1) {
        // Turn 1 completes cleanly
        return sseResponse([
          { event: 'session.snapshot', data: { type: 'session.snapshot', session: { object: 'session', id: 'sess-splice-1', status: 'in_progress' } } },
          { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_t1_user', sequence: 4, session_id: 'sess-splice-1', type: 'user.message' } } },
          { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_t1_msg', sequence: 5, session_id: 'sess-splice-1', type: 'agent.message', content: [{ type: 'text', text: '<tool_call>{"name":"Write","arguments":{"file_path":"a.html"}}</tool_call>' }] } } },
          { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_t1_done', sequence: 6, session_id: 'sess-splice-1', type: 'session.status', status: 'completed' } } },
          { event: 'stream.end', data: { type: 'stream.end', session_id: 'sess-splice-1', status: 'completed' } },
        ])
      }
      if (callNum === 2) {
        // Turn 2 rolls over at 120s BEFORE emitting any event.committed!
        return sseResponse([
          { event: 'session.snapshot', data: { type: 'session.snapshot', session: { object: 'session', id: 'sess-splice-1', status: 'in_progress' } } },
          { event: 'event.provisional', data: { type: 'event.provisional', event: { object: 'session_event', id: 'stream_t2', session_id: 'sess-splice-1', type: 'agent.message', content: [{ type: 'text', text: '<tool_call>{"name":"Bash","arguments":{"command":"echo part2 ' }] } } },
          { event: 'stream.end', data: { type: 'stream.end', session_id: 'sess-splice-1', status: 'in_progress' } },
        ])
      }
      // Call 3: continue_from MUST use ev_t2_user (NOT ev_t1_user!) and finish cleanly
      return sseResponse([
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_t2_msg', sequence: 11, session_id: 'sess-splice-1', type: 'agent.message', content: [{ type: 'text', text: '<tool_call>{"name":"Bash","arguments":{"command":"echo part2 done"}}</tool_call>' }] } } },
        { event: 'event.committed', data: { type: 'event.committed', event: { object: 'session_event', id: 'ev_t2_done', sequence: 12, session_id: 'sess-splice-1', type: 'session.status', status: 'completed' } } },
        { event: 'stream.end', data: { type: 'stream.end', session_id: 'sess-splice-1', status: 'completed' } },
      ])
    }
    return new Response('not found', { status: 404 })
  }

  const plugin = await NotionAiAuthPlugin({}, { fetchImpl, sessionReuse: true, sessionDir: '' })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  // Turn 1
  const t1 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: false,
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'Write part 1' }],
    }),
  })
  const j1 = await t1.json()
  assert.equal(j1.choices[0].message.tool_calls[0].function.name, 'Write')

  // Turn 2 (reuses sess-splice-1 and hits rollover before committed event)
  const t2 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'notion-ai/claude-opus-5-5',
      stream: false,
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'Write part 1' },
        j1.choices[0].message,
        { role: 'tool', tool_call_id: j1.choices[0].message.tool_calls[0].id, content: 'Wrote part 1' },
      ],
    }),
  })
  const j2 = await t2.json()
  assert.equal(sessionBodies.length, 3)
  assert.deepEqual(sessionBodies[2], { session_id: 'sess-splice-1', continue_from: 'ev_t2_user' })
  assert.equal(j2.choices[0].message.tool_calls[0].function.name, 'Bash')
  assert.deepEqual(JSON.parse(j2.choices[0].message.tool_calls[0].function.arguments), { command: 'echo part2 done' })
})

test('tool call parser repairs Notion markdown escapes and raw newlines inside large JSON payloads', () => {
  const parser = createToolCallParser({ enabled: true })
  const messy = '<tool_call>{"name":"Bash","arguments":{"command":"echo \\#hello\\!\nline2\\_ok"}}</tool_call>'
  const items = [...parser.push(messy), ...parser.flush()]
  const calls = items.filter((i) => i.type === 'tool_call').map((i) => i.call)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'Bash')
  assert.equal(JSON.parse(calls[0].arguments).command, 'echo #hello!\nline2_ok')
})

test('GET /v1/models exposes rich metadata (family, efforts, context_window) and X-Notion-* headers control session/agent', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: true, sessionDir: '' })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  // 1) Rich /v1/models metadata
  const mr = await loaded.fetch(`${loaded.baseURL}/models`, { method: 'GET' })
  assert.equal(mr.status, 200)
  const mdata = await mr.json()
  const opus = mdata.data.find((m) => m.id === 'claude-opus-5-5')
  assert.equal(opus.family, 'Claude')
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opus.context_window, 1000000)

  // 2) Turn 1 saves session, Turn 2 with X-Notion-Fresh-Session: 1 forces fresh session + X-Notion-Agent-Id overrides agent
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-magpie-session': 'orch-1' },
    body: JSON.stringify({ model: 'notion-ai/auto', stream: false, messages: [{ role: 'user', content: 'Step 1' }] }),
  })
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-magpie-session': 'orch-1',
      'x-notion-fresh-session': '1',
      'x-notion-agent-id': 'notion_ai',
    },
    body: JSON.stringify({
      model: 'notion-ai/auto',
      stream: false,
      messages: [
        { role: 'user', content: 'Step 1' },
        { role: 'assistant', content: 'Hello_from_Notion!' },
        { role: 'user', content: 'Step 2 fresh' },
      ],
    }),
  })

  const sessCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/sessions'))
  assert.equal(sessCalls.length, 2)
  assert.equal(sessCalls[1].body.session_id, undefined)
  assert.equal(sessCalls[1].body.agent_id, 'notion_ai')
})
