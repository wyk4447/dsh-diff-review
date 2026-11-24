/**
 * The smoke test: does the plugin hold together as a whole?
 *
 * The suites below check behaviour. This one checks the shape — that the
 * package ships what it says it ships, that the host module exports what the
 * host calls, and that applying it to a context wires the route and the gate
 * without throwing. It is the first thing to run when the plugin does not
 * load at all, which is the failure nobody wants to debug through a panel.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* ---- what the package says it ships ---- */
check('the package has a version', typeof manifest.version === 'string' && manifest.version !== '')
check('the package is an es module', manifest.type === 'module')
check('the package names its entry', existsSync(join(root, manifest.main)))
check('the client entry exists', existsSync(join(root, manifest.exports['./client'])))
check('the icon exists', existsSync(join(root, manifest.icon)))
for (const entry of manifest.files) {
  check(`the package ships ${entry}`, existsSync(join(root, entry)))
}

/* ---- the manifest the host reads ---- */
check('the manifest declares its version', manifest.dsh?.manifestVersion === 1)
check('the manifest declares a bundle', typeof manifest.dsh?.bundle?.patch === 'string')
check('the bundle patch exists', existsSync(join(root, manifest.dsh.bundle.patch)))
check('the manifest declares a client', manifest.dsh?.client?.platform === 'web')
check('the client injects the sidebar', Array.isArray(manifest.dsh.client.inject))
check('the client injects the locale', manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
// The host resolves these against its own tree; a name it does not have is a
// bundle that fails to load with nothing to point at.
for (const name of manifest.dsh.client.inject) {
  check(`the injected module exists in the host: ${name}`, name.startsWith('@deepseek-ai/'))
}
check('the engine range accepts the host', typeof manifest.engines?.dsh === 'string')
check('the node engine is declared', typeof manifest.engines?.node === 'string')

/* ---- the host module ---- */
const host = await import('../lib/index.js')
check('the host module exports apply', typeof host.apply === 'function')
check('the host module exports inject', Array.isArray(host.inject))
check('the host module exports its namespace', typeof host.NS === 'string' && host.NS !== '')
check('the host module exports its api prefix', typeof host.API_PREFIX === 'string' && host.API_PREFIX !== '')
check('the host module exports the shell parser', typeof host.parseShellCommand === 'function')
check('the parser reads a command', host.parseShellCommand('Remove-Item a.txt').length === 1)

/* ---- applying it ---- */
const routes = []
const handlers = new Map()
const ctx = {
  get: () => undefined,
  effect: (fn) => { const dispose = fn(); return () => dispose && dispose() },
  on: (event, handler) => { handlers.set(event, handler); return () => {} },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  connection: { requestRejection: () => undefined },
  fs: {},
}
host.apply(ctx, { trace: false })
check('the api route is registered', routes.length === 1)
check('the route has a handler', typeof routes[0]?.handler === 'function')
check('the route is mounted on the prefix', String(routes[0]?.path ?? '').includes(host.API_PREFIX))
check('the gate is subscribed', typeof handlers.get('tools/pre-execute') === 'function')
check('the takeover listener is subscribed', typeof handlers.get('tools/post-execute') === 'function')
check('the session listener is subscribed', typeof handlers.get('session/event') === 'function')

/* ---- the client module ---- */
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let registered = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => { registered = definition },
    },
  },
  console,
}
sandbox.window.document = { hidden: false }
sandbox.globalThis = sandbox
try {
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })
  check('the client module registers itself', registered !== null)
  check('the client module has an id', typeof registered?.id === 'string' && registered.id !== '')
  check('the client module has a factory', typeof registered?.factory === 'function')
} catch (error) {
  check(`the client module loads: ${error.message}`, false)
}

console.log(`\n${failures === 0 ? 'SMOKE OK' : `${failures} FAILED`} (${passes} passed)`)
if (failures > 0) process.exit(1)
