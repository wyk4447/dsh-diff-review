/**
 * The route layer and the refusals behind it.
 *
 * Two things are checked here. First, the routes themselves: a request that is
 * not a POST, a method that does not exist, a body that is not JSON, a body
 * that is too large — each has to fail in its own way, and none of them may
 * reach a handler. Second, the codes the two write paths answer with, because
 * a code the panel cannot word is a code the reader is left to guess at.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const snapshotRoot = mkdtempSync(join(tmpdir(), 'diff-review-routes-'))
process.env.DSH_DIFF_REVIEW_HISTORY_ROOT = snapshotRoot

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

const files = new Map()
const versions = new Map()
let versionCounter = 1

function makeCtx({ reject = false, throwOnResolve = false } = {}) {
  const routes = []
  const handlers = new Map()
  const ctx = {
    get: (name) => (name === 'workingDirectory' ? { get: () => 'D:/w', defaultDirectory: 'D:/fallback' } : undefined),
    effect: (fn) => { const d = fn(); return () => d && d() },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => (reject ? { reason: 'forbidden' } : undefined) },
    fs: {
      resolve: async (p) => {
        if (throwOnResolve) throw new Error('cannot resolve')
        return { targetKey: p, displayPath: p }
      },
      stat: async (target) => {
        const key = String(target.targetKey)
        if (files.get(key) === null) return undefined
        return { version: versions.get(key) ?? 'v1', type: 'file', size: 10 }
      },
      readText: async (target) => String(files.get(String(target.targetKey)) ?? 'alpha\n'),
      writeText: async (target, content) => {
        const key = String(target.targetKey)
        files.set(key, content)
        versionCounter += 1
        versions.set(key, `v${versionCounter}`)
        return { operation: 'write', version: versions.get(key) }
      },
      deleteFile: async (target) => {
        files.set(String(target.targetKey), null)
        return { before: 'alpha\n' }
      },
    },
  }
  return { ctx, routes, handlers }
}

/** Send a request through the route and read the answer back. */
async function send(route, { method = 'POST', url = '/diff-review/api/list', body = {}, raw, contentLength } = {}) {
  const payload = raw !== undefined ? raw : JSON.stringify(body)
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }) },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload) },
  }
  let out = ''
  const res = {
    status: 200,
    writeHead: (code) => { res.status = code },
    setHeader: () => {},
    write: (chunk) => { out += chunk },
    end: (chunk) => { out = String(chunk ?? out) },
  }
  await route.handler(req, res)
  let parsed = null
  try {
    parsed = JSON.parse(out)
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

try {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx, { trace: false })
  const route = routes[0]
  const gate = handlers.get('tools/pre-execute')
  const next = async () => ({ kind: 'allow' })
  const exec = (name, args) => ({
    callId: 'c1',
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 's1', session: { header: { id: 's1', cwd: 'D:/w' } } },
  })

  /* ---- the route layer ---- */
  const ok = await send(route, { body: {} })
  check('a known method answers', ok.status === 200 && ok.body.ok === true)

  const wrongMethod = await send(route, { method: 'GET' })
  check('a GET is refused', wrongMethod.status === 405)
  check('a GET says what is wrong', wrongMethod.body.error.code === 'method-not-allowed')

  const unknown = await send(route, { url: '/diff-review/api/nosuchthing' })
  check('an unknown method is not found', unknown.status === 404)
  check('an unknown method says what is wrong', unknown.body.error.code === 'not-found')

  // A name that exists on every object must not be mistaken for a method.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const polluted = await send(route, { url: `/diff-review/api/${name}` })
    check(`${name} is not a method`, polluted.status === 404)
  }

  const broken = await send(route, { raw: '{ not json' })
  check('a body that is not JSON is refused', broken.status === 400)
  check('a broken body says what is wrong', broken.body.error.code === 'bad-request')

  const empty = await send(route, { raw: '' })
  check('an empty body means no arguments', empty.status === 200 && empty.body.ok === true)

  const huge = await send(route, { raw: 'x'.repeat(2 * 1024 * 1024), contentLength: 2 * 1024 * 1024 })
  check('a body over the ceiling is refused', huge.status === 400)

  const refused = makeCtx({ reject: true })
  apply(refused.ctx, { trace: false })
  const refusedAnswer = await send(refused.routes[0], { body: {} })
  check('a request the host refuses is not served', refusedAnswer.status === 403)
  check('a refused request says what is wrong', refusedAnswer.body.error.code === 'forbidden')

  /* ---- the two write paths and their refusals ---- */
  // Park a write so that there is something to answer about.
  files.set('D:/w/a.txt', 'alpha\n')
  const parked = gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\nbeta\n' }), next)
  await new Promise((r) => setTimeout(r, 30))
  const listed = await send(route, { body: {} })
  check('the write is pending', listed.body.value.changes.length === 1)
  const pendingId = listed.body.value.changes[0].id
  const pendingSession = listed.body.value.changes[0].sessionId

  const missingId = await send(route, { url: '/diff-review/api/applyEdited', body: { id: 'no-such-id', sessionId: pendingSession, content: 'x' } })
  check('an unknown change is refused', missingId.body.value.error === 'missing')
  check('an unknown change is flagged as missing', missingId.body.value.missing === true)

  const noSession = await send(route, { url: '/diff-review/api/applyEdited', body: { id: pendingId, content: 'x' } })
  check('a change without a conversation is refused', noSession.body.value.error === 'missing')

  const otherSession = await send(route, { url: '/diff-review/api/applyEdited', body: { id: pendingId, sessionId: 'session-other', content: 'x' } })
  check('another conversation cannot edit it', otherSession.body.value.error === 'missing')

  const emptyContent = await send(route, { url: '/diff-review/api/applyEdited', body: { id: pendingId, sessionId: pendingSession } })
  check('an edit without text is refused', emptyContent.body.value.error === 'empty')

  const unchanged = await send(route, { url: '/diff-review/api/applyEdited', body: { id: pendingId, sessionId: pendingSession, content: 'alpha\n' } })
  check('an edit that changes nothing is refused', unchanged.body.value.error === 'unchanged')

  const applied = await send(route, { url: '/diff-review/api/applyEdited', body: { id: pendingId, sessionId: pendingSession, content: 'alpha\nbeta\ngamma\n' } })
  check('an edit is written', applied.body.value.ok === true)
  check('the file holds the reviewer text', files.get('D:/w/a.txt') === 'alpha\nbeta\ngamma\n')
  // The panel wrote the file itself, so the model's own write must not run on
  // top of it: the tool call is refused and the model is told afterwards.
  check('the model write is refused', (await parked).kind !== 'allow')

  // A change that was never applied has nothing to undo.
  const notApplied = await send(route, { url: '/diff-review/api/restore', body: { id: 'no-such-id', sessionId: pendingSession } })
  check('an unknown entry has nothing to restore', notApplied.body.value.missing === true)

  const shellRecord = gate(exec('pwsh', { command: "Set-Content -Path 'D:/w/b.txt' -Value 'x'" }), next)
  await new Promise((r) => setTimeout(r, 30))
  const shellListed = await send(route, { body: {} })
  const shellItem = shellListed.body.value.changes.find((item) => item.tool === 'pwsh')
  check('the shell change is pending', shellItem !== undefined)
  if (shellItem !== undefined) {
    const notEditable = await send(route, { url: '/diff-review/api/applyEdited', body: { id: shellItem.id, sessionId: shellItem.sessionId, content: 'x' } })
    check('a command record cannot be edited', notEditable.body.value.error === 'not-editable')
    await send(route, { url: '/diff-review/api/decide', body: { id: shellItem.id, action: 'accept' } })
    await shellRecord
  }

  // A path the plugin refuses to write to.
  const protectedPath = gate(exec('write', { file_path: 'C:/Windows/System32/drivers/etc/hosts', content: 'x' }), next)
  await new Promise((r) => setTimeout(r, 30))
  const protectedListed = await send(route, { body: {} })
  const protectedItem = protectedListed.body.value.changes.find((item) => String(item.path).includes('hosts'))
  check('a protected path is still reviewed', protectedItem !== undefined)
  if (protectedItem !== undefined) {
    await send(route, { url: '/diff-review/api/decide', body: { id: protectedItem.id, action: 'accept' } })
    await protectedPath
  }
} finally {
  rmSync(snapshotRoot, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${passes} passed)`)
if (failures > 0) process.exit(1)
