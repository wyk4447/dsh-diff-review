/**
 * Conversations the reader asked not to be reviewed.
 *
 * The plugin already has one global off switch (the `history`/`files`/`shell`
 * settings), and the panel has a manual "allow everything" switch. Both are
 * either too wide or too forgetful: the settings turn the plugin off for every
 * conversation at once, and the manual switch still reviews and still records —
 * it only answers for you.
 *
 * This one is per conversation and means it: no panel, no record, no snapshot.
 * It is written to disk because a reader who silenced one conversation did not
 * mean "until the next restart", and a switch that forgets is a switch nobody
 * trusts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** Bumped only if the shape changes; an older file is read as "nothing off". */
const FORMAT_VERSION = 1

/**
 * Keep the written file readable and stable: a plain object of ids, sorted, so a
 * diff of it says something and a hand edit is not required to be pretty.
 */
const parse = (text) => {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return {}
    if (parsed.version !== FORMAT_VERSION) return {}
    if (parsed.off === null || typeof parsed.off !== 'object') return {}
    const off = {}
    for (const key of Object.keys(parsed.off)) {
      if (typeof key === 'string' && key !== '' && parsed.off[key] === true) off[key] = true
    }
    return off
  } catch {
    // Unreadable means unread: treating a broken file as "everything is off"
    // would silently stop reviewing every conversation on the machine.
    return {}
  }
}

/**
 * @param {string} file absolute path of the state file
 */
export function createSwitches(file) {
  const usable = typeof file === 'string' && file !== ''
  let loaded = false
  /** @type {Record<string, true>} */
  let off = {}

  const load = () => {
    if (loaded || !usable) return
    loaded = true
    try {
      off = parse(readFileSync(file, 'utf8'))
    } catch {
      // No file yet is the normal first run, not a failure.
      off = {}
    }
  }

  const save = () => {
    if (!usable) return false
    const dir = file.slice(0, file.lastIndexOf('/'))
    try {
      if (dir !== '') mkdirSync(dir, { recursive: true })
      const body = { version: FORMAT_VERSION, off }
      // Write then rename: a half-written file would read as "nothing is off" and
      // quietly start reviewing the conversation the reader silenced.
      const next = `${file}.tmp`
      writeFileSync(next, JSON.stringify(body, null, 2), 'utf8')
      renameSync(next, file)
      return true
    } catch {
      return false
    }
  }

  return {
    /** True when this conversation must not be reviewed at all. */
    isOff(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      load()
      return off[sessionId] === true
    },
    /** Turn review on or off for one conversation; returns the new state. */
    setOff(sessionId, value) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      load()
      if (value === true) off[sessionId] = true
      else delete off[sessionId]
      save()
      return value === true
    },
    /** The conversations currently silenced, for a caller that wants to show it. */
    list() {
      load()
      return Object.keys(off)
    },
  }
}
