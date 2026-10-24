import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const results = []
const check = (label, value) => results.push([label, value === true])

function makeCtx({ dir = 'D:/w', absent = false, throwOnGet = false } = {}) {
  const routes = []
  const handlers = new Map()
  const ctx = {
    get: (name) => {
      if (throwOnGet) throw new Error('no service')
      if (name !== 'workingDirectory' || absent) return undefined
      return { get: () => dir, defaultDirectory: 'D:/fallback' }
    },
    effect: (fn) => { const d = fn(); return () => d && d() },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    fs: {
      resolve: async (p) => ({ targetKey: p, displayPath: p }),
      stat: async () => ({ version: 'v1', type: 'file' }),
      readText: async () => 'alpha\nbeta\ngamma\ndelta\n',
    },
  }
  return { ctx, routes, handlers }
}

async function call(route, method, body) {
  const req = {
    method: 'POST',
    url: '/diff-review/api/' + method,
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body ?? {})) },
  }
  let payload = ''
  const res = { writeHead: () => {}, setHeader: () => {}, write: (d) => { payload += d }, end: (d) => { payload = String(d ?? payload) } }
  await route.handler(req, res)
  return JSON.parse(payload)
}

const exec = (name, args) => ({
  callId: 'c1',
  name,
  arguments: args,
  signal: new AbortController().signal,
  agent: { id: 's1', session: { header: { id: 's1', cwd: 'D:/w' } } },
})
const next = async () => ({ kind: 'allow' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---- main scenario ---- */
const { ctx, routes, handlers } = makeCtx()
apply(ctx, { trace: false })
const route = routes[0]
const gate = handlers.get('tools/pre-execute')
check('route registered', typeof route.handler === 'function')

let decision = await gate(exec('write', { file_path: 'D:/w/a.txt', content: 'x\n' }), next)
check('unarmed passes', decision.kind === 'allow')
let listed = await call(route, 'list', {})
check('reason not-armed', listed.value.diag.reason === 'not-armed')
check('recent ring records', listed.value.diag.recent.length === 1 && listed.value.diag.recent[0].reason === 'not-armed')

await call(route, 'list', {})
const parked = gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\nBETA\ngamma\ndelta\n' }), next)
await wait(30)
listed = await call(route, 'list', {})
check('pending surfaced', listed.value.changes.length === 1)
check('change op update', listed.value.changes[0].op === 'update')
const id = listed.value.changes[0].id
const detail = await call(route, 'detail', { id })
check('rows are hunks', Array.isArray(detail.value.rows) && detail.value.rows.some((r) => r.t === 'del' || r.t === 'add'))
await call(route, 'decide', { id, action: 'accept' })
check('accept allows', (await parked).kind === 'allow')
check('pending drained', (await call(route, 'list', {})).value.changes.length === 0)

/* ---- reject ---- */
await call(route, 'list', {})
const parkedReject = gate(exec('write', { file_path: 'D:/w/b.txt', content: 'new\n' }), next)
await wait(30)
let current = await call(route, 'list', {})
await call(route, 'decide', { id: current.value.changes[0].id, action: 'reject' })
const rejected = await parkedReject
check('reject denies', rejected.kind === 'deny')
check('reject reason names path', String(rejected.reason).includes('D:/w/b.txt'))

/* ---- abort ---- */
await call(route, 'list', {})
const controller = new AbortController()
const parkedAbort = gate({ ...exec('write', { file_path: 'D:/w/c.txt', content: 'c\n' }), signal: controller.signal }, next)
await wait(30)
controller.abort()
check('abort cancels', (await parkedAbort).kind === 'cancel')

/* ---- edit diff ---- */
await call(route, 'list', {})
const parkedEdit = gate(exec('edit', { file_path: 'D:/w/a.txt', old_string: 'beta', new_string: 'BETA!' }), next)
await wait(30)
current = await call(route, 'list', {})
const editDetail = await call(route, 'detail', { id: current.value.changes[0].id })
const editText = JSON.stringify(editDetail.value.rows)
check('edit diff has both sides', editText.includes('beta') && editText.includes('BETA!'))
await call(route, 'decide', { id: current.value.changes[0].id, action: 'accept' })
await parkedEdit

/* ---- shell ---- */
await call(route, 'list', {})
const parkedShell = gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/a.txt'" }), next)
await wait(30)
current = await call(route, 'list', {})
check('shell delete parks', current.value.changes.length === 1 && current.value.changes[0].op === 'delete')
await call(route, 'decide', { id: current.value.changes[0].id, action: 'accept' })
check('shell accept allows', (await parkedShell).kind === 'allow')

for (const harmless of ["Remove-Item 'D:/w/a.txt' -WhatIf", 'Get-ChildItem D:/w', 'Write-Host hi']) {
  const value = await gate(exec('pwsh', { command: harmless }), next)
  check(`shell bypass ${harmless}`, value.kind === 'allow')
}

/* ---- self + temp exemptions ---- */
await call(route, 'list', {})
// Derived from this file's own location so the test survives a clone anywhere.
const selfFile = fileURLToPath(new URL('../lib/x.js', import.meta.url))
check('self skipped', (await gate(exec('write', { file_path: selfFile, content: 'x\n' }), next)).kind === 'allow')
const tempProbe = `${(process.env.TEMP || 'C:/Temp').replace(/\\\\/g, '/')}/probe.txt`
check('temp skipped', (await gate(exec('write', { file_path: tempProbe, content: 'x\n' }), next)).kind === 'allow')

/* ---- directory fallbacks ---- */
const fallback = makeCtx({ dir: 'D:/fallback' })
apply(fallback.ctx, { trace: false })
await call(fallback.routes[0], 'list', {})
const parkedFallback = fallback.handlers.get('tools/pre-execute')(
  { callId: 'c2', name: 'write', arguments: { file_path: 'D:/x.txt', content: 'x\n' }, signal: new AbortController().signal, agent: { id: 's2', session: { header: { id: 's2' } } } },
  next,
)
await wait(30)
const listedFallback = await call(fallback.routes[0], 'list', {})
check('no header.cwd still parks', listedFallback.value.changes.length === 1)
await call(fallback.routes[0], 'decide', { id: listedFallback.value.changes[0].id, action: 'reject' })
check('fallback reject denies', (await parkedFallback).kind === 'deny')

const throwing = makeCtx({ throwOnGet: true })
apply(throwing.ctx, { trace: false })
await call(throwing.routes[0], 'list', {})
const parkedThrowing = throwing.handlers.get('tools/pre-execute')(
  { callId: 'c3', name: 'write', arguments: { file_path: 'D:/y.txt', content: 'y\n' }, signal: new AbortController().signal, agent: { id: 's3', session: { header: { id: 's3', cwd: 'D:/w' } } } },
  next,
)
await wait(30)
const listedThrowing = await call(throwing.routes[0], 'list', {})
check('throwing service still parks', listedThrowing.value.changes.length === 1)
await call(throwing.routes[0], 'decide', { id: listedThrowing.value.changes[0].id, action: 'reject' })
check('throwing service reject denies', (await parkedThrowing).kind === 'deny')

/* ---- not gated ---- */
await call(route, 'list', {})
check('read not gated', (await gate(exec('read', { file_path: 'D:/w/a.txt' }), next)).kind === 'allow')

let failed = 0
for (const [label, ok] of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
