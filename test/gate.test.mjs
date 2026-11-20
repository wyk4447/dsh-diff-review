import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

// Snapshots go to a throwaway directory: a test run must not fill the real
// `~/.dsh/diff-review/history` with entries for files that never existed.
const snapshotRoot = mkdtempSync(join(tmpdir(), 'diff-review-gate-'))
process.env.DSH_DIFF_REVIEW_HISTORY_ROOT = snapshotRoot

const results = []
const check = (label, value) => results.push([label, value === true])

// A tiny stand-in for the workspace, so a restore has something real to change.
// `readText` used to be a constant, which made "the file changed after the
// review" impossible to express — the exact case a safe undo has to refuse.
const DEFAULT_TEXT = 'alpha\nbeta\ngamma\ndelta\n'
const files = new Map()
const writes = []
const currentText = (key) => (files.has(key) ? files.get(key) : DEFAULT_TEXT)
// Versions are fake but they have to move, because `replaceIfVersion` is the only
// thing standing between an in-panel edit and overwriting a file that changed
// while the panel was open. A stub that always says `v1` would make that guard
// untestable — every write would look fresh.
const versions = new Map()
let versionCounter = 1
const currentVersion = (key) => (versions.has(key) ? versions.get(key) : 'v1')
// Files that start out absent for this fake workspace. A write creates them; a
// delete removes them again. The creation-then-deletion case a turn can produce
// needs a second such name, and `fresh.txt` is already load-bearing above.
const absentFiles = new Set(['D:/w/fresh.txt', 'D:/w/brand-new.txt'])

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
      // `fresh.txt` does not exist in this fake workspace: that is what makes the
      // creation path distinguishable from an overwrite. `size` is real, because a
      // binary file is reported by size alone and a fake without it would let the
      // byte-count path pass while reporting 0 → 0.
      stat: async (target) => (absentFiles.has(String(target.targetKey)) || files.get(String(target.targetKey)) === null
        ? undefined
        : String(target.targetKey).includes('exists-dir')
          ? { version: currentVersion(String(target.targetKey)), type: 'directory', size: 0 }
          : {
              version: currentVersion(String(target.targetKey)),
              type: 'file',
              size: Buffer.byteLength(currentText(String(target.targetKey)), 'utf8'),
            }),
      readText: async (target) => currentText(String(target.targetKey)),
      writeText: async (target, content, expected) => {
        const key = String(target.targetKey)
        // Mirror the host's guard, otherwise the fake would happily accept a write
        // that the real filesystem refuses and the "stale" path would go untested.
        if (expected?.kind === 'replaceIfVersion') {
          // `files` only holds what a test explicitly wrote or deleted; an absent
          // key still means the default text exists, which is exactly what `stat`
          // reports above. Only an explicit `null` is a missing file.
          if (files.get(key) === null) {
            const error = new Error('stale version')
            error.code = 'FS_STALE_VERSION'
            throw error
          }
          if (currentVersion(key) !== expected.version) {
            const error = new Error('stale version')
            error.code = 'FS_STALE_VERSION'
            throw error
          }
        } else if (expected?.kind === 'createIfAbsent' && files.has(key) && files.get(key) !== null) {
          const error = new Error('already exists')
          error.code = 'FS_NOT_OBSERVED'
          throw error
        }
        writes.push({ key, content })
        files.set(key, content)
        // A path that started out absent stops being absent the moment it is
        // written; leaving it in the set would report a created file as missing.
        absentFiles.delete(key)
        versionCounter += 1
        versions.set(key, `v${versionCounter}`)
        return { operation: 'write', version: currentVersion(key) }
      },
      deleteFile: async (target) => {
        const key = String(target.targetKey)
        const before = currentText(key)
        files.set(key, null)
        versionCounter += 1
        versions.set(key, `v${versionCounter}`)
        return { before }
      },
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

// A path the shell expands cannot be resolved, so the gate has to confirm the
// command itself. Before this was handled, `Remove-Item -LiteralPath $p` parsed
// as the literal name `$p`, resolved to nothing, and went through unreviewed.
const expanded = [
  'Remove-Item -LiteralPath $p -Force',
  'Remove-Item -LiteralPath "${target}"',
]
for (const command of expanded) {
  await call(route, 'list', {})
  const parkedExpanded = gate(exec('pwsh', { command }), next)
  await wait(30)
  const listedExpanded = await call(route, 'list', {})
  check(`shell expanded target parks ${command}`, listedExpanded.value.changes.length === 1)
  await call(route, 'decide', { id: listedExpanded.value.changes[0].id, action: 'reject' })
  check(`shell expanded target reject denies ${command}`, (await parkedExpanded).kind === 'deny')
}

// A write whose content the shell decides is not worth interrupting for: the
// reviewer cannot judge what they cannot see, so only *deletes* stay gated in
// that case. Parking every `Set-Content -Value $out` was pure noise.
await call(route, 'list', {})
const parkedUnknownWrite = gate(exec('pwsh', { command: 'Set-Content -Path $out -Value hi' }), next)
check('shell unknown write is not parked', (await parkedUnknownWrite).kind === 'allow')
const listedUnknownWrite = await call(route, 'list', {})
check('shell unknown write leaves nothing pending', listedUnknownWrite.value.changes.length === 0)

// `$env:TEMP` is the one expansion the host can replay, and replaying it turns a
// throwaway scratch delete into a path `isTempPath` recognises — so it must be
// skipped, not parked. Left unexpanded it never matched, and every cleanup of a
// file in the OS temp directory asked the user to approve it.
await call(route, 'list', {})
const parkedEnvTemp = gate(exec('pwsh', { command: 'Remove-Item $env:TEMP\\probe.txt -Force' }), next)
check('shell env temp target is skipped', (await parkedEnvTemp).kind === 'allow')
const listedEnvTemp = await call(route, 'list', {})
check('shell env temp target leaves nothing pending', listedEnvTemp.value.changes.length === 0)

// cmd spells the same thing `%TEMP%`, and cmd expands it before the command runs,
// so a throwaway delete written that way names the OS temp directory exactly as
// `$env:TEMP` does. Left unexpanded it matched no known location and every
// `cmd /c "del %TEMP%\a.txt"` cleanup stopped for approval.
if (typeof process.env.TEMP === 'string' && process.env.TEMP !== '') {
  await call(route, 'list', {})
  const parkedCmdTemp = gate(exec('pwsh', { command: 'cmd /c "del %TEMP%\\probe-cmd.txt" 2>&1' }), next)
  check('cmd percent-temp delete is skipped', (await parkedCmdTemp).kind === 'allow')
  const listedCmdTemp = await call(route, 'list', {})
  check('cmd percent-temp delete leaves nothing pending', listedCmdTemp.value.changes.length === 0)

  // ...but a `%NAME%` that expands to somewhere real outside scratch/temp is a
  // write like any other, and an unknown one is unknowable: both still park.
  const parkedCmdProfile = gate(exec('pwsh', { command: 'cmd /c "del %USERPROFILE%\\a.txt" 2>&1' }), next)
  await wait(30)
  const listedCmdProfile = await call(route, 'list', {})
  check('cmd percent-var delete outside scratch parks', listedCmdProfile.value.changes.length === 1)
  await call(route, 'decide', { id: listedCmdProfile.value.changes[0].id, action: 'reject' })
  check('cmd percent-var delete reject denies', (await parkedCmdProfile).kind === 'deny')

  await call(route, 'list', {})
  const parkedCmdUnknown = gate(exec('pwsh', { command: 'cmd /c "del %DSH_NO_SUCH_VAR%\\a.txt" 2>&1' }), next)
  await wait(30)
  const listedCmdUnknown = await call(route, 'list', {})
  check('cmd unknown percent-var parks', listedCmdUnknown.value.changes.length === 1)
  await call(route, 'decide', { id: listedCmdUnknown.value.changes[0].id, action: 'reject' })
  check('cmd unknown percent-var reject denies', (await parkedCmdUnknown).kind === 'deny')

  // A PowerShell cmdlet naming its target with cmd's spelling resolves the same
  // way, so `skipTemp` sees a temp path and the command stays quiet.
  await call(route, 'list', {})
  const parkedCmdletTemp = gate(exec('pwsh', { command: 'Remove-Item "%TEMP%\\probe-cmdlet.txt" -Force' }), next)
  check('a cmdlet target spelled with percent-temp is skipped', (await parkedCmdletTemp).kind === 'allow')
}

// Formatters and linters asked to rewrite in place name no `-Path`/`-Value` and
// print no redirection, so they used to arrive with no ops at all and were waved
// through — a real write the gate could not see. The flag is what decides: the
// same tool without it only reads and prints.
for (const command of [
  'npx prettier --write D:/w/a.txt',
  'npx eslint --fix D:/w/a.txt',
  'npx stylelint --fix D:/w/a.css',
  "sed -i 's/a/b/' D:/w/a.txt",
  "perl -pi -e 's/a/b/' D:/w/a.txt",
  'black D:/w/a.py',
  'gofmt -w D:/w/main.go',
  'pnpm exec prettier --write D:/w/a.ts',
]) {
  await call(route, 'list', {})
  const parkedRewriter = gate(exec('pwsh', { command }), next)
  await wait(30)
  const listedRewriter = await call(route, 'list', {})
  check(`an in-place rewriter parks ${command}`, listedRewriter.value.changes.length === 1)
  await call(route, 'decide', { id: listedRewriter.value.changes[0].id, action: 'accept' })
  check(`an in-place rewriter accept allows ${command}`, (await parkedRewriter).kind === 'allow')
}

// The read-only spelling of the same tools touches no file, so it stays silent.
for (const command of [
  'npx prettier --check D:/w/a.txt',
  'npx prettier D:/w/a.txt',
  "sed -n '1,5p' D:/w/a.txt",
  'black --check D:/w/a.py',
  'rustfmt --check D:/w/main.rs',
  'pnpm exec tsc --noEmit',
  'npm run build',
]) {
  await call(route, 'list', {})
  const clearRewriter = await gate(exec('pwsh', { command }), next)
  check(`a read-only lint run does not park ${command}`, clearRewriter.kind === 'allow')
}

// The tool's output is its own decision, but *which files it was handed* is on
// the command line. The record has to name them — otherwise the panel said
// "command, result unknown" and the reviewer could not tell what was about to
// change, even when the command said `a.txt` in plain sight.
for (const [command, expected] of [
  ['npx prettier --write D:/w/a.txt', ['D:/w/a.txt']],
  ['npx eslint --fix D:/w/a.txt D:/w/b.txt', ['D:/w/a.txt', 'D:/w/b.txt']],
  ["sed -i 's/a/b/' D:/w/a.txt", ['D:/w/a.txt']],
  // The real command line carries plumbing and quoting: a redirect tail is not a
  // file name, and the quotes around a path are not part of it. Both leaked into
  // the record once, showing a target literally named `'D:/w/a.txt'` and a second
  // one named `2>`.
  ["npx prettier --write 'D:/w/a.txt' 2>&1", ['D:/w/a.txt']],
  ["sed -i 's/a/b/' 'D:/w/a.txt' 2>&1 | Out-String", ['D:/w/a.txt']],
  ['npx prettier --write', []],
]) {
  await call(route, 'list', {})
  const namedParked = gate(exec('pwsh', { command }), next)
  await wait(30)
  const namedListed = await call(route, 'list', {})
  const named = namedListed.value.changes.length === 1 ? namedListed.value.changes[0] : undefined
  // A sweep names no file of its own: the record is command-level, and the strip
  // is drawn from `targets` only when there is something real to name.
  const namedPaths = named !== undefined && Array.isArray(named.targets) && named.fileless !== true
    ? named.targets.map((item) => item.path).join(',')
    : ''
  check(`an in-place rewriter names its files ${command}`, named !== undefined
    && namedPaths === expected.join(','))
  // A sweep names nothing, so there is no file strip to draw and no per-file
  // restore: it stays a command-level review with no path of its own.
  check(`an in-place sweep stays command level ${command}`, named !== undefined
    && (expected.length > 0 || named.fileless === true))
  await call(route, 'decide', { id: named.id, action: 'accept' })
  check(`an in-place named accept allows ${command}`, (await namedParked).kind === 'allow')
}

// A formatter wrapped in a shell still names its files. The shell carries the
// command; it does not decide which paths the tool is handed. The same command
// bare has always listed `a.txt`, so the wrapped form used to fall behind it and
// showed "command, result unknown" instead.
await call(route, 'list', {})
const wrappedParked = gate(exec('pwsh', { command: 'cmd /c "npx prettier --write D:/w/a.txt"' }), next)
await wait(30)
const wrappedListed = await call(route, 'list', {})
const wrapped = wrappedListed.value.changes.length === 1 ? wrappedListed.value.changes[0] : undefined
check('a wrapped formatter still names its file', wrapped !== undefined
  && Array.isArray(wrapped.targets)
  && wrapped.targets.length === 1
  && wrapped.targets[0].path === 'D:/w/a.txt')
check('a wrapped formatter is reviewed as an in-place rewrite', wrapped !== undefined
  && wrapped.reason === 'inplace')
await call(route, 'decide', { id: wrapped.id, action: 'accept' })
check('a wrapped formatter accept allows', (await wrappedParked).kind === 'allow')

// The rewritten content is the tool's decision, so the entry has a before text
// but no after text and no proof to restore by. It still belongs in "this turn":
// the reviewer approved this file by name.
const wrappedHistory = await call(route, 'history', { sessionId: 's1' })
const wrappedEntries = wrappedHistory.value.entries.filter((entry) => entry.path === 'D:/w/a.txt'
  && entry.verify == null)
check('an in-place entry reaches the history', wrappedEntries.length > 0)
check('an in-place entry keeps its before text', wrappedEntries.every((entry) => entry.restorable === true
  || entry.beforeBytes > 0))

// A wrapped removal stays command level: which files `del` reaches is decided by
// the shell at run time, not by this parser at review time.
await call(route, 'list', {})
const wrappedDeleteParked = gate(exec('pwsh', { command: 'cmd /c "del D:/w/a.txt"' }), next)
await wait(30)
const wrappedDeleteListed = await call(route, 'list', {})
const wrappedDelete = wrappedDeleteListed.value.changes.length === 1
  ? wrappedDeleteListed.value.changes[0]
  : undefined
check('a wrapped removal stays command level', wrappedDelete !== undefined
  && wrappedDelete.fileless === true)
await call(route, 'decide', { id: wrappedDelete.id, action: 'accept' })
check('a wrapped removal accept allows', (await wrappedDeleteParked).kind === 'allow')

// A comma-separated list can sit in one argument: `Remove-Item 'a.txt','b.txt'`.
// The commas are outside the quotes, so each name needs unquoting on its own.
await call(route, 'list', {})
const parkedList = gate(exec('pwsh', { command: "Remove-Item 'D:/w/a.txt','D:/w/b.txt' -Force" }), next)
await wait(30)
const listedList = await call(route, 'list', {})
const listTargets = listedList.value.changes.length === 1 ? listedList.value.changes[0].targets : []
check('shell comma list parks', listedList.value.changes.length === 1)
check(
  'shell comma list keeps both names clean',
  Array.isArray(listTargets) && listTargets.length === 2
    && listTargets[0].path === 'D:/w/a.txt' && listTargets[1].path === 'D:/w/b.txt',
)
await call(route, 'decide', { id: listedList.value.changes[0].id, action: 'accept' })
check('shell comma list accept allows', (await parkedList).kind === 'allow')

// The same file written twice in one command used to appear twice in the header
// (`D:/w/a.txt, D:/w/a.txt`), which reads like two files. Seeding a file with a
// .NET call and then rewriting it with a cmdlet is an ordinary thing to do.
const twiceSame = await parkShell([
  "[System.IO.File]::WriteAllText('D:/w/a.txt', 'seed')",
  "Set-Content -Path 'D:/w/a.txt' -Value 'body'",
].join('\n'))
check('shell duplicate target still parks', twiceSame.item !== undefined)
// `targets` now names files, not operations: the two writes to one file are one
// target carrying both operations inside its own diff.
check('shell duplicate target keeps one entry', twiceSame.item !== undefined && twiceSame.item.targets.length === 1)
check('shell duplicate target names the file once', twiceSame.item !== undefined && twiceSame.item.displayPath === 'D:/w/a.txt')
await call(route, 'decide', { id: twiceSame.item.id, action: 'accept' })
check('shell duplicate target accept allows', (await twiceSame.parked).kind === 'allow')

// Two different files must still both be named, in the order the command wrote them.
const twoFiles = await parkShell([
  "[System.IO.File]::WriteAllText('D:/w/a.txt', 'seed')",
  "Set-Content -Path 'D:/w/b.txt' -Value 'body'",
].join('\n'))
check('shell two files names both', twoFiles.item !== undefined && twoFiles.item.displayPath === 'D:/w/a.txt, D:/w/b.txt')
await call(route, 'decide', { id: twoFiles.item.id, action: 'accept' })
check('shell two files accept allows', (await twoFiles.parked).kind === 'allow')

// The exemption has to stay narrow: a literal `$` in a file name is a real path.
await call(route, 'list', {})
const parkedDollar = gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/a$b.txt'" }), next)
await wait(30)
const listedDollar = await call(route, 'list', {})
check('shell literal dollar name still parks', listedDollar.value.changes.length === 1)
check('shell literal dollar name keeps its path', listedDollar.value.changes[0].path === 'D:/w/a$b.txt')
await call(route, 'decide', { id: listedDollar.value.changes[0].id, action: 'accept' })
check('shell literal dollar name accept allows', (await parkedDollar).kind === 'allow')

// A script block is a statement sequence: `if (Test-Path $t) { Remove-Item $t }`
// used to tokenize as one run starting with `if(Test-Path`, match no cmdlet, and
// let the delete inside it through unreviewed. Every block form must park.
for (const command of [
  "if (Test-Path 'D:/w/a.txt') { Remove-Item -LiteralPath 'D:/w/a.txt' -Force }",
  "& { Remove-Item -LiteralPath 'D:/w/a.txt' }",
  "foreach ($f in @('D:/w/a.txt')) { Remove-Item $f -Force }",
]) {
  await call(route, 'list', {})
  const parkedBlock = gate(exec('pwsh', { command }), next)
  await wait(30)
  const listedBlock = await call(route, 'list', {})
  check(`shell script block parks ${command}`, listedBlock.value.changes.length === 1)
  await call(route, 'decide', { id: listedBlock.value.changes[0].id, action: 'accept' })
  check(`shell script block accept allows ${command}`, (await parkedBlock).kind === 'allow')
}

// A compact assignment has no spaces, so it tokenizes as one token; missing it
// meant the very next `Remove-Item $t` stayed at command level.
await call(route, 'list', {})
const parkedCompact = gate(exec('pwsh', { command: "$t='D:/w/a.txt'\nRemove-Item $t -Force" }), next)
await wait(30)
const listedCompact = await call(route, 'list', {})
check('shell compact assignment resolves the path', listedCompact.value.changes.length === 1 && listedCompact.value.changes[0].path === 'D:/w/a.txt')
await call(route, 'decide', { id: listedCompact.value.changes[0].id, action: 'accept' })
check('shell compact assignment accept allows', (await parkedCompact).kind === 'allow')

/* ---- shell literal writes ---- */
// A command that carries its content as a quoted literal is knowable up front, so
// the reviewer gets a real diff instead of "the result is not knowable".
async function parkShell(command) {
  await call(route, 'list', {})
  const parked = gate(exec('pwsh', { command }), next)
  await wait(30)
  const listed = await call(route, 'list', {})
  if (listed.value.changes.length !== 1) return { parked, item: undefined, detail: undefined, listed }
  const item = listed.value.changes[0]
  const detail = (await call(route, 'detail', { id: item.id })).value
  return { parked, item, detail, listed }
}

const overwrite = await parkShell("Set-Content -Path 'D:/w/a.txt' -Value 'one'")
check('shell literal overwrite parks', overwrite.item !== undefined && overwrite.item.op === 'update')
check('shell literal overwrite is reviewable', overwrite.item !== undefined && overwrite.item.reviewable === true)
check('shell literal overwrite has no reason', overwrite.item !== undefined && overwrite.item.reason === undefined)
check('shell literal overwrite keeps the old text', overwrite.detail.before.includes('alpha'))
check('shell literal overwrite shows the new text', overwrite.detail.after === 'one')
check('shell literal overwrite has rows', Array.isArray(overwrite.detail.rows) && overwrite.detail.rows.length > 0)
await call(route, 'decide', { id: overwrite.item.id, action: 'accept' })
check('shell literal overwrite accept allows', (await overwrite.parked).kind === 'allow')

// `-Value $x` is produced at run time. A *write* whose content nobody can see is
// not worth interrupting for — the reviewer cannot judge it — so it goes straight
// through. Only a delete stays gated when its content is unknowable, because that
// cannot be undone.
await call(route, 'list', {})
const runtime = gate(exec('pwsh', { command: 'Set-Content -Path D:/w/a.txt -Value $x' }), next)
check('shell runtime write is not parked', (await runtime).kind === 'allow')
const listedRuntime = await call(route, 'list', {})
check('shell runtime write leaves nothing pending', listedRuntime.value.changes.length === 0)

// Append semantics: the diff has to keep the existing lines and add the new one.
const appended = await parkShell("Add-Content -Path 'D:/w/a.txt' -Value 'epsilon'")
check('shell append is reviewable', appended.item !== undefined && appended.item.reviewable === true)
check('shell append keeps the old text', appended.detail.after.startsWith('alpha'))
check('shell append adds the new line', appended.detail.after.trimEnd().endsWith('epsilon'))
check('shell append shows only an addition', appended.item.added === 1 && appended.item.removed === 0)
await call(route, 'decide', { id: appended.item.id, action: 'accept' })
check('shell append accept allows', (await appended.parked).kind === 'allow')

// The same rule applies to redirection, and `2>` carries no content at all.
const redirect = await parkShell("'redirected' > 'D:/w/a.txt'")
check('shell literal redirect is reviewable', redirect.item !== undefined && redirect.item.reviewable === true)
check('shell literal redirect shows the new text', redirect.detail.after === 'redirected')
await call(route, 'decide', { id: redirect.item.id, action: 'accept' })
check('shell literal redirect accept allows', (await redirect.parked).kind === 'allow')

// A redirect whose content the shell supplies is the same shape as `-Value $x`:
// one known file, text nobody can see, so it is no longer worth stopping for.
await call(route, 'list', {})
const streamed = gate(exec('pwsh', { command: '$js > D:/w/a.txt' }), next)
check('shell runtime redirect is not parked', (await streamed).kind === 'allow')
const listedStreamed = await call(route, 'list', {})
check('shell runtime redirect leaves nothing pending', listedStreamed.value.changes.length === 0)

// Writing a file that does not exist yet is a creation, and the whole content is
// new — the badge must not call it an edit of nothing.
const fresh = await parkShell("Set-Content -Path 'D:/w/fresh.txt' -Value 'brand new'")
check('shell new file is a create', fresh.item !== undefined && fresh.item.op === 'create')
check('shell new file is reviewable', fresh.item !== undefined && fresh.item.reviewable === true)
check('shell new file has no old text', fresh.detail.before === '')
check('shell new file shows the new text', fresh.detail.after === 'brand new')
await call(route, 'decide', { id: fresh.item.id, action: 'accept' })
check('shell new file accept allows', (await fresh.parked).kind === 'allow')

/* ---- shell literal writes through a variable ---- */
// Real commands build the payload first and hand over a variable, so a variable
// that was assigned a literal in the same command is still knowable. Without
// this, the ordinary `$t = '...'; Set-Content -Value $t` shape showed no diff.
const viaVariable = await parkShell("$t = 'one'\nSet-Content -Path D:/w/a.txt -Value $t")
check('shell variable write parks', viaVariable.item !== undefined && viaVariable.item.op === 'update')
check('shell variable write is reviewable', viaVariable.item !== undefined && viaVariable.item.reviewable === true)
check('shell variable write has no reason', viaVariable.item !== undefined && viaVariable.item.reason === undefined)
check('shell variable write keeps the old text', viaVariable.detail.before.includes('alpha'))
check('shell variable write shows the new text', viaVariable.detail.after === 'one')
await call(route, 'decide', { id: viaVariable.item.id, action: 'accept' })
check('shell variable write accept allows', (await viaVariable.parked).kind === 'allow')

// Backtick escapes decide the bytes, so they have to be resolved: `` `n `` is a
// newline, not the letter n. This is the shape that produced the reported "no
// diff" panel.
const escaped = await parkShell('$c = "first`nsecond`n"\nSet-Content -Path D:/w/a.txt -Value $c')
check('shell escaped write is reviewable', escaped.item !== undefined && escaped.item.reviewable === true)
check('shell escaped write has two lines', escaped.detail.after === 'first\nsecond\n')
check('shell escaped write adds both lines', escaped.item.added === 2)
await call(route, 'decide', { id: escaped.item.id, action: 'accept' })
check('shell escaped write accept allows', (await escaped.parked).kind === 'allow')

// A variable holding a path is the same idea: `$p = '...'; Remove-Item $p` names
// a real file, so it must be reviewed as that file, not as the text `$p`.
const pathVariable = await parkShell("$p = 'D:/w/a.txt'\nRemove-Item -LiteralPath $p")
check('shell variable path parks', pathVariable.item !== undefined)
check('shell variable path resolves the file', pathVariable.item !== undefined && pathVariable.item.path === 'D:/w/a.txt')
check('shell variable path is a delete', pathVariable.item !== undefined && pathVariable.item.op === 'delete')
await call(route, 'decide', { id: pathVariable.item.id, action: 'accept' })
check('shell variable path accept allows', (await pathVariable.parked).kind === 'allow')

// A here-string is how every multi-line payload is actually written. Its body
// spans newlines and freely contains `|`, `&`, braces and quotes — a markdown
// table alone is enough to tear a line-based splitter apart.
const hereLiteral = await parkShell([
  "$p = 'D:/w/a.txt'",
  "$add = @'",
  'line one',
  'line two',
  "'@",
  '[System.IO.File]::WriteAllText($p, $add)',
].join('\n'))
check('shell here-string literal is reviewable', hereLiteral.item !== undefined && hereLiteral.item.reviewable === true)
check('shell here-string literal has both lines', hereLiteral.detail.after === 'line one\nline two')
await call(route, 'decide', { id: hereLiteral.item.id, action: 'accept' })
check('shell here-string literal accept allows', (await hereLiteral.parked).kind === 'allow')

// A markdown table inside the body: pipes and a `---` rule, which the statement
// splitter would otherwise treat as command boundaries.
const hereTable = await parkShell([
  "$c = @'",
  '| a | b |',
  '| - | - |',
  "'@",
  "Set-Content -Path 'D:/w/a.txt' -Value $c",
].join('\n'))
check('shell here-string table is reviewable', hereTable.item !== undefined && hereTable.item.reviewable === true)
check('shell here-string table keeps the pipes', hereTable.detail.after === '| a | b |\n| - | - |')
await call(route, 'decide', { id: hereTable.item.id, action: 'accept' })
check('shell here-string table accept allows', (await hereTable.parked).kind === 'allow')

// An expanding here-string follows the same rule as `"..."`: knowable only when
// every reference was assigned a literal earlier in the same command.
const hereKnown = await parkShell([
  "$v = 'hello'",
  '$add = @"',
  'line $v',
  '"@',
  "[System.IO.File]::WriteAllText('D:/w/a.txt', $add)",
].join('\n'))
check('shell here-string interpolates a known value', hereKnown.detail !== undefined && hereKnown.detail.after === 'line hello')
await call(route, 'decide', { id: hereKnown.item.id, action: 'accept' })
check('shell here-string known accept allows', (await hereKnown.parked).kind === 'allow')

// No content to show, single known file, and it is only a write: not parked.
await call(route, 'list', {})
const hereUnknown = gate(exec('pwsh', { command: [
  '$n = Get-Date',
  '$add = @"',
  'line $n',
  '"@',
  "[System.IO.File]::WriteAllText('D:/w/a.txt', $add)",
].join('\n') }), next)
check('shell here-string unknown value is not parked', (await hereUnknown).kind === 'allow')

// `$t = 'a' + 'b'` is an expression, not a literal, so `$t` stays unknown. It used
// to be recorded as the garbage text `a'+'b` and shown to the reviewer as if that
// were the content about to be written; now the write simply goes through unseen.
await call(route, 'list', {})
const builtAtRuntime = gate(exec('pwsh', { command: "$t = 'a' + 'b'\nSet-Content -Path D:/w/a.txt -Value $t" }), next)
check('shell computed value is not parked', (await builtAtRuntime).kind === 'allow')
const listedBuilt = await call(route, 'list', {})
check('shell computed value leaves nothing pending', listedBuilt.value.changes.length === 0)

// Interpolation of a variable the same command assigned is still exact text, so
// `"hello $n"` is reviewable. Only an unknown reference falls back.
const interpolated = await parkShell("$n = 'x'\nSet-Content -Path D:/w/a.txt -Value \"hello $n\"")
check('shell interpolated value is reviewable', interpolated.item !== undefined && interpolated.item.reviewable === true)
check('shell interpolated value resolves the text', interpolated.detail.after === 'hello x')
await call(route, 'decide', { id: interpolated.item.id, action: 'accept' })
check('shell interpolated value accept allows', (await interpolated.parked).kind === 'allow')

// The exact shape that was reported as "no diff at all": a script builds its
// payload and its output path in variables, then writes through Out-File. Both
// variables are literals, so the whole thing is knowable.
const scripted = await parkShell([
  "$dir = 'D:/w'",
  '$js = "line one`nline two`n"',
  'Out-File -FilePath "$dir/probe.js" -InputObject $js',
].join('\n'))
check('shell scripted write parks', scripted.item !== undefined)
check('shell scripted write resolves the path', scripted.item !== undefined && scripted.item.path === 'D:/w/probe.js')
check('shell scripted write is reviewable', scripted.item !== undefined && scripted.item.reviewable === true)
check('shell scripted write has the new text', scripted.detail.after === 'line one\nline two\n')
check('shell scripted write counts both lines', scripted.item.added === 2)
await call(route, 'decide', { id: scripted.item.id, action: 'accept' })
check('shell scripted write accept allows', (await scripted.parked).kind === 'allow')
// An environment reference the plugin cannot resolve makes the text unknowable, so
// this is the same shape as `-Value $x`: one known file, invisible content.
await call(route, 'list', {})
const unknownRef = gate(exec('pwsh', { command: 'Set-Content -Path D:/w/a.txt -Value "hello $env:USERNAME"' }), next)
check('shell unknown reference is not parked', (await unknownRef).kind === 'allow')
const listedUnknownRef = await call(route, 'list', {})
check('shell unknown reference leaves nothing pending', listedUnknownRef.value.changes.length === 0)

/* ---- shell shape recognition ---- */
// A cmdlet inventory can never be complete, so the net keys off shape instead:
// PowerShell's verb-noun convention, .NET member calls, programs that take code
// as a string, and tools that rewrite files in place. Each of these rewrote a
// file while matching nothing the old whitelist knew.
for (const command of [
  "Set-Item -Path 'D:/w/a.txt' -Value 'one'",
  "Rename-Item -Path 'D:/w/a.txt' -NewName 'b.txt'",
  "[System.IO.File]::Delete('D:/w/a.txt')",
  "[System.IO.Directory]::Delete('D:/w/dir')",
  "cmd /c del D:/w/a.txt",
  "iex $code",
  "Invoke-Expression 'Remove-Item D:/w/a.txt'",
  'node -e "require(`fs`).writeFileSync(`D:/w/a.txt`, `x`)"',
  'python -c "open(`D:/w/a.txt`, `w`).write(`x`)"',
  'powershell -EncodedCommand ZQBjAGgAbwA=',
  'git clean -fdx',
  'git checkout -- .',
  "Get-ChildItem 'D:/w' | Remove-Item -Force",
]) {
  const parked = await parkShell(command)
  check(`shell shape parks ${command}`, parked.item !== undefined)
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  check(`shell shape accept allows ${command}`, (await parked.parked).kind === 'allow')
}

// One known file, text only the shell produces, nothing else touched: the
// reviewer could not judge it even if the panel opened, so it goes through.
// These three shapes are the reason the write exemption has to be by shape
// rather than by cmdlet name — they matched nothing the old whitelist knew, and
// now they are recognised and deliberately let past.
for (const command of [
  "New-Item -Path 'D:/w/dir' -ItemType Directory",
  "'x' | Tee-Object -FilePath 'D:/w/a.txt'",
  "Get-Process | Export-Csv -Path 'D:/w/a.csv'",
]) {
  await call(route, 'list', {})
  const unseen = gate(exec('pwsh', { command }), next)
  check(`shell invisible write is not parked ${command}`, (await unseen).kind === 'allow')
  const listedUnseen = await call(route, 'list', {})
  check(`shell invisible write leaves nothing pending ${command}`, listedUnseen.value.changes.length === 0)
}

// Whether the panel can show a diff depends on the payload, not on the shape: the
// same recognition has to fall back to the command block when the payload is a
// string handed to another program, and produce rows when it is a literal.
for (const command of [
  "cmd /c del D:/w/a.txt",
  'iex $code',
  'powershell -EncodedCommand ZQBjAGgAbwA=',
  'git clean -fdx',
  "Get-ChildItem 'D:/w' | Remove-Item -Force",
  "[System.IO.File]::Delete($path)",
]) {
  const parked = await parkShell(command)
  check(
    `shell shape confirms the command ${command}`,
    parked.item !== undefined && parked.item.reason === 'shell-command' && parked.detail.rows.length === 0,
  )
  // A shape match has no file of its own. Its `path` used to be the verb, which the
  // panel rendered as a file name — the review of `iex $code` claimed to be creating
  // a file called `iex`. The entry must carry no path and say it is a command.
  check(
    `shell shape has no file name ${command}`,
    parked.item !== undefined && parked.item.op === 'shell' && parked.item.displayPath === '',
  )
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  await parked.parked
}

// A shell host wrapping disposable work (`cmd /c node <scratch>/probe.mjs 2>&1`)
// is the shape of nearly every throwaway probe, and the payload cannot touch
// anything the reviewer would want to keep: every path in it lands in the
// scratch or temp roots, which are skipped anyway. Wrapping it in `cmd /c` used
// to hide that, because the wrapper reads as "runs code" and the payload became
// an unnameable command record. Now the payload is inspected and, when it is
// inert, the pass says `shell-scratch` rather than `shell-not-destructive`.
for (const command of [
  'cmd /c "node D:/w/.dsh/tmp/probe.mjs"',
  'cmd /c "node D:/w/.dsh/tmp/probe.mjs 2>&1"',
  'cmd /c "del D:/w/.dsh/tmp/y.txt"',
  'bash -c "node D:/w/.dsh/tmp/probe.mjs"',
  'powershell -Command "del D:/w/.dsh/tmp/y.txt"',
]) {
  const inert = await gate(exec('pwsh', { command }), next)
  check(`a shell host around disposable work is not parked ${command}`, (await inert).kind === 'allow')
  const listedInert = await call(route, 'list', {})
  check(`the pass says why ${command}`, listedInert.value.diag.reason === 'shell-scratch')
}

// Unwrapping must not turn into a bypass. A payload that names a removal or a
// write keeps its ops, so the wrapper parks exactly like the bare command does —
// and a mixed command is only as disposable as its least disposable statement.
for (const command of [
  'cmd /c "del D:/w/a.txt"',
  'cmd /c "node D:/w/.dsh/../real.mjs" ; del D:/w/a.txt',
  'cmd /c "echo hi > D:/w/a.txt"',
  'cmd /c "copy D:/w/a.txt D:/w/b.txt"',
  'bash -c "rm D:/w/a.txt"',
]) {
  const notInert = await parkShell(command)
  check(`a shell host around real work still parks ${command}`, notInert.item !== undefined)
  if (notInert.item !== undefined) {
    await call(route, 'decide', { id: notInert.item.id, action: 'accept' })
    await notInert.parked
  }
}

// The other half of the same rule, and the reason it exists: a wrapper must never
// be *stricter* than the command it wraps. `node D:/w/real.mjs` on its own is let
// through — the interpreter's arguments do not name anything this parser can read
// as a write — so `cmd /c "node D:/w/real.mjs"` has to be let through too. Before
// this, every probe written as `cmd /c "… node.exe test\gate.test.mjs 2>&1"`
// stopped for approval while the identical bare command ran untouched, which is
// what made the wrapper look like noise.
for (const command of [
  'cmd /c "node D:/w/real.mjs"',
  'cmd /c "evil.exe"',
  'cmd /c "echo hi"',
  'cmd /c "node D:/w/real.mjs 2>&1"',
]) {
  await call(route, 'list', {})
  const cleared = await gate(exec('pwsh', { command }), next)
  check(`a wrapper is no stricter than the bare command ${command}`, (await cleared).kind === 'allow')
  const listedCleared = await call(route, 'list', {})
  check(`no panel was raised for ${command}`, listedCleared.value.changes.length === 0)
}

// A redirect tail after the quoted payload used to hide it. `cmd /c "del x" 2>&1`
// splits into `"del x"` and `2>&1`, so the payload no longer ends in a quote, the
// quoted form went unrecognised, and `stripQuotes` did nothing — the whole line
// stayed one quoted token that reads as a program path. The removal then ran with
// no panel at all. The tail is now peeled off the quotes instead of disqualifying
// them, so a real removal still parks however its output is redirected.
for (const command of [
  'cmd /c "del D:/w/a.txt" 2>&1',
  'cmd /c "del D:/w/a.txt" 2>nul',
  'cmd /c "del D:/w/a.txt" >nul',
  'cmd /c "copy D:/w/a.txt D:/w/b.txt" 2>&1',
  'cmd /c "rd D:/w/dir" 2>&1',
]) {
  const redirected = await parkShell(command)
  check(`a redirect tail does not hide the payload ${command}`, redirected.item !== undefined)
  if (redirected.item !== undefined) {
    await call(route, 'decide', { id: redirected.item.id, action: 'accept' })
    await redirected.parked
  }
}

// The same peel must not cost the disposable cases: a redirected probe under the
// scratch root is still disposable work.
for (const command of [
  'cmd /c "del D:/w/.dsh/tmp/y.txt" 2>&1',
  'cmd /c "node D:/w/.dsh/tmp/probe.mjs" 2>&1',
]) {
  await call(route, 'list', {})
  const redirectedInert = await gate(exec('pwsh', { command }), next)
  check(`a redirected disposable command still passes ${command}`, (await redirectedInert).kind === 'allow')
  const listedRedirected = await call(route, 'list', {})
  check(`no panel was raised for ${command}`, listedRedirected.value.changes.length === 0)
}

// A .NET call whose arguments are literals is still knowable, so it gets a diff
// rather than the command block. The first argument is a positional path.
const dotnetLiteral = await parkShell("[System.IO.File]::WriteAllText('D:/w/a.txt', 'body')")
check('shell dotnet literal parks', dotnetLiteral.item !== undefined)
check('shell dotnet literal is reviewable', dotnetLiteral.item !== undefined && dotnetLiteral.item.reviewable === true)
check('shell dotnet literal shows the new text', dotnetLiteral.detail.after === 'body')
await call(route, 'decide', { id: dotnetLiteral.item.id, action: 'accept' })
check('shell dotnet literal accept allows', (await dotnetLiteral.parked).kind === 'allow')

// A `.NET` delete of a file that exists knows exactly what disappears.
const dotnetDelete = await parkShell("[System.IO.File]::Delete('D:/w/a.txt')")
check('shell dotnet delete is a delete', dotnetDelete.item !== undefined && dotnetDelete.item.op === 'delete')
check('shell dotnet delete shows the old text', dotnetDelete.detail.before.includes('alpha'))
await call(route, 'decide', { id: dotnetDelete.item.id, action: 'accept' })
check('shell dotnet delete accept allows', (await dotnetDelete.parked).kind === 'allow')

// The member name alone is not the signal: it has to come from a type that can
// reach the disk. `[SHA256]::Create()` shares its name with `[File]::Create(path)`
// and builds a hash object in memory, and stopping the reviewer over it — with no
// diff to show, only the command text — was a report of its own.
for (const command of [
  '[System.Security.Cryptography.SHA256]::Create()',
  '$sha=[System.Security.Cryptography.SHA256]::Create(); $sha.ComputeHash($b)',
  "$b=[System.IO.File]::ReadAllBytes('D:/w/a.txt'); [System.Text.Encoding]::UTF8.GetString($b)",
  '[System.IO.Path]::GetFileName($p)',
]) {
  await call(route, 'list', {})
  const memoryOnly = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([memoryOnly.then((out) => out.kind), wait(120).then(() => 'parked')])
  check(`an in-memory .NET call is not parked ${command}`, verdict === 'allow')
  if (verdict !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await memoryOnly
  }
}
// ...and the disk types are still caught: when the path is an expression rather
// than a literal, the owning type is the only thing left to judge by, and a call
// that reaches the disk must not be cleared for lacking a readable path.
{
  const variablePath = await parkShell("[System.IO.File]::WriteAllText($p, 'body')")
  check('a disk member with an expression path still parks', variablePath.item !== undefined)
  if (variablePath.item !== undefined) {
    await call(route, 'decide', { id: variablePath.item.id, action: 'accept' })
    await variablePath.parked
  }
}

// The command that was reported: hash a file and print the digest. Every call in it
// either reads bytes or works on an object in memory, so there is nothing to review
// and the panel never had anything to show for it.
{
  const command = "$f='D:/w/a.txt'; $b=[System.IO.File]::ReadAllBytes($f); "
    + "$sha=[System.Security.Cryptography.SHA256]::Create(); "
    + "$h=($sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join ''; $h"
  await call(route, 'list', {})
  const hashing = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([hashing.then((out) => out.kind), wait(120).then(() => 'parked')])
  check('the reported hashing command is not parked', verdict === 'allow')
  if (verdict !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await hashing
  }
  check('the hashing command leaves nothing pending', (await call(route, 'list', {})).value.changes.length === 0)
}

/* ---- git subcommands ---- */
// `git` used to be one entry in a mutating set, so `git branch` and `git stash list`
// asked the reviewer to approve a command that writes nothing. Loosening that by
// "any second token that is not obviously a flag" would be the same guess in reverse:
// `git branch newbr` creates a branch and `git branch -D x` deletes one. Only the
// listed read-only options pass; everything else keeps asking.
for (const command of [
  'git branch',
  'git branch -a',
  'git branch --list',
  'git stash list',
  'git stash show',
]) {
  await call(route, 'list', {})
  const reading = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([reading.then((out) => out.kind), wait(120).then(() => 'parked')])
  check(`git read-only subcommand is not parked ${command}`, verdict === 'allow')
  if (verdict !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await reading
  }
  check(`git read-only subcommand leaves nothing pending ${command}`, (await call(route, 'list', {})).value.changes.length === 0)
}

// `checkout` and `switch` have no read-only form: switching branches rewrites the
// whole working tree, and `git checkout a.txt` overwrites that file from the index.
// Whether it destroys anything depends on uncommitted state at run time, which no
// argument scan can see. These assertions exist so nobody "simplifies" them back
// into the read-only list on the strength of a missing `-b`.
for (const command of [
  'git branch -D topic',
  'git branch newbr',
  'git branch --set-upstream-to=origin/main',
  'git stash',
  'git stash pop',
  'git stash drop',
  'git checkout main',
  'git checkout a.txt',
  'git checkout -- .',
  'git switch main',
  'git switch -c feat',
]) {
  const parked = await parkShell(command)
  check(`git mutating subcommand still parks ${command}`, parked.item !== undefined)
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  check(`git mutating subcommand accept allows ${command}`, (await parked.parked).kind === 'allow')
}

// Known holes, recorded as they are rather than as they should be. `git remote` is
// not a file write anyone can see from the command, and `--output=` writes a file
// without a redirect for the statement scanner to notice. Both would need a rewrite
// of `git` handling; until then this test pins the current behaviour so a future
// change that silently starts gating them is caught, and so nobody reads the
// read-only list above and believes it covers them.
for (const command of ['git remote add origin https://example.com/r.git', 'git log --output=f.txt']) {
  await call(route, 'list', {})
  const hole = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([hole.then((out) => out.kind), wait(120).then(() => 'parked')])
  check(`known hole is still ungated ${command}`, verdict === 'allow')
  if (verdict !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await hole
  }
}

/* ---- directories ---- */
// Making a directory is not a file write: it cannot replace a byte that already
// exists. Counting it as one put a phantom entry in the file strip — "this file was
// left unchanged" for a path that is not a file — and asked for approval of
// something the panel could say nothing about.
for (const command of ['mkdir out', 'mkdir -p a/b', 'New-Item -ItemType Directory lib']) {
  await call(route, 'list', {})
  const making = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([making.then((out) => out.kind), wait(120).then(() => 'parked')])
  check(`making a directory is not parked ${command}`, verdict === 'allow')
  if (verdict !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await making
  }
}
// The exemption is by shape, not by cmdlet: `New-Item` that writes a file value is
// still a write.
{
  const parked = await parkShell("New-Item -Path 'D:/w/a.txt' -Value 'body'")
  check('New-Item writing file content still parks', parked.item !== undefined)
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  check('New-Item writing file content accept allows', (await parked.parked).kind === 'allow')
}

/* ---- command steps ---- */
// The command block is broken into the steps the command performs. `splitStatements`
// breaks at `|`, `&`, `{` and `}`, which is right for the gate but wrong for reading:
// one pipeline expression came out as four "steps", each a fragment of an expression
// that meant nothing on its own. Fragments that do not balance are now folded into
// the statement that completes them.
{
  const command = "$h=(Get-ChildItem 'D:/w' | ForEach-Object { $_.Name }) -join ''; "
    + '$h; Remove-Item -LiteralPath $p -Force'
  const parked = await parkShell(command)
  check('the pipeline script parks', parked.item !== undefined)
  const steps = parked.item !== undefined ? parked.item.steps : undefined
  check('the command block carries steps', Array.isArray(steps) && steps.length > 0)
  const texts = Array.isArray(steps) ? steps.map((step) => String(step.text ?? '')) : []
  // Nothing may end in the middle of a parenthesis: every step has to balance, or
  // it is a fragment rather than a step.
  const balanced = (text) => {
    let depth = 0
    for (const ch of text) {
      if (ch === '(' || ch === '[') depth += 1
      else if (ch === ')' || ch === ']') depth -= 1
    }
    return depth === 0
  }
  check('every step is a whole statement', texts.every(balanced))
  check(
    'the pipeline is one step',
    texts.some((text) => text.includes('ForEach-Object') && text.includes('Get-ChildItem') && text.includes('-join')),
  )
  // Folding fragments must not delete the separators that split them: putting them
  // back together with a bare space turned a pipeline into `(… ForEach-Object …)`,
  // which is not the command that ran.
  check(
    'the folded step still shows its pipes',
    texts.some((text) => text.includes('|') && text.includes('ForEach-Object')),
  )
  check('no step is a bare closing bracket', texts.every((text) => text.replace(/[{}()\[\]]/g, '').trim() !== ''))
  if (parked.item !== undefined) {
    await call(route, 'decide', { id: parked.item.id, action: 'accept' })
    await parked.parked
  }
}

// `Set-Item` is a known write cmdlet with a literal path and value, so the same
// diff machinery applies rather than a bare command block.
const setItem = await parkShell("Set-Item -Path 'D:/w/a.txt' -Value 'one'")
check('shell set-item is reviewable', setItem.item !== undefined && setItem.item.reviewable === true)
check('shell set-item shows the new text', setItem.detail.after === 'one')
await call(route, 'decide', { id: setItem.item.id, action: 'accept' })
check('shell set-item accept allows', (await setItem.parked).kind === 'allow')

// An interpreter running source text is judged by that text. A script that loads a
// file and prints a number touches nothing, and the panel could only have shown the
// whole command with "the result is not knowable up front" — which is the complaint
// that started this: thirty lines of code and no way to tell it was a read.
for (const command of [
  `node -e "const fs=require('fs');const t=fs.readFileSync('D:/w/a.txt','utf8');console.log(t.length)"`,
  `node -p "process.version"`,
  `python -c "print(open('D:/w/a.txt').read().strip())"`,
  `python -c "import sys;sys.stdout.write('hi')"`,
  `node -e "console.log('write this to stdout')"`,
  `node -e "const fs=require('fs');for(const n of fs.readdirSync('D:/w'))console.log(n)"`,
  `python -c "import csv;print(list(csv.reader(open('D:/w/a.csv'))))"`,
]) {
  await call(route, 'list', {})
  const pending = gate(exec('pwsh', { command }), next)
  const verdict = await Promise.race([pending.then((out) => out.kind), wait(120).then(() => 'parked')])
  check(`inline script that only reads is not parked ${command}`, verdict === 'allow')
  if (verdict !== 'allow') {
    const listed = await call(route, 'list', {})
    for (const open of listed.value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await pending
  }
  check(`inline script that only reads leaves nothing pending ${command}`, (await call(route, 'list', {})).value.changes.length === 0)
}

// The shortcut is withdrawn the moment the text names something that can write, so
// the ordinary ways a script produces a file still stop for review.
for (const command of [
  `node -e "require('fs').writeFileSync('D:/w/a.txt','x')"`,
  `node -e "const fs=require('fs');fs.appendFileSync('D:/w/b.txt','x')"`,
  `node -e "require('fs').promises.unlink('D:/w/a.txt')"`,
  `python -c "open('D:/w/a.txt','w').write('x')"`,
  `python -c "import shutil;shutil.copy('D:/w/a.txt','D:/w/b.txt')"`,
  `python -c "import os;os.replace('D:/w/a.txt','D:/w/b.txt')"`,
  `node -e "require('child_process').execSync('del D:/w/a.txt')"`,
  `node -e "eval(payload)"`,
]) {
  const parked = await parkShell(command)
  check(`inline script that writes parks ${command}`, parked.item !== undefined)
  check(`inline script that writes says it is unknowable ${command}`, parked.item !== undefined && parked.item.reason === 'shell-command')
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  await parked.parked
}

// One writing script anywhere in the command withdraws the shortcut for the whole
// command: clearing only the statements that happened to be read-only would let the
// second half through unexamined.
{
  const mixed = 'node -e "console.log(1)"; node -e "require(`fs`).mkdirSync(`D:/w/newdir`)"'
  const parked = await parkShell(mixed)
  check('a read-only script next to a writing one still parks', parked.item !== undefined)
  await call(route, 'decide', { id: parked.item.id, action: 'accept' })
  await parked.parked
}

// The exact command that started this: read a YAML file, print two lengths. It was
// shown as thirty lines of one-liner with "the result is not knowable up front".
{
  const command = "$env:DSH_PERMISSION_MODE='danger-full-access'; $d='D:/w/data'; cd $d; "
    + `node -e "const yaml=require('js-yaml');const fs=require('fs');const t=fs.readFileSync('a.yml','utf8');const o=yaml.load(t);console.log('EN len',o.description.en.length);" 2>&1`
  await call(route, 'list', {})
  const verdict = gate(exec('pwsh', { command }), next)
  const kind = await Promise.race([verdict.then((out) => out.kind), wait(120).then(() => 'parked')])
  check('the report script that started this is not parked', kind === 'allow')
  if (kind !== 'allow') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await verdict
  }
  check('the report script that started this leaves nothing pending', (await call(route, 'list', {})).value.changes.length === 0)
}

// Grouping parentheses sit flush against a cmdlet when the group has no inner
// spaces: `(Get-Process | Out-String)` splits on `|` into `(Get-Process` and
// `Out-String)`. That trailing `)` made the harmless lookup miss, so `Out-String`
// fell into the mutating-prefix branch and the reviewer was asked to approve
// formatting a table. Every one of these is a read.
for (const grouped of [
  '(Get-Process | Out-String)',
  'Get-Process | Out-String)',
  '(Get-Process | Format-Table -AutoSize | Out-String)',
  '(Get-Content D:/w/a.txt -Raw | ConvertFrom-Json).version',
  'Write-Host hi)',
]) {
  check(`a grouped pipeline is a read ${grouped}`, (await gate(exec('pwsh', { command: grouped }), next)).kind === 'allow')
}

// A group around the whole command leaves a parenthesis flush against the host
// name and another one after the payload: `(cmd /c "del x")`. Both have to be
// read through, or a disposable payload keeps its "cannot be known" review.
for (const [label, command, expected] of [
  ['a group around a disposable command is still disposable', '(cmd /c "del D:/.dsh/tmp/x.txt")', 'allow'],
  ['a group around a real removal still parks', '(cmd /c "del D:/w/a.txt")', 'parked'],
]) {
  const verdict = gate(exec('pwsh', { command }), next)
  const kind = await Promise.race([verdict.then((out) => out.kind), wait(150).then(() => 'parked')])
  check(label, kind === expected)
  if (kind === 'parked') {
    for (const open of (await call(route, 'list', {})).value.changes) await call(route, 'decide', { id: open.id, action: 'reject' })
    await verdict
  }
}

for (const harmless of [
  'Get-ChildItem D:/w',
  "Select-String 'x' D:/w/a.txt",
  'git status',
  'git log --oneline -3',
  'git diff',
  'dotnet --version',
  'node --version',
  'New-Object System.Text.StringBuilder',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Set-Variable x 1',
  'Clear-Host',
  'Write-Output hi',
]) {
  check(`shell shape bypass ${harmless}`, (await gate(exec('pwsh', { command: harmless }), next)).kind === 'allow')
}

// Emptying a file leaves the file in place and the result is the known empty
// string, so it is an edit with a diff — not a delete. It used to sit in the
// delete list, which painted the whole file as gone and kept it asking even
// inside an exempt request.
const cleared = await parkShell("Clear-Content -Path 'D:/w/a.txt'")
check('shell clear-content parks', cleared.item !== undefined)
check('shell clear-content is an update', cleared.item !== undefined && cleared.item.op === 'update')
check('shell clear-content is reviewable', cleared.item !== undefined && cleared.item.reviewable === true)
check('shell clear-content shows the file emptied', cleared.detail.after === '')
check('shell clear-content removes every line', cleared.detail.before !== '' && cleared.item.removed > 0 && cleared.item.added === 0)
await call(route, 'decide', { id: cleared.item.id, action: 'accept' })
check('shell clear-content accept allows', (await cleared.parked).kind === 'allow')

/* ---- self + temp exemptions ---- */
await call(route, 'list', {})
// Derived from this file's own location so the test survives a clone anywhere.
const selfFile = fileURLToPath(new URL('../lib/x.js', import.meta.url))
check('self skipped', (await gate(exec('write', { file_path: selfFile, content: 'x\n' }), next)).kind === 'allow')
const tempProbe = `${(process.env.TEMP || 'C:/Temp').replace(/\\\\/g, '/')}/probe.txt`
check('temp skipped', (await gate(exec('write', { file_path: tempProbe, content: 'x\n' }), next)).kind === 'allow')
// `skipScratch` covers the workspace scratch directory, which lives under no
// environment variable: the harness puts every throwaway file in `<ws>/.dsh/`,
// and the agent drops one-off scripts straight into `.dsh/` as well as `.dsh/tmp/`.
for (const scratch of [
  'D:/w/.dsh/tmp/probe.cjs',
  'D:/w/.dsh/tmp/deep/nest/probe.mjs',
  'D:/other/.dsh/tmp/x.html',
  'D:/w/.dsh/tmp_find2.js',
  'D:/w/.dsh/settings.json',
]) {
  check(`scratch skipped ${scratch}`, (await gate(exec('write', { file_path: scratch, content: 'x\n' }), next)).kind === 'allow')
}
// The exemption must stay narrow: a directory that merely starts with the same
// letters is a real project directory and still parks.
for (const keeper of ['D:/w/.dsh-tmp/probe.cjs', 'D:/w/.dshtmp/probe.cjs', 'D:/w/src/tmp/app.js']) {
  const parked = gate(exec('write', { file_path: keeper, content: 'x\n' }), next)
  await wait(20)
  const listed = await call(route, 'list', {})
  check(`scratch guard keeps ${keeper}`, listed.value.changes.some((item) => item.path === keeper))
  await call(route, 'decide', { id: listed.value.changes[0].id, action: 'reject' })
  await parked
}

/* ---- generated directories ---- */
// A build cache is not source: the largest single pile of noise in a real log was
// `__pycache__` deletions — Python regenerates them on the next import, and the
// reviewer had never written them. Directories a tool owns outright are skipped;
// names that can hold hand-written files (`bin`, `lib`, `public`, `src`) are not.
for (const noise of [
  'D:/p/__pycache__/mod.cpython-311.pyc',
  'D:/p/node_modules/react/index.js',
  'D:/p/dist/app.js',
  'D:/p/build/out.bin',
  'D:/p/target/classes/A.class',
  'D:/p/src/coverage/lcov.info',
  'D:/p/.venv/lib/site.py',
  'D:/p/vendor/github.com/x/y.go',
  'D:/p/.pytest_cache/v/cache/lastfailed',
  'D:/p/obj/project.assets.json',
]) {
  check(`noise skipped ${noise}`, (await gate(exec('write', { file_path: noise, content: 'x\n' }), next)).kind === 'allow')
}
// Version control is the exception: a hook is a program that runs on the next
// commit, and a rewrite there is exactly what a reviewer has to see.
for (const guarded of ['D:/p/.git/hooks/pre-commit', 'D:/p/.git/config']) {
  await call(route, 'list', {})
  const parked = gate(exec('write', { file_path: guarded, content: 'x\n' }), next)
  await wait(20)
  const listed = await call(route, 'list', {})
  check(`version control still parks ${guarded}`, listed.value.changes.some((item) => item.path === guarded))
  await call(route, 'decide', { id: listed.value.changes[0].id, action: 'reject' })
  await parked
}
// A removal of a generated directory is the case that actually hurt: it parked
// every time, carried no diff, and was approved without being read.
await call(route, 'list', {})
const noiseRm = await gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/p/__pycache__' -Recurse -Force" }), next)
check('noise delete is not parked', (await noiseRm).kind === 'allow')
check('noise delete leaves nothing pending', (await call(route, 'list', {})).value.changes.length === 0)
// Backslashes are what the host actually reports on Windows.
check('noise matches a backslash path', (await gate(exec('write', { file_path: 'D:\\p\\dist\\a.js', content: 'x\n' }), next)).kind === 'allow')
// The exemption is segment-wise, so a project merely named like one still parks.
for (const keeper of ['D:/p/distro/app.js', 'D:/p/src/build.js', 'D:/p/my-dist/x.js', 'D:/p/builder/a.txt', 'D:/p/src/bin/main.js', 'D:/p/lib/util.js']) {
  await call(route, 'list', {})
  const parked = gate(exec('write', { file_path: keeper, content: 'x\n' }), next)
  await wait(20)
  const listed = await call(route, 'list', {})
  check(`noise guard keeps ${keeper}`, listed.value.changes.some((item) => item.path === keeper))
  await call(route, 'decide', { id: listed.value.changes[0].id, action: 'reject' })
  await parked
}
// The switch exists so the policy can be dropped without editing source.
const noisy = makeCtx()
apply(noisy.ctx, { trace: false, skipNoise: false })
await call(noisy.routes[0], 'list', {})
const noisyGate = noisy.handlers.get('tools/pre-execute')
const noisyParked = noisyGate(exec('write', { file_path: 'D:/p/dist/app.js', content: 'x\n' }), next)
await wait(20)
const noisyListed = await call(noisy.routes[0], 'list', {})
check('skipNoise false reviews a build file', noisyListed.value.changes.length === 1)
await call(noisy.routes[0], 'decide', { id: noisyListed.value.changes[0].id, action: 'reject' })
check('skipNoise false reject denies', (await noisyParked).kind === 'deny')

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

/* ---- allow all writes until switched off ---- */
// The switch is manual and belongs to one conversation. Keying an exemption to the
// turn number seemed tidier, but every new user message silently re-armed the gate,
// so "I already allowed this" and "why is it asking again" were both true at once.
// A switch the reader can see and turn off is the only version that keeps its
// promise, so the turn number is now a diagnostic and nothing more.
//
// It is per session because one shared flag made two conversations disagree about
// their own state: flipping it in the conversation on screen silenced — or
// re-armed — every other conversation, and a tab with nothing pending had no state
// of its own left to show.
const onSessionEvent = handlers.get('session/event')
check('session/event is subscribed', typeof onSessionEvent === 'function')

// A tool call made on behalf of a named Session: the switch is per session, so the
// tests have to be able to say which conversation a write came from.
const execIn = (id, name, args) => ({
  ...exec(name, args),
  agent: { id: id, session: { header: { id: id, cwd: 'D:/w' } } },
})

const turnEvent = (type, turn) => onSessionEvent({ id: 's1', header: { id: 's1', cwd: 'D:/w' } }, { type, data: { turn } })

await call(route, 'list', {})
turnEvent('turn/start', 7)
const beforeAllow = await call(route, 'list', { sessionId: 's1' })
check('turn id reaches the panel', beforeAllow.value.turn === 7)
check('writes are reviewed before the switch', beforeAllow.value.allowAll.s1 !== true)

const firstWrite = gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\none\ngamma\ndelta\n' }), next)
await wait(30)
const listedFirst = await call(route, 'list', { sessionId: 's1' })
check('first write still parks', listedFirst.value.changes.length === 1)
await call(route, 'decide', { id: listedFirst.value.changes[0].id, action: 'allowTurn' })
check('allowTurn accepts the pending change', (await firstWrite).kind === 'allow')

const afterAllow = await call(route, 'list', { sessionId: 's1' })
check('the switch reports on', afterAllow.value.allowAll.s1 === true)
check('nothing left pending after allowTurn', afterAllow.value.changes.length === 0)

// The switch covers the conversation it was flipped in, and only that one.
const otherSessionBefore = await call(route, 'list', { sessionId: 's2' })
check('another conversation stays reviewed', otherSessionBefore.value.allowAll.s2 !== true)
const otherWrite = gate(execIn('s2', 'write', { file_path: 'D:/w/b.txt', content: 'alpha\nbeta\ngamma\nzeta\n' }), next)
await wait(30)
const listedOther = await call(route, 'list', { sessionId: 's2' })
check('another conversation still parks', listedOther.value.changes.length === 1)
await call(route, 'decide', { id: listedOther.value.changes[0].id, action: 'reject' })
check('another conversation can be rejected', (await otherWrite).kind === 'deny')
const afterOther = await call(route, 'list', { sessionId: 's1' })
check('rejecting there left this switch alone', afterOther.value.allowAll.s1 === true)

// Later writes go straight through, and that does not depend on the turn: a new
// user message must not quietly re-arm the gate behind the reader's back.
const secondWrite = await gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\ntwo\ngamma\ndelta\n' }), next)
check('later write is allowed', secondWrite.kind === 'allow')
const listedSecond = await call(route, 'list', { sessionId: 's1' })
check('later write did not park', listedSecond.value.changes.length === 0)
check('later write reports allow-all', listedSecond.value.diag.reason === 'allow-all')

// Deletes stay gated even with the switch on: it promises to stop interrupting
// for writes, and a removal cannot be undone, so silence there would overrun it.
const deleteInTurn = gate(
  exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/a.txt' -Force" }),
  next,
)
await wait(30)
const listedDelete = await call(route, 'list', { sessionId: 's1' })
check('delete still parks while writes are allowed', listedDelete.value.changes.length === 1)
await call(route, 'decide', { id: listedDelete.value.changes[0].id, action: 'reject' })
check('delete while writes are allowed can be rejected', (await deleteInTurn).kind === 'deny')
// The turn is not only for writes: a command's snapshot is what fills the
// per-turn groups in the history screen, and an entry without the number lands
// under "unannotated" where it cannot be cleared a turn at a time.
const deleteHistory = await call(route, 'history', { sessionId: 's1' })
const deleteEntry = deleteHistory.value.entries.find(
  (entry) => entry.path === 'D:/w/a.txt' && entry.op === 'delete',
)
check('a command-recorded entry carries the turn too', deleteEntry !== undefined && deleteEntry.turn === 7)

// Emptying a file is an edit, not a removal: the file is still there afterwards,
// and the panel can show every line as removed. Treating it as a delete kept it
// gated with the switch on, which is exactly the interruption it promised to
// stop. `Rename-Item` moves the file instead, so it stays gated.
await call(route, 'list', {})
const truncateInTurn = await gate(exec('pwsh', { command: "Clear-Content -Path 'D:/w/a.txt'" }), next)
check('emptying a file is allowed while writes are allowed', truncateInTurn.kind === 'allow')
const listedTruncate = await call(route, 'list', { sessionId: 's1' })
check('emptying a file did not park', listedTruncate.value.changes.length === 0)

const renameInTurn = gate(exec('pwsh', { command: "Rename-Item -Path 'D:/w/a.txt' -NewName 'b.txt'" }), next)
await wait(30)
const listedRename = await call(route, 'list', { sessionId: 's1' })
check('renaming still parks while writes are allowed', listedRename.value.changes.length === 1)
await call(route, 'decide', { id: listedRename.value.changes[0].id, action: 'accept' })
check('rename while writes are allowed can be accepted', (await renameInTurn).kind === 'allow')

// The shape that made the switch feel broken: write a scratch file, use it, then
// delete it. The removal cannot lose anything because the file did not exist when
// the command started, so the record is a plain `create` and the switch covers it.
// Keying off the raw text instead of the record stopped every such command, and the
// prompt it produced still carried the diff, so it read as a write being reviewed
// again right after "allow all writes".
await call(route, 'list', {})
const writeThenRemove = gate(
  exec('pwsh', {
    command:
      "$p='D:/w/fresh.txt'; [System.IO.File]::WriteAllText($p, \"temp`n\"); Remove-Item -LiteralPath $p -Force",
  }),
  next,
)
check('a write that cleans up after itself is allowed', (await writeThenRemove).kind === 'allow')
const listedWriteThenRemove = await call(route, 'list', { sessionId: 's1' })
check('the self-cleaning write did not park', listedWriteThenRemove.value.changes.length === 0)
check('the self-cleaning write reports allow-all', listedWriteThenRemove.value.diag.reason === 'allow-all')

// Removing something that was already there stays gated even in the same command
// as a write: that is the one case where silence could lose a file.
const mixedInTurn = gate(
  exec('pwsh', {
    command: "Set-Content -Path 'D:/w/fresh.txt' -Value 'one'; Remove-Item -LiteralPath 'D:/w/a.txt' -Force",
  }),
  next,
)
await wait(30)
const listedMixed = await call(route, 'list', { sessionId: 's1' })
check('a mixed write and removal still parks', listedMixed.value.changes.length === 1)
await call(route, 'decide', { id: listedMixed.value.changes[0].id, action: 'accept' })
check('a mixed write and removal can be accepted', (await mixedInTurn).kind === 'allow')

// Neither a new request nor the end of one touches the switch. This is the whole
// point of replacing a per-turn exemption with it.
turnEvent('turn/end', 7)
const afterEnd = await call(route, 'list', { sessionId: 's1' })
check('turn/end leaves the switch alone', afterEnd.value.allowAll.s1 === true)
turnEvent('turn/start', 8)
const nextTurn = await call(route, 'list', { sessionId: 's1' })
check('a new request leaves the switch alone', nextTurn.value.allowAll.s1 === true && nextTurn.value.turn === 8)
const parkedNextTurn = await gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\nthree\ngamma\ndelta\n' }), next)
check('a write after the next request still passes', parkedNextTurn.kind === 'allow')

// The switch stops the interruption, not the memory. A write it waved through is
// still recorded with the bytes it replaced, so a reader who later realises what
// went past can take it back — and the entry says plainly that no one read it.
const allowedParked = await gate(exec('write', { file_path: 'D:/w/allowed.txt', content: 'alpha\nbeta\ngamma\nALLOWED\n' }), next)
check('a write under the switch does not park', allowedParked.kind === 'allow')
const allowedHistory = await call(route, 'history', { sessionId: 's1' })
const allowedEntry = allowedHistory.value.entries.find((entry) => entry.path === 'D:/w/allowed.txt')
check('a write the switch waved through is kept in the history', allowedEntry !== undefined)
check('the entry says no one read it', allowedEntry !== undefined && allowedEntry.state === 'allowed')
check('the entry still offers an undo', allowedEntry !== undefined && allowedEntry.restorable === true && allowedEntry.verify !== null)
// The fake host does not perform writes, so the tool's effect is applied here.
files.set('D:/w/allowed.txt', 'alpha\nbeta\ngamma\nALLOWED\n')
const allowedUndo = await call(route, 'restore', { id: allowedEntry.id, sessionId: 's1' })
check('an entry the switch waved through can be taken back', allowedUndo.value.ok === true)
check('the previous text comes back', currentText('D:/w/allowed.txt') === DEFAULT_TEXT)

// Turning it off needs no pending change: it has to work from the empty panel,
// which is exactly where a reader lands right after allowing everything.
const switchedOff = await call(route, 'decide', { action: 'setAllowAll', value: false, sessionId: 's1' })
check('setAllowAll turns the switch off without a pending change', switchedOff.value.ok === true && switchedOff.value.allowAll.s1 !== true)
const offList = await call(route, 'list', { sessionId: 's1' })
check('the panel sees the switch off', offList.value.allowAll.s1 !== true)
await call(route, 'list', {})
const reviewedAgain = gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\nfour\ngamma\ndelta\n' }), next)
await wait(30)
const listedAgain = await call(route, 'list', { sessionId: 's1' })
check('a write after switching off parks again', listedAgain.value.changes.length === 1)
await call(route, 'decide', { id: listedAgain.value.changes[0].id, action: 'accept' })
check('that write accepts normally', (await reviewedAgain).kind === 'allow')

// Switching one conversation off must not re-arm, or silence, another. This is the
// bug that started it: the panel's switch used to be one process-wide boolean, so
// the conversation nobody touched lost its state along with the one being toggled.
const scopedOn = await call(route, 'decide', { action: 'setAllowAll', value: true, sessionId: 's1' })
check('one conversation can be switched on alone', scopedOn.value.allowAll.s1 === true && scopedOn.value.allowAll.s2 !== true)
const scopedOff = await call(route, 'decide', { action: 'setAllowAll', value: false, sessionId: 's1' })
check('switching it off leaves the other untouched', scopedOff.value.allowAll.s1 !== true && scopedOff.value.allowAll.s2 !== true)
const noOwner = await call(route, 'decide', { action: 'setAllowAll', value: true })
check('a switch with no conversation is refused', noOwner.value.missing === true)

/* ---- one review per session ---- */
// Two Sessions share one process, so the pending map is shared while the panels
// are not. Session B must not be able to see or answer Session A's change just
// because it learned the id from the poll.
await call(route, 'list', {})
const otherParked = gate(execIn('s2', 'write', { file_path: 'D:/w/a.txt', content: 'alpha\nbeta\ngamma\nzeta\n' }), next)
await wait(30)
const otherListed = await call(route, 'list', { sessionId: 's2' })
check('the other session parks its own change', otherListed.value.changes.length === 1)
check('the other session change belongs to s2', otherListed.value.changes[0].sessionId === 's2')
const otherId = otherListed.value.changes[0].id
const s1View = await call(route, 'list', { sessionId: 's1' })
check('the first session does not list it', s1View.value.changes.every((item) => item.id !== otherId))
const peek = await call(route, 'detail', { id: otherId, sessionId: 's1' })
check('the first session cannot read the diff', peek.value.missing === true)
const peekOwn = await call(route, 'detail', { id: otherId, sessionId: 's2' })
check('the owning session can read the diff', peekOwn.value.change !== undefined && peekOwn.value.change.id === otherId)
const crossDecide = await call(route, 'decide', { id: otherId, action: 'reject', sessionId: 's1' })
check('the first session cannot answer it', crossDecide.value.missing === true)
const stillPending = await call(route, 'list', { sessionId: 's2' })
check('the refused decision left it pending', stillPending.value.changes.length === 1)
const ownDecide = await call(route, 'decide', { id: otherId, action: 'accept', sessionId: 's2' })
check('the owning session answers it', ownDecide.value.ok === true)
check('the owning session decision applies', (await otherParked).kind === 'allow')

/* ---- undo ---- */
// The point of the snapshot store: a change the reviewer accepted can be taken
// back, but only while the file still looks the way that change left it.
const undoContent = 'alpha\nbeta\ngamma\nUNDO\n'
const undoParked = gate(exec('write', { file_path: 'D:/w/undo.txt', content: undoContent }), next)
await wait(30)
const undoListed = await call(route, 'list', {})
const undoId = undoListed.value.changes[undoListed.value.changes.length - 1].id
await call(route, 'decide', { id: undoId, action: 'accept', sessionId: 's1' })
check('the undoable write was accepted', (await undoParked).kind === 'allow')

const undoHistory = await call(route, 'history', { sessionId: 's1' })
const undoEntry = undoHistory.value.entries.find((entry) => entry.id === undoId)
check('an accepted write appears in the history', undoEntry !== undefined)
check('the history entry says what happened', undoEntry !== undefined && undoEntry.state === 'accepted')
check('the history entry offers an undo', undoEntry !== undefined && undoEntry.restorable === true)

// The fake host does not perform writes, so the tool's effect is applied here
// the way a real workspace would have it after the tool ran.
files.set('D:/w/undo.txt', undoContent)
const undoOnce = await call(route, 'restore', { id: undoId, sessionId: 's1' })
check('an accepted change can be taken back', undoOnce.value.ok === true)
check('the file is back to its previous text', currentText('D:/w/undo.txt') === DEFAULT_TEXT)
const undoAgain = await call(route, 'restore', { id: undoId, sessionId: 's1' })
check('undoing twice is refused', undoAgain.value.error === 'already-restored')

// A file that changed after the review must not be reverted: the undo would
// silently throw away whatever wrote it since.
const staleContent = 'alpha\nbeta\ngamma\nSTALE\n'
const staleParked = gate(exec('write', { file_path: 'D:/w/stale.txt', content: staleContent }), next)
await wait(30)
const staleListed = await call(route, 'list', {})
const staleId = staleListed.value.changes[staleListed.value.changes.length - 1].id
await call(route, 'decide', { id: staleId, action: 'accept', sessionId: 's1' })
await staleParked
files.set('D:/w/stale.txt', 'edited afterwards\n')
const staleUndo = await call(route, 'restore', { id: staleId, sessionId: 's1' })
check('a file edited since is not reverted', staleUndo.value.error === 'stale')
check('the newer text survives the refused undo', currentText('D:/w/stale.txt') === 'edited afterwards\n')

// A rejected change never reached the disk, so there is nothing to undo.
const rejectedParked = gate(exec('write', { file_path: 'D:/w/rejected.txt', content: 'alpha\nbeta\ngamma\nNO\n' }), next)
await wait(30)
const rejectedListed = await call(route, 'list', {})
const rejectedId = rejectedListed.value.changes[rejectedListed.value.changes.length - 1].id
await call(route, 'decide', { id: rejectedId, action: 'reject', sessionId: 's1' })
check('the rejected write was refused', (await rejectedParked).kind !== 'allow')
const rejectedUndo = await call(route, 'restore', { id: rejectedId, sessionId: 's1' })
check('undoing a rejected change is refused', rejectedUndo.value.error === 'not-applied')

// A removal is undone by putting the bytes back.
const goneParked = gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/gone.txt' -Force" }), next)
await wait(30)
const goneListed = await call(route, 'list', {})
const goneId = goneListed.value.changes[goneListed.value.changes.length - 1].id
await call(route, 'decide', { id: goneId, action: 'accept', sessionId: 's1' })
check('the removal was accepted', (await goneParked).kind === 'allow')
files.set('D:/w/gone.txt', null)
const goneUndo = await call(route, 'restore', { id: goneId, sessionId: 's1' })
check('a removal can be undone', goneUndo.value.ok === true)
check('the removed bytes are back', currentText('D:/w/gone.txt') === DEFAULT_TEXT)

// The history is per conversation, like every other panel call.
const foreignHistory = await call(route, 'history', { sessionId: 's2' })
check('another conversation does not see these undo entries', foreignHistory.value.entries.every((entry) => entry.id !== undoId))
const foreignUndo = await call(route, 'restore', { id: staleId, sessionId: 's2' })
check('another conversation cannot undo them', foreignUndo.value.missing === true)
const unknownUndo = await call(route, 'restore', { id: 'no-such-change', sessionId: 's1' })
check('an unknown change cannot be undone', unknownUndo.value.missing === true)

/* ---- multi-file review ---- */
// One command touching two files is one decision with two diffs. It used to fall
// back to "the result is not knowable" for the whole call, which made a
// two-statement script unreadable even though both outcomes were literals.
await call(route, 'list', {})
const multiCommand = [
  "Set-Content -Path 'D:/w/m1.txt' -Value 'one'",
  "Set-Content -Path 'D:/w/m2.txt' -Value 'two'",
].join('\n')
const multiParked = gate(exec('pwsh', { command: multiCommand }), next)
await wait(30)
const multiListed = await call(route, 'list', {})
const multiItem = multiListed.value.changes[0]
check('a command touching two files parks once', multiListed.value.changes.length === 1)
check('a two-file command lists both files', multiItem !== undefined && multiItem.files !== undefined && multiItem.files.length === 2)
const multiDetail = multiItem === undefined ? { value: {} } : (await call(route, 'detail', { id: multiItem.id })).value
check('a two-file command carries one diff per file', Array.isArray(multiDetail.files) && multiDetail.files.length === 2)
check('each file has its own rows', Array.isArray(multiDetail.files) && multiDetail.files.every((file) => file.computed === true && file.rows.length > 0))
check('each file carries its own new text', Array.isArray(multiDetail.files) && multiDetail.files[1].after === 'two')
check('each file names its own path', Array.isArray(multiDetail.files) && multiDetail.files[0].path === 'D:/w/m1.txt' && multiDetail.files[1].path === 'D:/w/m2.txt')
await call(route, 'decide', { id: multiItem.id, action: 'accept' })
check('a two-file command accept allows', (await multiParked).kind === 'allow')

/* ---- folders among the targets ---- */
// A folder has no text to read, so it used to arrive as a file entry that failed to
// diff and then sat in the strip saying "this file was left unchanged" — the exact
// opposite of what happened to it. A write *into* a folder is different: the new
// file has no name yet, so that one still needs the command-level prompt.
await call(route, 'list', {})
const intoFolder = await parkShell("Copy-Item 'D:/w/a.txt' -Destination 'D:/w/exists-dir'")
check('a write into a folder still parks', intoFolder.item !== undefined)
check('a write into a folder is a command-level review', intoFolder.item !== undefined && intoFolder.item.reason === 'shell-command')
await call(route, 'decide', { id: intoFolder.item.id, action: 'accept' })
check('a write into a folder accept allows', (await intoFolder.parked).kind === 'allow')

await call(route, 'list', {})
const removeFolder = await parkShell("Remove-Item -LiteralPath 'D:/w/exists-dir' -Recurse -Force")
check('removing a folder parks', removeFolder.item !== undefined && removeFolder.item.op === 'delete')
check('removing a folder is marked as a folder', removeFolder.item !== undefined && removeFolder.item.directory === true)
await call(route, 'decide', { id: removeFolder.item.id, action: 'accept' })
check('removing a folder accept allows', (await removeFolder.parked).kind === 'allow')

// Creating a folder is not a content change: it must not prompt on its own, and it
// must not leave a phantom "unchanged file" cell when it rides along with a write.
await call(route, 'list', {})
const makeFolder = gate(exec('pwsh', { command: "New-Item -ItemType Directory -Path 'D:/w/new-dir' -Force | Out-Null" }), next)
check('creating a folder is not parked', (await makeFolder).kind === 'allow')
const afterFolder = await call(route, 'list', {})
check('creating a folder leaves nothing pending', afterFolder.value.changes.length === 0)

/* ---- binary and contentless changes ---- */
// A binary file has no lines: reading it as UTF-8 would only show replacement
// characters, so the review is the size. It still has to be reviewable, or the
// panel would refuse to show the one fact that matters.
await call(route, 'list', {})
const binaryParked = gate(exec('pwsh', { command: "Set-Content -Path 'D:/w/logo.png' -Value 'x'" }), next)
await wait(30)
const binaryListed = await call(route, 'list', {})
const binaryItem = binaryListed.value.changes[0]
check('a binary write parks', binaryListed.value.changes.length === 1)
check('a binary file is described as binary', binaryItem !== undefined && binaryItem.kind === 'binary')
check('a binary file reports no lines', binaryItem !== undefined && binaryItem.added === 0 && binaryItem.removed === 0)
check('a binary file reports its bytes', binaryItem !== undefined && binaryItem.bytesBefore > 0 && binaryItem.bytesAfter === 1)
check('a binary file is reviewable on its size', binaryItem !== undefined && binaryItem.reviewable === true)
check('a binary file is not called unknowable', binaryItem !== undefined && binaryItem.reason === undefined)
await call(route, 'decide', { id: binaryItem.id, action: 'accept' })
check('a binary write accept allows', (await binaryParked).kind === 'allow')

/* ---- formatting-only and line-ending-only changes ---- */
// Re-indenting every line changes every byte and no content. Reported as its own
// category so a reviewer is not asked to hunt through four hundred rows of noise.
await call(route, 'list', {})
const reindentParked = gate(exec('write', { file_path: 'D:/w/format.txt', content: '  alpha\n  beta\n  gamma\n  delta\n' }), next)
await wait(30)
const reindentListed = await call(route, 'list', {})
const reindentItem = reindentListed.value.changes[0]
check('a re-indented file is flagged as formatting only', reindentItem !== undefined && reindentItem.note === 'formatting')
await call(route, 'decide', { id: reindentItem.id, action: 'accept' })
check('a re-indented file accept allows', (await reindentParked).kind === 'allow')

await call(route, 'list', {})
const eolParked = gate(exec('write', { file_path: 'D:/w/eol.txt', content: 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n' }), next)
await wait(30)
const eolListed = await call(route, 'list', {})
const eolItem = eolListed.value.changes[0]
check('a CRLF rewrite is flagged as line endings only', eolItem !== undefined && eolItem.note === 'line-endings')
await call(route, 'decide', { id: eolItem.id, action: 'accept' })
check('a CRLF rewrite accept allows', (await eolParked).kind === 'allow')

/* ---- unknown tools judged by shape ---- */
// A third-party filesystem server is not in any list this plugin can keep, so it
// is judged by what the call looks like: a mutating verb plus a real path.
await call(route, 'list', {})
const intentParked = gate(exec('mcp__fs__write_file', { path: 'D:/w/intent.txt', content: 'hello\n' }), next)
await wait(30)
const intentListed = await call(route, 'list', {})
const intentItem = intentListed.value.changes[0]
check('a third-party write tool parks', intentListed.value.changes.length === 1)
const intentDetail = intentItem === undefined ? { value: {} } : (await call(route, 'detail', { id: intentItem.id })).value
check('the new text is diffed when the call carries it', intentDetail.after === 'hello\n')
await call(route, 'decide', { id: intentItem.id, action: 'accept' })
check('a third-party write accept allows', (await intentParked).kind === 'allow')

// The same server's read is not a change: a path alone is not a mutation, or
// every listing would stop for approval.
check('a third-party read is not gated', (await gate(exec('mcp__fs__read_file', { path: 'D:/w/a.txt' }), next)).kind === 'allow')

// A verb in prose is not an operation. `grep({pattern: "write"})` used to read as
// a write and park a search for approval.
check('a search for the word write is not a mutation', (await gate(exec('grep', { pattern: 'write', path: 'D:/w/a.txt' }), next)).kind === 'allow')
check('a tool named write with no path is not gated', (await gate(exec('write_log', { level: 'info', message: 'started' }), next)).kind === 'allow')

/* ---- editing the change before it lands ---- */
// The reviewer can rewrite the pending text and write it themselves. The tool is
// then refused, because its own version would overwrite what the reviewer chose.
await call(route, 'list', {})
const editedContent = 'alpha\nbeta\ngamma\nEDITED\n'
const editedParked = gate(exec('write', { file_path: 'D:/w/edited.txt', content: editedContent }), next)
await wait(30)
const editedListed = await call(route, 'list', {})
const editedId = editedListed.value.changes[editedListed.value.changes.length - 1].id
const editedApply = await call(route, 'applyEdited', {
  id: editedId,
  sessionId: 's1',
  content: 'alpha\nbeta\ngamma\nMINE\n',
})
check('the reviewer\'s text is written', editedApply.value.ok === true)
check('the file holds the reviewer\'s text', currentText('D:/w/edited.txt') === 'alpha\nbeta\ngamma\nMINE\n')
check('the taken-over tool is refused', (await editedParked).kind !== 'allow')
const editedHistory = await call(route, 'history', { sessionId: 's1' })
const editedEntry = editedHistory.value.entries.find((entry) => entry.id === editedId)
check('the entry records that it was applied by hand', editedEntry !== undefined && editedEntry.state === 'applied')
// The verification hash has to follow the reviewer's text: keeping the tool's
// version would make every later undo fail with "the file changed since".
const editedUndo = await call(route, 'restore', { id: editedId, sessionId: 's1' })
check('a hand-applied change can still be taken back', editedUndo.value.ok === true)
check('the undo restored the original text', currentText('D:/w/edited.txt') === DEFAULT_TEXT)

// The model must learn that its write was replaced, or it would simply write
// again and destroy the edit. A denial alone reads as "failed, try harder".
const postExecute = handlers.get('tools/post-execute')
check('the takeover listener is registered', typeof postExecute === 'function')
const takeover = await postExecute(exec('write', { file_path: 'D:/w/edited.txt' }), {}, next)
check('the replaced write is reported as taken over', takeover.kind === 'block')
check('the notice tells the model not to retry', JSON.stringify(takeover.feedback).includes('Do not write this file again'))
const afterTakeover = await postExecute(exec('write', { file_path: 'D:/w/edited.txt' }), {}, next)
check('an unrelated call is left alone', afterTakeover.kind === 'allow')

// Editing is a text-file privilege. A shell record has no target of its own and a
// removal has no text to edit, so both are refused instead of half-working.
await call(route, 'list', {})
const noEditShell = gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/a.txt'" }), next)
await wait(30)
let current2 = await call(route, 'list', {})
const shellEdit = await call(route, 'applyEdited', { id: current2.value.changes[0].id, sessionId: 's1', content: 'x' })
check('a shell record is not editable', shellEdit.value.error === 'not-editable')
await call(route, 'decide', { id: current2.value.changes[0].id, action: 'reject' })
await noEditShell

await call(route, 'list', {})
const emptyEdit = await call(route, 'applyEdited', { id: 'no-such-change', sessionId: 's1', content: 'x' })
check('an unknown change cannot be edited', emptyEdit.value.missing === true)
const foreignEdit = await call(route, 'applyEdited', { id: editedId, sessionId: 's2', content: 'x' })
check('another conversation cannot edit it', foreignEdit.value.missing === true)

// A file that changed while the panel was open must not be overwritten: the
// reviewer saw one version, and writing over a third one would lose it silently.
await call(route, 'list', {})
const staleParked2 = gate(exec('write', { file_path: 'D:/w/moved.txt', content: 'alpha\nbeta\ngamma\nNEW\n' }), next)
await wait(30)
const staleListed2 = await call(route, 'list', {})
const staleId2 = staleListed2.value.changes[staleListed2.value.changes.length - 1].id
await ctx.fs.writeText({ targetKey: 'D:/w/moved.txt' }, 'written by someone else\n')
const staleApply = await call(route, 'applyEdited', { id: staleId2, sessionId: 's1', content: 'alpha\nbeta\ngamma\nMINE\n' })
check('an edit over a newer file is refused', staleApply.value.error === 'stale')
check('the newer text survives', currentText('D:/w/moved.txt') === 'written by someone else\n')
await call(route, 'decide', { id: staleId2, action: 'reject' })
await staleParked2

// Sending the same text back is not an edit: saying "ok" must not be reported as
// a write that happened.
await call(route, 'list', {})
const sameParked = gate(exec('write', { file_path: 'D:/w/a.txt', content: 'alpha\nbeta\ngamma\n' }), next)
await wait(30)
const sameListed = await call(route, 'list', {})
const sameId = sameListed.value.changes[sameListed.value.changes.length - 1].id
const sameApply = await call(route, 'applyEdited', { id: sameId, sessionId: 's1', content: DEFAULT_TEXT })
check('an unchanged edit is refused', sameApply.value.error === 'unchanged')
await call(route, 'decide', { id: sameId, action: 'reject' })
await sameParked

/* ---- the whole file, not just the diff ---- */
// The history view compares the file as it is now with the copy taken before the
// change, so it needs both texts and their line-by-line rows.
const detailOne = await call(route, 'historyDetail', { id: undoId, sessionId: 's1' })
check('the history detail returns both texts', detailOne.value.before === DEFAULT_TEXT && detailOne.value.after === undoContent)
check('the history detail returns rows', Array.isArray(detailOne.value.rows) && detailOne.value.rows.some((row) => row.t === 'del'))
const detailForeign = await call(route, 'historyDetail', { id: undoId, sessionId: 's2' })
check('another conversation cannot read the whole file', detailForeign.value.missing === true)
const detailUnknown = await call(route, 'historyDetail', { id: 'nope', sessionId: 's1' })
check('an unknown entry has no whole file', detailUnknown.value.missing === true)

/* ---- how much is stored ---- */
// The bar shows a count and a size, and it cannot measure either one itself: the
// blobs live in the host's store. So `list` carries them, and `history` answers
// the same numbers when the screen is open.
const statsList = await call(route, 'list', { sessionId: 's1' })
check(
  'the poll reports what the history is holding',
  typeof statsList.value.history === 'object'
    && statsList.value.history !== null
    && typeof statsList.value.history.entries === 'number'
    && statsList.value.history.entries > 0
    && typeof statsList.value.history.bytes === 'number'
    && statsList.value.history.bytes > 0,
)

check(
  'a session-less poll reports zero',
  (await call(route, 'list', {})).value.history.entries === 0,
)
const statsHistory = await call(route, 'history', { sessionId: 's1' })
check(
  'the history screen agrees with the bar',
  statsHistory.value.stats.entries === statsHistory.value.entries.length
    && statsHistory.value.stats.bytes > 0,
)

/* ---- clearing one turn ---- */
// A conversation that has been going for days is exactly the case where the
// snapshot store grows without anyone noticing, so clearing has to work per turn:
// deleting everything to reclaim the space of one turn is not an answer.
const clearParkedWrites = []
const turnOf = (await call(route, 'history', { sessionId: 's1' })).value.entries
const someTurn = turnOf.find((entry) => typeof entry.turn === 'number')
check('history entries carry the turn that made them', someTurn !== undefined)
if (someTurn !== undefined) {
  const others = turnOf.filter((entry) => entry.turn !== someTurn.turn).length
  const clearedTurn = await call(route, 'historyClear', { sessionId: 's1', turn: someTurn.turn })
  check('clearing one turn reports the list back', Array.isArray(clearedTurn.value.entries))
  check(
    'only that turn is gone',
    clearedTurn.value.entries.every((entry) => entry.turn !== someTurn.turn)
      && clearedTurn.value.entries.length === others,
  )
  check('the count moves with it', clearedTurn.value.stats.entries === clearedTurn.value.entries.length)
}
// A turn nobody has an entry for is not an error, and must not delete anything.
const clearMissing = await call(route, 'historyClear', { sessionId: 's1', turn: 99999 })
check('clearing a turn with nothing in it removes nothing', clearMissing.value.removed === 0)
check('the list survives that', clearMissing.value.entries.length > 0)

/* ---- clearing everything ---- */
// Another conversation's history is not reachable: the store is keyed per
// session, and a clear names its own.
const beforeClear = await call(route, 'history', { sessionId: 's1' })
check('there is something to clear', beforeClear.value.entries.length > 0)
const clearedAllHistory = await call(route, 'historyClear', { sessionId: 's1' })
check('clearing all removes every entry', clearedAllHistory.value.entries.length === 0)
check('clearing all reports what went', clearedAllHistory.value.removed === beforeClear.value.entries.length)
check('the store reads empty afterwards', clearedAllHistory.value.stats.entries === 0 && clearedAllHistory.value.stats.bytes === 0)
check(
  'the next poll reports the empty store',
  (await call(route, 'list', { sessionId: 's1' })).value.history.entries === 0,
)
check('a session-less clear is refused', (await call(route, 'historyClear', {})).value.missing === true)

/* ---- one file, one turn, one row ---- */
// A model that rewrites the same file five times while answering one message used
// to leave five rows saying the same thing. Folding them into the single row that
// stands for the file in that turn is what makes the list readable — and what
// makes its undo put the file back to how the turn found it, rather than to how
// the previous write left it.
turnEvent('turn/start', 9)
files.set('D:/w/merged.txt', 'one\ntwo\nthree\n')
await call(route, 'list', {})
const mergeFirst = gate(exec('write', { file_path: 'D:/w/merged.txt', content: 'one\nTWO\nthree\n' }), next)
await wait(30)
let mergeListed = await call(route, 'list', {})
await call(route, 'decide', { id: mergeListed.value.changes[0].id, action: 'accept' })
await mergeFirst
// The tool ran: the first write is on disk now, which is the "before" of the second.
files.set('D:/w/merged.txt', 'one\nTWO\nthree\n')
await call(route, 'list', {})
const mergeSecond = gate(exec('write', { file_path: 'D:/w/merged.txt', content: 'one\nTWO\nTHREE\n' }), next)
await wait(30)
mergeListed = await call(route, 'list', {})
const mergeSecondId = mergeListed.value.changes[0].id
await call(route, 'decide', { id: mergeSecondId, action: 'accept' })
await mergeSecond
const mergedRows = (await call(route, 'history', { sessionId: 's1' })).value.entries
  .filter((entry) => entry.path === 'D:/w/merged.txt')
check('two writes to one file in one turn leave one row', mergedRows.length === 1)
check('the row keeps the turn it belongs to', mergedRows[0] !== undefined && mergedRows[0].turn === 9)
// Net, not the sum of both writes: the turn took the file from three lines to
// three different lines, so two lines changed and two did not survive.
check('the row counts the net change', mergedRows[0] !== undefined && mergedRows[0].added === 2 && mergedRows[0].removed === 2)
check('the row still reads as an update', mergedRows[0] !== undefined && mergedRows[0].op === 'update')
check('the row answers to the latest call', mergedRows[0] !== undefined && mergedRows[0].id === mergeSecondId)

// Created and removed inside one turn: the file is exactly as the turn found it,
// so a row would offer an undo with nothing left to undo.
await call(route, 'list', {})
const bornParked = gate(exec('write', { file_path: 'D:/w/brand-new.txt', content: 'temporary\n' }), next)
await wait(30)
const bornListed = await call(route, 'list', {})
await call(route, 'decide', { id: bornListed.value.changes[bornListed.value.changes.length - 1].id, action: 'accept' })
check('a created file is accepted', (await bornParked).kind === 'allow')
// The fake host does not perform the write a `write` call asks for — the gate only
// says yes. Putting the bytes there by hand is what makes the following removal a
// removal of something real rather than of a path that never existed.
files.set('D:/w/brand-new.txt', 'temporary\n')
// It exists now, so the fake `stat` must stop reporting the path as absent — a
// removal of a path that is not there is neither destructive nor reviewable.
absentFiles.delete('D:/w/brand-new.txt')
await call(route, 'list', {})
const killedParked = gate(exec('pwsh', { command: "Remove-Item -LiteralPath 'D:/w/brand-new.txt' -Force" }), next)
await wait(30)
const killedListed = await call(route, 'list', {})
await call(route, 'decide', { id: killedListed.value.changes[killedListed.value.changes.length - 1].id, action: 'accept' })
check('the removal of a fresh file is accepted', (await killedParked).kind === 'allow')
const bornRows = (await call(route, 'history', { sessionId: 's1' })).value.entries
  .filter((entry) => entry.path === 'D:/w/brand-new.txt')
check('created and removed in one turn leaves no row to read', bornRows.length === 0)

/* ---- silencing one conversation ---- */
// The settings turn the plugin off for every conversation at once and the manual
// switch still reviews and still records. This one is per conversation and means
// it: no panel, no record, no snapshot.
await call(route, 'list', {})
const offSet = await call(route, 'decide', { action: 'setSessionOff', value: true, sessionId: 's1' })
check('turning review off reports the new state', offSet.value.ok === true && offSet.value.off === true)
check('the poll says so too', (await call(route, 'list', { sessionId: 's1' })).value.off.s1 === true)
// Written down, not just held in memory: a switch that forgets at the next restart
// is a switch nobody trusts. The file lives beside the snapshot directories rather
// than inside one, so "clear this conversation's history" cannot resurrect review.
const offFile = join(snapshotRoot, 'review-off.json')
check('the switch is written down', existsSync(offFile))
check('the file names the conversation', readFileSync(offFile, 'utf8').includes('s1'))
check('a silenced conversation is not asked', (await gate(exec('write', { file_path: 'D:/w/silent.txt', content: 'quiet\n' }), next)).kind === 'allow')
check('nothing was left waiting', (await call(route, 'list', { sessionId: 's1' })).value.changes.length === 0)
const silentRows = (await call(route, 'history', { sessionId: 's1' })).value.entries
  .filter((entry) => entry.path === 'D:/w/silent.txt')
check('and nothing was recorded', silentRows.length === 0)
const offBack = await call(route, 'decide', { action: 'setSessionOff', value: false, sessionId: 's1' })
check('review can be turned back on', offBack.value.ok === true && offBack.value.off === false)
const resumedParked = gate(exec('write', { file_path: 'D:/w/resumed.txt', content: 'again\n' }), next)
await wait(30)
const resumedListed = await call(route, 'list', { sessionId: 's1' })
check('the conversation is reviewed again', resumedListed.value.changes.some((item) => item.path === 'D:/w/resumed.txt'))
await call(route, 'decide', { id: resumedListed.value.changes[resumedListed.value.changes.length - 1].id, action: 'accept', sessionId: 's1' })
await resumedParked
check('a session-less silence is refused', (await call(route, 'decide', { action: 'setSessionOff', value: true })).value.missing === true)

/* ---- not gated ---- */
await call(route, 'list', {})
check('read not gated', (await gate(exec('read', { file_path: 'D:/w/a.txt' }), next)).kind === 'allow')

let failed = 0
for (const [label, ok] of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
// Leave no trace: the snapshot directory belongs to this run alone.
rmSync(snapshotRoot, { recursive: true, force: true })
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
