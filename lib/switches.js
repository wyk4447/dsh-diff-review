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
  /**
   * The file is read fresh every time it is asked about.
   *
   * Two Harness windows can have this file open at once, and each keeps its own
   * copy of what it thinks the table says. A cached copy goes stale the moment
   * the other window changes something, and a switch that is out of date is a
   * switch that stops working without saying so. The file is a few hundred
   * bytes; reading it is cheaper than being wrong.
   */
  const read = () => {
    if (!usable) return {}
    try {
      return parse(readFileSync(file, 'utf8'))
    } catch {
      // No file yet is the normal first run, not a failure.
      return {}
    }
  }

  let tmpCounter = 0

  const save = (table) => {
    if (!usable) return false
    const dir = file.slice(0, file.lastIndexOf('/'))
    try {
      if (dir !== '') mkdirSync(dir, { recursive: true })
      const body = { version: FORMAT_VERSION, off: table }
      // Write then rename: a half-written file would read as "nothing is off" and
      // quietly start reviewing the conversation the reader silenced. The
      // temporary name carries the process id, so two windows writing at the
      // same moment cannot rename each other's file away.
      const next = `${file}.${process.pid}.${(tmpCounter += 1)}.tmp`
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
      return read()[sessionId] === true
    },
    /**
     * Turn review on or off for one conversation.
     *
     * The table is read again before it is written, and only this one key is
     * changed: a window that had never heard of another conversation's switch
     * would otherwise write its own stale copy over it and silently bring that
     * conversation back under review.
     *
     * The result says whether the file was written. A switch that did not reach
     * the disk is not a switch, and the caller has to be able to say so.
     */
    setOff(sessionId, value) {
      if (typeof sessionId !== 'string' || sessionId === '') return { off: false, saved: false }
      const current = read()
      if (value === true) current[sessionId] = true
      else delete current[sessionId]
      const saved = save(current)
      return { off: value === true, saved }
    },
    /** The conversations currently silenced, for a caller that wants to show it. */
    list() {
      return Object.keys(read())
    },
  }
}
