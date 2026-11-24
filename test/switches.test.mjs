/**
 * The per-conversation switch: the one control that has to be trusted.
 *
 * A switch that forgets is a switch nobody trusts, and a switch that loses
 * another window's entry is worse than no switch at all: the reader would
 * believe a conversation was silenced while it was still being reviewed. These
 * cases cover the file, the merge, and the failure that has to be reported
 * rather than swallowed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSwitches } from '../lib/switches.js'

let failures = 0
let passes = 0

function check(label, condition) {
  if (condition) {
    passes += 1
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'diff-review-switches-'))
const file = join(root, 'state', 'review-off.json')

try {
  const switches = createSwitches(file)

  check('a conversation nobody silenced is not off', switches.isOff('session-a') === false)
  check('an empty id is not off', switches.isOff('') === false)
  check('a missing id is not off', switches.isOff(undefined) === false)

  const turned = switches.setOff('session-a', true)
  check('turning a conversation off is written', turned.saved === true && turned.off === true)
  check('the conversation reads as off', switches.isOff('session-a') === true)
  check('another conversation is untouched', switches.isOff('session-b') === false)
  check('the file lists the conversation', switches.list().includes('session-a'))

  const body = JSON.parse(readFileSync(file, 'utf8'))
  check('the file carries its version', body.version === 1)
  check('the file carries the conversation', body.off['session-a'] === true)

  const back = switches.setOff('session-a', false)
  check('turning it back on is written', back.saved === true && back.off === false)
  check('the conversation reads as reviewed again', switches.isOff('session-a') === false)
  check('the file no longer carries it', switches.list().includes('session-a') === false)

  // Two windows, two copies of the table: the second must not write the first
  // one's entry away.
  const one = createSwitches(file)
  const two = createSwitches(file)
  one.setOff('session-one', true)
  two.setOff('session-two', true)
  check('the first entry survives the second write', one.isOff('session-one') === true)
  check('the second entry is there too', one.isOff('session-two') === true)
  check('both entries are on disk', one.list().length === 2)

  // A file that cannot be parsed reads as "nothing is silenced": reviewing a
  // conversation again is the safe direction.
  writeFileSync(file, '{ this is not json', 'utf8')
  check('a broken file silences nothing', switches.list().length === 0)
  check('a broken file leaves every conversation reviewed', switches.isOff('session-one') === false)

  // A file from a future shape is read the same way.
  writeFileSync(file, JSON.stringify({ version: 99, off: { 'session-x': true } }), 'utf8')
  check('an unknown version silences nothing', switches.list().length === 0)

  // Entries that are not `true` are not switches.
  writeFileSync(file, JSON.stringify({ version: 1, off: { a: true, b: 'yes', c: false } }), 'utf8')
  check('only a true value is a switch', switches.list().length === 1 && switches.list()[0] === 'a')

  // A file that cannot be written must say so rather than claim it worked.
  const blocked = join(root, 'blocked')
  mkdirSync(blocked)
  // A directory where the file should be: writing it cannot succeed.
  const overDirectory = createSwitches(join(blocked, 'review-off.json'))
  mkdirSync(join(blocked, 'review-off.json'))
  const failed = overDirectory.setOff('session-a', true)
  check('a switch that could not be written says so', failed.saved === false)
  check('a switch that could not be written is not off', overDirectory.isOff('session-a') === false)

  const unusable = createSwitches('')
  check('no file means no switch', unusable.isOff('session-a') === false)
  check('no file means nothing is written', unusable.setOff('session-a', true).saved === false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${passes} passed)`)
if (failures > 0) process.exit(1)
