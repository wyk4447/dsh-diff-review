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
  // Refs are real mutable boxes here so the scroll-sync assertion can drive them.
  useRef: (initial) => {
    const box = { current: initial === undefined ? null : initial }
    React.refs.push(box)
    return box
  },
  useCallback: (fn) => fn,
  // Effects are collected and flushed by flushEffects(): the panel loads its
  // detail from a useEffect, so a no-op stub would hide half the component.
  useEffect: (fn) => { pendingEffects.push(fn) },
  useSyncExternalStore: (_sub, get) => get(),
}
React.forcedView = null
React.refs = []
React.scrollers = []

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
  // The scroll lock releases on the next frame. Frames are queued, not run, so the
  // test can prove the mirror write does not bounce back before that release.
  requestAnimationFrame: (fn) => { windowStub.frames.push(fn); return windowStub.frames.length },
  frames: [],
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
  // Scroll-sync needs two things the stub world otherwise lacks: a ref that holds
  // something scrollable, and a handle on the handlers to drive them.
  if (props.ref && typeof props.ref === 'object') {
    props.ref.current = { className: props.className, scrollTop: 0, scrollLeft: 0 }
  }
  if (typeof props.onScroll === 'function') {
    React.scrollers.push({ element: props.ref && props.ref.current, onScroll: props.onScroll })
  }
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
      // The fixture keeps a long shared prefix on purpose: the assertion below is
      // that only the differing characters get the stronger shade, so the pair has
      // to be similar enough to pair at all (INLINE_SIMILARITY) yet differ locally.
      rows: [
        { t: 'equal', a: 1, b: 1, text: 'alpha' },
        { t: 'del', a: 2, b: null, text: 'beta line' },
        { t: 'add', a: null, b: 2, text: 'beta line edited' },
      ],
      before: 'alpha\nbeta line\n',
      after: 'alpha\nbeta line edited\n',
    },
  }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('PENDING OUT:', out.slice(0, 400))
  if (!out.includes('dshr-marker')) throw new Error('unified view did not render markers')
  // A rewritten line must mark only the characters that differ, or a one-character
  // edit and a full rewrite look identical at a glance. The fixture appends " edited",
  // so the stronger shade belongs on exactly that suffix and nowhere else.
  // The serializer writes a class as <name>, so an emphasised span shows up as
  // <dshr-inline> immediately followed by the text it covers.
  if (!out.includes('dshr-inline')) throw new Error('unified view did not emphasise the changed span')
  if (!out.includes('<dshr-inline> edited')) throw new Error('inline emphasis did not cover the appended text exactly')
  if (out.includes('<dshr-inline>beta')) throw new Error('inline emphasis covered the unchanged prefix')
  if (!out.includes('dshr-split')) {
    React.forcedView = 'full'
    out = await render()
    if (!out.includes('dshr-split')) throw new Error('full view did not render the split container')
    if (!out.includes('dshr-paint')) throw new Error('full view did not render the gutter paint')
  }
  console.log('unified + full: OK')

  // 3) the two full-text panes share one scroll position
  React.forcedView = 'full'
  React.scrollers.length = 0
  await render()
  const panes = React.scrollers.filter((entry) => entry.element && String(entry.element.className).indexOf('dshr-full') !== -1)
  if (panes.length < 2) throw new Error('full view did not expose two scrollable panes')
  const left = panes[panes.length - 2]
  const right = panes[panes.length - 1]
  left.element.scrollTop = 120
  left.element.scrollLeft = 40
  left.onScroll()
  if (right.element.scrollTop !== 120) throw new Error('dragging the left pane did not move the right pane')
  if (right.element.scrollLeft !== 40) throw new Error('horizontal scroll did not follow the other pane')
  // The mirrored write fires its own scroll event; the lock must swallow it or the
  // two panes would push each other back and forth on every drag.
  right.element.scrollTop = 999
  right.onScroll()
  if (left.element.scrollTop !== 120) throw new Error('the mirrored scroll bounced back into the dragged pane')
  while (windowStub.frames.length > 0) windowStub.frames.shift()()
  right.element.scrollTop = 300
  right.onScroll()
  if (left.element.scrollTop !== 300) throw new Error('the other direction stayed locked after the frame')
  console.log('scroll sync: OK')

  // 4) a command-level review: the command is all the panel knows, so it must not
  // pretend to draw a diff, must not offer a view toggle that does nothing, and
  // must say why in its own words instead of "too large".
  React.forcedView = 'unified'
  listPayload = {
    ok: true,
    value: {
      changes: [
        // `reason` replaces the old blanket `reviewable === false` wording: this one
        // is a shell command whose result the shell decides at run time.
        { id: 'c2', sessionId: 's1', tool: 'pwsh', displayPath: '$dir\\probe.js', op: 'create', added: 0, removed: 0, oldLineCount: 0, newLineCount: 0, truncated: false, reviewable: false, reason: 'shell-command', command: "Out-File -FilePath $dir\\probe.js -InputObject $js" },
      ],
      diag: null,
    },
  }
  detailPayload = { ok: true, value: { change: { id: 'c2' }, rows: [], before: '', after: '' } }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('COMMAND OUT:', out)
  if (!out.includes('Out-File -FilePath')) throw new Error('command-level review did not show the command')
  if (out.includes('dshr-code')) throw new Error('command-level review drew an empty code pane')
  if (out.includes('dshr-stat')) throw new Error('command-level review kept the line statistics')
  // `t()` resolves through the registered dictionary, so the assertion has to use
  // the rendered sentence rather than the key that produced it.
  const wrongForCommand = '改动过大'
  const rightForCommand = '无法预知最终内容'
  if (!out.includes(rightForCommand)) throw new Error('command-level review used the wrong wording')
  if (out.includes(wrongForCommand)) throw new Error('command-level review claimed the change was too large')

  // The same panel must still word a genuinely oversized change as oversized.
  listPayload.value.changes[0].reason = undefined
  await poll()
  out = await render()
  if (!out.includes(wrongForCommand)) throw new Error('an oversized change lost its own wording')
  if (out.includes(rightForCommand)) throw new Error('an oversized change claimed to be a command')

  // A shape match with no file of its own must not borrow the verb as a file name:
  // reviewing `iex $code` used to name the entry after `iex`, which reads as if a
  // file called `iex` were about to be created. The header names the shape instead.
  listPayload.value.changes[0] = {
    id: 'c3',
    sessionId: 's1',
    tool: 'pwsh',
    displayPath: '',
    op: 'shell',
    added: 0,
    removed: 0,
    oldLineCount: 0,
    newLineCount: 0,
    truncated: false,
    reviewable: false,
    reason: 'shell-command',
    command: "iex $code",
  }
  detailPayload = { ok: true, value: { change: { id: 'c3' }, rows: [], before: '', after: '' } }
  await poll()
  out = await render()
  if (!out.includes('iex $code')) throw new Error('a fileless review lost its command')
  if (out.includes('<dshr-name>')) throw new Error('a fileless review invented a file name')
  console.log('command-level review: OK')

  console.log('client render smoke: OK')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error && error.message)
    process.exit(1)
  },
)
