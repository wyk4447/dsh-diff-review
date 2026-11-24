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
const MAX_BLOB_BYTES = 4 * 1024 * 1024

/** Upper bound on one conversation's blobs; trimming starts at the oldest. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * How long a measured size is trusted.
 *
 * The panel asks for the total on every 1.2s poll, and the honest answer costs a
 * directory walk plus a `stat` per blob. A couple of seconds of staleness is
 * invisible on a number that only moves when a file is reviewed.
 */
const STATS_TTL_MS = 4000

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
 *
 * `diff` is injected rather than imported: this module owns the store and knows
 * nothing about how a change is drawn. Merging two changes to the same file in
 * one turn needs the *net* line counts, which means comparing the turn's opening
 * bytes with its final bytes — a job for the caller's diff, not for the store.
 * Without it the store still merges, and falls back to the incoming counts.
 */
export function createHistory({ root, enabled, diff }) {
  const active = () => enabled() === true && typeof root === 'string' && root !== ''

  const dirOf = (sessionId) => `${root}/${sessionKey(sessionId)}`
  const blobDirOf = (sessionId) => `${dirOf(sessionId)}/blobs`
  const indexPathOf = (sessionId) => `${dirOf(sessionId)}/index.json`

  /** Measured sizes, keyed by session, refreshed by `stats` when stale. */
  const statsCache = new Map()

  /**
   * Conversations whose index was found damaged.
   *
   * The store does not throw over a bad file — it keeps working with what it
   * has — but the reader is told, because a history that silently reads as
   * empty is indistinguishable from one that was never written.
   */
  const damaged = new Set()

  const ensureDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  const loadIndex = (sessionId) => {
    const path = indexPathOf(sessionId)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { entries: [] }
      return { entries: parsed.entries.filter((item) => item !== null && typeof item === 'object') }
    } catch (error) {
      // A missing index is an empty one: losing history is survivable, throwing
      // inside the gate is not. A *damaged* index is a different thing — it
      // means the store was hurt, and calling it empty threw the conversation's
      // undo away without a word. The damaged file is kept beside the index for
      // a look, and the session is marked so the panel can say so.
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        return { entries: [] }
      }
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`)
      } catch {
        /* keeping a copy is a courtesy, not a requirement */
      }
      damaged.add(sessionId)
      return { entries: [] }
    }
  }

  /**
   * A temporary name that two processes cannot collide on.
   *
   * The index is written by the host process, but a second Harness window — or
   * a test running beside it — can write the same conversation's index at the
   * same moment. With one fixed `.tmp` name, one of them renames the other's
   * file away and the entry the other had just written is lost.
   */
  let tmpCounter = 0
  const tmpNameOf = (path) => `${path}.${process.pid}.${(tmpCounter += 1)}.tmp`

  const saveIndex = (sessionId, store) => {
    if (!ensureDir(dirOf(sessionId)) || !ensureDir(blobDirOf(sessionId))) return false
    try {
      // Write then rename: a half-written index would lose every entry at once,
      // and this file is the only record of what the blobs mean.
      const next = tmpNameOf(indexPathOf(sessionId))
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
      const next = tmpNameOf(path)
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
      // The after-copy is what "changes this turn" reads to draw a whole-file
      // view. Collecting only `beforeSha` would leave every such view claiming
      // the file was never written.
      if (typeof entry.afterSha === 'string') keep.add(entry.afterSha)
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

  /**
   * Trim oldest-first until the caps hold.
   *
   * The blobs of the entries that were dropped are *not* collected here. They
   * are collected after the index that no longer names them has been written:
   * deleting them first left a window in which a crash between the two steps
   * left the index pointing at blobs that were already gone. The whole
   * conversation's undo then stopped working, and the panel showed an empty
   * diff instead of an error.
   */
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
    return trimmed
  }

  /**
   * Fold `entry` into `prior`, the row that already stands for this file in this
   * turn.
   *
   * The folded row keeps the bytes the turn opened with and takes the newest
   * result, so one row answers "what did this turn do to this file" and its undo
   * puts the file back to how the turn found it — not to how the previous write
   * left it, which would leave half the turn behind.
   *
   * The operation follows the turn's shape rather than the last call: a file that
   * ends up deleted is a delete however often it was edited first, a file that
   * did not exist when the turn began stays a create however often it was
   * rewritten, and everything else is an update.
   */
  const foldEntry = (sessionId, prior, entry) => {
    const beforeText = prior.existed === true ? getBlob(sessionId, prior.beforeSha) : ''
    const afterText = entry.op === 'delete'
      ? ''
      : (typeof entry.afterSha === 'string' ? getBlob(sessionId, entry.afterSha) : null)
    const folded = {
      ...prior,
      id: entry.id,
      tool: entry.tool,
      at: entry.at,
      op: entry.op === 'delete' ? 'delete' : (prior.existed === true ? 'update' : 'create'),
      afterSha: entry.afterSha ?? null,
      afterBytes: entry.afterBytes,
      afterLarge: entry.afterLarge === true,
      // The newest result is the one an undo has to check against: anything else
      // would revert a file that has moved on since.
      verify: entry.verify ?? null,
      state: entry.state,
      restoredAt: entry.restoredAt ?? null,
    }
    // The net counts need both ends of the turn. When either is missing (a
    // truncated capture, a shell record we could not reduce) the incoming
    // change's own numbers are the only honest ones left.
    const net = typeof diff === 'function' && beforeText !== null && afterText !== null
      ? diff(beforeText, afterText)
      : null
    folded.added = net !== null && typeof net.added === 'number' ? net.added : entry.added
    folded.removed = net !== null && typeof net.removed === 'number' ? net.removed : entry.removed
    return folded
  }

  /**
   * Merge rows that already piled up before one-row-per-file-per-turn existed.
   *
   * Only rows carrying a turn number are merged: entries written before the host
   * told us the turn cannot be attributed to one, and merging edits from several
   * unknown turns into a single row would make its undo reach days back. Such
   * rows stay as they are, and "clear this group" is the honest way out of them.
   */
  const compact = (sessionId, store) => {
    const at = new Map()
    const next = []
    let changed = false
    for (const entry of store.entries) {
      const key = typeof entry.turn === 'number' ? `${entry.turn}\u0000${entry.path}` : null
      const index = key === null ? undefined : at.get(key)
      if (index === undefined || next[index] === null) {
        if (key !== null) at.set(key, next.length)
        next.push(entry)
        continue
      }
      changed = true
      const folded = foldEntry(sessionId, next[index], entry)
      // Created and removed inside the same turn: the file is exactly as the turn
      // found it, and the row would offer an undo with nothing left to undo.
      next[index] = folded.existed === false && folded.op === 'delete' ? null : folded
    }
    if (!changed) return false
    store.entries = next.filter((item) => item !== null)
    return true
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
    //
    // An in-place rewrite (`prettier --write`, `eslint --fix`) is the one shell
    // case where `known` is false for a different reason: the *after* is the
    // tool's decision, but the *before* was read off the disk before the tool
    // ran. The row is worth keeping — the reviewer named that file and should
    // see it under "this turn" — while the undo stays absent, because there is
    // no `verify` to prove the file still holds what the tool wrote.
    if (rec.tool === 'pwsh' && rec.known !== true && rec.opaque !== true) return undefined

    const existed = rec.op !== 'create'
    const before = typeof rec.before === 'string' ? rec.before : ''
    // A truncated `before` is not the file: restoring it would silently cut the
    // tail off a large one. Keep the entry as history, refuse the undo.
    const complete = rec.truncated !== true
    const beforeSha = existed && complete ? putBlob(sessionId, before) : null

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
    // One rule for "can this be undone": there has to be something to put back
    // *and* a way to prove the file still holds what the change wrote. An
    // in-place rewrite has the first but not the second — the tool decided the
    // new content — and it used to be listed as undoable anyway, so the panel
    // offered a button that failed when it was pressed.
    const restorable = verify !== null && (existed ? beforeSha !== null : true)

    const entry = {
      id: rec.id,
      sessionId,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
      path: rec.path,
      op: rec.op,
      tool: rec.tool,
      at: Date.now(),
      // Which turn of the conversation this belongs to; `null` when the host did
      // not tell us. Grouping by it is what turns a flat log into "what changed
      // since I last looked".
      turn: typeof rec.turn === 'number' ? rec.turn : null,
      // Collected here rather than recomputed when the list is read: the counts
      // are known exactly once, before the bytes go away, and re-diffing every
      // stored pair on each open would cost more than the list is worth.
      added: typeof rec.added === 'number' ? rec.added : 0,
      removed: typeof rec.removed === 'number' ? rec.removed : 0,
      existed,
      beforeSha,
      beforeBytes: existed ? byteLength(before) : 0,
      // The copy of what the change produced. `known` gates it for the same
      // reason `verify` is gated: a guessed after-state is not the file.
      afterSha: null,
      afterBytes: typeof rec.after === 'string' ? byteLength(rec.after) : 0,
      restorable,
      verify,
      state: 'pending',
      restoredAt: null,
    }
    if (rec.known === true && complete && rec.op !== 'delete' && typeof rec.after === 'string') {
      entry.afterSha = putBlob(sessionId, rec.after)
      entry.afterLarge = rec.afterSha === null
    }
    const store = loadIndex(sessionId)
    // One file, one turn, one row: a model that rewrites the same file five times
    // while answering one message produces one thing worth reading, not five.
    // Entries with no turn number are never folded together — they cannot be told
    // apart, and a row spanning several turns would undo far more than it says.
    const index = entry.turn === null
      ? -1
      : store.entries.findIndex((item) => item.turn === entry.turn && item.path === entry.path)
    let kept = entry
    if (index === -1) {
      store.entries.push(entry)
    } else {
      const folded = foldEntry(sessionId, store.entries[index], entry)
      // Started and ended absent: the turn left the file exactly as it found it,
      // so there is nothing to show and nothing to undo.
      if (folded.existed === false && folded.op === 'delete') {
        store.entries.splice(index, 1)
        kept = undefined
      } else {
        store.entries[index] = folded
        kept = folded
      }
    }
    prune(sessionId, store)
    // The index goes to disk first; the blobs nobody names any more are
    // reclaimed only after it is safely there. The other order lost a whole
    // conversation's undo when the process died between the two steps.
    const saved = saveIndex(sessionId, store)
    // ...and only when it really was written. A failed save leaves the old
    // index in place, and that one still names those blobs.
    if (saved) collectBlobs(sessionId, store)
    statsCache.delete(sessionId)
    return kept
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
        : outcome === 'applied'
          // The reviewer edited the change and their version is on disk. Without
          // this branch the outcome would fall through to `rejected`, which is
          // the opposite of what happened.
          ? 'applied'
          : outcome === 'timeout'
            ? 'timeout'
            : outcome === 'cancel' ? 'cancelled' : 'rejected'
    saveIndex(sessionId, store)
  }

  /**
   * Re-point a stored entry at the bytes the reviewer actually wrote.
   *
   * `record` froze the verification hash to the model's version. Once the panel
   * writes the user's version instead, that hash describes a file that never
   * existed, and every later restore reports `stale` — the misleading kind of
   * stale, where the file is exactly as the user left it. Only the digest moves;
   * `state` stays `settle`'s alone, so there is still one writer for it.
   */
  const updateApplied = (sessionId, id, content) => {
    if (!active()) return
    if (typeof content !== 'string') return
    const store = loadIndex(sessionId)
    const entry = store.entries.find((item) => item.id === id)
    if (entry === undefined) return
    if (entry.op === 'delete') return
    entry.afterSha = putBlob(sessionId, content)
    entry.afterBytes = byteLength(content)
    entry.afterLarge = entry.afterSha === null
    entry.verify = { kind: 'sha', sha: sha256(content) }
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
    const store = loadIndex(sessionId)
    // Rows written before one-row-per-file-per-turn existed are folded on the
    // first read, once, and the result is kept: the alternative is a list that
    // keeps showing a file five times for one turn forever.
    if (compact(sessionId, store)) {
      saveIndex(sessionId, store)
      statsCache.delete(sessionId)
    }
    return store.entries.slice().sort((a, b) => b.at - a.at)
  }

  /**
   * How much this conversation's history is holding.
   *
   * Measured rather than counted up from the entries: the blobs are the bytes a
   * reader is actually asking about, and the index is small next to them. Cached
   * for a few seconds because the panel polls `list` every 1.2s and a directory
   * walk with two hundred `stat` calls does not belong on that path.
   */
  const stats = (sessionId) => {
    if (!active()) return { entries: 0, bytes: 0 }
    if (typeof sessionId !== 'string' || sessionId === '') return { entries: 0, bytes: 0 }
    const cached = statsCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < STATS_TTL_MS) {
      return { entries: cached.entries, bytes: cached.bytes, corrupt: cached.corrupt === true }
    }
    const entries = loadIndex(sessionId).entries.length
    let bytes = totalBytes(sessionId)
    try {
      bytes += statSync(indexPathOf(sessionId)).size
    } catch {
      /* no index yet: zero entries anyway */
    }
    const corrupt = damaged.has(sessionId)
    statsCache.set(sessionId, { at: Date.now(), entries, bytes, corrupt })
    return { entries, bytes, corrupt }
  }

  /**
   * Drop history, either all of it or one turn's worth.
   *
   * `turn` is `undefined` for everything, `null` for the entries that were
   * recorded before turn numbers existed, and a number for one turn. Blobs are
   * re-collected afterwards, so clearing a turn actually gives the disk back
   * instead of leaving orphaned copies behind.
   */
  const clear = (sessionId, turn) => {
    if (!active()) return { entries: 0, bytes: 0 }
    if (typeof sessionId !== 'string' || sessionId === '') return { entries: 0, bytes: 0 }
    if (turn === undefined) {
      const removed = loadIndex(sessionId).entries.length
      forget(sessionId)
      statsCache.delete(sessionId)
      return { removed, entries: 0, bytes: 0 }
    }
    const store = loadIndex(sessionId)
    const keep = store.entries.filter((entry) => {
      const own = typeof entry.turn === 'number' ? entry.turn : null
      return own !== turn
    })
    const removed = store.entries.length - keep.length
    if (removed === 0) return { removed: 0, ...stats(sessionId) }
    store.entries = keep
    // The index first, the blobs afterwards: a crash between the two used to
    // leave an index pointing at copies that were already gone.
    const saved = saveIndex(sessionId, store)
    if (saved) collectBlobs(sessionId, store)
    statsCache.delete(sessionId)
    return { removed, ...stats(sessionId) }
  }

  const read = (sessionId, id) => {
    if (!active()) return undefined
    if (typeof sessionId !== 'string' || sessionId === '' || typeof id !== 'string') return undefined
    const entry = loadIndex(sessionId).entries.find((item) => item.id === id)
    if (entry === undefined) return undefined
    const after = typeof entry.afterSha === 'string' ? getBlob(sessionId, entry.afterSha) : null
    return {
      entry,
      before: entry.existed ? getBlob(sessionId, entry.beforeSha) : '',
      after,
    }
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

  return { record, settle, markRestored, updateApplied, list, read, forget, stats, clear }
}
