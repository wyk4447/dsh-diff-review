/**
 * The trace file has a size cap.
 *
 * Tracing is on by default and the file grew to 7.5MB on a real machine without
 * anyone noticing. A log in the user's home that nobody prunes is a slow leak,
 * so the writer rolls it over into one kept copy once it outgrows the cap. This
 * checks the roll happens on the very first line a process writes, which is what
 * saves a machine whose file is already oversized from a run that never checks.
 *
 * The trace path is read once when the module loads, so the environment has to
 * point somewhere writable before the import — hence the dynamic import.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'diff-review-trace-'))
const tracePath = join(root, 'diff-review.log')
const ROLLED_BYTES = 6 * 1024 * 1024
writeFileSync(tracePath, 'x'.repeat(ROLLED_BYTES), 'utf8')
process.env.DSH_DIFF_REVIEW_TRACE_FILE = tracePath
process.env.DSH_DIFF_REVIEW_HISTORY_ROOT = join(root, 'history')

let failures = 0
let passes = 0

function ok(label, condition) {
  if (condition) {
    passes += 1
    console.log(`ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}`)
}

function makeCtx() {
  const routes = []
  const ctx = {
    get: (name) => (name === 'workingDirectory' ? { get: () => 'D:/w', defaultDirectory: 'D:/fallback' } : undefined),
    effect: (fn) => { const d = fn(); return () => d && d() },
    on: () => () => {},
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    fs: {
      resolve: async (p) => ({ targetKey: p, displayPath: p }),
      stat: async () => undefined,
      readText: async () => '',
      writeText: async () => ({ operation: 'write', version: 'v1' }),
      deleteFile: async () => ({ before: '' }),
    },
  }
  return { ctx, routes }
}

/** Send one request so the route layer has something to trace. */
async function send(route, body) {
  const req = {
    method: 'POST',
    url: '/diff-review/api/list',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(body) },
  }
  const res = {
    status: 200,
    writeHead: (code) => { res.status = code },
    setHeader: () => {},
    write: () => {},
    end: () => {},
  }
  await route.handler(req, res)
  return res.status
}

const { apply } = await import('../lib/index.js')
const { ctx, routes } = makeCtx()
apply(ctx, { trace: true })

// A body that is not JSON takes the route's error branch, which is traced.
const status = await send(routes[0], '{ not json')
ok('the route still answers', status === 400)
ok('the oversized file was rolled aside', statSync(`${tracePath}.1`).size === ROLLED_BYTES)
ok('the live file is small again', statSync(tracePath).size < 4096)
ok('the live file holds the new line', readFileSync(tracePath, 'utf8').includes('route-error'))

// A second line stays in the live file: the cap is not re-checked per line.
await send(routes[0], '{ not json')
ok('the next line appends to the live file', readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).length === 2)

// With tracing off nothing is written at all, even with the file in place.
const before = statSync(tracePath).size
const quiet = makeCtx()
apply(quiet.ctx, { trace: false })
await send(quiet.routes[0], '{ not json')
ok('tracing off writes nothing', statSync(tracePath).size === before)

rmSync(root, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${passes} passed)`)
if (failures !== 0) process.exit(1)
