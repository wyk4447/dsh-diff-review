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
// `>&` merges every stream into one file, and it used to be read as `2>&1` —
// a rename of one stream into another, which writes nothing. The line was also
// cut in half at the `&`, so the operator and the file name ended up in two
// different statements and neither half named a file.
check('a merged stream with a space writes the file', writes('cmd >& a.txt', 'a.txt', (item) => item.opaque === true))
check('a merged stream without a space writes the file', writes('cmd >&a.txt', 'a.txt', (item) => item.opaque === true))
check('a merged stream of a program writes the file', writes('node a.js >& out.txt', 'out.txt', (item) => item.opaque === true))
check('a merged stream into a descriptor writes nothing', allowed('node a.js >& 2'))
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

/* ---- a script handed to a host ---- */
// `.\deploy.ps1` was caught because the script was the command itself. The same
// script handed to a host — `powershell -File deploy.ps1`, `bash deploy.sh` —
// is the same program, and the text is in the file rather than on the command
// line, so it is confirmed as a whole.
check('a script handed to powershell is seen', writes('powershell -File deploy.ps1', 'deploy', (item) => item.shape === true))
check('a script handed to pwsh is seen', writes('pwsh -File build.ps1', 'build', (item) => item.shape === true))
check('a script behind another flag is seen', writes('powershell -ExecutionPolicy Bypass -File deploy.ps1', 'deploy', (item) => item.shape === true))
check('a script handed to bash is seen', writes('bash deploy.sh', 'deploy.sh', (item) => item.shape === true))
check('a script handed to sh is seen', writes('sh build.sh', 'build.sh', (item) => item.shape === true))
check('a script handed to zsh is seen', writes('zsh tool.zsh', 'tool.zsh', (item) => item.shape === true))
// The short options of a POSIX shell may be written in one bundle: `bash -lc` is
// `-l` plus `-c`, and the command line is the argument that follows.
check('a bundled command flag is seen', writes('bash -lc "rm a.txt"', 'bash', (item) => item.shape === true))
check('a plain command flag is seen', writes('bash -c "rm a.txt"', 'bash', (item) => item.shape === true))
check('inline code is not a script file', allowed('bash -c "node test.mjs"'))

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
// `Format-*` shapes something for a person to look at. `Format-Volume` writes to
// a volume, not to a file, and no diff could show it — asking about it was a
// prompt the reviewer could not refuse in any useful way.
check('formatting a volume writes no file', allowed('Format-Volume -DriveLetter D'))
check('formatting a table writes no file', allowed('Format-Table'))

/* ---- an argument that is an expression ---- */
// `(Get-ChildItem '*.txt')` is one argument, but the tokenizer works on spaces and
// hands it over in pieces. Read piece by piece, the panel showed
// `(Get-ChildItem` as a file that was about to be deleted — a name no reviewer
// could make sense of. The expression is kept whole instead.
const grouped = ops("Remove-Item (Get-ChildItem 'D:/w/*.txt')")
check('an expression is one target', grouped.length === 1)
check('an expression is not read as a file name', grouped.length === 1 && grouped[0].path.includes('Get-ChildItem'))
check('an expression that deletes still deletes', grouped.length === 1 && grouped[0].op === 'delete')
const joined = ops("Remove-Item ('D:/w/' + 'a.txt')")
check('a joined expression is one target', joined.length === 1)
check('a joined expression keeps its text', joined.length === 1 && joined[0].path.includes('+'))
// The value of a flag is still the value of a flag: `-AclObject $acl` names an
// object, not a file.
check('a flag value is not a path', ops('Set-Acl -Path D:/w/a.txt -AclObject $acl').length === 1)

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
  // A git command that only records what is already in the working tree writes
  // the repository's own bookkeeping and changes no file the user works with.
  // Asking about it would put a command with no file list in front of the
  // reviewer on every commit. A git command that *does* rewrite the working
  // tree — checkout, reset, restore, clean, merge, pull, rebase — is gated.
  'git commit -m x',
  'git add .',
  'git tag v1',
  'git config user.name x',
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
