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
check('shell duplicate target keeps both ops', twiceSame.item !== undefined && twiceSame.item.targets.length === 2)
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
