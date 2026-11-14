/**
 * Snapshots of what a reviewed change replaced, so an accepted write can be
 * taken back.
 *
 * The shape follows what Claude Code settled on for the same job: a whole-file
 * copy rather than a patch chain, content-addressed so two writes of the same
 * bytes cost one copy, one index per conversation, and a cap that trims the
 * oldest entries. A patch chain would need every intermediate version to be
 * replayable; a copy is the state itself, so restoring it cannot fail halfway.
 *
 * Nothing here touches the filesystem service: the module owns the store, the
 * caller owns the workspace. That split lets the store be tested without a fake
 * host, and it keeps `ctx.fs` the only thing that writes files a user cares
 * about.
 *
 * Every operation is best-effort and swallows its own errors. A snapshot that
 * cannot be written must not change a tool's fate — the review already happened.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/** Entries kept per conversation. Older ones are trimmed, blobs and all. */
const MAX_ENTRIES_PER_SESSION = 200

/** A single snapshot larger than this is recorded but not restorable. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024

/** Upper bound on one conversation's blobs; trimming starts at the oldest. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * The only operations worth a history row.
 *
 * A shell record can also be `shell` (a command whose effect is unknown) or
 * carry a verb we could not pin to a file. Neither can be put back, and listing
 * them buried the three operations a reader actually came for.
 */
const TRACKED_OPS = new Set(['create', 'update', 'delete'])

/** SHA-256 over the UTF-8 bytes, or `null` when the digest cannot be taken. */
export function sha256(text) {
  try {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  } catch {
    return null
  }
}

const byteLength = (text) => Buffer.byteLength(text, 'utf8')

/**
 * A session id is not a safe path segment: it may contain separators, and it
 * arrives from the browser half. Hash it, so the directory name can never
 * escape the store.
 */
const sessionKey = (sessionId) => `s${String(sha256(String(sessionId))).slice(0, 16)}`

const listDir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Build the snapshot store.
 *
 * `enabled` is read on every call rather than captured once, because it is a
 * live setting; `root` is the absolute store directory.
 */
export function createHistory({ root, enabled }) {
  const active = () => enabled() === true && typeof root === 'string' && root !== ''

  const dirOf = (sessionId) => `${root}/${sessionKey(sessionId)}`
  const blobDirOf = (sessionId) => `${dirOf(sessionId)}/blobs`
  const indexPathOf = (sessionId) => `${dirOf(sessionId)}/index.json`

  const ensureDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  const loadIndex = (sessionId) => {
    try {
      const parsed = JSON.parse(readFileSync(indexPathOf(sessionId), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { entries: [] }
      return { entries: parsed.entries.filter((item) => item !== null && typeof item === 'object') }
    } catch {
      // A missing or corrupt index is an empty one: losing history is survivable,
      // throwing inside the gate is not.
      return { entries: [] }
    }
  }

  const saveIndex = (sessionId, store) => {
    if (!ensureDir(dirOf(sessionId)) || !ensureDir(blobDirOf(sessionId))) return false
    try {
      // Write then rename: a half-written index would lose every entry at once,
      // and this file is the only record of what the blobs mean.
      const next = `${indexPathOf(sessionId)}.tmp`
      writeFileSync(next, JSON.stringify(store), 'utf8')
      renameSync(next, indexPathOf(sessionId))
      return true
    } catch {
      return false
    }
  }

  /**
   * Store one blob and return its hash, or `null` when it cannot be kept.
   * Content addressing means a file written twice from the same base costs one
   * copy, which is the common case in a refactor loop.
   */
  const putBlob = (sessionId, text) => {
    const hash = sha256(text)
    if (hash === null) return null
    const path = `${blobDirOf(sessionId)}/${hash}`
    if (listDir(blobDirOf(sessionId)).includes(hash)) return hash
    if (byteLength(text) > MAX_BLOB_BYTES) return null
    if (!ensureDir(blobDirOf(sessionId))) return null
    try {
      const next = `${path}.tmp`
      writeFileSync(next, text, 'utf8')
      renameSync(next, path)
      return hash
    } catch {
      return null
    }
  }

  const getBlob = (sessionId, hash) => {
    if (typeof hash !== 'string' || hash === '') return null
    try {
      return readFileSync(`${blobDirOf(sessionId)}/${hash}`, 'utf8')
    } catch {
      return null
    }
  }

  const totalBytes = (sessionId) => {
    const dir = blobDirOf(sessionId)
    let total = 0
    for (const name of listDir(dir)) {
      try {
        total += statSync(`${dir}/${name}`).size
      } catch {
        /* raced away: it does not count */
      }
    }
    return total
  }

  /** Drop blobs no surviving entry refers to. */
  const collectBlobs = (sessionId, store) => {
    const keep = new Set()
    for (const entry of store.entries) {
      if (typeof entry.beforeSha === 'string') keep.add(entry.beforeSha)
    }
    const dir = blobDirOf(sessionId)
    for (const name of listDir(dir)) {
      if (keep.has(name)) continue
      try {
        unlinkSync(`${dir}/${name}`)
      } catch {
        /* a blob that will not go away is not a correctness problem */
      }
    }
  }

  /** Trim oldest-first until the caps hold, then drop the orphaned blobs. */
  const prune = (sessionId, store) => {
    let trimmed = false
    while (store.entries.length > MAX_ENTRIES_PER_SESSION) {
      store.entries.shift()
      trimmed = true
    }
    while (store.entries.length > 1 && totalBytes(sessionId) > MAX_TOTAL_BYTES) {
      store.entries.shift()
      trimmed = true
    }
    if (trimmed) collectBlobs(sessionId, store)
  }

  /**
   * Record what a parked change is about to replace.
   *
   * Called before the reviewer answers, not after: an unanswered review times
   * out and is allowed through, and by then the bytes are gone. Capture first,
   * decide second, and an undo exists for every outcome that touched the disk.
   *
   * Returns the stored entry, or `undefined` when there is nothing to restore.
   */
  const record = (rec) => {
    if (!active()) return undefined
    if (rec === null || typeof rec !== 'object') return undefined
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : ''
    if (sessionId === '') return undefined
    if (typeof rec.path !== 'string' || rec.path.trim() === '') return undefined
    // Only the three operations that actually add, change or remove a file are
    // worth keeping. A command-level review (`Remove-Item $x`, `iex $code`) has
    // no file of its own to put back, and a listing of every one of those turns
    // the history into a log nobody scrolls.
    if (!TRACKED_OPS.has(rec.op)) return undefined
    // A command-level record names no file of its own: it may touch anything the
    // shell decides, so there is nothing precise to put back. A command that
    // names exactly one file is the useful exception — its `path` is that file.
    if (Array.isArray(rec.targets) && rec.targets.length !== 1) return undefined
    // A shell record whose outcome was not derived carries an empty `before`
    // even when the file exists. Storing that would make "undo" blank the file,
    // which is worse than having no undo at all.
    if (rec.tool === 'pwsh' && rec.known !== true) return undefined

    const existed = rec.op !== 'create'
    const before = typeof rec.before === 'string' ? rec.before : ''
    // A truncated `before` is not the file: restoring it would silently cut the
    // tail off a large one. Keep the entry as history, refuse the undo.
    const complete = rec.truncated !== true
    const beforeSha = existed && complete ? putBlob(sessionId, before) : null
    const restorable = existed ? beforeSha !== null : true

    /**
     * What the file must look like for the undo to be safe. Verifying this is
     * the difference between "take my change back" and "throw away whatever
     * happened afterwards": a stale restore would revert edits made after the
     * change being undone.
     */
    let verify = null
    if (rec.known === true) {
      if (rec.op === 'delete') verify = { kind: 'absent' }
      else if (typeof rec.after === 'string') verify = { kind: 'sha', sha: sha256(rec.after) }
    }

    const entry = {
      id: rec.id,
      sessionId,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
      path: rec.path,
      op: rec.op,
      tool: rec.tool,
      at: Date.now(),
      existed,
      beforeSha,
      beforeBytes: existed ? byteLength(before) : 0,
      afterBytes: typeof rec.after === 'string' ? byteLength(rec.after) : 0,
      restorable,
      verify,
      state: 'pending',
      restoredAt: null,
    }
    const store = loadIndex(sessionId)
    store.entries.push(entry)
    prune(sessionId, store)
    saveIndex(sessionId, store)
    return entry
  }

  /** Record how the reviewer answered, so the list can say what happened. */
  const settle = (sessionId, id, outcome) => {
    if (!active()) return
    const store = loadIndex(sessionId)
    const entry = store.entries.find((item) => item.id === id)
    if (entry === undefined) return
    entry.state = outcome === 'accept'
      ? 'accepted'
      : outcome === 'allow'
        // The manual switch waved it through without asking. It is not the same
        // as "accepted": nobody looked at it, and the list should say so.
        ? 'allowed'
        : outcome === 'timeout'
          ? 'timeout'
          : outcome === 'cancel' ? 'cancelled' : 'rejected'
    saveIndex(sessionId, store)
  }

  const markRestored = (sessionId, id) => {
    if (!active()) return
    const store = loadIndex(sessionId)
    const entry = store.entries.find((item) => item.id === id)
    if (entry === undefined) return
    entry.restoredAt = Date.now()
    saveIndex(sessionId, store)
  }

  /** Newest first: the change a reader wants back is almost always the last. */
  const list = (sessionId) => {
    if (!active()) return []
    if (typeof sessionId !== 'string' || sessionId === '') return []
    return loadIndex(sessionId).entries.slice().sort((a, b) => b.at - a.at)
  }

  const read = (sessionId, id) => {
    if (!active()) return undefined
    if (typeof sessionId !== 'string' || sessionId === '' || typeof id !== 'string') return undefined
    const entry = loadIndex(sessionId).entries.find((item) => item.id === id)
    if (entry === undefined) return undefined
    return { entry, before: entry.existed ? getBlob(sessionId, entry.beforeSha) : '' }
  }

  /** Remove one conversation's history, so a reader can clear the list. */
  const forget = (sessionId) => {
    if (!active()) return false
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const dir = dirOf(sessionId)
    for (const name of listDir(`${dir}/blobs`)) {
      try {
        unlinkSync(`${dir}/blobs/${name}`)
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(indexPathOf(sessionId))
    } catch {
      /* nothing to remove */
    }
    try {
      rmdirSync(`${dir}/blobs`)
      rmdirSync(dir)
    } catch {
      /* non-empty or already gone */
    }
    return true
  }

  return { record, settle, markRestored, list, read, forget }
}
