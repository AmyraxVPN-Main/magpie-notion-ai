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

test('oversized prompt automatically uploads via /v1/file_uploads and attaches file', async () => {
  clearPinnedModelCache()
  const fakeFetch = makeFakeNotionFetch()
  const plugin = await NotionAiAuthPlugin({}, { fetchImpl: fakeFetch, sessionReuse: false })
  const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: 'ntn_valid_token_12345' }))

  const hugePrompt = 'X'.repeat(12000)
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
  assert.ok(sessionCall.body.message.length <= 9500)
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
