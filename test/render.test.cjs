const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8')

let registered = {}
const store = { current: { changes: [], detail: null, detailId: null, error: null, ready: true, diag: null } }
let listPayload = { ok: true, value: { changes: [], diag: null } }
let detailPayload = { ok: true, value: { missing: true } }

const pendingEffects = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Component: class { constructor(p) { this.props = p; this.state = {} } },
  // The view toggle is a useState the test cannot click, so it is forced here.
  useState: (initial) => [initial === 'unified' && React.forcedView !== null ? React.forcedView : initial, () => {}],
  useMemo: (fn) => fn(),
  // Effects are collected and flushed by flushEffects(): the panel loads its
  // detail from a useEffect, so a no-op stub would hide half the component.
  useEffect: (fn) => { pendingEffects.push(fn) },
  useSyncExternalStore: (_sub, get) => get(),
}
React.forcedView = null

function flushEffects() {
  while (pendingEffects.length > 0) {
    const fn = pendingEffects.shift()
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  }
}

const documentStub = {
  baseURI: 'http://127.0.0.1:8070/',
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, appendChild: () => {} }),
  querySelector: () => null,
}

const windowStub = {
  ticks: [],
  setInterval: (fn) => { windowStub.ticks.push(fn); return windowStub.ticks.length },
  clearInterval: () => {},
  setTimeout: (fn) => { fn(); return 1 },
  clearTimeout: () => {},
}

const dicts = {}
const ctx = {
  locale: {
    bind: () => (key) => (dicts.zh && typeof dicts.zh[key] === 'string' ? dicts.zh[key] : key),
    register: (ns, value) => { Object.assign(dicts, value); return () => {} },
  },
  effect: (fn) => { const d = fn(); return () => d && d() },
  slots: { inject: (_n, fn) => fn(), register: (meta, comp) => { registered[meta.name] = comp; return () => {} } },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTabIn: () => {} },
  get: () => undefined,
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: async (url) => {
    const path = String(url)
    const payload = path.endsWith('/list') ? listPayload : detailPayload
    return { ok: true, status: 200, json: async () => payload }
  },
  console,
  URL,
  setTimeout: windowStub.setTimeout,
  clearTimeout: windowStub.clearTimeout,
  setInterval: windowStub.setInterval,
  clearInterval: windowStub.clearInterval,
  module: { exports: {} },
  require: (name) => (name === 'react' ? React : {}),
}
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    const exports = factory(sandbox.require)
    sandbox.__plugin = exports
  },
}
windowStub.__ModuleLoader__ = sandbox.window.__ModuleLoader__

vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const plugin = sandbox.__plugin
if (plugin === undefined) throw new Error('plugin did not export')
plugin.apply(ctx)

const TabBody = registered['sidebar.right.pane.tab']
if (typeof TabBody !== 'function') throw new Error('tab body not registered')

function serialize(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  const type = node.type
  const props = Object.assign({}, node.props)
  if (node.children && node.children.length > 0) props.children = node.children
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      instance.props = props
      instance.state = typeof instance.state === 'object' && instance.state !== null ? instance.state : {}
      return serialize(instance.render())
    }
    return serialize(type(props))
  }
  // Class names are part of what this test asserts, so keep them in the dump.
  const className = typeof props.className === 'string' ? `<${props.className}>` : ''
  return className + serialize(node.children)
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r))
}

/** The panel only learns about the gate through the poller, like the live UI. */
async function poll() {
  const tick = windowStub.ticks[windowStub.ticks.length - 1]
  if (typeof tick !== 'function') throw new Error('poller was not installed')
  await tick()
  await settle()
}

/** Render the panel, letting its effects run and re-render, the way React does. */
async function render() {
  for (let pass = 0; pass < 4; pass += 1) {
    const out = serialize(TabBody({ sessionId: 's1' }))
    if (pendingEffects.length === 0) return out
    flushEffects()
    await settle()
  }
  return serialize(TabBody({ sessionId: 's1' }))
}

async function main() {
  // 1) empty state with a full diag payload (the live-debugging view)
  listPayload = {
    ok: true,
    value: {
      changes: [],
      armed: false,
      diag: {
        calls: 3,
        tools: ['read', 'write', 'pwsh'],
        tool: 'write',
        reason: 'not-armed',
        armed: false,
        heartbeatAgeMs: -1,
        pending: 0,
        session: 's1@D:/w',
        shape: { exec: ['callId', 'name', 'arguments', 'signal', 'agent'], hasAgent: true, sessionKeys: ['header'] },
        recent: [{ tool: 'write', reason: 'not-armed' }, { tool: 'read', reason: 'not-gated' }],
      },
    },
  }
  await poll()
  let out = await render()
  if (process.env.DUMP) console.log('EMPTY OUT:', out)
  if (!out.includes('not-armed')) throw new Error('empty state did not show gate reason')
  if (!out.includes('write:not-armed')) throw new Error('empty state did not show the recent ring')
  console.log('empty diag: OK')

  // 2) pending change renders rows
  listPayload = {
    ok: true,
    value: {
      changes: [
        { id: 'c1', sessionId: 's1', tool: 'write', displayPath: 'D:/w/a.txt', op: 'update', added: 1, removed: 1, oldLineCount: 2, newLineCount: 2, truncated: false, reviewable: true },
      ],
      diag: null,
    },
  }
  detailPayload = {
    ok: true,
    value: {
      change: { id: 'c1' },
      rows: [
        { t: 'equal', a: 1, b: 1, text: 'alpha' },
        { t: 'del', a: 2, b: null, text: 'beta' },
        { t: 'add', a: null, b: 2, text: 'BETA' },
      ],
      before: 'alpha\nbeta\n',
      after: 'alpha\nBETA\n',
    },
  }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('PENDING OUT:', out.slice(0, 400))
  if (!out.includes('dshr-marker')) throw new Error('unified view did not render markers')
  if (!out.includes('dshr-split')) {
    React.forcedView = 'full'
    out = await render()
    if (!out.includes('dshr-split')) throw new Error('full view did not render the split container')
    if (!out.includes('dshr-paint')) throw new Error('full view did not render the gutter paint')
  }
  console.log('unified + full: OK')
  console.log('client render smoke: OK')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error && error.message)
    process.exit(1)
  },
)
