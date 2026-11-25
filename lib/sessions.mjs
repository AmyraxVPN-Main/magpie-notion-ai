// Persistent session store mapping hashed conversation prefixes to Notion session_ids.
// Stores only SHA-256 hashes + Notion UUIDs (never raw message content).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION_DEFAULTS = {
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 200,
}

export function defaultStoreDir() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(cfg, 'magpie', 'notion-ai')
}

export function hashKey(parts) {
  const h = createHash('sha256')
  for (const p of parts) {
    h.update(String(p ?? ''))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 32)
}

export function createSessionStore({ file, ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max } = {}) {
  const map = new Map()

  const load = () => {
    if (!file) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const now = Date.now()
      for (const [k, v] of Object.entries(raw || {})) {
        if (v?.sessionId && now - (v.updatedAt || 0) < ttlMs) map.set(k, v)
      }
    } catch {}
  }

  const save = () => {
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const obj = Object.fromEntries(map.entries())
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 })
    } catch {}
  }

  const prune = () => {
    const now = Date.now()
    for (const [k, v] of map.entries()) {
      if (now - (v.updatedAt || 0) >= ttlMs) map.delete(k)
    }
    while (map.size > max) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  load()

  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return null
      if (Date.now() - (entry.updatedAt || 0) >= ttlMs) {
        map.delete(key)
        save()
        return null
      }
      return entry
    },
    set(key, sessionId) {
      map.delete(key)
      map.set(key, { sessionId, updatedAt: Date.now() })
      prune()
      save()
    },
    delete(key) {
      if (map.delete(key)) save()
    },
    size() {
      return map.size
    },
  }
}
