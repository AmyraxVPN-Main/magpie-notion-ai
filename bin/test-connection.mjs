#!/usr/bin/env node
// Standalone diagnostic CLI to test your Notion Personal Access Token (PAT),
// list accessible agents, and run a live streaming chat test against POST /v1/sessions.
//
// Usage:
//   node bin/test-connection.mjs --token ntn_... [--prompt "Say OK"] [--agent notion_ai] [--raw-sse]
//   NOTION_API_KEY=ntn_... node bin/test-connection.mjs
import { listAgents, PERSONAL_AGENT_ID, streamSession, verifyToken } from '../lib/notion.mjs'

const args = process.argv.slice(2)
function flag(name, fallback = '') {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback
}

const token = (flag('--token') || process.env.NOTION_API_KEY || '').trim()
const agentId = flag('--agent', PERSONAL_AGENT_ID)
const prompt = flag('--prompt', 'Reply with exactly: NOTION_AI_OK')
const rawSse = args.includes('--raw-sse')

if (!token) {
  console.error('Usage: node bin/test-connection.mjs --token <NOTION_PAT> [--agent notion_ai] [--prompt "..."] [--raw-sse]')
  process.exit(1)
}

console.log('1) Verifying Notion Personal Access Token (GET /v1/users/me)...')
const user = await verifyToken(token)
console.log(`   OK: ${user.name || user.id}${user.email ? ` <${user.email}>` : ''} (type=${user.type})`)

console.log('2) Listing accessible Notion AI agents (POST /v1/agents/query)...')
const agents = await listAgents(token)
for (const a of agents) {
  console.log(`   - ${a.id} (${a.name}) [${a.kind}]`)
}

console.log(`3) Testing live session stream (POST /v1/sessions, agent_id=${agentId})...`)
let text = ''
let sid = ''
for await (const ev of streamSession({
  token,
  agentId,
  message: prompt,
  onRawEvent: rawSse ? (raw) => console.error('[raw]', JSON.stringify(raw)) : undefined,
})) {
  if (ev.sessionId) sid = ev.sessionId
  if (ev.kind === 'delta') {
    process.stdout.write(ev.text)
    text += ev.text
  }
}
console.log(`\n\nDone. session_id=${sid || '(none)'}, chars=${text.length}`)
