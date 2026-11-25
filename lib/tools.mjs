// OpenAI tools <-> Notion Agent text convention bridge + streaming parser.
//
// Notion's Agent API runs Notion-side tools internally and has no external client
// tool-calling channel. To let Claude Code / Codex / Cline use Notion AI as a full
// coding model, we inject compact client tool specs into `prompt_context` (or an
// attached file when large) and parse `<tool_call>{"name":...,"arguments":...}</tool_call>`
// blocks back into standard OpenAI `tool_calls`.
import { randomUUID } from 'node:crypto'

const SCHEMA_ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', 'default', '$comment',
  'deprecated', 'readOnly', 'writeOnly', 'markdownDescription',
])
const SCHEMA_NESTED = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not'])
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    const schema = fn.parameters ?? fn.input_schema
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} },
    })
  }
  return out
}

export function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 6) return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(k)) continue
    if (SCHEMA_NESTED.has(k) && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, slimSchema(pv, depth + 1)]))
    } else if (SCHEMA_SINGLE.has(k) && v && typeof v === 'object') {
      out[k] = slimSchema(v, depth + 1)
    } else if (SCHEMA_ARRAY.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => slimSchema(x, depth + 1))
    } else {
      out[k] = v
    }
  }
  return out
}

function boundedParams(t) {
  const slim = slimSchema(t.parameters)
  const json = JSON.stringify(slim)
  if (json.length <= 2048) return slim
  const required = Array.isArray(t.parameters?.required) ? t.parameters.required : []
  return { type: 'object', properties: {}, ...(required.length ? { required } : {}) }
}

export function buildToolPreamble(tools, toolChoice, { reminder = false, maxChars = 8500 } = {}) {
  if (!tools.length) return ''
  const tc = typeof toolChoice === 'object' && toolChoice !== null ? toolChoice : null
  const forcedName = tc?.function?.name ?? (tc?.type === 'tool' ? tc.name : undefined)
  const forcedAny = Boolean(forcedName) || toolChoice === 'required' || tc?.type === 'any'
  const shown = forcedName ? tools.filter((t) => t.name === forcedName) : tools
  const list = shown.length ? shown : tools

  const mustLine = forcedName
    ? `You MUST invoke client tool "${forcedName}" now — reply ONLY with its <tool_call> block.`
    : forcedAny
      ? 'You MUST invoke one or more client tools now — reply ONLY with <tool_call> block(s).'
      : ''

  if (reminder) {
    return [
      '[Client tools reminder]',
      `Available client tools: ${list.slice(0, 80).map((t) => t.name).join(', ')}.`,
      'To invoke a client tool, output ONLY: <tool_call>{"name":"<tool_name>","arguments":{...}}</tool_call> (do NOT escape underscores or JSON characters; do NOT wrap inside markdown fences).',
      'Do NOT run Notion/Slack/Calendar/Mail workspace tools for coding tasks unless explicitly asked.',
      mustLine,
    ].filter(Boolean).join('\n')
  }

  const header = [
    '[Client Tool Calling Protocol]',
    'You are acting as a coding/assistant backend for a local application that executes client tools on the user machine and sends results back as [tool_result ...] messages.',
    'Do NOT use Notion/Slack/Calendar/Mail built-in workspace tools unless the user explicitly asks about their Notion workspace.',
    'When you need to call a client tool, output ONLY raw <tool_call> block(s) with valid JSON (no markdown code fences around <tool_call>, no extra commentary):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json object>}}</tool_call>',
    'Rules:',
    '- One <tool_call>...</tool_call> block per tool call; multiple blocks are allowed.',
    '- After receiving [tool_result ...], continue solving the task.',
    mustLine,
    'Client tools:',
  ].filter(Boolean).join('\n')

  const fullSpecs = list
    .map((t) => `- ${t.name}: ${String(t.description || '').slice(0, 180)}\n  params: ${JSON.stringify(boundedParams(t))}`)
    .join('\n')
  if (header.length + fullSpecs.length + 2 <= maxChars) {
    return `${header}\n${fullSpecs}`
  }

  const liteSpecs = list
    .map((t) => `- ${t.name}: ${String(t.description || '(no description)').slice(0, 140)}`)
    .join('\n')
  if (header.length + liteSpecs.length + 2 <= maxChars) {
    return `${header}\n${liteSpecs}`
  }

  return `${header}\n${list.map((t) => `- ${t.name}`).join('\n')}`
}

/**
 * Gently unescape Notion's markdown escaping (`\_`, `\*`, `\<`, `\>`) when it
 * leaks into plain text or `<tool_call>` payloads, without touching fenced code.
 */
export function unescapeNotionText(text) {
  if (!text || !text.includes('\\')) return text
  // Preserve ```...``` fenced code blocks verbatim
  const parts = String(text).split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part
      return part.replace(/\\([_*<>[\]])/g, '$1')
    })
    .join('')
}

function parseToolCallBody(raw) {
  // Unescape any Notion markdown escapes inside the JSON block (`\_` -> `_`)
  let cleaned = String(raw || '').trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  const attempts = [cleaned, cleaned.replace(/\\([_*<>[\]])/g, '$1')]
  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate)
      if (obj && typeof obj.name === 'string' && obj.name.trim()) {
        const args = obj.arguments ?? obj.input ?? obj.params ?? {}
        return {
          id: `call_notion_${randomUUID().slice(0, 12)}`,
          name: obj.name.trim(),
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        }
      }
    } catch {}
  }
  return null
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let len = max; len >= 1; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

/**
 * Stateful streaming parser that separates plain text from `<tool_call>...</tool_call>`
 * blocks, handling tags split across arbitrary SSE chunks and Notion markdown escaping.
 */
export function createToolCallParser({ enabled = false } = {}) {
  let buf = ''
  let inside = false
  let currentBody = ''

  const normalizeTagEscapes = (s) =>
    s
      .replace(/\\<tool\\_call\\>/g, OPEN_TAG)
      .replace(/<tool\\_call>/g, OPEN_TAG)
      .replace(/\\<\/tool\\_call\\>/g, CLOSE_TAG)
      .replace(/<\/tool\\_call>/g, CLOSE_TAG)

  return {
    push(chunk) {
      const out = []
      if (!chunk) return out
      if (!enabled) {
        out.push({ type: 'text', text: chunk })
        return out
      }
      buf += chunk
      // Only normalize escaped tag forms once enough characters exist
      buf = normalizeTagEscapes(buf)

      while (buf.length > 0) {
        if (!inside) {
          const openIdx = buf.indexOf(OPEN_TAG)
          if (openIdx >= 0) {
            if (openIdx > 0) out.push({ type: 'text', text: buf.slice(0, openIdx) })
            buf = buf.slice(openIdx + OPEN_TAG.length)
            inside = true
            currentBody = ''
            continue
          }
          // Hold back any partial prefix of `<tool_call>` or `\<tool\_call\>`
          const hold = Math.max(
            heldPrefixLen(buf, OPEN_TAG),
            heldPrefixLen(buf, '<tool\\_call>'),
            heldPrefixLen(buf, '\\<tool\\_call\\>')
          )
          const safe = buf.length - hold
          if (safe > 0) {
            out.push({ type: 'text', text: buf.slice(0, safe) })
            buf = buf.slice(safe)
          }
          break
        } else {
          const closeIdx = buf.indexOf(CLOSE_TAG)
          if (closeIdx >= 0) {
            currentBody += buf.slice(0, closeIdx)
            buf = buf.slice(closeIdx + CLOSE_TAG.length)
            inside = false
            const parsed = parseToolCallBody(currentBody)
            if (parsed) {
              out.push({ type: 'tool_call', call: parsed })
            } else {
              out.push({ type: 'text', text: `${OPEN_TAG}${currentBody}${CLOSE_TAG}` })
            }
            currentBody = ''
            continue
          }
          const hold = Math.max(
            heldPrefixLen(buf, CLOSE_TAG),
            heldPrefixLen(buf, '</tool\\_call>'),
            heldPrefixLen(buf, '\\</tool\\_call\\>')
          )
          const safe = buf.length - hold
          if (safe > 0) {
            currentBody += buf.slice(0, safe)
            buf = buf.slice(safe)
          }
          break
        }
      }
      return out
    },

    flush() {
      const out = []
      if (inside) {
        const tail = currentBody + buf
        const parsed = parseToolCallBody(tail)
        if (parsed) out.push({ type: 'tool_call', call: parsed })
        else if (tail) out.push({ type: 'text', text: `${OPEN_TAG}${tail}` })
      } else if (buf) {
        out.push({ type: 'text', text: buf })
      }
      buf = ''
      currentBody = ''
      inside = false
      return out
    },
  }
}
