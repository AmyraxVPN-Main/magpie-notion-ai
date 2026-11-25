#!/usr/bin/env node
// magpie-notion-ctl — Orchestrator & management CLI for magpie-notion-ai.
//
// Commands:
//   catalog [--json]                               List all Notion AI models grouped by family with exact supported efforts + current Claude Code route
//   health  [--json]                               Zero-credit pre-flight check (Magpie gateway :3425, Claude CLI, active route, Claude Desktop untouched)
//   select  <model> [effort] [--haiku <model>]     Configure Claude Code in Magpie to use `notion-ai/<model>` + validated `<effort>`
//   run     --cwd <dir> (--prompt <t> | --prompt-file <f>) [--model <id>] [--effort <e>] [--mode acceptEdits|bypassPermissions] [--timeout 300] [--retries 1]
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { KNOWN_NOTION_MODELS } from '../lib/notion.mjs'

const args = process.argv.slice(2)
const cmd = args[0] || 'help'

function hasFlag(name) {
  return args.includes(name)
}

function getFlag(name, fallback = '') {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback
}

function stripPrefix(id) {
  const s = String(id || '').trim()
  return s.startsWith('notion-ai/') ? s.slice('notion-ai/'.length) : s
}

function withWindowsUserPath(env = process.env) {
  if (process.platform !== 'win32') return env
  const extra = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'magpie'),
    path.join(process.env.APPDATA || '', 'npm'),
  ].filter(Boolean)
  const cur = env.Path || env.PATH || ''
  const parts = cur.split(';')
  for (const p of extra) {
    if (!parts.some((x) => x.toLowerCase() === p.toLowerCase())) parts.push(p)
  }
  return { ...env, Path: parts.join(';') }
}

function runSync(bin, binArgs) {
  const env = withWindowsUserPath()
  const isWin = process.platform === 'win32'
  const res = spawnSync(bin, binArgs, {
    encoding: 'utf8',
    env,
    shell: isWin,
    timeout: 15000,
    windowsHide: true,
  })
  return {
    ok: res.status === 0,
    status: res.status ?? -1,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  }
}

async function checkGateway(baseUrl = 'http://127.0.0.1:3425') {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3000)
    const res = await fetch(`${baseUrl}/v1/models`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return { up: false, status: res.status, modelsCount: 0, notionModels: [] }
    const data = await res.json().catch(() => ({}))
    const list = Array.isArray(data?.data) ? data.data : []
    const notionModels = list.filter((m) => String(m?.id || '').startsWith('notion-ai/'))
    return { up: true, status: res.status, modelsCount: list.length, notionModels }
  } catch (err) {
    return { up: false, error: err?.message || String(err), modelsCount: 0, notionModels: [] }
  }
}

async function cmdCatalog() {
  const asJson = hasFlag('--json')
  const gw = await checkGateway()
  const claudeStatus = runSync('magpie', ['claude'])

  const families = {}
  const models = KNOWN_NOTION_MODELS.map((m) => {
    const item = {
      id: m.id,
      providerId: `notion-ai/${m.id}`,
      name: m.name,
      family: m.family || 'Other',
      efforts: m.efforts,
      recommendedEffort: m.efforts.includes('high') ? 'medium' : m.efforts[0] || 'medium',
      context: m.context,
      output: m.output,
    }
    ;(families[item.family] ??= []).push(item)
    return item
  })

  if (asJson) {
    console.log(JSON.stringify({
      gatewayUp: gw.up,
      gatewayModelsCount: gw.modelsCount,
      currentClaude: claudeStatus.stdout,
      families,
      models,
    }, null, 2))
    return
  }

  console.log(`Magpie Gateway (127.0.0.1:3425): ${gw.up ? `UP (${gw.modelsCount} models)` : 'DOWN'}`)
  if (claudeStatus.stdout) console.log(`Current Claude Code: ${claudeStatus.stdout}`)
  console.log('')
  for (const [fam, list] of Object.entries(families)) {
    console.log(`=== ${fam} (${list.length}) ===`)
    for (const m of list) {
      console.log(`  ${m.id.padEnd(20)} | ${m.name.padEnd(20)} | efforts: ${m.efforts.join(', ')}`)
    }
  }
}

async function cmdHealth() {
  const asJson = hasFlag('--json')
  const gw = await checkGateway()
  const claudeRoute = runSync('magpie', ['claude'])
  const desktopRoute = runSync('magpie', ['claude-desktop'])
  const claudeVer = runSync('claude', ['--version'])

  const report = {
    ok: gw.up && claudeVer.ok,
    gateway: { url: 'http://127.0.0.1:3425', up: gw.up, modelsCount: gw.modelsCount, notionCount: gw.notionModels.length },
    claudeCli: { ok: claudeVer.ok, version: claudeVer.stdout },
    claudeCodeRoute: claudeRoute.stdout,
    claudeDesktopRoute: desktopRoute.stdout,
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`Gateway :3425 : ${gw.up ? `OK (${gw.modelsCount} total, ${gw.notionModels.length} notion-ai)` : 'OFFLINE'}`)
    console.log(`Claude CLI    : ${claudeVer.ok ? claudeVer.stdout : 'NOT FOUND'}`)
    console.log(`Claude Code   : ${claudeRoute.stdout || '(unknown)'}`)
    console.log(`Claude Desktop: ${desktopRoute.stdout || '(unknown)'}`)
  }
  if (!report.ok) process.exitCode = 1
}

function cmdSelect() {
  const rawModel = args[1]
  const rawEffort = args[2] && !args[2].startsWith('--') ? args[2].toLowerCase() : ''
  const rawHaiku = getFlag('--haiku', '')
  if (!rawModel || rawModel.startsWith('--')) {
    console.error('Usage: magpie-notion-ctl select <model-id> [effort] [--haiku <model-id>]')
    process.exit(1)
  }

  const modelId = stripPrefix(rawModel)
  const meta = KNOWN_NOTION_MODELS.find((m) => m.id === modelId)
  const allowedEfforts = meta?.efforts || ['low', 'medium', 'high', 'xhigh', 'max']
  const effort = rawEffort || 'medium'
  if (!allowedEfforts.includes(effort)) {
    console.error(`Invalid effort "${effort}" for ${modelId}. Allowed: ${allowedEfforts.join(', ')}`)
    process.exit(1)
  }

  const r1 = runSync('magpie', ['claude', `notion-ai/${modelId}`])
  if (!r1.ok) {
    console.error('Failed to set model:', r1.stderr || r1.stdout)
    process.exit(1)
  }
  const r2 = runSync('magpie', ['claude', 'effort', effort])
  if (!r2.ok) {
    console.error('Failed to set effort:', r2.stderr || r2.stdout)
    process.exit(1)
  }
  if (rawHaiku) {
    const haikuId = stripPrefix(rawHaiku)
    const r3 = runSync('magpie', ['claude', 'haiku', `notion-ai/${haikuId}`])
    if (!r3.ok) {
      console.error('Failed to set haiku model:', r3.stderr || r3.stdout)
      process.exit(1)
    }
  }

  const status = runSync('magpie', ['claude'])
  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      ok: true,
      model: `notion-ai/${modelId}`,
      effort,
      allowedEfforts,
      claudeCodeRoute: status.stdout,
    }, null, 2))
  } else {
    console.log(`Configured: notion-ai/${modelId} (effort=${effort})`)
    console.log(status.stdout)
  }
}

function runClaudeOnce({ cwd, prompt, mode, model, timeoutSec, maxTurns }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const env = withWindowsUserPath()
    const cliArgs = ['-p', '--permission-mode', mode, '--output-format', 'text']
    if (model) cliArgs.push('--model', model.startsWith('notion-ai/') ? model : `notion-ai/${model}`)
    if (maxTurns > 0) cliArgs.push('--max-turns', String(maxTurns))

    const child = spawn('claude', cliArgs, {
      cwd,
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000).unref?.()
    }, timeoutSec * 1000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        code: code ?? -1,
        timedOut,
        durationMs: Date.now() - t0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })

    child.stdin.write(prompt, 'utf8')
    child.stdin.end()
  })
}

async function cmdRun() {
  const cwd = path.resolve(getFlag('--cwd', process.cwd()))
  const promptFile = getFlag('--prompt-file', '')
  const promptArg = getFlag('--prompt', '')
  const model = getFlag('--model', '')
  const effort = getFlag('--effort', '')
  const mode = getFlag('--mode', 'acceptEdits')
  const timeoutSec = Math.max(30, Number(getFlag('--timeout', '300')) || 300)
  const maxTurns = Number(getFlag('--max-turns', '0')) || 0
  const retries = Math.max(0, Math.min(2, Number(getFlag('--retries', '1')) || 0))
  const asJson = hasFlag('--json')

  const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : promptArg
  if (!prompt || !prompt.trim()) {
    console.error('Error: --prompt or --prompt-file is required')
    process.exit(1)
  }

  if (model && effort) {
    const mId = stripPrefix(model)
    runSync('magpie', ['claude', `notion-ai/${mId}`])
    runSync('magpie', ['claude', 'effort', effort])
  } else if (effort) {
    runSync('magpie', ['claude', 'effort', effort])
  }

  let res
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await runClaudeOnce({ cwd, prompt, mode, model, timeoutSec, maxTurns })
    const transient = !res.ok && !res.timedOut && /502|503|504|ECONNRESET|socket|stream/i.test(`${res.stderr} ${res.stdout}`)
    const creditErr = /402|credit|usage limit/i.test(`${res.stderr} ${res.stdout}`)
    if (res.ok || creditErr || !transient || attempt === retries) break
    await new Promise((r) => setTimeout(r, 2000))
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2))
  } else {
    if (res.stdout) console.log(res.stdout)
    if (!res.ok && res.stderr) console.error(res.stderr)
    if (res.timedOut) console.error(`[notion-ctl] Worker timed out after ${timeoutSec}s`)
  }
  if (!res.ok) process.exitCode = res.code || 1
}

if (cmd === 'catalog') {
  await cmdCatalog()
} else if (cmd === 'health') {
  await cmdHealth()
} else if (cmd === 'select') {
  cmdSelect()
} else if (cmd === 'run') {
  await cmdRun()
} else {
  console.log(`magpie-notion-ctl — Notion AI Orchestrator CLI

Usage:
  node bin/notion-ctl.mjs catalog [--json]
  node bin/notion-ctl.mjs health  [--json]
  node bin/notion-ctl.mjs select  <model-id> [effort] [--haiku <model-id>] [--json]
  node bin/notion-ctl.mjs run     --cwd <dir> (--prompt <text> | --prompt-file <file>)
                                  [--model <id>] [--effort <e>] [--mode acceptEdits|bypassPermissions]
                                  [--timeout 300] [--max-turns 0] [--retries 1] [--json]`)
}
