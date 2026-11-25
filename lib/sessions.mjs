// Persistent session store mapping hashed conversation prefixes to Notion session_ids.
// Stores only SHA-256 hashes + Notion UUIDs + last committed event anchor (never raw message content).
// Modeled after magpie-aws-quick's strict-prefix + fuzzy-anchor + claim-on-use session engine
// so parallel subagents never collide on a shared Notion session.
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

export function createSessionStore({ file, ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now() } = {}) {
  const map = new Map()
  const inFlight = new Set()
  let saveTimer = null

  const load = () => {
    if (!file) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const t = now()
      for (const [k, v] of Object.entries(raw || {})) {
        if (v?.sessionId && t - (v.updatedAt || 0) < ttlMs) {
          map.set(k, {
            sessionId: String(v.sessionId),
            lastCommittedId: typeof v.lastCommittedId === 'string' ? v.lastCommittedId : '',
            replyKey: typeof v.replyKey === 'string' ? v.replyKey : '',
            tailKey: typeof v.tailKey === 'string' ? v.tailKey : '',
            updatedAt: Number(v.updatedAt) || t,
          })
        }
      }
    } catch {}
  }

  const flushSave = () => {
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const obj = Object.fromEntries(map.entries())
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {}
  }

  const save = () => {
    if (!file) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, 150)
    saveTimer.unref?.()
  }

  const prune = () => {
    const t = now()
    for (const [k, v] of map.entries()) {
      if (t - (v.updatedAt || 0) >= ttlMs) map.delete(k)
    }
    while (map.size > max) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  const live = (key) => {
    const entry = map.get(key)
    if (!entry) return null
    if (now() - (entry.updatedAt || 0) >= ttlMs) {
      map.delete(key)
      save()
      return null
    }
    return entry
  }

  load()

  return {
    has(key) {
      return Boolean(live(key))
    },
    get(key) {
      return live(key)
    },
    /** Claim-on-use: removes the entry on match so a retry never double-replays the same turn. */
    take(key) {
      const entry = live(key)
      if (!entry) return null
      map.delete(key)
      save()
      return entry
    },
    findEntry(pred) {
      const t = now()
      for (const [key, entry] of map.entries()) {
        if (t - (entry.updatedAt || 0) >= ttlMs) {
          map.delete(key)
          continue
        }
        if (pred(entry)) return { key, entry }
      }
      return null
    },
    set(key, sessionIdOrEntry) {
      const entry = typeof sessionIdOrEntry === 'string'
        ? { sessionId: sessionIdOrEntry, lastCommittedId: '', replyKey: '', tailKey: '', updatedAt: now() }
        : {
            sessionId: String(sessionIdOrEntry?.sessionId || ''),
            lastCommittedId: typeof sessionIdOrEntry?.lastCommittedId === 'string' ? sessionIdOrEntry.lastCommittedId : '',
            replyKey: typeof sessionIdOrEntry?.replyKey === 'string' ? sessionIdOrEntry.replyKey : '',
            tailKey: typeof sessionIdOrEntry?.tailKey === 'string' ? sessionIdOrEntry.tailKey : '',
            updatedAt: now(),
          }
      if (!entry.sessionId) return
      map.delete(key)
      map.set(key, entry)
      prune()
      save()
    },
    delete(key) {
      if (map.delete(key)) save()
    },
    /** Prevent two concurrent requests from sending simultaneous turns to the same Notion session_id. */
    acquire(sessionId) {
      if (!sessionId || inFlight.has(sessionId)) return false
      inFlight.add(sessionId)
      return true
    },
    release(sessionId) {
      if (sessionId) inFlight.delete(sessionId)
    },
    size() {
      return map.size
    },
  }
}
