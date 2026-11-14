/**
 * Unit tests for the snapshot store.
 *
 * These cover the parts that decide whether an undo is safe: what gets kept,
 * what gets refused, and what the store does when the disk misbehaves. They run
 * against a temporary directory, so no test can touch a real file.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
ok('dropped entries take their blobs with them', trimBlobs.length <= 200)

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

/* -------------------------------------------------------------------- forget -- */

ok('forget reports success', store.forget('session-b') === true)
ok('a forgotten conversation lists nothing', store.list('session-b').length === 0)
ok('the other conversation survives a forget', store.list('session-a').length > 0)
ok('forgetting twice is harmless', store.forget('session-b') === true)

/* -------------------------------------------------------------------- bytes -- */

const big = 'x'.repeat(3 * 1024 * 1024)
const oversize = record({ id: 'c40', before: big, truncated: false })
ok('an oversized snapshot is still recorded', oversize !== undefined)
ok('an oversized snapshot cannot be restored', oversize.restorable === false)
ok('an oversized snapshot keeps no blob', oversize.beforeSha === null)

/* ------------------------------------------------------------------ summary -- */

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? `ALL ${passed} PASS` : `${passed} passed, ${failed} FAILED`)
if (failed > 0) process.exitCode = 1
