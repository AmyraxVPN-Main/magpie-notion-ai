// Official Notion Agent APIs client (https://developers.notion.com)
//
// Endpoints used (all official REST + SSE endpoints, Notion-Version: 2026-03-11):
//   GET   /v1/users/me                  — verify Personal Access Token (PAT)
//   POST  /v1/agents/query              — list accessible Custom Agents + their current model
//   GET   /v1/agents/:id                — retrieve one agent's metadata
//   PATCH /v1/agents/:id                — pin a model ({mode:"pinned",id}) or {mode:"auto"}
//   POST  /v1/file_uploads              — create a direct file upload object
//   POST  /v1/file_uploads/:id/send     — upload text/markdown overflow context (<=20MB)
//   POST  /v1/sessions                  — create/continue/resume a session (SSE with continue_from)
//   POST  /v1/sessions/:id/events/query — fallback to read agent reply events

export const NOTION_API_BASE = 'https://api.notion.com/v1'
export const DEFAULT_NOTION_VERSION = '2026-03-11'
export const PERSONAL_AGENT_ID = 'notion_ai'

// Public Notion model IDs live-verified (`200 OK`) on Notion Agent API (2026-03-11),
// each with its tailored reasoning effort variants and context/output limits.
// Any newer model ID requested by a client (or configured on an agent in Notion UI)
// is also discovered automatically and forwarded dynamically to PATCH /v1/agents/:id.
const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const STD_EFFORTS = ['low', 'medium', 'high']

export const KNOWN_NOTION_MODELS = [
  { id: 'auto', name: 'Notion Auto', efforts: STD_EFFORTS, context: 1000000, output: 64000 },
  // Claude 5.5 / Fable 5.x / 5 / 4.x
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: STD_EFFORTS, context: 200000, output: 32000 },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: STD_EFFORTS, context: 200000, output: 32000 },
  // GPT-6.x / 5.x
  { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', efforts: FULL_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', efforts: STD_EFFORTS, context: 200000, output: 32000 },
  { id: 'gpt-5.2', name: 'GPT-5.2', efforts: STD_EFFORTS, context: 200000, output: 32000 },
  // SpaceXAI (Grok)
  { id: 'grok-4.7', name: 'Grok 4.7', efforts: STD_EFFORTS, context: 256000, output: 32000 },
  { id: 'grok-4.6', name: 'Grok 4.6', efforts: STD_EFFORTS, context: 256000, output: 32000 },
  { id: 'grok-4.5', name: 'Grok 4.5', efforts: STD_EFFORTS, context: 256000, output: 32000 },
  { id: 'grok-4.3', name: 'Grok 4.3', efforts: STD_EFFORTS, context: 256000, output: 32000 },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', efforts: STD_EFFORTS, context: 256000, output: 32000 },
  // Gemini
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: STD_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: STD_EFFORTS, context: 1000000, output: 64000 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', efforts: STD_EFFORTS, context: 1000000, output: 64000 },
]

export const MESSAGE_MAX_CHARS = 9800
export const PROMPT_CONTEXT_MAX_CHARS = 9800

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 529])

export class NotionApiError extends Error {
  constructor(message, { status = 502, code = 'notion_api_error', body } = {}) {
    super(message)
    this.name = 'NotionApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export function buildHeaders(token, { version = DEFAULT_NOTION_VERSION, accept = 'application/json', contentType = 'application/json' } = {}) {
  const h = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': version,
    Accept: accept,
  }
  if (contentType) h['Content-Type'] = contentType
  return h
}

async function parseError(res) {
  let text = ''
  try { text = await res.text() } catch {}
  let json = null
  try { json = JSON.parse(text) } catch {}
  const msg = json?.message || json?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`
  const code = json?.code || `http_${res.status}`
  return new NotionApiError(`Notion API error (${res.status}): ${msg}`, { status: res.status, code, body: json || text })
}

async function sleep(ms, signal) {
  if (ms <= 0) return
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(signal.reason || new Error('Aborted')); return }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('Aborted')) }, { once: true })
    }
  })
}

async function fetchWithRetry(fetchImpl, url, init, { retries = 2, signal } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal })
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === retries) {
        return res
      }
      const retryAfter = Number(res.headers.get('retry-after'))
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 800 * (attempt + 1)
      await sleep(delayMs, signal)
    } catch (err) {
      if (signal?.aborted || attempt === retries) throw err
      lastErr = err
      await sleep(800 * (attempt + 1), signal)
    }
  }
  throw lastErr
}

/**
 * Verify a Notion Personal Access Token (PAT) via GET /v1/users/me.
 */
export async function verifyToken(token, { apiBase = NOTION_API_BASE, version = DEFAULT_NOTION_VERSION, fetchImpl = fetch, signal } = {}) {
  const res = await fetchWithRetry(
    fetchImpl,
    `${apiBase.replace(/\/+$/, '')}/users/me`,
    { method: 'GET', headers: buildHeaders(token, { version, contentType: null }) },
    { retries: 1, signal }
  )
  if (!res.ok) throw await parseError(res)
  const data = await res.json()
  return {
    id: data?.id || '',
    name: data?.name || data?.bot?.owner?.user?.name || '',
    email: data?.person?.email || data?.bot?.owner?.user?.person?.email || '',
    type: data?.type || '',
    raw: data,
  }
}

/**
 * Query accessible Notion agents: Custom Agents from POST /v1/agents/query
 * plus personal `notion_ai`. Preserves each agent's current model config.
 */
export async function listAgents(token, { apiBase = NOTION_API_BASE, version = DEFAULT_NOTION_VERSION, fetchImpl = fetch, signal } = {}) {
  const agents = []
  const seen = new Set()

  try {
    const res = await fetchWithRetry(
      fetchImpl,
      `${apiBase.replace(/\/+$/, '')}/agents/query`,
      {
        method: 'POST',
        headers: buildHeaders(token, { version }),
        body: JSON.stringify({ page_size: 50 }),
      },
      { retries: 1, signal }
    )
    if (res.ok) {
      const data = await res.json()
      const items = Array.isArray(data?.results) ? data.results : Array.isArray(data?.agents) ? data.agents : []
      for (const a of items) {
        const id = a?.id || a?.agent_id
        if (!id || seen.has(id)) continue
        if (a?.status && a.status !== 'active') continue
        seen.add(id)
        agents.push({
          id: String(id),
          name: String(a?.name || a?.title || `Notion Agent ${String(id).slice(0, 8)}`),
          kind: id === PERSONAL_AGENT_ID ? 'personal' : 'custom',
          model: a?.model || null,
          isFavorited: Boolean(a?.is_favorited),
        })
      }
    }
  } catch {
    // Workspace may not have Custom Agents enabled; personal notion_ai still works.
  }

  if (!seen.has(PERSONAL_AGENT_ID)) {
    let personalModel = null
    try {
      const pr = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/agents/${PERSONAL_AGENT_ID}`, {
        method: 'GET',
        headers: buildHeaders(token, { version, contentType: null }),
        signal,
      })
      if (pr.ok) {
        const pd = await pr.json()
        personalModel = pd?.model || null
      }
    } catch {}
    agents.push({
      id: PERSONAL_AGENT_ID,
      name: 'Notion AI (Personal)',
      kind: 'personal',
      model: personalModel,
      isFavorited: false,
    })
  }

  return agents
}

/**
 * Pick the primary custom agent for model-routed calls (prefers configured defaultAgentId,
 * then an active "Morning brief" agent, then the first active favorited/custom agent,
 * falling back to `notion_ai`).
 */
export function pickPrimaryAgent(agents, preferredAgentId = '') {
  if (preferredAgentId) {
    const exact = agents.find((a) => a.id === preferredAgentId)
    if (exact) return exact
  }
  const custom = agents.filter((a) => a.kind === 'custom')
  const morningBrief = custom.find((a) => /morning\s*brief/i.test(a.name))
  if (morningBrief) return morningBrief
  const fav = custom.find((a) => a.isFavorited)
  if (fav) return fav
  if (custom.length) return custom[0]
  return agents.find((a) => a.id === PERSONAL_AGENT_ID) || { id: PERSONAL_AGENT_ID, name: 'Notion AI (Personal)', kind: 'personal' }
}

// Per-agent cache of the currently pinned model so we only call PATCH when changing models.
const pinnedModelCache = new Map()

/**
 * Pin an agent's model via official PATCH /v1/agents/{agent_id}.
 * `modelId === "auto"` sets `{"mode":"auto"}`; any other ID sets `{"mode":"pinned","id":modelId}`.
 */
export async function ensureAgentModel(
  token,
  agentId,
  modelId,
  { apiBase = NOTION_API_BASE, version = DEFAULT_NOTION_VERSION, fetchImpl = fetch, signal, force = false } = {}
) {
  const desired = String(modelId || 'auto').trim() || 'auto'
  const cacheKey = `${agentId}`
  if (!force && pinnedModelCache.get(cacheKey) === desired) return desired

  const modelPayload = desired === 'auto'
    ? { mode: 'auto' }
    : { mode: 'pinned', id: desired }

  const res = await fetchWithRetry(
    fetchImpl,
    `${apiBase.replace(/\/+$/, '')}/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      headers: buildHeaders(token, { version }),
      body: JSON.stringify({ model: modelPayload }),
    },
    { retries: 1, signal }
  )
  if (!res.ok) throw await parseError(res)
  pinnedModelCache.set(cacheKey, desired)
  return desired
}

export function clearPinnedModelCache() {
  pinnedModelCache.clear()
}

/**
 * Upload an overflow text/markdown payload via Notion's official Direct File Upload API
 * so sessions never fail Notion's 10,000-character message/prompt_context cap.
 */
export async function uploadTextAttachment(
  token,
  filename,
  text,
  { apiBase = NOTION_API_BASE, version = DEFAULT_NOTION_VERSION, fetchImpl = fetch, signal } = {}
) {
  const base = apiBase.replace(/\/+$/, '')
  const createRes = await fetchWithRetry(
    fetchImpl,
    `${base}/file_uploads`,
    {
      method: 'POST',
      headers: buildHeaders(token, { version }),
      body: JSON.stringify({}),
    },
    { retries: 1, signal }
  )
  if (!createRes.ok) throw await parseError(createRes)
  const created = await createRes.json()
  const uploadId = created?.id
  if (!uploadId) throw new NotionApiError('Notion file_uploads create returned no id', { status: 502 })

  const form = new FormData()
  const blob = new Blob([String(text)], { type: 'text/plain; charset=utf-8' })
  form.append('file', blob, filename)

  const sendRes = await fetchWithRetry(
    fetchImpl,
    `${base}/file_uploads/${encodeURIComponent(uploadId)}/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': version,
      },
      body: form,
    },
    { retries: 1, signal }
  )
  if (!sendRes.ok) throw await parseError(sendRes)

  return {
    type: 'file_upload',
    name: filename,
    file_upload: { id: uploadId },
  }
}

/**
 * Extract normalized info from any Notion session SSE envelope or event payload.
 *
 * Real Notion Agent API (`Notion-Version: 2026-03-11`) SSE envelopes:
 *   event: session.snapshot  -> { type: "session.snapshot", session: { id, ... } }
 *   event: event.provisional -> { type: "event.provisional", event: { id, session_id, type: "agent.message"|"agent.thinking", content: [{type:"text", text:"..."}] } }
 *   event: event.committed   -> { type: "event.committed",   event: { id, session_id, type: "agent.message"|"agent.thinking"|"session.status", content: [...], status } }
 *   event: stream.end        -> { type: "stream.end", session_id, status }
 */
export function extractEventChunk(eventName, payload) {
  if (payload == null) return null
  if (typeof payload === 'string') return { kind: 'delta', text: payload }

  const envType = String(payload.type || eventName || '').toLowerCase()
  const inner = payload.event && typeof payload.event === 'object' ? payload.event : null
  const innerType = inner ? String(inner.type || '').toLowerCase() : ''

  const sessionId =
    payload.session_id ||
    payload.session?.id ||
    inner?.session_id ||
    payload.data?.session_id ||
    (envType.startsWith('session') && payload.id ? payload.id : undefined)

  if (envType === 'session.snapshot' || envType === 'session.created' || envType === 'session.updated' || envType === 'session') {
    return { kind: 'session', sessionId }
  }

  if (envType === 'error' || envType === 'session.error' || envType === 'stream.error' || payload.error || inner?.error) {
    const errObj = payload.error || inner?.error || payload
    const errMsg = errObj?.message || payload.message || JSON.stringify(errObj)
    return { kind: 'error', message: String(errMsg), sessionId }
  }

  if ((envType === 'event.provisional' || envType === 'event.committed') && inner) {
    const isCommitted = envType === 'event.committed'
    const committedId = isCommitted && inner.id ? String(inner.id) : undefined
    const sequence = typeof inner.sequence === 'number' ? inner.sequence : undefined
    if (innerType === 'session.status') {
      const st = String(inner.status || '').toLowerCase()
      if (st === 'failed' || st === 'error') {
        return { kind: 'error', message: inner.error?.message || `Notion session ${st}`, sessionId, committedId, sequence, innerType }
      }
      if (st === 'completed' || st === 'cancelled' || st === 'canceled') {
        return { kind: 'done', sessionId, committedId, sequence, innerType }
      }
      return { kind: 'session', sessionId, committedId, sequence, innerType }
    }
    if (innerType === 'agent.thinking' || innerType.includes('thinking') || innerType.includes('reasoning')) {
      const t = extractTextFromObject(inner)
      if (t) return { kind: isCommitted ? 'thinking_committed' : 'thinking_provisional', eventId: inner.id || '', committedId, sequence, innerType, text: t, sessionId }
      return committedId ? { kind: 'session', sessionId, committedId, sequence, innerType } : null
    }
    if (innerType === 'agent.message' || innerType === 'assistant.message') {
      const t = extractTextFromObject(inner)
      if (t) return { kind: isCommitted ? 'message_committed' : 'message_provisional', eventId: inner.id || '', committedId, sequence, innerType, text: t, sessionId }
      return committedId ? { kind: 'session', sessionId, committedId, sequence, innerType } : null
    }
    return (sessionId || committedId) ? { kind: 'session', sessionId, committedId, sequence, innerType } : null
  }

  if (envType === 'stream.end' || envType === 'done' || envType === 'turn.completed' || envType === 'session.completed' || envType === 'message.completed') {
    const st = String(payload.status || '').toLowerCase()
    if (st === 'failed' || st === 'error') {
      return { kind: 'error', message: payload.error?.message || 'Notion session failed', sessionId }
    }
    // Notion's POST /v1/sessions SSE stream rolls over after ~120s with
    // `event: stream.end` and `status: "in_progress"` (or `"queued"`).
    // Signal `continue` so streamSession immediately reconnects via `continue_from`!
    if (envType === 'stream.end' && (st === 'in_progress' || st === 'queued')) {
      return { kind: 'continue', status: st, sessionId }
    }
    const finalText = extractTextFromObject(payload.data || payload)
    return { kind: 'done', status: st || 'completed', text: finalText || undefined, sessionId }
  }

  if (envType.includes('thinking') || envType.includes('reasoning')) {
    const t = extractTextFromObject(payload.delta || payload.data || payload)
    if (t) return { kind: 'thinking', text: t, sessionId }
  }

  if (envType.includes('delta') || typeof payload.delta === 'string' || (payload.delta && typeof payload.delta === 'object')) {
    const d = payload.delta ?? payload.data ?? payload
    const t = typeof d === 'string' ? d : extractTextFromObject(d)
    if (t) return { kind: 'delta', text: t, sessionId }
  }

  if (envType === 'agent.message' || envType === 'assistant.message' || payload.role === 'assistant') {
    const t = extractTextFromObject(payload.data || payload)
    if (t) return { kind: 'message_committed', eventId: payload.id || '', text: t, sessionId }
  }

  if (sessionId) return { kind: 'session', sessionId }
  return null
}

function extractTextFromObject(obj) {
  if (!obj || typeof obj !== 'object') return ''
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.content === 'string') return obj.content
  if (typeof obj.markdown === 'string') return obj.markdown
  if (typeof obj.message === 'string') return obj.message
  if (obj.text && typeof obj.text.content === 'string') return obj.text.content
  if (Array.isArray(obj.rich_text)) {
    return obj.rich_text.map((r) => r?.plain_text ?? r?.text?.content ?? '').join('')
  }
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        if (typeof part?.plain_text === 'string') return part.plain_text
        if (typeof part?.text?.content === 'string') return part.text.content
        return ''
      })
      .join('')
  }
  return ''
}

async function* parseSseStream(body) {
  const decoder = new TextDecoder()
  let buf = ''
  let eventName = ''
  let dataLines = []

  const flush = () => {
    if (!dataLines.length && !eventName) return null
    const raw = dataLines.join('\n')
    const evt = eventName
    eventName = ''
    dataLines = []
    return { event: evt, data: raw }
  }

  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line === '') {
        const item = flush()
        if (item) yield item
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') eventName = val
      else if (field === 'data') dataLines.push(val)
    }
  }
  const tail = flush()
  if (tail) yield tail
}

export async function querySessionEvents(token, sessionId, { apiBase = NOTION_API_BASE, version = DEFAULT_NOTION_VERSION, fetchImpl = fetch, signal } = {}) {
  const res = await fetchWithRetry(
    fetchImpl,
    `${apiBase.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}/events/query`,
    {
      method: 'POST',
      headers: buildHeaders(token, { version }),
      body: JSON.stringify({ page_size: 50 }),
    },
    { retries: 1, signal }
  )
  if (!res.ok) throw await parseError(res)
  const data = await res.json()
  return Array.isArray(data?.results) ? data.results : Array.isArray(data?.events) ? data.events : []
}

function emitCumulative(prev, next) {
  if (!next) return { nextPrev: prev, delta: '' }
  if (!prev) return { nextPrev: next, delta: next }
  if (next.startsWith(prev)) {
    return { nextPrev: next, delta: next.slice(prev.length) }
  }
  // Only diff minor in-place revisions of the SAME cumulative stream (>=70% prefix overlap);
  // never splice an unrelated/replayed message that happens to share a short prefix.
  let i = 0
  const max = Math.min(prev.length, next.length)
  while (i < max && prev[i] === next[i]) i++
  if (i >= Math.max(32, Math.floor(prev.length * 0.7))) {
    return { nextPrev: next, delta: next.slice(i) }
  }
  return { nextPrev: prev, delta: '' }
}

/**
 * Sort Notion session events chronologically (oldest -> newest) regardless of API sort order,
 * then pick the newest anchor strictly after `priorCommittedId` (never an earlier turn's event).
 */
function pickContinuationAnchor(events, priorCommittedId = '') {
  const valid = (Array.isArray(events) ? events : []).filter((e) => e?.id)
  if (!valid.length) return ''

  const hasSeq = valid.every((e) => typeof e.sequence === 'number')
  const hasTime = !hasSeq && valid.every((e) => typeof e.created_time === 'string' && !Number.isNaN(Date.parse(e.created_time)))
  let chronological
  if (hasSeq) {
    chronological = [...valid].sort((a, b) => a.sequence - b.sequence)
  } else if (hasTime) {
    chronological = [...valid].sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time))
  } else {
    // Notion's query endpoints default to newest-first when no sequence/timestamp is present
    chronological = [...valid].reverse()
  }

  let scoped = chronological
  if (priorCommittedId) {
    const idx = chronological.findIndex((e) => String(e.id) === String(priorCommittedId))
    if (idx >= 0) {
      scoped = chronological.slice(idx + 1)
    }
  }
  if (!scoped.length) return ''

  const userEvs = scoped.filter((e) => String(e?.type || '').toLowerCase() === 'user.message')
  const anchor = userEvs[userEvs.length - 1] || scoped[scoped.length - 1]
  return anchor?.id ? String(anchor.id) : ''
}

/**
 * Send a turn to POST /v1/sessions with SSE streaming (`Accept: text/event-stream`),
 * supporting official `prompt_context`, `attachments`, transient HTTP retries,
 * and mid-stream SSE auto-resume via `{ session_id, continue_from }`.
 */
export async function* streamSession({
  token,
  agentId = PERSONAL_AGENT_ID,
  sessionId,
  priorCommittedId = '',
  message,
  promptContext,
  attachments,
  apiBase = NOTION_API_BASE,
  version = DEFAULT_NOTION_VERSION,
  fetchImpl = fetch,
  signal,
  onRawEvent,
}) {
  const base = apiBase.replace(/\/+$/, '')
  const initialPayload = sessionId
    ? { session_id: sessionId, message }
    : { agent_id: agentId, message }
  if (promptContext) initialPayload.prompt_context = promptContext
  if (Array.isArray(attachments) && attachments.length) initialPayload.attachments = attachments

  let activeSessionId = sessionId || ''
  let lastCommittedId = ''
  const seenCommittedIds = new Set(priorCommittedId ? [String(priorCommittedId)] : [])
  let minAcceptedSeq = -1
  let emittedText = ''
  let currentMsgText = ''
  let currentThinkText = ''
  let anyCommittedMsg = false
  let completed = false
  const MAX_RESUME_WINDOWS = 15

  for (let resumeAttempt = 0; resumeAttempt <= MAX_RESUME_WINDOWS; resumeAttempt++) {
    let reqBody
    if (resumeAttempt === 0) {
      reqBody = initialPayload
    } else if (activeSessionId && lastCommittedId) {
      reqBody = { session_id: activeSessionId, continue_from: lastCommittedId }
    } else {
      break
    }

    const res = await fetchWithRetry(
      fetchImpl,
      `${base}/sessions`,
      {
        method: 'POST',
        headers: buildHeaders(token, { version, accept: 'text/event-stream' }),
        body: JSON.stringify(reqBody),
      },
      { retries: resumeAttempt === 0 ? 2 : 1, signal }
    )

    if (!res.ok) throw await parseError(res)

    const ctype = String(res.headers.get('content-type') || '').toLowerCase()

    if (ctype.includes('text/event-stream') && res.body) {
      let needsContinue = false
      try {
        for await (const { event, data } of parseSseStream(res.body)) {
          if (!data || data === '[DONE]') continue
          let parsed = data
          try { parsed = JSON.parse(data) } catch {}
          onRawEvent?.({ event, data: parsed })

          const chunk = extractEventChunk(event, parsed)
          if (!chunk) continue
          if (chunk.sessionId && chunk.sessionId !== activeSessionId) {
            activeSessionId = chunk.sessionId
            yield { kind: 'session', sessionId: activeSessionId }
          }
          // Ignore replayed events strictly older than this turn's sequence watermark
          if (typeof chunk.sequence === 'number' && minAcceptedSeq >= 0 && chunk.sequence < minAcceptedSeq) {
            continue
          }
          if (chunk.committedId) {
            const alreadySeen = seenCommittedIds.has(chunk.committedId)
            if (alreadySeen) {
              // Never process replayed committed messages/thinking or prior-turn terminal status
              if (chunk.kind === 'message_committed' || chunk.kind === 'thinking_committed' || chunk.kind === 'done') {
                continue
              }
            } else {
              seenCommittedIds.add(chunk.committedId)
              lastCommittedId = chunk.committedId
              if (chunk.innerType === 'user.message' && typeof chunk.sequence === 'number' && minAcceptedSeq < 0) {
                minAcceptedSeq = chunk.sequence
              }
            }
          }
          if (chunk.kind === 'error') {
            const errMsg = chunk.message || 'Notion session stream error'
            const isQuota = /credit|quota|rate.?limit|usage.?limit/i.test(errMsg)
            throw new NotionApiError(errMsg, {
              status: isQuota ? 429 : 502,
              code: isQuota ? 'rate_limited' : 'stream_error',
            })
          }
          if (chunk.kind === 'continue') {
            needsContinue = true
            yield { kind: 'keepalive', sessionId: activeSessionId }
            break
          }
          if (chunk.kind === 'thinking_provisional' && chunk.text) {
            const { nextPrev, delta } = emitCumulative(currentThinkText, chunk.text)
            currentThinkText = nextPrev
            if (delta) yield { kind: 'thinking', text: delta }
          } else if (chunk.kind === 'thinking_committed' && chunk.text) {
            const { delta } = emitCumulative(currentThinkText, chunk.text)
            currentThinkText = ''
            if (delta) yield { kind: 'thinking', text: delta }
          } else if (chunk.kind === 'thinking' && chunk.text) {
            yield { kind: 'thinking', text: chunk.text }
          } else if (chunk.kind === 'message_provisional' && chunk.text) {
            const { nextPrev, delta } = emitCumulative(currentMsgText, chunk.text)
            currentMsgText = nextPrev
            if (delta) {
              emittedText += delta
              yield { kind: 'delta', text: delta }
            }
          } else if (chunk.kind === 'message_committed' && chunk.text) {
            const prefix = anyCommittedMsg && !currentMsgText ? '\n\n' : ''
            const { delta } = emitCumulative(currentMsgText, chunk.text)
            currentMsgText = ''
            anyCommittedMsg = true
            if (delta) {
              emittedText += prefix + delta
              yield { kind: 'delta', text: prefix + delta }
            }
          } else if (chunk.kind === 'delta' && chunk.text) {
            emittedText += chunk.text
            yield { kind: 'delta', text: chunk.text }
          } else if (chunk.kind === 'done') {
            if (chunk.text && !emittedText) {
              emittedText = chunk.text
              yield { kind: 'delta', text: chunk.text }
            }
            completed = true
            break
          } else if (chunk.kind === 'session') {
            // Keep downstream HTTP connections alive while Notion executes internal steps
            yield { kind: 'keepalive', sessionId: activeSessionId }
          }
        }

        if (completed) break

        // Defensive fallback: if stream ended in_progress before any committed event id arrived,
        // fetch session events, sort chronologically, and pick strictly the newest post-prior anchor.
        if ((needsContinue || !completed) && activeSessionId && !lastCommittedId) {
          const evs = await querySessionEvents(token, activeSessionId, { apiBase, version, fetchImpl, signal }).catch(() => [])
          const anchorId = pickContinuationAnchor(evs, priorCommittedId)
          if (anchorId) lastCommittedId = anchorId
        }

        // If stream closed with `in_progress` (or EOF before terminal status), reconnect via `continue_from`
        if ((needsContinue || !completed) && activeSessionId && lastCommittedId && resumeAttempt < MAX_RESUME_WINDOWS) {
          await sleep(300, signal)
          continue
        }
        if (!needsContinue) {
          completed = true
        }
        break
      } catch (err) {
        if (err instanceof NotionApiError || signal?.aborted) throw err
        // Network drop mid-stream: resume cleanly with Notion's official `continue_from`
        if (activeSessionId && lastCommittedId && resumeAttempt < MAX_RESUME_WINDOWS) {
          await sleep(600 * Math.min(resumeAttempt + 1, 4), signal)
          continue
        }
        throw err
      }
    }

    // JSON response fallback
    const json = await res.json().catch(() => ({}))
    onRawEvent?.({ event: 'json', data: json })
    activeSessionId = json?.session_id || json?.id || activeSessionId
    if (activeSessionId) yield { kind: 'session', sessionId: activeSessionId }

    let reply = extractTextFromObject(json?.data || json)
    if (!reply && activeSessionId) {
      const events = await querySessionEvents(token, activeSessionId, { apiBase, version, fetchImpl, signal }).catch(() => [])
      const agentEvents = events.filter((e) => String(e?.type || '').toLowerCase().includes('agent'))
      const last = agentEvents[agentEvents.length - 1]
      reply = extractTextFromObject(last?.data || last)
    }
    if (reply) yield { kind: 'delta', text: reply }
    completed = true
    break
  }

  if (!completed && !emittedText) {
    throw new NotionApiError('Notion session remained in_progress past maximum continuation windows', {
      status: 504,
      code: 'session_timeout',
    })
  }
  yield { kind: 'done', sessionId: activeSessionId, lastCommittedId }
}
