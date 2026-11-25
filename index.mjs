/**
 * magpie-notion-ai — Official Notion Agent APIs (Custom Agents + Notion AI)
 * as a full-featured Magpie / OpenCode OpenAI-compatible provider.
 *
 * Features:
 *   - Uses official Notion Agent APIs (`Notion-Version: 2026-03-11`):
 *     POST /v1/agents/query, PATCH /v1/agents/:id, POST /v1/sessions (SSE + continue_from),
 *     POST /v1/file_uploads (auto-attaches oversized prompts > 10k chars).
 *   - Exposes all verified Notion workspace models (`claude-opus-5-5`, `claude-sonnet-5-5`,
 *     `gpt-5.5`, `gpt-5.4`, `auto`, etc.) routed via your active primary Custom Agent
 *     (auto-picks "Morning brief" if active, or `options.defaultAgentId`), plus all Custom
 *     Agents directly.
 *   - Full streaming `<tool_call>` bridge so Claude Code, Codex, Cline, and other coding
 *     agents can read/edit files and run tools seamlessly.
 *
 * Options (`magpie plugin options notion-ai '{...}'`), all optional:
 *   defaultAgentId  Explicit agent UUID to route model-pinned calls through (default: auto-picks Morning brief)
 *   extraModels     Array of additional Notion public model IDs to list in Magpie
 *   apiBase         Override Notion API base URL (default https://api.notion.com/v1)
 *   notionVersion   Override Notion-Version header (default 2026-03-11)
 *   sessionReuse    Continue Notion sessions across turns (default true)
 *   sessionTtlMs    Cached session TTL in ms (default 86400000 = 24h)
 *   sessionMax      Max cached sessions (default 200)
 *   sessionDir      Directory for session cache file
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildCatalogModels, handleChatCompletions, handleModels } from './lib/handler.mjs'
import {
  DEFAULT_NOTION_VERSION,
  listAgents,
  NOTION_API_BASE,
  pickPrimaryAgent,
  verifyToken,
} from './lib/notion.mjs'
import { createSessionStore, defaultStoreDir, SESSION_DEFAULTS } from './lib/sessions.mjs'

const PROVIDER = 'notion-ai'
// Virtual URL intercepted by the plugin loader's custom fetch.
const BASE = 'https://api.notion.com/magpie-notion-ai/v1'

const BASE_MODEL = {
  limit: { context: 200000, output: 32768 },
  tool_call: true,
  api: { url: BASE, npm: '@ai-sdk/openai-compatible' },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true },
    interleaved: false,
  },
}

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return null
  }
}

async function readBody(input, init) {
  let raw = init?.body
  if (raw == null && input instanceof Request) raw = await input.text()
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
  if (typeof raw !== 'string') raw = raw == null ? '' : String(raw)
  return JSON.parse(raw || '{}')
}

function headerOf(input, init, name) {
  try {
    const own = init?.headers ? new Headers(init.headers).get(name) : null
    return own ?? (input instanceof Request ? input.headers.get(name) : null) ?? undefined
  } catch {
    return undefined
  }
}

function makeSessions(opts) {
  if (opts.sessionReuse === false || opts.sessionReuse === 'false' || opts.sessionReuse === 0) return undefined
  const ttlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_DEFAULTS.ttlMs
  const max = Number(opts.sessionMax) > 0 ? Math.floor(Number(opts.sessionMax)) : SESSION_DEFAULTS.max
  const dir = opts.sessionDir || defaultStoreDir()
  return createSessionStore({ ttlMs, max, file: path.join(dir, 'notion-sessions.json') })
}

function makeFetch(token, opts, sessions, getPrimaryAgentId) {
  const identity = createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
  return async function notionFetch(input, init) {
    const url = requestUrl(input)
    const pathname = url?.pathname ?? ''

    if (/\/models\/?$/.test(pathname) && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return handleModels({ token, options: { ...opts, getPrimaryAgentId }, signal: init?.signal })
    }

    if (!/\/chat\/completions\/?$/.test(pathname)) {
      return new Response(
        JSON.stringify({ error: { message: `magpie-notion-ai supports /models and /chat/completions (got ${pathname})`, type: 'invalid_request_error' } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    }

    let body
    try {
      body = await readBody(input, init)
    } catch {
      return new Response(
        JSON.stringify({ error: { message: 'Request body must be valid JSON', type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }

    const sessionKey = ['x-magpie-session', 'session_id', 'x-session-id', 'x-session-affinity', 'x-thread-id', 'x-conversation-id']
      .map((n) => headerOf(input, init, n))
      .find((v) => typeof v === 'string' && v.trim())
    const freshHeader = String(headerOf(input, init, 'x-notion-fresh-session') || '').trim().toLowerCase()
    const freshSession = freshHeader === '1' || freshHeader === 'true' || freshHeader === 'yes'
    const inlineHeader = String(headerOf(input, init, 'x-notion-inline-only') || '').trim().toLowerCase()
    const inlineOnly = inlineHeader === '1' || inlineHeader === 'true' || inlineHeader === 'yes'
    const agentOverride = String(headerOf(input, init, 'x-notion-agent-id') || '').trim()

    return handleChatCompletions({
      body,
      token,
      sessions,
      options: {
        ...opts,
        identity,
        sessionKey,
        freshSession,
        inlineOnly,
        ...(agentOverride ? { defaultAgentId: agentOverride } : {}),
        getPrimaryAgentId,
      },
      effortHeader: headerOf(input, init, 'x-magpie-effort'),
      signal: init?.signal,
    })
  }
}

export const NotionAiAuthPlugin = async (_input, options) => {
  const opts = options && typeof options === 'object' ? options : {}
  const sessions = makeSessions(opts)
  const apiBase = opts.apiBase || NOTION_API_BASE
  const notionVersion = opts.notionVersion || DEFAULT_NOTION_VERSION

  // Cache primary agent discovery for 5 minutes so every request doesn't re-query /v1/agents/query
  let primaryCache = { tokenHash: '', agentId: '', at: 0 }
  const getPrimaryAgentId = async (token, signal) => {
    if (opts.defaultAgentId) return opts.defaultAgentId
    const th = createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
    if (primaryCache.tokenHash === th && primaryCache.agentId && Date.now() - primaryCache.at < 5 * 60_000) {
      return primaryCache.agentId
    }
    const agents = await listAgents(token, { apiBase, version: notionVersion, fetchImpl: opts.fetchImpl, signal })
    const primary = pickPrimaryAgent(agents, opts.defaultAgentId)
    primaryCache = { tokenHash: th, agentId: primary.id, at: Date.now() }
    return primary.id
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'Notion AI',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: Number(opts.maxConcurrency) > 0 ? Math.floor(Number(opts.maxConcurrency)) : 1,
      methods: [
        {
          type: 'api',
          label: 'Notion Personal Access Token (PAT)',
          prompts: [
            {
              type: 'text',
              key: 'key',
              message: 'Paste your Notion Personal Access Token (Notion Settings → Developer Mode → Personal access tokens)',
              placeholder: 'ntn_...',
              validate: (v) => (String(v || '').trim().length >= 10 ? undefined : 'Please enter a valid Notion token'),
            },
          ],
          authorize: async (inputs, { signal } = {}) => {
            const raw = String(inputs?.key || inputs?.apiKey || '').trim()
            if (!raw) return { type: 'failed', error: 'Notion Personal Access Token is required' }
            try {
              const user = await verifyToken(raw, { apiBase, version: notionVersion, fetchImpl: opts.fetchImpl, signal })
              const account = user.email || user.name || user.id || 'Notion user'
              return { type: 'success', key: raw, metadata: { account, userId: user.id } }
            } catch (err) {
              return { type: 'failed', error: `Notion token verification failed: ${String(err?.message || err).slice(0, 300)}` }
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const token = auth?.type === 'api' ? String(auth.key || '').trim() : ''
        if (!token) return {}
        return {
          baseURL: BASE,
          apiKey: 'notion-ai-pat',
          fetch: makeFetch(token, { ...opts, apiBase, notionVersion }, sessions, getPrimaryAgentId),
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const token = auth?.type === 'api' ? String(auth.key || '').trim() : ''
        if (!token) return provider.models
        const list = await buildCatalogModels(token, { ...opts, apiBase, notionVersion })
        const out = {}
        for (const m of list) {
          const entry = structuredClone(BASE_MODEL)
          entry.name = m.name
          entry.limit = {
            context: m.context || BASE_MODEL.limit.context,
            output: m.output || BASE_MODEL.limit.output,
          }
          if (Array.isArray(m.efforts) && m.efforts.length) {
            entry.reasoning = true
            entry.variants = Object.fromEntries(m.efforts.map((effort) => [effort, {}]))
          }
          out[m.id] = entry
        }
        return out
      },
    },
  }
}

export const _internal = { makeFetch, makeSessions, PROVIDER, BASE, BASE_MODEL }
