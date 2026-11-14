const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8')

let registered = {}
let tabDefinition = null
const store = { current: { changes: [], detail: null, detailId: null, error: null, ready: true, diag: null } }
let listPayload = { ok: true, value: { changes: [], diag: null } }
let detailPayload = { ok: true, value: { missing: true } }
let historyPayload = { ok: true, value: { entries: [] } }

const pendingEffects = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Component: class { constructor(p) { this.props = p; this.state = {} } },
  // The view toggle is a useState the test cannot click, so it is forced here.
  // The history screen has the same problem twice over: no state update reaches
  // this stub, and its list arrives from a fetch the stub resolves after the
  // render. Forcing both values is the only way to reach that screen.
  useState: (initial) => {
    if (initial === 'unified' && React.forcedView !== null) return [React.forcedView, () => {}]
    if (initial === false && React.forcedHistory === true) return [true, () => {}]
    // The folded raw command is the same shape of problem: a click the stub
    // cannot deliver. Forcing the state is how the opened block is rendered.
    if (initial === false && React.forcedRaw === true) return [true, () => {}]
    if (Array.isArray(initial) && React.forcedList !== null) return [React.forcedList, () => {}]
    return [initial, () => {}]
  },
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
React.forcedHistory = false
React.forcedRaw = false
React.forcedList = null
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
  sidebarRightTabs: {
    // Keep the definition: the guide entry's artwork is what the sidebar's "start"
    // page draws for us, and a type with no `icon` silently falls back to the
    // sidebar's own cube — the exact failure where changing the manifest icon
    // changed nothing the user could see.
    register: (definition) => { tabDefinition = definition; return () => {} },
  },
  sidebarRight: { openTabIn: () => {} },
  get: () => undefined,
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: async (url) => {
    const path = String(url)
    const payload = path.endsWith('/list')
      ? listPayload
      : path.endsWith('/history')
        ? historyPayload
        : detailPayload
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

  // 2b) a command touching several files: one decision, one diff per file. The
  // strip is the whole point — without it the panel would have to pick a single
  // file to draw and silently hide the rest.
  React.forcedView = 'unified'
  listPayload = {
    ok: true,
    value: {
      changes: [
        {
          id: 'c9',
          sessionId: 's1',
          tool: 'pwsh',
          displayPath: 'D:/w/one.txt, D:/w/two.txt',
          op: 'update',
          added: 0,
          removed: 0,
          oldLineCount: 0,
          newLineCount: 0,
          truncated: false,
          reviewable: true,
          files: [
            { path: 'D:/w/one.txt', op: 'update', kind: 'text', computed: true, truncated: false, added: 1, removed: 1, oldLineCount: 1, newLineCount: 1 },
            { path: 'D:/w/two.txt', op: 'create', kind: 'binary', computed: false, truncated: false, added: 0, removed: 0, oldLineCount: 0, newLineCount: 0, bytesBefore: 0, bytesAfter: 64 },
          ],
        },
      ],
      diag: null,
    },
  }
  detailPayload = {
    ok: true,
    value: {
      change: { id: 'c9' },
      files: [
        { path: 'D:/w/one.txt', op: 'update', kind: 'text', computed: true, truncated: false, added: 1, removed: 1, oldLineCount: 1, newLineCount: 1, before: 'one\n', after: 'uno\n', rows: [{ t: 'del', a: 1, b: null, text: 'one' }, { t: 'add', a: null, b: 1, text: 'uno' }] },
        { path: 'D:/w/two.txt', op: 'create', kind: 'binary', computed: false, truncated: false, added: 0, removed: 0, oldLineCount: 0, newLineCount: 0, bytesBefore: 0, bytesAfter: 64, before: '', after: '', rows: [] },
      ],
    },
  }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('MULTI OUT:', out)
  if (!out.includes('dshr-files')) throw new Error('a multi-file review drew no file strip')
  if (!out.includes('2 个文件')) throw new Error('the strip did not count the files')
  if (!out.includes('one.txt') || !out.includes('two.txt')) throw new Error('the strip did not list both files')
  // The first file is the one on screen, so its diff must be the one drawn.
  if (!out.includes('uno')) throw new Error('the first file lost its diff')
  if (out.includes('该文件内容未变')) throw new Error('a file in the strip was reported as unchanged')
  // A binary file has no lines, so its row must report bytes — not the "content
  // did not change" wording, which is the opposite of why it is listed.
  if (!out.includes('0 → 64 B')) throw new Error('a binary file in the strip did not report its bytes')
  console.log('multi-file review: OK')

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
  // must say why in its own words instead of "too large". The command itself used
  // to arrive as one long block of code; it is now broken into the steps it
  // performs, because "what is this doing?" was the question nobody could answer.
  React.forcedView = 'unified'
  listPayload = {
    ok: true,
    value: {
      changes: [
        // `reason` replaces the old blanket `reviewable === false` wording: this one
        // is a shell command whose result the shell decides at run time.
        {
          id: 'c2',
          sessionId: 's1',
          tool: 'pwsh',
          displayPath: '$dir\\probe.js',
          op: 'create',
          added: 0,
          removed: 0,
          oldLineCount: 0,
          newLineCount: 0,
          truncated: false,
          reviewable: false,
          reason: 'shell-command',
          command: "cd D:/w; $js = 'x'; Out-File -FilePath $dir\\probe.js -InputObject $js",
          steps: [
            { kind: 'cd', text: 'cd D:/w' },
            { kind: 'note', text: "$js = 'x'" },
            { kind: 'write', text: 'Out-File -FilePath $dir\\probe.js -InputObject $js', path: '$dir\\probe.js' },
          ],
        },
      ],
      diag: null,
    },
  }
  detailPayload = { ok: true, value: { change: { id: 'c2' }, rows: [], before: '', after: '' } }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('COMMAND OUT:', out)
  if (!out.includes('dshr-steps')) throw new Error('command-level review did not list the steps')
  if (!out.includes('这条命令会做这些事')) throw new Error('command-level review lost the step heading')
  if (!out.includes('切换目录')) throw new Error('command-level review did not name the directory switch')
  if (!out.includes('$dir\\probe.js')) throw new Error('command-level review did not name the file being written')
  // The raw command is one click away, not gone: approving a summary you cannot
  // check against the original text would be approving something unseen.
  if (!out.includes('看原命令')) throw new Error('command-level review lost the way back to the raw command')
  // The raw block is the whole command in one piece; the step list is the readable
  // form of it, so the two are told apart by the block's own class.
  if (out.includes('dshr-cmd')) throw new Error('the raw command was shown before it was asked for')
  if (out.includes('dshr-code')) throw new Error('command-level review drew an empty code pane')
  if (out.includes('dshr-stat')) throw new Error('command-level review kept the line statistics')
  // `t()` resolves through the registered dictionary, so the assertion has to use
  // the rendered sentence rather than the key that produced it.
  const wrongForCommand = '改动过大'
  const rightForCommand = '无法预知最终内容'
  if (!out.includes(rightForCommand)) throw new Error('command-level review used the wrong wording')
  if (out.includes(wrongForCommand)) throw new Error('command-level review claimed the change was too large')

  // Opening the folded block has to reveal the exact text being approved.
  React.forcedRaw = true
  out = await render()
  if (!out.includes('Out-File -FilePath')) throw new Error('the raw command stayed hidden after it was asked for')
  if (!out.includes('收起原命令')) throw new Error('the raw command could not be folded again')
  React.forcedRaw = false

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

  // 5) The manual switch: it is always on screen and always says which state it
  // is in. A per-request exemption hid its own button once granted, so a reader
  // could not find it again — that is the bug this replaced, and the two states
  // are therefore mutually exclusive but never both absent.
  React.forcedView = 'unified'
  listPayload = {
    ok: true,
    value: {
      changes: [
        { id: 'c4', sessionId: 's1', tool: 'write', displayPath: 'D:/w/app.js', op: 'update', added: 1, removed: 1, oldLineCount: 3, newLineCount: 3, truncated: false, reviewable: true },
      ],
      diag: null,
      // One entry per conversation that has the switch on. A plain boolean was
      // wrong: it made every tab show whichever conversation was toggled last,
      // so a tab nobody touched lost its own state.
      allowAll: {},
    },
  }
  detailPayload = {
    ok: true,
    value: {
      change: { id: 'c4' },
      rows: [
        { t: 'del', a: 2, b: null, text: 'const a = 1' },
        { t: 'add', a: null, b: 2, text: 'const a = 2' },
      ],
      before: 'const a = 1\n',
      after: 'const a = 2\n',
    },
  }
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('ALLOW OUT:', out)
  if (!out.includes('全部允许')) throw new Error('the allow-all switch did not render')
  if (out.includes('已全部允许 · 点此关闭')) throw new Error('the switch claimed to be on before it was turned on')

  // Turned on: the same spot now offers the way back off. Without that, the
  // panel would go quiet with no control to undo it.
  listPayload.value.allowAll = { s1: true }
  await poll()
  out = await render()
  if (!out.includes('已全部允许 · 点此关闭')) throw new Error('the switch did not show its on state')
  if (!out.includes('已全部允许：写入不再询问')) throw new Error('the note did not explain what the switch turned off')

  // And the state the reader is actually in a second after flipping it: the last
  // change was accepted, the queue is empty, and the panel is showing its empty
  // page. The bar must survive that — an empty panel with no bar is a switch that
  // cannot be found again, which is the whole bug this is guarding.
  listPayload.value.changes = []
  await poll()
  out = await render()
  if (!out.includes('已全部允许 · 点此关闭')) throw new Error('the switch vanished once the queue emptied')
  if (!out.includes('暂无待审查的文件改动')) throw new Error('the empty page did not render under the switch')

  // Another conversation's tab must not inherit this one's state. It is the bug
  // that prompted the per-session table: flipping the switch in one panel used to
  // change every other panel, so a tab nobody touched could lose its own button.
  const otherTab = serialize(TabBody({ sessionId: 's2' }))
  if (otherTab.includes('已全部允许')) throw new Error('this conversation switch leaked into another one')
  if (!otherTab.includes('全部允许')) throw new Error('the other conversation lost its off switch')

  // And back off again, which must also work from an empty panel. With nothing to
  // review there is nothing to allow, so the off switch is the only thing left to
  // show — its absence here is what the reader is testing for.
  listPayload.value.allowAll = {}
  listPayload.value.changes = []
  await poll()
  out = await render()
  if (out.includes('已全部允许')) throw new Error('the switch stayed on after being turned off')
  console.log('allow-all-switch: OK')

  // The chip sits in one Session's header, so its number must be that Session's
  // number. Before this filter the title counted the whole poll, which announced
  // Session A's pending change inside Session B's header.
  const TabTitle = registered['sidebar.right.pane.tab.title']
  if (typeof TabTitle !== 'function') throw new Error('tab title not registered')
  const titleFor = (sid) => serialize(TabTitle({ sessionId: sid }))
  listPayload.value.allowAll = {}
  listPayload.value.changes = [
    { id: 'c5', sessionId: 's1', tool: 'write', displayPath: 'D:/w/app.js', op: 'update', added: 1, removed: 1, oldLineCount: 3, newLineCount: 3, truncated: false, reviewable: true },
    { id: 'c6', sessionId: 's2', tool: 'write', displayPath: 'D:/w/other.js', op: 'update', added: 1, removed: 1, oldLineCount: 3, newLineCount: 3, truncated: false, reviewable: true },
  ]
  await poll()
  if (!titleFor('s1').includes('(1)')) throw new Error('the first session chip did not count its own change')
  if (!titleFor('s2').includes('(1)')) throw new Error('the second session chip did not count its own change')
  if (titleFor('s1').includes('(2)')) throw new Error('the chip counted another session change')
  console.log('session-scoped title: OK')

  // The guide entry is what the sidebar's "start" page lists. Its artwork comes
  // from the type definition, not from the manifest: a type with no `icon` renders
  // the sidebar's own cube, so a missing icon here is invisible to any test that
  // only looks at the manifest file. Read the vnode rather than its serialisation —
  // the serialiser here keeps class names only, and an <svg> has none.
  if (tabDefinition === null) throw new Error('tab type was never registered')
  const guideEntry = Array.isArray(tabDefinition.guide) ? tabDefinition.guide[0] : undefined
  if (guideEntry === undefined) throw new Error('the tab type lost its guide entry')
  if (typeof guideEntry.icon !== 'function') throw new Error('the guide entry has no artwork, so the start page draws the sidebar cube')
  const artwork = guideEntry.icon({ size: 22 })
  if (artwork === null || typeof artwork !== 'object' || artwork.type !== 'svg') throw new Error('the guide artwork is not an svg')
  if (artwork.props.viewBox !== '0 0 1024 1024') throw new Error('the guide artwork lost its viewBox')
  if (artwork.props.width !== 22 || artwork.props.height !== 22) throw new Error('the guide artwork ignored the size the sidebar passed')
  const paths = Array.isArray(artwork.children) ? artwork.children : []
  if (paths.length !== 2) throw new Error('the guide artwork lost one of its two shapes')
  const fills = paths.map((path) => (path && path.props ? path.props.fill : undefined))
  if (fills.indexOf('#D6F3FA') === -1 || fills.indexOf('#18BAE5') === -1) throw new Error('the guide artwork lost its literal fills')
  if (fills.some((fill) => typeof fill !== 'string' || fill.indexOf('currentColor') !== -1)) throw new Error('the guide artwork relies on currentColor, which neither an <img> nor the sidebar ink provides')
  if (paths.some((path) => typeof path.props.d !== 'string' || path.props.d.length < 100)) throw new Error('the guide artwork lost its path data')
  console.log('guide artwork: OK')

  // The history screen: what was already reviewed, and the one action it offers.
  // It has to be reachable with nothing pending, because that is exactly when a
  // reader wants to take back the change they just accepted.
  historyPayload = {
    ok: true,
    value: {
      entries: [
        { id: 'h1', path: 'D:/w/accepted.js', op: 'update', state: 'accepted', restorable: true, verify: { kind: 'sha', sha: 'aa' }, restoredAt: null },
        { id: 'h2', path: 'D:/w/gone.js', op: 'delete', state: 'accepted', restorable: true, verify: { kind: 'absent' }, restoredAt: 1 },
        { id: 'h3', path: 'D:/w/refused.js', op: 'update', state: 'rejected', restorable: true, verify: { kind: 'sha', sha: 'bb' }, restoredAt: null },
        { id: 'h4', path: 'D:/w/big.js', op: 'update', state: 'accepted', restorable: false, verify: null, restoredAt: null },
      ],
    },
  }
  // The screen's own state is a useState the stub cannot update, and its list
  // arrives from a fetch that resolves after the render. Both are forced here.
  React.forcedList = historyPayload.value.entries
  listPayload = { ok: true, value: { changes: [], diag: null, allowAll: {} } }
  detailPayload = { ok: true, value: { missing: true } }
  React.forcedHistory = true
  await poll()
  out = await render()
  if (process.env.DUMP) console.log('HISTORY OUT:', out)
  if (!out.includes('accepted.js')) throw new Error('the history screen did not list a reviewed change')
  if (!out.includes('已还原')) throw new Error('the history screen did not mark an already-restored entry')
  // Exactly one undo button: the restored entry, the rejected one (never reached
  // the disk) and the truncated one (no trustworthy bytes) must not offer one.
  if ((out.match(/<dshr-btn>/g) || []).length === 0) throw new Error('the history screen offered no undo at all')
  const undoButtons = out.split('<dshr-btn>').filter((chunk) => chunk.startsWith('还原'))
  if (undoButtons.length !== 1) throw new Error(`the history screen offered ${undoButtons.length} undos, expected 1`)
  if (out.includes('本会话还没有审查记录')) throw new Error('the history screen showed its empty hint with entries present')
  React.forcedHistory = false
  React.forcedList = null

  console.log('client render smoke: OK')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error && error.message)
    process.exit(1)
  },
)
