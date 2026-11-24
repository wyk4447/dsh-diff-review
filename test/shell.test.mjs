/**
 * The shell matrix: what the gate makes of a command line, before anything runs.
 *
 * Every case here is a command that was either waved through while it wrote a
 * file, or stopped while it wrote nothing. The parser is the only thing that
 * decides which, so the decisions are asserted here rather than through a live
 * session — a session would only tell us that the panel opened, not why.
 */
import { parseShellCommand } from '../lib/index.js'

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

/** The operations a command produces, in a shape a case can talk about. */
function ops(command) {
  return parseShellCommand(command).map((item) => ({
    op: item.op,
    path: item.path,
    value: item.value === undefined ? null : item.value,
    opaque: item.opaque === true,
    shape: item.shape === true,
    wildcard: item.wildcard === true,
  }))
}

function allowed(command) {
  return ops(command).length === 0
}

function writes(command, path, extra) {
  const found = ops(command).find((item) => item.path === path && item.op === 'write')
  if (found === undefined) return false
  if (extra === undefined) return true
  return extra(found)
}

function deletes(command, path) {
  return ops(command).some((item) => item.path === path && item.op === 'delete')
}

/* ---- redirection ---- */
// The operator comes in more shapes than the four that used to be read, and the
// stream number belongs to the operator rather than to the name in front of it.
check('a literal redirect carries its text', writes('echo hi > D:/w/a.txt', 'D:/w/a.txt', (item) => item.value === 'hi'))
check('a redirect without a space carries its text', writes('echo hi>D:/w/a.txt', 'D:/w/a.txt', (item) => item.value === 'hi'))
check('a one-character word carries its text', writes('echo x > D:/w/a.txt', 'D:/w/a.txt', (item) => item.value === 'x'))
check('Write-Output carries its text', writes('Write-Output hi > D:/w/a.txt', 'D:/w/a.txt', (item) => item.value === 'hi'))
check('a bare string redirect carries its text', writes("'redirected' > D:/w/a.txt", 'D:/w/a.txt', (item) => item.value === 'redirected'))
check('a program output is unknown', writes('node a.js > out.txt', 'out.txt', (item) => item.opaque === true))
check('a joined stderr is unknown', writes('node a.js 2> err.txt', 'err.txt', (item) => item.opaque === true))
check('a merged stream writes no file', allowed('node a.js 2>&1'))
check('a numbered stdout is unknown', writes('node a.js 1> a.txt', 'a.txt', (item) => item.opaque === true))
check('every stream at once is unknown', writes('node a.js *> a.txt', 'a.txt', (item) => item.opaque === true))
check('the cmd spelling of every stream is unknown', writes('node a.js &> a.txt', 'a.txt', (item) => item.opaque === true))
check('a stderr append is a write', writes('cmd 2>> e.txt', 'e.txt', (item) => item.opaque === true))
check('the null device is not a file', allowed('Get-Date > $null'))
check('the cmd null device is not a file', allowed('cmd > NUL'))

/* ---- the program, not just the verb ---- */
// Whether a write was caught used to depend on whether the path had been typed
// with a directory in it.
check('a fully qualified cmd is seen', writes('C:\\Windows\\System32\\cmd.exe /c del D:\\w\\a.txt', 'cmd', (item) => item.shape === true))
check('a quoted fully qualified host is seen', writes('"C:\\Program Files\\Git\\bin\\bash.exe" -c "rm a.txt"', 'bash', (item) => item.shape === true))
check('a quoted cmdlet name is the cmdlet', deletes("'remove-item' D:/w/a.txt", 'D:/w/a.txt'))
check('a group around a cmdlet is the cmdlet', deletes('(Remove-Item "D:/w/a.txt")', 'D:/w/a.txt'))
check('a sub-expression is the cmdlet', deletes('$(Remove-Item "D:/w/a.txt")', 'D:/w/a.txt'))
check('a pipeline source is not a file name', ops('Remove-Item (Get-ChildItem "D:/w/*.txt")').every((item) => item.wildcard === true))

/* ---- writes whose text nobody can see ---- */
// The file is named and is about to be replaced. The reviewer is asked about the
// file; the text is the tool's own decision.
check('a pipeline write names the file', writes("Get-Process | Out-File 'D:/w/a.txt'", 'D:/w/a.txt', (item) => item.opaque === true))
check('a tee names the file', writes("'x' | Tee-Object -FilePath 'D:/w/a.txt'", 'D:/w/a.txt', (item) => item.opaque === true))
check('an export names the file', writes("Get-Process | Export-Csv -Path 'D:/w/a.csv'", 'D:/w/a.csv', (item) => item.opaque === true))
check('a runtime value is an opaque write', writes('Set-Content -Path D:/w/a.txt -Value $x', 'D:/w/a.txt', (item) => item.opaque === true))
check('a literal value is a known write', writes("Set-Content -Path 'D:/w/a.txt' -Value 'hi'", 'D:/w/a.txt', (item) => item.value === 'hi'))
check('a .NET write with an unknown value is opaque', writes("[IO.File]::WriteAllText('D:/w/a.txt', $body)", 'D:/w/a.txt', (item) => item.opaque === true))
check('a .NET write with a literal value is known', writes("[IO.File]::WriteAllText('D:/w/a.txt', 'hi')", 'D:/w/a.txt', (item) => item.value === 'hi'))
check('an in-memory .NET call is not a write', allowed('[SHA256]::Create()'))
check('a stream writer is a write', writes('[IO.StreamWriter]::new("D:/w/a.txt")', 'D:/w/a.txt', (item) => item.shape === true))

/* ---- git ---- */
check('a pull changes the working tree', writes('git pull', 'git', (item) => item.shape === true))
check('a merge changes the working tree', writes('git merge topic', 'git', (item) => item.shape === true))
check('a rebase changes the working tree', writes('git rebase topic', 'git', (item) => item.shape === true))
check('a clean removes files', ops('git clean -fdx').some((item) => item.op === 'delete'))
check('a commit only touches the repository', allowed('git commit -m x'))
check('a diff only reads', allowed('git diff'))

/* ---- packaging and unpacking ---- */
check('an archive is unpacked', writes('tar -xf out.tar -C D:/w', 'tar', (item) => item.shape === true))
check('a zip is unpacked', writes('unzip out.zip -d D:/w', 'unzip', (item) => item.shape === true))

/* ---- wrappers ---- */
check('sudo does not hide a removal', deletes('sudo rm a.txt', 'a.txt'))
check('an env assignment does not hide a removal', deletes('env FOO=1 rm a.txt', 'a.txt'))
check('a wrapper that does nothing else is harmless', allowed('npm test'))
check('a read-only lint run is harmless', allowed('npx prettier --check a.js'))
check('a listing is harmless', allowed('Get-ChildItem'))
check('a search is harmless', allowed('Select-String -Pattern x a.txt'))

/* ---- copy, move, rename ---- */
// The second argument of these three is a destination, not content.
check('a copy writes the destination', writes('Copy-Item a.txt b.txt', 'b.txt', (item) => item.opaque === true))
check('a copy of a list writes every destination', ops('Copy-Item a.txt b.txt,c.txt').filter((item) => item.op === 'write').length === 2)
check('a move removes the source', deletes('Move-Item a.txt b.txt', 'a.txt'))
check('a move writes the destination', writes('Move-Item a.txt b.txt', 'b.txt'))
check('a rename keeps the directory', deletes('Rename-Item D:\\x\\a.txt b.txt', 'D:\\x\\a.txt'))
check('a rename names the new file', writes('Rename-Item D:\\x\\a.txt b.txt', 'D:\\x\\b.txt'))

/* ---- flags and cmdlets ---- */
check('a download without a file is a read', allowed('Invoke-WebRequest https://x'))
check('a download with a file is a write', writes('Invoke-WebRequest https://x -OutFile a.html', 'a.html'))
check('a transcript writes a file', writes('Start-Transcript -Path log.txt', 'log.txt'))
check('stopping a transcript writes nothing', allowed('Stop-Transcript'))
check('unblocking a file does not change it', allowed('Block-File a.txt'))
check('a permission change names the file', writes('Set-Acl -Path D:/w/a.txt -AclObject $acl', 'D:/w/a.txt'))
check('formatting a volume is destructive', ops('Format-Volume').length > 0)

/* ---- what the gate deliberately does not read ---- */
// These are known holes, recorded so that the choice stays visible: they are
// not bugs that were forgotten, they are calls the gate makes on purpose.
for (const command of [
  'npm install',
  'pnpm add left-pad',
  'pip install -r requirements.txt',
  'cargo build',
  'go build ./...',
  'tsc',
  'dotnet build',
  'make',
  'git remote add origin https://example.com/r.git',
  'git log --output=f.txt',
]) {
  check(`not gated on purpose: ${command}`, allowed(command))
}

/* ---- long commands ---- */
// A script with more statements than the limit used to be waved through whole.
const longScript = Array.from({ length: 45 }, (_, index) => `Write-Host "line ${index}"`).join('\n')
check('a long harmless script is not gated', allowed(longScript))
const longScriptWithRemoval = `${longScript}\nRemove-Item D:/w/a.txt`
check('a long script that removes is still seen', ops(longScriptWithRemoval).length > 0)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${passes} passed)`)
if (failures > 0) process.exit(1)
