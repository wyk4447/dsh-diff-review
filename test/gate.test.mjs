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
      // `fresh.txt` does not exist in this fake workspace: that is what makes the
      // creation path distinguishable from an overwrite.
      stat: async (target) => (String(target.targetKey).includes('fresh.txt') ? undefined : { version: 'v1', type: 'file' }),
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

// A path the shell expands cannot be resolved, so the gate has to confirm the
// command itself. Before this was handled, `Remove-Item -LiteralPath $p` parsed
// as the literal name `$p`, resolved to nothing, and went through unreviewed.
const expanded = [
  'Remove-Item -LiteralPath $p -Force',
  'Remove-Item -LiteralPath "${target}"',
  'Set-Content -Path $out -Value hi',
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

// `$env:TEMP` is the one expansion the host can replay, and replaying it turns a
// throwaway scratch delete into a path `isTempPath` recognises — so it must be
// skipped, not parked. Left unexpanded it never matched, and every cleanup of a
// file in the OS temp directory asked the user to approve it.
await call(route, 'list', {})
const parkedEnvTemp = gate(exec('pwsh', { command: 'Remove-Item $env:TEMP\\probe.txt -Force' }), next)
check('shell env temp target is skipped', (await parkedEnvTemp).kind === 'allow')
const listedEnvTemp = await call(route, 'list', {})
check('shell env temp target leaves nothing pending', listedEnvTemp.value.changes.length === 0)

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

// `-Value $x` is produced at run time: the panel must not invent content for it.
const runtime = await parkShell('Set-Content -Path D:/w/a.txt -Value $x')
check('shell runtime value parks', runtime.item !== undefined)
check('shell runtime value is not reviewable', runtime.item !== undefined && runtime.item.reviewable === false)
check('shell runtime value says shell-command', runtime.item !== undefined && runtime.item.reason === 'shell-command')
check('shell runtime value has no rows', runtime.detail.rows.length === 0 && runtime.detail.before === '')
await call(route, 'decide', { id: runtime.item.id, action: 'reject' })
check('shell runtime value reject denies', (await runtime.parked).kind === 'deny')

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

const streamed = await parkShell('$js > D:/w/a.txt')
check('shell runtime redirect says shell-command', streamed.item !== undefined && streamed.item.reason === 'shell-command')
await call(route, 'decide', { id: streamed.item.id, action: 'accept' })
check('shell runtime redirect accept allows', (await streamed.parked).kind === 'allow')

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

const hereUnknown = await parkShell([
  '$n = Get-Date',
  '$add = @"',
  'line $n',
  '"@',
  "[System.IO.File]::WriteAllText('D:/w/a.txt', $add)",
].join('\n'))
check('shell here-string unknown value says shell-command', hereUnknown.item !== undefined && hereUnknown.item.reason === 'shell-command')
await call(route, 'decide', { id: hereUnknown.item.id, action: 'accept' })
check('shell here-string unknown accept allows', (await hereUnknown.parked).kind === 'allow')

// The exemption stays narrow: a variable assigned at run time is not knowable.
const builtAtRuntime = await parkShell("$t = 'a' + 'b'\nSet-Content -Path D:/w/a.txt -Value $t")
check('shell computed value says shell-command', builtAtRuntime.item !== undefined && builtAtRuntime.item.reason === 'shell-command')
check('shell computed value has no rows', builtAtRuntime.detail.rows.length === 0)
await call(route, 'decide', { id: builtAtRuntime.item.id, action: 'accept' })
check('shell computed value accept allows', (await builtAtRuntime.parked).kind === 'allow')

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
const unknownRef = await parkShell('Set-Content -Path D:/w/a.txt -Value "hello $env:USERNAME"')
check('shell unknown reference says shell-command', unknownRef.item !== undefined && unknownRef.item.reason === 'shell-command')
await call(route, 'decide', { id: unknownRef.item.id, action: 'accept' })
check('shell unknown reference accept allows', (await unknownRef.parked).kind === 'allow')

/* ---- shell shape recognition ---- */
// A cmdlet inventory can never be complete, so the net keys off shape instead:
// PowerShell's verb-noun convention, .NET member calls, programs that take code
// as a string, and tools that rewrite files in place. Each of these rewrote a
// file while matching nothing the old whitelist knew.
for (const command of [
  "Set-Item -Path 'D:/w/a.txt' -Value 'one'",
  "Rename-Item -Path 'D:/w/a.txt' -NewName 'b.txt'",
  "New-Item -Path 'D:/w/dir' -ItemType Directory",
  "'x' | Tee-Object -FilePath 'D:/w/a.txt'",
  "Get-Process | Export-Csv -Path 'D:/w/a.csv'",
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

// `Set-Item` is a known write cmdlet with a literal path and value, so the same
// diff machinery applies rather than a bare command block.
const setItem = await parkShell("Set-Item -Path 'D:/w/a.txt' -Value 'one'")
check('shell set-item is reviewable', setItem.item !== undefined && setItem.item.reviewable === true)
check('shell set-item shows the new text', setItem.detail.after === 'one')
await call(route, 'decide', { id: setItem.item.id, action: 'accept' })
check('shell set-item accept allows', (await setItem.parked).kind === 'allow')

// The wider net must not swallow read-only commands or cmdlets that only build
// objects in memory: `New-Object`, `Add-Type`, `Clear-Host` and friends share a
// mutating prefix but never touch a file.
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

/* ---- self + temp exemptions ---- */
await call(route, 'list', {})
// Derived from this file's own location so the test survives a clone anywhere.
const selfFile = fileURLToPath(new URL('../lib/x.js', import.meta.url))
check('self skipped', (await gate(exec('write', { file_path: selfFile, content: 'x\n' }), next)).kind === 'allow')
const tempProbe = `${(process.env.TEMP || 'C:/Temp').replace(/\\\\/g, '/')}/probe.txt`
check('temp skipped', (await gate(exec('write', { file_path: tempProbe, content: 'x\n' }), next)).kind === 'allow')
// `skipScratch` covers the workspace scratch directory, which lives under no
// environment variable: the harness puts every throwaway file in `<ws>/.dsh/tmp`.
for (const scratch of ['D:/w/.dsh/tmp/probe.cjs', 'D:/w/.dsh/tmp/deep/nest/probe.mjs', 'D:/other/.dsh/tmp/x.html']) {
  check(`scratch skipped ${scratch}`, (await gate(exec('write', { file_path: scratch, content: 'x\n' }), next)).kind === 'allow')
}
// The exemption must stay narrow: a directory that merely starts with the word
// tmp, or a .dsh file outside tmp, is a real project file and still parks.
for (const keeper of ['D:/w/.dsh/tmpfoo/probe.cjs', 'D:/w/.dsh/settings.json', 'D:/w/src/tmp/app.js']) {
  const parked = gate(exec('write', { file_path: keeper, content: 'x\n' }), next)
  await wait(20)
  const listed = await call(route, 'list', {})
  check(`scratch guard keeps ${keeper}`, listed.value.changes.some((item) => item.path === keeper))
  await call(route, 'decide', { id: listed.value.changes[0].id, action: 'reject' })
  await parked
}

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
