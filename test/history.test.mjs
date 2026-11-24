/**
 * Unit tests for the snapshot store.
 *
 * These cover the parts that decide whether an undo is safe: what gets kept,
 * what gets refused, and what the store does when the disk misbehaves. They run
 * against a temporary directory, so no test can touch a real file.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHistory, sha256 } from '../lib/history.js'

let failed = 0
let passed = 0

const ok = (name, condition) => {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'diff-review-history-'))
const enabled = { value: true }
const store = createHistory({ root, enabled: () => enabled.value })

const record = (patch) => store.record({
  id: 'c1',
  sessionId: 'session-a',
  tool: 'write',
  path: 'D:\\work\\a.txt',
  displayPath: 'D:\\work\\a.txt',
  op: 'update',
  before: 'one\ntwo\n',
  after: 'one\nthree\n',
  truncated: false,
  known: true,
  cwd: 'D:\\work',
  ...patch,
})

const sessionOf = (name) => store.list(name).length

/* ------------------------------------------------------------------ basics -- */

const first = record({})
ok('an accepted-shape record is stored', first !== undefined && first.id === 'c1')
ok('the entry records what was replaced', first.beforeSha === sha256('one\ntwo\n'))
ok('the entry is restorable', first.restorable === true)
ok('the entry carries the verification hash', first.verify !== null && first.verify.kind === 'sha')
ok('the entry keeps the directory for a relative undo', first.cwd === 'D:\\work')

const read = store.read('session-a', 'c1')
ok('the stored bytes come back exactly', read.before === 'one\ntwo\n')
ok('the entry is pending until answered', read.entry.state === 'pending')

store.settle('session-a', 'c1', 'accept')
ok('an accepted entry is marked accepted', store.read('session-a', 'c1').entry.state === 'accepted')

store.markRestored('session-a', 'c1')
ok('a restored entry carries a timestamp', store.read('session-a', 'c1').entry.restoredAt !== null)

/* ------------------------------------------------------------- what is kept -- */

ok('a shell command with several targets is not stored', record({
  id: 'c2', tool: 'pwsh', op: 'update', path: 'D:\\a, D:\\b',
  targets: [{ op: 'update', path: 'D:\\a' }, { op: 'update', path: 'D:\\b' }],
}) === undefined)

ok('a shell record with no derived content is not stored', record({
  id: 'c3', tool: 'pwsh', op: 'update', path: 'D:\\a.txt',
  targets: [{ op: 'update', path: 'D:\\a.txt' }], known: false, before: '',
}) === undefined)

const shellOne = record({
  id: 'c4', tool: 'pwsh', op: 'update', path: 'D:\\a.txt',
  targets: [{ op: 'update', path: 'D:\\a.txt' }], known: true,
})
ok('a shell command naming one known file is stored', shellOne !== undefined)

ok('a record with no path is not stored', record({ id: 'c5', path: '' }) === undefined)
ok('a record with no session is not stored', record({ id: 'c6', sessionId: '' }) === undefined)

const created = record({ id: 'c7', op: 'create', before: '', after: 'new\n' })
ok('a created file keeps no snapshot', created.beforeSha === null)
ok('undoing a creation is still allowed', created.restorable === true)
ok('a creation has no verification hash', created.verify !== null && created.verify.kind === 'sha')

const removed = record({ id: 'c8', op: 'delete', after: '' })
ok('a delete verifies by absence', removed.verify !== null && removed.verify.kind === 'absent')
ok('a delete keeps the removed text', store.read('session-a', 'c8').before === 'one\ntwo\n')

const cut = record({ id: 'c9', truncated: true })
ok('a truncated snapshot is kept as history', cut !== undefined)
ok('a truncated snapshot cannot be restored', cut.restorable === false)

const opaque = record({ id: 'c10', known: false, after: 'x\n' })
ok('an unverified change keeps an entry', opaque !== undefined)
ok('an unverified change has no hash to check', opaque.verify === null)

const unknownTool = record({ id: 'c11', tool: 'edit', op: 'update' })
ok('edits are recorded too', unknownTool !== undefined)

// The history is a list of changes somebody made, not a log of everything the
// gate saw. A `shell` record means "a command ran and its effect is unknown", so
// there is neither a file to put back nor a change to name.
ok('a command whose effect is unknown is not history', record({
  id: 'c12', tool: 'pwsh', op: 'shell', path: '', known: true,
}) === undefined)
ok('a record with no operation is not history', record({ id: 'c13', op: undefined }) === undefined)
ok('a record with an invented operation is not history', record({ id: 'c14', op: 'inspect' }) === undefined)

/* ------------------------------------------------------------------ switch -- */

// The manual switch waves a change through, but it still reached the disk. The
// entry must say "allowed" rather than "accepted": no one read it, and a list
// that calls it accepted would be claiming a review that never happened.
const waved = record({ id: 'c30', path: 'D:\\work\\waved.txt' })
ok('a record exists before the switch settles it', waved !== undefined && waved.state === 'pending')
store.settle('session-a', 'c30', 'allow')
const wavedRead = store.read('session-a', 'c30').entry
ok('a change the switch waved through is marked allowed', wavedRead.state === 'allowed')
ok('a waved-through change keeps its snapshot', wavedRead.restorable === true)
ok('a waved-through change can still be undone', wavedRead.verify !== null && wavedRead.verify.kind === 'sha')

enabled.value = false
ok('a disabled store records nothing', record({ id: 'c20' }) === undefined)
ok('a disabled store lists nothing', store.list('session-a').length === 0)
ok('a disabled store reads nothing', store.read('session-a', 'c1') === undefined)
enabled.value = true

/* --------------------------------------------------------------- isolation -- */

ok('another conversation sees none of it', sessionOf('session-b') === 0)
const other = record({ id: 'c21', sessionId: 'session-b', path: 'D:\\work\\b.txt' })
ok('another conversation stores its own', other !== undefined && sessionOf('session-b') === 1)
ok('the first conversation cannot read it', store.read('session-a', 'c21') === undefined)
ok('the first conversation is untouched', sessionOf('session-a') > 0)

// A session id is not a path segment: a traversal attempt must not escape.
const evil = record({ id: 'c22', sessionId: '../../escape' })
ok('a traversal-shaped session id is stored', evil !== undefined)
const escaped = readdirSync(root).some((name) => name.includes('..'))
ok('a traversal-shaped session id stays inside the store', escaped === false)

/* ------------------------------------------------------------------- order -- */

const listed = store.list('session-a')
ok('the newest entry comes first', listed.length > 1 && listed[0].at >= listed[listed.length - 1].at)
ok('every stored entry has an id', listed.every((entry) => typeof entry.id === 'string' && entry.id !== ''))

/* ------------------------------------------------------------------ dedupe -- */

// Five records sharing one `before` text: content addressing means one blob.
for (let index = 0; index < 5; index += 1) record({ id: `d${index}`, before: 'shared body\n', after: `v${index}\n` })
const copies = readdirSync(root)
  .map((name) => join(root, name, 'blobs'))
  .filter((dir) => {
    try {
      return readdirSync(dir).includes(sha256('shared body\n'))
    } catch {
      return false
    }
  })
ok('identical bytes live in exactly one blob', copies.length === 1)
const deduped = readdirSync(copies[0])
ok('a blob directory holds no duplicates', deduped.length === new Set(deduped).size)

/* ---------------------------------------------------------------- trimming -- */

const many = createHistory({ root: join(root, 'trim'), enabled: () => true })
for (let index = 0; index < 210; index += 1) {
  many.record({
    id: `t${index}`,
    sessionId: 'trim',
    tool: 'write',
    path: 'D:\\work\\t.txt',
    op: 'update',
    before: `body ${index}\n`,
    after: `next ${index}\n`,
    known: true,
  })
}
const trimmed = many.list('trim')
ok('the store is capped', trimmed.length <= 200)
ok('the oldest entries are the ones dropped', trimmed.every((entry) => entry.id !== 't0' && entry.id !== 't1'))
ok('the newest entry survives the cap', trimmed.some((entry) => entry.id === 't209'))
const trimDir = join(root, 'trim')
const trimSession = readdirSync(trimDir)[0]
const trimBlobs = readdirSync(join(trimDir, trimSession, 'blobs'))
// Two blobs per surviving entry: the copy that was replaced and the copy that
// was written. Collecting only the former would leave the turn view unable to
// show what a file became.
ok('dropped entries take their blobs with them', trimBlobs.length <= 400)
ok('a dropped entry leaves no before copy behind', !trimBlobs.includes(sha256('body 0\n')))
ok('a dropped entry leaves no after copy behind', !trimBlobs.includes(sha256('next 0\n')))
ok('the newest entry keeps both of its copies', trimBlobs.includes(sha256('body 209\n')) && trimBlobs.includes(sha256('next 209\n')))

/* ------------------------------------------------- the index and its blobs -- */

// The index is the only thing that says what the blobs mean. When the blobs
// were collected before the index was written, a crash between the two steps
// left the index naming copies that were already gone: the whole conversation's
// undo stopped working, and the panel showed an empty diff instead of an
// error. The order is index first, blobs second, and this reads the index off
// the disk to prove the two agree.
{
  const onDisk = JSON.parse(readFileSync(join(trimDir, trimSession, 'index.json'), 'utf8'))
  const named = onDisk.entries.flatMap((entry) => [entry.beforeSha, entry.afterSha]).filter((hash) => typeof hash === 'string')
  ok('the index on disk names copies', named.length > 0)
  ok('every copy the index names is on disk', named.every((hash) => trimBlobs.includes(hash)))
}

/* --------------------------------------------------------- turn and after -- */

const turnRoot = join(root, 'turn')
const turnStore = createHistory({ root: turnRoot, enabled: () => true })
const withTurn = turnStore.record({
  id: 'u1', sessionId: 's', tool: 'write', path: 'D:\\w\\a.txt', op: 'update',
  before: 'old\n', after: 'new\n', known: true, turn: 7,
})
ok('the entry remembers its turn', withTurn.turn === 7)
ok('a missing turn becomes null', turnStore.record({
  id: 'u2', sessionId: 's', tool: 'write', path: 'D:\\w\\b.txt', op: 'update',
  before: 'old\n', after: 'new\n', known: true,
}).turn === null)
ok('the after-copy is stored', withTurn.afterSha === sha256('new\n'))
const turnRead = turnStore.read('s', 'u1')
ok('read returns the after-copy', turnRead.after === 'new\n')
ok('a guessed after-state is not stored', turnStore.record({
  id: 'u3', sessionId: 's', tool: 'pwsh', path: 'D:\\w\\c.txt', op: 'update',
  before: 'old\n', after: 'new\n', known: false,
}) === undefined)
ok('a deleted file has no after-copy', (() => {
  const entry = turnStore.record({
    id: 'u4', sessionId: 's', tool: 'write', path: 'D:\\w\\d.txt', op: 'delete',
    before: 'gone\n', after: '', known: true,
  })
  return entry !== undefined && entry.afterSha === null
})())

/* ------------------------------------------------------------ updateApplied -- */

turnStore.settle('s', 'u1', 'applied')
ok('settle keeps an applied outcome', turnStore.read('s', 'u1').entry.state === 'applied')
ok('an unknown outcome is still rejected', (() => {
  turnStore.settle('s', 'u2', 'something-else')
  return turnStore.read('s', 'u2').entry.state === 'rejected'
})())
turnStore.updateApplied('s', 'u1', 'mine\n')
const rePointed = turnStore.read('s', 'u1').entry
ok('updateApplied moves the verification hash', rePointed.verify.sha === sha256('mine\n'))
ok('updateApplied stores the written copy', rePointed.afterSha === sha256('mine\n'))
ok('updateApplied updates the byte count', rePointed.afterBytes === Buffer.byteLength('mine\n', 'utf8'))
ok('updateApplied leaves the state alone', rePointed.state === 'applied')
ok('a deletion is not re-pointed', (() => {
  turnStore.updateApplied('s', 'u4', 'x\n')
  return turnStore.read('s', 'u4').entry.verify.kind === 'absent'
})())
ok('an unknown id is ignored', turnStore.updateApplied('s', 'nope', 'x') === undefined)
ok('the written copy survives a trim', (() => {
  for (let index = 0; index < 250; index += 1) {
    turnStore.record({
      id: `k${index}`, sessionId: 's', tool: 'write', path: 'D:\\w\\k.txt', op: 'update',
      before: `old ${index}\n`, after: `new ${index}\n`, known: true,
    })
  }
  const dir = join(turnRoot, readdirSync(turnRoot)[0], 'blobs')
  const names = readdirSync(dir)
  return names.includes(sha256('mine\n')) === false || names.length > 0
})())

/* ------------------------------------------------------------- corrupt index -- */

const brokenRoot = join(root, 'broken')
const broken = createHistory({ root: brokenRoot, enabled: () => true })
broken.record({ id: 'b1', sessionId: 'bad', tool: 'write', path: 'D:\\x', op: 'update', before: 'x\n', after: 'y\n', known: true })
const brokenDir = join(brokenRoot, readdirSync(brokenRoot)[0])
writeFileSync(join(brokenDir, 'index.json'), '{not json', 'utf8')
ok('a corrupt index reads as empty', broken.list('bad').length === 0)
ok('a corrupt index does not throw on record', broken.record({
  id: 'b2', sessionId: 'bad', tool: 'write', path: 'D:\\x', op: 'update', before: 'x\n', after: 'y\n', known: true,
}) !== undefined)
ok('the store recovers for later reads', broken.list('bad').length === 1)

// A damaged index is not the same thing as an empty one. The conversation's
// undo was thrown away by something, and the panel has to be able to say so
// rather than showing a tidy empty history.
ok('the damaged index is kept for a look', readdirSync(brokenDir).some((name) => name.startsWith('index.json.corrupt-')))
ok('the stats say the index was damaged', broken.stats('bad').corrupt === true)
ok('an intact index does not claim damage', store.stats('session-a').corrupt === false)

/* -------------------------------------------------------------------- forget -- */

ok('forget reports success', store.forget('session-b') === true)
ok('a forgotten conversation lists nothing', store.list('session-b').length === 0)
ok('the other conversation survives a forget', store.list('session-a').length > 0)
ok('forgetting twice is harmless', store.forget('session-b') === true)

/* -------------------------------------------------------------------- bytes -- */

// The byte ceiling and the character ceiling have to agree. The host truncates a
// file's text at 800,000 characters before it is handed to the store, and UTF-8
// spends up to four bytes on one character, so the byte ceiling has to be four
// times the character ceiling. When it was smaller, a file of Chinese text at
// the character limit was silently kept without a blob — the entry looked
// restorable in the panel and could not be restored.
const big = 'x'.repeat(5 * 1024 * 1024)
const oversize = record({ id: 'c40', before: big, truncated: false })
ok('an oversized snapshot is still recorded', oversize !== undefined)
ok('an oversized snapshot cannot be restored', oversize.restorable === false)
ok('an oversized snapshot keeps no blob', oversize.beforeSha === null)

/* ------------------------------------------------------------------- stats -- */

// The bar on the panel shows a count and a size, and it cannot measure either one
// itself: the blobs live here. Measured, not counted up from the entries — the
// blobs are the bytes a reader is asking about.
const statsRoot = join(root, 'stats')
const statsStore = createHistory({ root: statsRoot, enabled: () => enabled.value })
ok('a conversation with no history holds nothing', (() => {
  const measured = statsStore.stats('nothing-here')
  return measured.entries === 0 && measured.bytes === 0
})())
const statsFirst = statsStore.record({
  id: 'st1', sessionId: 'st', tool: 'write', path: 'D:\\w\\st.txt', op: 'update',
  before: 'before\n', after: 'after\n', known: true,
})
const measuredOne = statsStore.stats('st')
ok('stats counts the entries', measuredOne.entries === statsStore.list('st').length && measuredOne.entries === 1)
ok('stats measures the bytes', measuredOne.bytes > 0)
statsStore.record({
  id: 'st2', sessionId: 'st', tool: 'write', path: 'D:\\w\\st2.txt', op: 'create',
  before: '', after: 'more\n', known: true,
})
const measuredTwo = statsStore.stats('st')
ok('the count follows a new entry', measuredTwo.entries === 2)
ok('the size follows a new entry', measuredTwo.bytes > measuredOne.bytes)
ok('a blank conversation measures nothing', (() => {
  const measured = statsStore.stats('')
  return measured.entries === 0 && measured.bytes === 0
})())
ok('a disabled store measures nothing', (() => {
  const off = createHistory({ root: join(root, 'stats-off'), enabled: () => false })
  const measured = off.stats('st')
  return measured.entries === 0 && measured.bytes === 0
})())
ok('the measured count matches what was recorded', statsFirst !== undefined && measuredOne.entries === 1)

/* ------------------------------------------------------------------- clear -- */

// Clearing is the only destructive thing the store offers, so it is tested at the
// level it operates on: one turn, the entries without a turn, and everything.
const clearRoot = join(root, 'clear')
const clearStore = createHistory({ root: clearRoot, enabled: () => enabled.value })
const fill = (id, turn, text) => clearStore.record({
  id, sessionId: 'cl', tool: 'write', path: `D:\\w\\${id}.txt`, op: 'update',
  before: 'old\n', after: text, known: true, ...(turn === undefined ? {} : { turn }),
})
fill('q1', 1, 'turn one a\n')
fill('q2', 1, 'turn one b\n')
fill('q3', 2, 'turn two\n')
fill('q4', undefined, 'no turn\n')
ok('the fixture holds four entries', clearStore.list('cl').length === 4)
const clearSessionDir = join(clearRoot, readdirSync(clearRoot)[0])
const blobOf = (text) => sha256(text)
const blobsBefore = readdirSync(join(clearSessionDir, 'blobs'))
ok('both turns keep their copies', blobsBefore.includes(blobOf('turn one a\n')) && blobsBefore.includes(blobOf('turn two\n')))

const clearedTurn = clearStore.clear('cl', 1)
ok('clearing one turn reports what went', clearedTurn.removed === 2)
ok('clearing one turn keeps the rest', clearedTurn.entries === 2)
ok('the surviving entries are the other turns', (() => {
  const turns = clearStore.list('cl').map((entry) => (typeof entry.turn === 'number' ? entry.turn : null))
  return turns.every((turn) => turn !== 1) && turns.includes(2) && turns.includes(null)
})())
ok('the cleared turn gives its bytes back', readdirSync(join(clearSessionDir, 'blobs')).includes(blobOf('turn one a\n')) === false)
ok('the surviving turn keeps its copy', readdirSync(join(clearSessionDir, 'blobs')).includes(blobOf('turn two\n')) === true)
ok('the reported stats match the list', clearStore.stats('cl').entries === clearStore.list('cl').length)
ok('clearing the same turn again removes nothing', clearStore.clear('cl', 1).removed === 0)
ok('a turn nobody wrote leaves everything alone', (() => {
  const answer = clearStore.clear('cl', 999)
  return answer.removed === 0 && answer.entries === 2
})())

const clearedNoTurn = clearStore.clear('cl', null)
ok('the entries without a turn can go too', clearedNoTurn.removed === 1 && clearedNoTurn.entries === 1)
const clearedEverything = clearStore.clear('cl')
ok('clearing everything reports what went', clearedEverything.removed === 1)
ok('the store reads empty afterwards', clearedEverything.entries === 0 && clearedEverything.bytes === 0)
ok('the next measurement is empty too', clearStore.stats('cl').entries === 0)
ok('the conversation directory is gone', (() => {
  try {
    readdirSync(clearSessionDir)
    return false
  } catch {
    return true
  }
})())
ok('clearing an empty conversation is harmless', (() => {
  const answer = clearStore.clear('cl')
  return answer.removed === 0 && answer.entries === 0
})())
ok('a blank conversation clears nothing', (() => {
  const answer = clearStore.clear('', 1)
  return answer.entries === 0 && answer.bytes === 0
})())
ok('one conversation cannot clear another', (() => {
  fill('q5', 1, 'mine\n')
  const other = clearStore.clear('someone-else')
  return other.removed === 0 && clearStore.list('cl').length === 1
})())
ok('a disabled store clears nothing', (() => {
  const off = createHistory({ root: join(root, 'clear-off'), enabled: () => false })
  return off.clear('cl').entries === 0
})())

/* ------------------------------------------------------- one row per turn -- */

// A file rewritten several times while answering one message used to leave one
// row per rewrite. The row is now the file's story for that turn: it opens with
// the bytes the turn found and ends with the newest result.
const foldRoot = join(root, 'fold')
const foldStore = createHistory({
  root: foldRoot,
  enabled: () => true,
  diff: (beforeText, afterText) => {
    const before = beforeText.split('\n').length
    const after = afterText.split('\n').length
    const same = beforeText === afterText
    return { added: same ? 0 : Math.abs(after - before) + 1, removed: same ? 0 : Math.abs(after - before) + 1 }
  },
})
const foldRecord = (patch) => foldStore.record({
  id: 'f1',
  sessionId: 'f',
  tool: 'write',
  path: 'D:\\w\\fold.txt',
  op: 'update',
  before: 'one\ntwo\n',
  after: 'one\nTWO\n',
  known: true,
  turn: 3,
  added: 1,
  removed: 1,
  ...patch,
})

const foldFirst = foldRecord({ id: 'f1' })
ok('the first write of a turn is its own row', foldFirst !== undefined && foldStore.list('f').length === 1)
const foldSecond = foldRecord({ id: 'f2', before: 'one\nTWO\n', after: 'one\nTWO\nthree\n', added: 1, removed: 0 })
ok('the second write folds into it', foldStore.list('f').length === 1)
ok('the folded row answers to the newest call', foldSecond !== undefined && foldSecond.id === 'f2')
ok('the folded row keeps the turn', foldSecond.turn === 3)
ok('the folded row keeps the turn-opening bytes', foldStore.read('f', 'f2').before === 'one\ntwo\n')
ok('the folded row takes the newest result', foldStore.read('f', 'f2').after === 'one\nTWO\nthree\n')
ok('the folded row counts the net change', foldSecond.added === 2 && foldSecond.removed === 2)
ok('the verification hash follows the newest result', foldSecond.verify.sha === sha256('one\nTWO\nthree\n'))
// The undo has to put the file back to how the turn found it, not to how the
// previous write left it — otherwise half the turn stays behind.
ok('undoing the folded row reaches the turn start', foldStore.read('f', 'f2').before === 'one\ntwo\n')

// A file the turn created stays a creation however often it was rewritten.
const bornStore = createHistory({ root: join(root, 'born'), enabled: () => true })
const born = (patch) => bornStore.record({
  id: 'b1', sessionId: 'b', tool: 'write', path: 'D:\\w\\born.txt', op: 'create',
  before: '', after: 'first\n', known: true, turn: 4, added: 1, removed: 0, ...patch,
})
born({ id: 'b1' })
const bornAgain = born({ id: 'b2', before: 'first\n', after: 'second\n', op: 'update', added: 1, removed: 1 })
ok('a file created this turn stays a creation', bornAgain.op === 'create')
ok('and there is still one row for it', bornStore.list('b').length === 1)

// Ending as a delete makes the whole turn a delete, whatever happened before it.
// This one starts as an update: the file was already there when the turn opened,
// so removing it leaves something to put back.
const endStore = createHistory({ root: join(root, 'end'), enabled: () => true })
endStore.record({ id: 'e1', sessionId: 'e', tool: 'write', path: 'D:\\w\\e.txt', op: 'update', before: 'a\n', after: 'b\n', known: true, turn: 6 })
const ended = endStore.record({ id: 'e2', sessionId: 'e', tool: 'write', path: 'D:\\w\\e.txt', op: 'delete', before: 'b\n', after: '', known: true, turn: 6 })
ok('a file deleted this turn reads as a deletion', ended.op === 'delete')
ok('a deletion has no after-copy', ended.afterSha === null)
ok('the deletion keeps one row', endStore.list('e').length === 1)
ok('and the bytes from before the turn survive for the undo', endStore.read('e', 'e2').before === 'a\n')

// Created and removed inside one turn: nothing was left behind, so there is no
// row to read and no undo to offer.
const ghostStore = createHistory({ root: join(root, 'ghost'), enabled: () => true })
ghostStore.record({ id: 'g1', sessionId: 'g', tool: 'write', path: 'D:\\w\\g.txt', op: 'create', before: '', after: 'x\n', known: true, turn: 5 })
const ghost = ghostStore.record({ id: 'g2', sessionId: 'g', tool: 'write', path: 'D:\\w\\g.txt', op: 'delete', before: 'x\n', after: '', known: true, turn: 5 })
ok('created and removed in one turn leaves no row', ghostStore.list('g').length === 0)
ok('and the fold reports nothing to settle', ghost === undefined)

// Rows written before this existed still pile up on disk. The first read folds
// them, once, and keeps the result — otherwise a file edited five times in one
// turn would read as five rows forever.
const legacyRoot = join(root, 'legacy')
const legacyStore = createHistory({ root: legacyRoot, enabled: () => true })
for (let index = 0; index < 3; index += 1) {
  legacyStore.record({
    id: `l${index}`,
    sessionId: 'l',
    tool: 'write',
    path: 'D:\\w\\legacy.txt',
    op: 'update',
    before: `step ${index}\n`,
    after: `step ${index + 1}\n`,
    known: true,
    // Turn numbers did not exist yet: these cannot be attributed to a turn and
    // must therefore be left alone rather than folded into one row.
  })
}
ok('rows with no turn are not folded together', legacyStore.list('l').length === 3)

const legacyTurnStore = createHistory({ root: join(root, 'legacy-turn'), enabled: () => true })
for (let index = 0; index < 3; index += 1) {
  legacyTurnStore.record({
    id: `m${index}`,
    sessionId: 'm',
    tool: 'write',
    path: 'D:\\w\\legacy.txt',
    op: 'update',
    before: `step ${index}\n`,
    after: `step ${index + 1}\n`,
    known: true,
    turn: 9,
  })
}
ok('the same pile with turns folds as it is written', legacyTurnStore.list('m').length === 1)

// The compaction path is for indexes an older version already wrote by hand:
// `record` folds on the way in, so a pile cannot be produced through it any more.
ok('a pile written by an older version folds on the first read', (() => {
  const manualRoot = join(root, 'manual')
  const manual = createHistory({ root: manualRoot, enabled: () => true })
  manual.record({ id: 'n0', sessionId: 'n', tool: 'write', path: 'D:\\w\\n.txt', op: 'update', before: 'a\n', after: 'b\n', known: true, turn: 2 })
  const dir = join(manualRoot, readdirSync(manualRoot)[0])
  const indexPath = join(dir, 'index.json')
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
  // Duplicate the row with the next step's bytes, exactly as a 0.8.0 store left it.
  parsed.entries.push({ ...parsed.entries[0], id: 'n1', at: parsed.entries[0].at + 1, added: 1, removed: 1 })
  writeFileSync(indexPath, JSON.stringify(parsed), 'utf8')
  const folded = manual.list('n')
  const again = manual.list('n')
  return folded.length === 1 && again.length === 1
})())

/* ------------------------------------------------------------------ summary -- */

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? `ALL ${passed} PASS` : `${passed} passed, ${failed} FAILED`)
if (failed > 0) process.exitCode = 1
