// Translates OpenAI Chat Completions (/v1/chat/completions) and /v1/models
// into official Notion Agent API (/v1/sessions, /v1/agents, /v1/file_uploads) calls.
import { randomUUID } from 'node:crypto'
import {
  ensureAgentModel,
  KNOWN_NOTION_MODELS,
  listAgents,
  MESSAGE_MAX_CHARS,
  NotionApiError,
  PERSONAL_AGENT_ID,
  pickPrimaryAgent,
  PROMPT_CONTEXT_MAX_CHARS,
  streamSession,
  uploadTextAttachment,
} from './notion.mjs'
import { hashKey } from './sessions.mjs'
import {
  buildToolPreamble,
  createToolCallParser,
  normalizeTools,
  unescapeNotionText,
} from './tools.mjs'

const encoder = new TextEncoder()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (part?.type === 'image_url') return '[image attached]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function renderMessage(m) {
  const role = m?.role || 'user'
  if (role === 'tool') {
    const id = m.tool_call_id ? ` id=${m.tool_call_id}` : ''
    const name = m.name ? ` name=${m.name}` : ''
    return `[tool_result${id}${name}]\n${normalizeContent(m.content).trim()}`
  }
  if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const parts = []
    const text = normalizeContent(m.content).trim()
    if (text) parts.push(text)
    for (const tc of m.tool_calls) {
      const fn = tc?.function || tc
      let args = fn?.arguments ?? {}
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch {}
      }
      parts.push(`<tool_call>${JSON.stringify({ name: fn?.name || '', arguments: args })}</tool_call>`)
    }
    return parts.join('\n')
  }
  return normalizeContent(m?.content).trim()
}

/**
 * Split OpenAI `messages[]` into `{ systemText, userText }`:
 * - On a fresh session: `systemText` holds system/developer prompts; `userText` holds the conversation.
 * - On a reused session: `userText` holds only turns after the last assistant message (user + tool_result).
 */
export function buildPromptParts(messages, { reuse = false } = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return { systemText: '', userText: '' }

  if (reuse) {
    let lastAssistant = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === 'assistant') {
        lastAssistant = i
        break
      }
    }
    const tail = list.slice(lastAssistant + 1)
    if (tail.length === 1 && tail[0]?.role === 'user') {
      return { systemText: '', userText: renderMessage(tail[0]) }
    }
    const userText = tail
      .map((m) => {
        const rendered = renderMessage(m)
        if (!rendered) return ''
        if (m?.role === 'tool' || m?.role === 'user') return rendered
        return `[${m.role}]\n${rendered}`
      })
      .filter(Boolean)
      .join('\n\n')
      .trim()
    return { systemText: '', userText }
  }

  const systemParts = []
  const convoParts = []
  for (const m of list) {
    const role = m?.role || 'user'
    const text = renderMessage(m)
    if (!text) continue
    if (role === 'system' || role === 'developer') {
      systemParts.push(text)
    } else {
      convoParts.push({ role, text })
    }
  }

  const systemText = systemParts.join('\n\n').trim()
  if (convoParts.length === 1 && convoParts[0].role === 'user') {
    return { systemText, userText: convoParts[0].text }
  }

  const userText = convoParts
    .map((m) => {
      if (m.role === 'tool') return m.text
      const label = m.role === 'assistant' ? 'Assistant' : 'User'
      return `${label}:\n${m.text}`
    })
    .join('\n\n')
    .trim()

  return { systemText, userText }
}

// Backward-compatible export for tests / callers
export function buildPrompt(messages, { reuse = false } = {}) {
  const { systemText, userText } = buildPromptParts(messages, { reuse })
  if (!systemText) return userText
  if (!userText) return systemText
  return `System Instructions:\n${systemText}\n\n---\n\n${userText}`
}

function stripProviderPrefix(model) {
  const raw = String(model || 'auto').trim()
  const slash = raw.indexOf('/')
  return slash >= 0 ? raw.slice(slash + 1) || 'auto' : raw || 'auto'
}

function extractEffort(body, effortHeader) {
  const raw = String(effortHeader || body?.reasoning_effort || body?.reasoning?.effort || '').trim().toLowerCase()
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(raw) ? raw : ''
}

function effortHint(effort) {
  if (!effort) return ''
  if (effort === 'low') return 'Reasoning depth: concise and direct.'
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return `Reasoning depth (${effort}): think carefully step by step before answering or editing code.`
  }
  return ''
}

function normWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function canonMsg(m) {
  if (!m) return ''
  const role = m.role || 'user'
  if (role === 'assistant') {
    const calls = (m.tool_calls || []).map((c) => `${c.id || ''}:${c.function?.name || c.name || ''}`).join(',')
    return `assistant|${normWs(normalizeContent(m.content))}|${calls}`
  }
  if (role === 'tool') return `tool|${m.tool_call_id || m.id || ''}|${normWs(normalizeContent(m.content))}`
  return `${role}|${normWs(normalizeContent(m.content))}`
}

function splitConvo(messages) {
  const list = Array.isArray(messages) ? messages : []
  const systemParts = []
  const convo = []
  for (const m of list) {
    const role = m?.role || 'user'
    if (role === 'system' || role === 'developer') systemParts.push(renderMessage(m))
    else convo.push(m)
  }
  let lastAssistant = -1
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i]?.role === 'assistant') {
      lastAssistant = i
      break
    }
  }
  const firstUser = convo.find((m) => (m?.role || 'user') === 'user')
  return {
    systemText: systemParts.filter(Boolean).join('\n\n'),
    convo,
    lastAssistant,
    firstUserHash: hashKey([firstUser ? canonMsg(firstUser) : '']),
  }
}

function buildSessionLookup({ identity, scopeModel, sessionKey, messages }) {
  const { systemText, convo, lastAssistant, firstUserHash } = splitConvo(messages)
  const scope = hashKey([identity, scopeModel, normWs(systemText)])
  const scopedSessionKey = sessionKey ? hashKey(['session', scope, firstUserHash, sessionKey]) : null

  // CRITICAL: Never reuse a Notion session when `convo` has NO prior assistant message!
  // Parallel subagents in Claude Code share the parent `x-magpie-session` header, so
  // reusing on Turn 1 causes cross-agent collisions and deadlocks.
  if (lastAssistant < 0) {
    return { scope, convo, lastAssistant, scopedSessionKey, prefixKey: null, replyKey: null, tailKey: null }
  }

  const tail = convo.slice(lastAssistant + 1)
  const validDelta = tail.length > 0 && tail.every((m) => ['user', 'tool', 'function'].includes(m?.role || 'user'))
  if (!validDelta) {
    return { scope, convo, lastAssistant, scopedSessionKey: null, prefixKey: null, replyKey: null, tailKey: null }
  }

  const prefixKey = hashKey(['prefix', scope, ...convo.slice(0, lastAssistant + 1).map(canonMsg)])
  const replyKey = hashKey(['reply', scope, canonMsg(convo[lastAssistant])])
  const tailKey = lastAssistant >= 3
    ? hashKey(['tail', scope, ...convo.slice(lastAssistant - 3, lastAssistant).map(canonMsg)])
    : null
  return { scope, convo, lastAssistant, scopedSessionKey, prefixKey, replyKey, tailKey }
}

function saveSessionState({ sessions, lookup, assistantMsg, sessionId, lastCommittedId }) {
  if (!sessions || !sessionId) return
  const nextConvo = [...lookup.convo, assistantMsg]
  const nextPrefixKey = hashKey(['prefix', lookup.scope, ...nextConvo.map(canonMsg)])
  const nextReplyKey = hashKey(['reply', lookup.scope, canonMsg(assistantMsg)])
  const nextTailKey = lookup.convo.length >= 3
    ? hashKey(['tail', lookup.scope, ...lookup.convo.slice(-3).map(canonMsg)])
    : ''
  const entry = {
    sessionId,
    lastCommittedId: lastCommittedId || '',
    replyKey: nextReplyKey,
    tailKey: nextTailKey,
  }
  sessions.set(nextPrefixKey, entry)
  if (lookup.scopedSessionKey) {
    sessions.set(lookup.scopedSessionKey, entry)
  }
}

function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4))
}

function sseChunk(id, created, model, delta, finishReason = null, usage = null) {
  const frame = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage) frame.usage = usage
  return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
}

/**
 * Resolve requested model string into `{ agentId, pinModelId }`:
 * - Explicit agent UUID or `notion_ai` -> call that agent directly without re-pinning.
 * - Any model name (`auto`, `claude-opus-5-5`, `gpt-5.5`, etc.) -> route via primary
 *   active Custom Agent (Morning brief by default) and pin its model via PATCH /v1/agents/:id.
 */
async function resolveTarget({ requestedModel, token, options, signal }) {
  const bare = stripProviderPrefix(requestedModel)
  if (bare === PERSONAL_AGENT_ID || UUID_RE.test(bare)) {
    return { agentId: bare, pinModelId: null }
  }

  let primaryId = options.defaultAgentId || ''
  if (!primaryId && typeof options.getPrimaryAgentId === 'function') {
    primaryId = await options.getPrimaryAgentId(token, signal)
  }
  if (!primaryId) {
    const agents = await listAgents(token, {
      apiBase: options.apiBase,
      version: options.notionVersion,
      fetchImpl: options.fetchImpl,
      signal,
    })
    primaryId = pickPrimaryAgent(agents, options.defaultAgentId).id
  }

  return { agentId: primaryId, pinModelId: bare }
}

/**
 * Prepare `message`, `promptContext`, and `attachments` respecting Notion's
 * 10,000-character limits on `message` and `prompt_context`.
 *
 * Strategy:
 * 1. Pack up to ~19,600 chars inline across BOTH official fields (`prompt_context` + `message`)
 *    by spilling excess from whichever field overflows into unused room in the other field.
 *    This avoids unnecessary `/v1/file_uploads` attachments, which trigger Notion's Linux sandbox
 *    and add 30-120s of latency.
 * 2. Only when combined text still exceeds inline capacity do we upload via Notion's official
 *    Direct File Upload API (`/v1/file_uploads`) and instruct the agent to read it in one step.
 */
async function prepareSessionPayload({
  token,
  systemText,
  toolPreamble,
  effort,
  userText,
  options,
  signal,
}) {
  const attachments = []
  const uploadOpts = {
    apiBase: options.apiBase,
    version: options.notionVersion,
    fetchImpl: options.fetchImpl,
    signal,
  }

  const contextSections = [
    effortHint(effort),
    systemText,
    toolPreamble,
  ].filter(Boolean)
  let promptContext = contextSections.join('\n\n').trim()
  let message = String(userText || '').trim()

  // Case A: promptContext overflows 9,800 chars, while message has spare room -> spill tail of promptContext into message
  if (promptContext.length > PROMPT_CONTEXT_MAX_CHARS && message.length < MESSAGE_MAX_CHARS) {
    const contPrefix = '[System & Tool Instructions (continued)]\n'
    const userSep = '\n\n[User Request]\n'
    const freeInMessage = MESSAGE_MAX_CHARS - message.length - contPrefix.length - userSep.length
    const overflow = promptContext.length - PROMPT_CONTEXT_MAX_CHARS
    if (freeInMessage >= overflow) {
      const minSplit = promptContext.length - freeInMessage
      let splitAt = PROMPT_CONTEXT_MAX_CHARS
      const nl = promptContext.lastIndexOf('\n', PROMPT_CONTEXT_MAX_CHARS)
      if (nl >= minSplit) splitAt = nl
      const ctxHead = promptContext.slice(0, splitAt).trimEnd()
      const ctxTail = promptContext.slice(splitAt).trimStart()
      promptContext = ctxHead
      message = `${contPrefix}${ctxTail}${userSep}${message}`
    }
  }

  // Case B: message overflows 9,800 chars, while promptContext has spare room -> spill earlier part of message into promptContext
  if (message.length > MESSAGE_MAX_CHARS && promptContext.length < PROMPT_CONTEXT_MAX_CHARS) {
    const ctxSep = promptContext
      ? '\n\n[Earlier Prompt / Context]\n'
      : '[Earlier Prompt / Context]\n'
    const msgPrefix = '[Continued from prompt_context above]\n'
    const freeInContext = PROMPT_CONTEXT_MAX_CHARS - promptContext.length - ctxSep.length
    const maxTailInMessage = MESSAGE_MAX_CHARS - msgPrefix.length
    const overflow = message.length - maxTailInMessage
    if (freeInContext >= overflow) {
      let splitAt = overflow
      const nl = message.indexOf('\n', overflow)
      if (nl !== -1 && nl <= freeInContext) splitAt = nl
      const msgHead = message.slice(0, splitAt).trimEnd()
      const msgTail = message.slice(splitAt).trimStart()
      promptContext = `${promptContext}${ctxSep}${msgHead}`
      message = `${msgPrefix}${msgTail}`
    }
  }

  if (promptContext.length > PROMPT_CONTEXT_MAX_CHARS) {
    if (options.inlineOnly) {
      promptContext = promptContext.slice(0, PROMPT_CONTEXT_MAX_CHARS)
    } else {
      try {
        const att = await uploadTextAttachment(token, 'instructions-and-tools.md', promptContext, uploadOpts)
        attachments.push(att)
        // Keep the tool protocol compact inline + point to the full uploaded file
        const shortInline = [
          'Full system instructions and client tool definitions are attached in `instructions-and-tools.md`. Read it in a single step and follow it directly without extra exploratory sandbox commands.',
          toolPreamble ? toolPreamble.slice(0, 6000) : '',
        ].filter(Boolean).join('\n\n')
        promptContext = shortInline.slice(0, PROMPT_CONTEXT_MAX_CHARS)
      } catch {
        // Fallback: truncate cleanly if file upload permission is unavailable
        promptContext = promptContext.slice(0, PROMPT_CONTEXT_MAX_CHARS)
      }
    }
  }

  if (message.length > MESSAGE_MAX_CHARS) {
    if (options.inlineOnly) {
      message = message.slice(-MESSAGE_MAX_CHARS)
    } else {
      try {
        const att = await uploadTextAttachment(token, 'prompt-context.md', message, uploadOpts)
        attachments.push(att)
        const tail = message.slice(-7000)
        message =
          `The full user prompt / conversation history (${message.length} chars) is attached in \`prompt-context.md\`. ` +
          `If needed, read the attached file in ONE step without running extra exploratory shell commands, then respond directly to the latest request below:\n\n${tail}`
        if (message.length > MESSAGE_MAX_CHARS) message = message.slice(0, MESSAGE_MAX_CHARS)
      } catch {
        message = message.slice(-MESSAGE_MAX_CHARS)
      }
    }
  }

  return { message, promptContext: promptContext || undefined, attachments }
}

/**
 * Streaming markdown unescaper that holds a trailing `\` so split `\_` across
 * two SSE chunks still unescapes cleanly without touching fenced code blocks.
 */
function createStreamingUnescaper() {
  let pendingBackslash = false
  let inCodeFence = false
  let lineBuf = ''

  return {
    push(chunk) {
      if (!chunk) return ''
      let s = (pendingBackslash ? '\\' : '') + chunk
      pendingBackslash = false
      if (s.endsWith('\\')) {
        pendingBackslash = true
        s = s.slice(0, -1)
      }
      // Track ``` fences approximately so code blocks stay verbatim
      let out = ''
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (ch === '\n') {
          if (lineBuf.trimStart().startsWith('```')) inCodeFence = !inCodeFence
          lineBuf = ''
        } else {
          lineBuf += ch
        }
        if (!inCodeFence && ch === '\\' && i + 1 < s.length && '_*<>[]'.includes(s[i + 1])) {
          continue
        }
        out += ch
      }
      return out
    },
    flush() {
      if (!pendingBackslash) return ''
      pendingBackslash = false
      return '\\'
    },
  }
}

export async function buildCatalogModels(token, options = {}, signal) {
  const agents = await listAgents(token, {
    apiBase: options.apiBase,
    version: options.notionVersion,
    fetchImpl: options.fetchImpl,
    signal,
  })
  const primary = pickPrimaryAgent(agents, options.defaultAgentId)
  const out = []
  const seen = new Set()

  // 1) All verified Notion frontier models routed through the primary active agent (e.g. Morning brief)
  const extra = Array.isArray(options.extraModels) ? options.extraModels : []
  const dynamicFromAgents = agents
    .map((a) => a?.model?.id)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => ({ id: id.trim(), name: id.trim() }))

  for (const m of [...KNOWN_NOTION_MODELS, ...dynamicFromAgents, ...extra.map((id) => ({ id: String(id), name: String(id) }))]) {
    if (!m?.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push({
      id: m.id,
      name: `${m.name} · ${primary.name}`,
      family: m.family || 'Other',
      agentId: primary.id,
      pinModelId: m.id,
      efforts: Array.isArray(m.efforts) ? m.efforts : ['low', 'medium', 'high'],
      context: m.context || 200000,
      output: m.output || 32768,
    })
  }

  // 2) Direct agent entries (Morning brief / any custom agents / personal notion_ai)
  for (const a of agents) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push({
      id: a.id,
      name: a.name,
      family: 'Agent',
      agentId: a.id,
      pinModelId: null,
      efforts: ['low', 'medium', 'high'],
      context: 1000000,
      output: 64000,
    })
  }

  return out
}

export async function handleModels({ token, options = {}, signal }) {
  const models = await buildCatalogModels(token, options, signal)
  const now = Math.floor(Date.now() / 1000)
  return new Response(
    JSON.stringify({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: now,
        owned_by: 'notion',
        name: m.name,
        family: m.family,
        efforts: m.efforts,
        context_window: m.context,
        max_output_tokens: m.output,
        agent_id: m.agentId,
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

export async function handleChatCompletions({ body, token, sessions, options = {}, effortHeader, signal }) {
  const model = String(body?.model || 'auto')
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const stream = body?.stream !== false
  const identity = options.identity || 'notion-ai'
  const tools = normalizeTools(body?.tools)
  const effort = extractEffort(body, effortHeader)

  let target
  try {
    target = await resolveTarget({ requestedModel: model, token, options, signal })
    if (target.pinModelId) {
      await ensureAgentModel(token, target.agentId, target.pinModelId, {
        apiBase: options.apiBase,
        version: options.notionVersion,
        fetchImpl: options.fetchImpl,
        signal,
      })
    }
  } catch (err) {
    const status = err instanceof NotionApiError && err.status >= 400 && err.status < 600 ? err.status : 502
    const errType = status === 429 ? 'rate_limit_error' : 'api_error'
    return new Response(
      JSON.stringify({ error: { message: err?.message || String(err), type: errType, code: status } }),
      { status, headers: { 'content-type': 'application/json' } }
    )
  }

  const scopeModel = `${target.agentId}:${target.pinModelId || 'direct'}:${tools.map((t) => t.name).join(',')}`
  const lookup = buildSessionLookup({ identity, scopeModel, sessionKey: options.sessionKey, messages })

  // Match cached session in priority order (identical to magpie-aws-quick):
  //   1) strict prefix chain hash
  //   2) fuzzy reply+tail anchor
  //   3) scoped sessionKey fallback (only when lastAssistant >= 0)
  let cached = null
  let matchedKey = null
  if (sessions && !options.freshSession && lookup.lastAssistant >= 0) {
    if (lookup.prefixKey && sessions.has(lookup.prefixKey)) {
      cached = sessions.take(lookup.prefixKey)
      matchedKey = lookup.prefixKey
    }
    if (!cached && lookup.replyKey && lookup.tailKey) {
      const hit = sessions.findEntry((e) => e.replyKey === lookup.replyKey && e.tailKey === lookup.tailKey)
      if (hit) {
        cached = sessions.take(hit.key)
        matchedKey = hit.key
      }
    }
    if (!cached && lookup.scopedSessionKey && sessions.has(lookup.scopedSessionKey)) {
      cached = sessions.take(lookup.scopedSessionKey)
      matchedKey = lookup.scopedSessionKey
    }
  }

  // Acquire exclusive in-flight lock on the Notion session_id so concurrent calls never deadlock it
  let lockedSessionId = ''
  if (cached?.sessionId) {
    if (!sessions || sessions.acquire(cached.sessionId)) {
      lockedSessionId = cached.sessionId
    } else {
      // Another request is actively using this session right now -> open a clean fresh session
      cached = null
      matchedKey = null
    }
  }
  const canReuse = Boolean(cached?.sessionId)

  const parts = buildPromptParts(messages, { reuse: canReuse })
  if (!parts.userText && !parts.systemText) {
    if (lockedSessionId) sessions?.release(lockedSessionId)
    return new Response(
      JSON.stringify({ error: { message: 'messages must contain at least one non-empty message', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const toolPreamble = buildToolPreamble(tools, body?.tool_choice, { reminder: canReuse })
  const prepared = await prepareSessionPayload({
    token,
    systemText: parts.systemText,
    toolPreamble,
    effort,
    userText: parts.userText || '(continue)',
    options,
    signal,
  })

  const chatId = `chatcmpl-notion-${randomUUID().slice(0, 12)}`
  const created = Math.floor(Date.now() / 1000)

  async function* runWithRetry() {
    let produced = false
    let activeSessionId = cached?.sessionId || ''

    try {
      try {
        for await (const ev of streamSession({
          token,
          agentId: target.agentId,
          sessionId: canReuse ? cached.sessionId : undefined,
          priorCommittedId: canReuse ? cached.lastCommittedId || '' : '',
          message: prepared.message,
          promptContext: prepared.promptContext,
          attachments: prepared.attachments,
          apiBase: options.apiBase,
          version: options.notionVersion,
          fetchImpl: options.fetchImpl,
          signal,
        })) {
          if (ev.sessionId) activeSessionId = ev.sessionId
          if (ev.kind === 'delta' || ev.kind === 'thinking') produced = true
          yield ev
        }
      } catch (err) {
        const retryable = canReuse && !produced && !signal?.aborted && err?.status !== 401 && err?.status !== 402 && err?.status !== 403
        if (!retryable) throw err
        if (matchedKey) sessions?.delete(matchedKey)
        if (lookup.scopedSessionKey) sessions?.delete(lookup.scopedSessionKey)
        const freshParts = buildPromptParts(messages, { reuse: false })
        const freshPreamble = buildToolPreamble(tools, body?.tool_choice, { reminder: false })
        const freshPrepared = await prepareSessionPayload({
          token,
          systemText: freshParts.systemText,
          toolPreamble: freshPreamble,
          effort,
          userText: freshParts.userText || '(continue)',
          options,
          signal,
        })
        for await (const ev of streamSession({
          token,
          agentId: target.agentId,
          message: freshPrepared.message,
          promptContext: freshPrepared.promptContext,
          attachments: freshPrepared.attachments,
          apiBase: options.apiBase,
          version: options.notionVersion,
          fetchImpl: options.fetchImpl,
          signal,
        })) {
          if (ev.sessionId) activeSessionId = ev.sessionId
          yield ev
        }
      }
    } finally {
      if (lockedSessionId) {
        sessions?.release(lockedSessionId)
        lockedSessionId = ''
      }
    }
  }

  // Streaming SSE response (OpenAI format with tool_calls support & keepalive heartbeats)
  if (stream) {
    let streamClosed = false
    let heartbeat = null

    const readable = new ReadableStream({
      async start(controller) {
        let sentRole = false
        let outText = ''
        const toolCallsEmitted = []
        const parser = createToolCallParser({ enabled: tools.length > 0 })
        const unescaper = createStreamingUnescaper()
        let finalSessionId = ''
        let finalCommittedId = ''
        let lastActivityAt = Date.now()

        const safeEnqueue = (bytes) => {
          if (streamClosed) return
          try {
            controller.enqueue(bytes)
            lastActivityAt = Date.now()
          } catch {
            streamClosed = true
          }
        }

        // Send immediate SSE keepalive frame so downstream TTFT/idle timers reset at <1s
        const heartbeatMs = Number.isFinite(options.keepaliveIntervalMs) ? options.keepaliveIntervalMs : 10000
        if (heartbeatMs > 0) {
          safeEnqueue(encoder.encode(': keepalive\n\n'))
          heartbeat = setInterval(() => {
            if (streamClosed || signal?.aborted) return
            if (Date.now() - lastActivityAt >= heartbeatMs - 500) {
              safeEnqueue(encoder.encode(': keepalive\n\n'))
            }
          }, Math.min(heartbeatMs, 10000))
          heartbeat.unref?.()
        }

        const emitText = (txt) => {
          if (!txt) return
          outText += txt
          const delta = sentRole ? { content: txt } : { role: 'assistant', content: txt }
          sentRole = true
          safeEnqueue(sseChunk(chatId, created, model, delta))
        }

        const emitToolCall = (call) => {
          const idx = toolCallsEmitted.length
          toolCallsEmitted.push(call)
          const tcDelta = {
            index: idx,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }
          const delta = sentRole ? { tool_calls: [tcDelta] } : { role: 'assistant', tool_calls: [tcDelta] }
          sentRole = true
          safeEnqueue(sseChunk(chatId, created, model, delta))
        }

        const handleParsed = (items) => {
          for (const item of items) {
            if (item.type === 'tool_call') {
              const flushTxt = unescaper.flush()
              if (flushTxt) emitText(flushTxt)
              emitToolCall(item.call)
            } else if (item.type === 'text') {
              emitText(unescaper.push(item.text))
            }
          }
        }

        try {
          for await (const ev of runWithRetry()) {
            if (ev.sessionId) finalSessionId = ev.sessionId
            if (ev.lastCommittedId) finalCommittedId = ev.lastCommittedId
            if (ev.kind === 'keepalive') {
              safeEnqueue(encoder.encode(': keepalive\n\n'))
              continue
            }
            if (ev.kind === 'thinking' && ev.text) {
              const delta = sentRole ? { reasoning_content: ev.text } : { role: 'assistant', reasoning_content: ev.text }
              sentRole = true
              safeEnqueue(sseChunk(chatId, created, model, delta))
            } else if (ev.kind === 'delta' && ev.text) {
              handleParsed(parser.push(ev.text))
            }
          }
          handleParsed(parser.flush())
          const tail = unescaper.flush()
          if (tail) emitText(tail)

          if (sessions && finalSessionId && (outText || toolCallsEmitted.length)) {
            const assistantMsg = toolCallsEmitted.length
              ? {
                  role: 'assistant',
                  content: outText || null,
                  tool_calls: toolCallsEmitted.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : { role: 'assistant', content: outText }
            saveSessionState({
              sessions,
              lookup,
              assistantMsg,
              sessionId: finalSessionId,
              lastCommittedId: finalCommittedId,
            })
          }

          if (!sentRole) {
            safeEnqueue(sseChunk(chatId, created, model, { role: 'assistant', content: '' }))
          }
          const finishReason = toolCallsEmitted.length ? 'tool_calls' : 'stop'
          const usage = {
            prompt_tokens: approxTokens(prepared.message + (prepared.promptContext || '')),
            completion_tokens: approxTokens(outText + JSON.stringify(toolCallsEmitted)),
            total_tokens: approxTokens(prepared.message + (prepared.promptContext || '')) + approxTokens(outText + JSON.stringify(toolCallsEmitted)),
          }
          safeEnqueue(sseChunk(chatId, created, model, {}, finishReason, body?.stream_options?.include_usage ? usage : null))
          safeEnqueue(encoder.encode('data: [DONE]\n\n'))
          if (!streamClosed) {
            streamClosed = true
            controller.close()
          }
        } catch (err) {
          const status = err instanceof NotionApiError ? err.status : 502
          const errType = status === 429 ? 'rate_limit_error' : 'api_error'
          const msg = err?.message || String(err)
          safeEnqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: errType, code: status } })}\n\n`)
          )
          safeEnqueue(encoder.encode('data: [DONE]\n\n'))
          if (!streamClosed) {
            streamClosed = true
            controller.close()
          }
        } finally {
          if (lockedSessionId) {
            sessions?.release(lockedSessionId)
            lockedSessionId = ''
          }
          if (heartbeat) {
            clearInterval(heartbeat)
            heartbeat = null
          }
        }
      },
      cancel() {
        streamClosed = true
        if (lockedSessionId) {
          sessions?.release(lockedSessionId)
          lockedSessionId = ''
        }
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
      },
    })

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  // Non-streaming JSON response (OpenAI format with tool_calls support)
  try {
    let rawText = ''
    let reasoning = ''
    let finalSessionId = ''
    let finalCommittedId = ''
    for await (const ev of runWithRetry()) {
      if (ev.sessionId) finalSessionId = ev.sessionId
      if (ev.lastCommittedId) finalCommittedId = ev.lastCommittedId
      if (ev.kind === 'thinking' && ev.text) reasoning += ev.text
      else if (ev.kind === 'delta' && ev.text) rawText += ev.text
    }

    const parser = createToolCallParser({ enabled: tools.length > 0 })
    const parsedItems = [...parser.push(rawText), ...parser.flush()]
    let outText = ''
    const calls = []
    for (const item of parsedItems) {
      if (item.type === 'tool_call') calls.push(item.call)
      else if (item.type === 'text') outText += item.text
    }
    outText = unescapeNotionText(outText).trim()

    const messageObj = { role: 'assistant', content: calls.length && !outText ? null : outText }
    if (reasoning) messageObj.reasoning_content = reasoning
    if (calls.length) {
      messageObj.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))
    }

    if (sessions && finalSessionId && (outText || calls.length)) {
      saveSessionState({
        sessions,
        lookup,
        assistantMsg: messageObj,
        sessionId: finalSessionId,
        lastCommittedId: finalCommittedId,
      })
    }

    const promptTokens = approxTokens(prepared.message + (prepared.promptContext || ''))
    const completionTokens = approxTokens(outText + JSON.stringify(calls))
    return new Response(
      JSON.stringify({
        id: chatId,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: messageObj, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  } catch (err) {
    const status = err instanceof NotionApiError && err.status >= 400 && err.status < 600 ? err.status : 502
    const errType = status === 429 ? 'rate_limit_error' : 'api_error'
    return new Response(
      JSON.stringify({ error: { message: err?.message || String(err), type: errType, code: status } }),
      { status, headers: { 'content-type': 'application/json' } }
    )
  }
}
