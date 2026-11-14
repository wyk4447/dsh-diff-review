/**
 * dsh-diff-review — host half.
 *
 * Gates mutating file tools (`write`, `edit`) behind a user review in the
 * sidebar: the call parks on a `tools/pre-execute` waterfall until the user
 * accepts or rejects the pending change, then either delegates to `next()`
 * (the tool really runs) or denies it.
 *
 * Transport to the browser half is a small same-origin HTTP surface fenced by
 * `ctx.connection.requestRejection`, mirroring the official `dsh-better-sidebar`
 * pattern. No typert descriptors, no profile surgery.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createHistory, sha256 } from './history.js'

const NS = 'diff-review'
const API_PREFIX = '/diff-review/api'
const MAX_BODY_BYTES = 1 << 20
const MAX_STORED_CHARS = 800_000
const MAX_DIFF_CELLS = 4_000_000
const CONTEXT_LINES = 3

/**
 * Tools this plugin draws a precise diff for.
 *
 * These keep their own branches because they can be read exactly: `write` hands
 * over the new text, `edit` hands over both sides of a replacement, and `pwsh`
 * can be parsed. Every other tool is judged by {@link mutatingIntent} instead of
 * by name, so a filesystem MCP server — whose tool names this plugin has never
 * heard of — is still reviewed.
 */
const DIFFABLE_TOOLS = new Set(['write', 'edit', 'pwsh'])

/* ------------------------------------------------- unknown tools by shape -- */

/**
 * Verbs that mean "this call changes a file".
 *
 * An unknown tool is described only by its name and arguments, so the question
 * "does this write?" has to be answered from those two things. A tool that
 * merely mentions a path — `read`, `present`, a viewer, a diff — names none of
 * these verbs and is let through untouched.
 */
const MUTATING_VERBS = new Set([
  'write', 'create', 'delete', 'remove', 'edit', 'update', 'append', 'rename',
  'move', 'copy', 'mkdir', 'rmdir', 'truncate', 'save', 'put', 'upload',
  'patch', 'insert', 'replace', 'overwrite', 'unlink', 'touch', 'set', 'drop',
  'trash', 'erase', 'wipe', 'extract', 'unzip', 'chmod', 'chown', 'mkdirp',
])

/** Verbs that remove rather than rewrite, so the panel can word the badge. */
const REMOVAL_VERBS = new Set([
  'delete', 'remove', 'unlink', 'rmdir', 'drop', 'trash', 'erase', 'wipe', 'rm', 'del',
])

/** Argument keys whose value is the thing being acted on, not a description. */
const PATH_ARG_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'filepath', 'file_path', 'target',
  'targets', 'destination', 'dest', 'source', 'src', 'dir', 'directory',
  'folder', 'output', 'outfile', 'out_file', 'to', 'from', 'name',
  'absolute_path', 'relative_path', 'new_path', 'old_path',
])

/**
 * Argument keys that carry the new text rather than a location.
 *
 * An MCP filesystem server names these the same way everywhere, so a write it is
 * about to make can be shown as a real diff instead of "the file will change,
 * contents unknown". `source` is deliberately absent: on a copy call it is a
 * path, and reading it as text would diff a file against its own name.
 */
const CONTENT_ARG_KEYS = new Set([
  'content', 'contents', 'text', 'data', 'body', 'new_content', 'new_text',
  'newtext', 'value', 'payload', 'source_code',
])

/**
 * Argument keys whose value names the operation itself.
 *
 * Only these may spell out a mutating verb. Scanning every string value was the
 * obvious version and it was wrong: `grep({pattern: "write", path: …})` reads as
 * a write, so a search would have been parked for approval. A one-word verb in
 * `op` / `action` / `mode` is how MCP servers actually spell the operation; a
 * verb anywhere else is prose.
 */
const OPERATION_ARG_KEYS = new Set([
  'op', 'operation', 'action', 'mode', 'type', 'method',
])

/** Split a name or a key into lowercase word tokens (`sftp_write` → sftp, write). */
function verbTokens(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '')
}

/** True for a string that is plausibly a filesystem path rather than prose. */
function looksLikePath(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 4096) return false
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (text.startsWith('\\\\')) return true
  if (/^\.{1,2}[\\/]/.test(text)) return true
  if (/^[\\/]/.test(text)) return true
  // `sub/dir/file.ext` — a separator plus an extension is specific enough not
  // to catch prose, which is what every false positive here would have to be.
  return /[\\/]/.test(text) && /\.[A-Za-z0-9]{1,8}$/.test(text)
}

/**
 * Every string value in an arguments object, one level of nesting included.
 *
 * Kept for the diagnostic shape report; deciding whether a call mutates is done
 * from the tool name and the operation argument only, because a verb in prose is
 * not an operation.
 */
function argumentStrings(value, out = [], depth = 0) {
  if (depth > 3 || value === null || value === undefined) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) argumentStrings(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) argumentStrings(item, out, depth + 1)
  }
  return out
}

/**
 * Describe what an unrecognised tool is about to do, or `undefined` to let it be.
 *
 * The gate cannot know a third-party tool's semantics, so it decides from shape:
 * a mutating verb somewhere in the name or the argument keys, plus at least one
 * path-shaped argument value. Both halves are required — a verb with no path is
 * `db_execute("DELETE FROM …")`, a path with no verb is `read`, and neither of
 * those is a file change this panel could show.
 */
function mutatingIntent(name, args) {
  if (args === null || typeof args !== 'object') return undefined
  const nameMutation = verbTokens(name).some((token) => MUTATING_VERBS.has(token))
  // `{"op": "write", "path": …}` — a mutating verb as the *value* of the
  // operation argument is how most MCP servers spell it. Only that one key is
  // read: a one-word verb in `type: "write"` is an operation, while the same
  // word in `pattern: "write"` is a search target, and treating the two alike
  // parked a `grep` for approval.
  const valueMutation = Object.entries(args).some(([key, value]) => {
    if (!OPERATION_ARG_KEYS.has(key.toLowerCase())) return false
    return verbTokens(value).every((token) => MUTATING_VERBS.has(token)) && verbTokens(value).length > 0
  })
  if (!nameMutation && !valueMutation) return undefined

  const paths = []
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase()
    const looksTarget = PATH_ARG_KEYS.has(lower)
      || lower.includes('path') || lower.includes('file') || lower.includes('dir')
    const candidates = Array.isArray(value) ? value : [value]
    for (const candidate of candidates) {
      if (!looksTarget || !looksLikePath(candidate)) continue
      const text = candidate.trim()
      if (!paths.includes(text)) paths.push(text)
    }
  }
  // A verb with no path is `db_execute("DELETE FROM …")` or a log write to a
  // stream: nothing here could draw a before/after, so it is not this gate's work.
  if (paths.length === 0) return undefined

  // The new text, when the call carries it. An MCP `write_file` passes the whole
  // file body, so the panel can show the real diff; a call that only says "here
  // is the path I am going to change" leaves `content` undefined and the panel
  // says so instead of guessing.
  let content
  for (const [key, value] of Object.entries(args)) {
    if (!CONTENT_ARG_KEYS.has(key.toLowerCase())) continue
    if (typeof value !== 'string') continue
    content = value
    break
  }

  const tokens = [...verbTokens(name), ...Object.entries(args).flatMap(([key, value]) =>
    OPERATION_ARG_KEYS.has(key.toLowerCase()) ? verbTokens(value) : [],
  )]
  const verb = tokens.find((token) => MUTATING_VERBS.has(token)) ?? ''
  return { op: REMOVAL_VERBS.has(verb) ? 'delete' : 'write', paths, verb, content }
}

/** PowerShell statements that destroy or rewrite a file without a `fs` call. */
// Cmdlets after which the path it names no longer holds what it did: the file is
// gone, or it now lives somewhere else. Both stay gated even inside an exempt
// request — a file that moved cannot be found by looking where it was.
const SHELL_DELETE_CMDLETS = new Set([
  'remove-item',
  'ri',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'rename-item',
  'ren',
  'rni',
  'move-item',
  'mi',
  'move',
  'mv',
  'restore-item',
  'clear-recyclebin',
])
// Cmdlets that empty a file's contents while leaving the file in place. They are
// edits, not removals: `Clear-Content x.txt` is how a script deletes every line
// of a file, and the outcome is a known empty string, so it gets a diff.
const SHELL_TRUNCATE_CMDLETS = new Set(['clear-content', 'clc', 'clear-item', 'cli'])
const SHELL_WRITE_CMDLETS = new Set([
  'set-content',
  'sc',
  'out-file',
  'add-content',
  'ac',
  'set-item',
  'si',
  'new-item',
  'ni',
  'set-itemproperty',
  'sp',
  'copy-item',
  'cpi',
  'copy',
  'cp',
  'tee-object',
  'tee',
  'export-csv',
  'epcsv',
  'export-clixml',
  'epcxml',
  'compress-archive',
  'expand-archive',
  'set-acl',
  'save-module',
  'stop-transcript',
  'mkdir',
  'md',
])
/** Of the write cmdlets, the ones that extend the file instead of replacing it. */
const SHELL_APPEND_CMDLETS = new Set(['add-content', 'ac'])
/** Flags whose following token is a value; only path-ish ones count as targets. */
const SHELL_VALUE_FLAGS = new Set([
  '-path',
  '-literalpath',
  '-filepath',
  '-destination',
  '-value',
  '-filter',
  '-include',
  '-exclude',
  '-credential',
  '-erroraction',
  '-stream',
  '-encoding',
  '-name',
  '-itemtype',
  '-delimiter',
  '-width',
  '-inputobject',
])
const SHELL_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination'])

/**
 * Everything below widens the net from "cmdlets we listed" to "anything that
 * looks like it writes".
 *
 * A whitelist of cmdlets can never cover PowerShell: `Set-Item`, `New-Item`,
 * `Tee-Object`, `Export-Csv`, `Rename-Item`, `Move-Item`, `Copy-Item`,
 * `[IO.File]::WriteAllText`, `cmd /c del`, `iex`, `git clean` and an open-ended
 * tail of community modules each rewrite files without mentioning a name we
 * happened to list. That is why the same class of report kept coming back after
 * every single-name patch. The rules now key off *shape* instead of inventory:
 * PowerShell's own verb-noun convention, .NET member calls, programs that take
 * code as a string, and the handful of external tools that mutate in place.
 */
const SHELL_MUTATING_PREFIXES = [
  'set-',
  'new-',
  'remove-',
  'clear-',
  'rename-',
  'move-',
  'copy-',
  'add-',
  'out-',
  'tee-',
  'write-',
  'save-',
  'export-',
  'import-',
  'compress-',
  'expand-',
  'restore-',
  'block-',
  'unblock-',
  'mount-',
  'format-',
]

/**
 * Verbs that carry a mutating prefix but only touch the pipeline or the session.
 * Kept as an explicit list so every exemption is a decision, not an accident.
 */
const SHELL_HARMLESS_VERBS = new Set([
  'write-host',
  'write-output',
  'write-verbose',
  'write-information',
  'write-debug',
  'write-progress',
  'write-warning',
  'out-host',
  'out-string',
  'out-null',
  'out-gridview',
  'out-default',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'format-hex',
  'start-sleep',
  'start-transcript',
  'stop-transcript',
  'set-location',
  'set-variable',
  'set-strictmode',
  'push-location',
  'pop-location',
  'invoke-command',
  'invoke-webrequest',
  'invoke-restmethod',
  // In-memory only: they build objects, variables or aliases in the session.
  'add-member',
  'add-type',
  'add-history',
  'new-object',
  'new-variable',
  'set-alias',
  'set-psdebug',
  'write-error',
  'clear-host',
  'remove-variable',
  'remove-module',
  'remove-job',
  'remove-psdrive',
  'remove-alias',
  'import-module',
  'import-csv',
  'import-clixml',
  'import-localizeddata',
])

/** A .NET member call named like a write: `[IO.File]::WriteAllText(...)` and friends. */
const SHELL_MUTATING_MEMBER_RE = /::\s*(?:write|append|create|delete|move|copy|replace|open|truncate|save|remove|rename|set)\w*\s*\(/i
/** The subset of those that removes the target rather than filling it. */
const SHELL_MEMBER_DELETE_RE = /::\s*(?:delete|remove)\w*\s*\(/i
/** The subset of those that extend the target instead of replacing it. */
const SHELL_MEMBER_APPEND_RE = /::\s*append\w*\s*\(/i

/**
 * The only .NET types whose members can reach the disk.
 *
 * A member name alone says nothing: `SHA256]::Create()` and `File]::Create('a')`
 * were both read as "creates something", and the first one is a hash object held
 * in memory. The owning type is the part that decides, so a call is a write only
 * when it comes from one of these — or when it is handed a path.
 */
const SHELL_DISK_MEMBER_OWNER = /file|directory|streamwriter|zipfile|ziparchive|filesystem|isolatedstorage/i

/**
 * Verbs that execute or launch whatever they are handed, so the files they touch
 * only exist at run time: `iex $code`, `cmd /c del x`, `Start-Process x`.
 */
const SHELL_EXEC_ALWAYS = new Set([
  'iex',
  'invoke-expression',
  'invoke-item',
  'start-process',
  'saps',
  'mshta',
  'rundll32',
  'regsvr32',
])

/** Hosts that run supplied code only when one of the flags below is present. */
const SHELL_CODE_HOSTS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'cscript',
  'wscript',
  'node',
  'nodejs',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
])
/** Flags that turn a host into `program "<code>"`. */
const SHELL_INLINE_CODE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '-command',
  '-com',
  '-encodedcommand',
  '-ec',
  '-enc',
  '/c',
  '/k',
])

/**
 * Interpreters whose `-e`-style payload is ordinary source text this parser can
 * read. Deliberately short: `cmd /c del x` and `bash -c 'rm …'` also hand over a
 * string, but that string is *shell*, and judging it with the words below would
 * wave through a deletion spelled with a verb this file never lists.
 */
const SHELL_SCRIPT_HOSTS = new Set(['node', 'nodejs', 'python', 'python3', 'py'])
/** The flags those hosts use to take source text on the command line. */
const SHELL_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c'])

/**
 * Words that mean the script touched the disk, written without underscores and
 * matched against identifiers with their underscores removed as well, so
 * `writeFileSync`, `write_file` and `to_csv` all hit.
 *
 * This list decides when the read-only shortcut is *withdrawn*, and its failure
 * mode is asymmetric on purpose: a writing word it misses means a write is
 * reviewed as if it were harmless, so every ordinary way a script produces a
 * file has to be here — Node's `fs`, Python's builtins and `shutil`, numpy and
 * pandas. A straggler that only appears inside a string literal costs one extra
 * prompt instead, which is the cheap direction to be wrong in.
 */
const SHELL_SCRIPT_WRITE_WORDS = new Set([
  'write', 'writeline', 'writelines', 'writefile', 'writesync', 'writetext',
  'writebytes', 'writefilesync', 'appendfile', 'appendfilesync', 'createwritestream',
  'fdopen', 'unlink', 'unlinksync', 'rm', 'rmsync', 'rmdir', 'rmdirsync', 'rmtree',
  'remove', 'removesync', 'rename', 'renamesync', 'copytree',
  'copyfile', 'copyfilesync', 'cp', 'cpsync', 'mkdir',
  'mkdirsync', 'mkdtemp', 'mkdtempsync', 'truncate', 'truncatesync', 'ftruncate',
  'chmod', 'chown', 'utimes', 'symlink', 'dump', 'save', 'savez',
  'savetxt', 'savefig', 'imsave', 'tocsv', 'toexcel', 'tojson', 'tohtml',
  'topickle', 'tofile', 'extractall', 'extract', 'fsync', 'writealltext',
  'writealllines', 'writeallbytes', 'appendalltext',
])

/**
 * Write calls whose name is also an everyday method on something else.
 *
 * `list.copy()` and `text.replace()` are among the most common things a read-only
 * script does, so these only count when a disk module is spelled out in front of
 * them — `shutil.copy`, `os.replace`, `path.touch`. Flagging the bare name kept
 * ordinary report scripts behind the panel, which is the noise this recognition
 * exists to remove; the module prefix is what makes the call about a file.
 */
const SHELL_SCRIPT_CONTEXT_WORDS = new Set(['replace', 'move', 'copy', 'link', 'touch'])

/** The receivers that turn one of the words above into a filesystem call. */
const SHELL_SCRIPT_CONTEXT_RE =
  /\b(?:fs|fsp|fse|os|shutil|path|pathlib|io|np|numpy|pd|pandas|plt|matplotlib|cv2|PIL|Image|zipfile|tarfile|gzip|sh|glob|tempfile|subprocess)\s*\.\s*(?:replace|move|copy|link|touch)\b/i

/** String literals, so a word inside a message is not read as a call. */
const SHELL_SCRIPT_STRING_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g

/**
 * `open` is the one call whose meaning depends on its mode: without a writing
 * mode it only reads. Rather than gate every Python script that opens a file for
 * reading, the call is recognised by the mode literal next to it — and only
 * *there*, so `print('a')` in a report script does not read as a write mode.
 *
 * The gap between the parenthesis and the mode is written as "up to a semicolon"
 * because the path argument is usually a call itself (`open(os.path.join(a, b),
 * 'w')`), and stopping at the first `)` would never reach the mode.
 */
const SHELL_SCRIPT_WRITE_OPEN_RE =
  /\b\w*open\w*\s*\([^;\n]{0,200}?[`'"](?:w|wb|wt|a|ab|at|x|xb|r\+|w\+|a\+)[b+]*[`'"]/i

/**
 * Words that hand control to something this parser cannot follow at all. A
 * script that launches a program can do anything, so the read-only shortcut is
 * withdrawn the moment one of these appears.
 */
const SHELL_SCRIPT_OPAQUE_WORDS = new Set([
  'childprocess', 'execsync', 'execfile', 'execfilesync', 'spawn', 'spawnsync',
  'fork', 'eval', 'workerthreads',
])

/** Identifiers in a piece of source text, underscores and dollars removed. */
function scriptWords(text) {
  const out = []
  const found = String(text).toLowerCase().match(/[a-z0-9_$]+/g)
  if (found === null) return out
  for (const word of found) out.push(word.replace(/[_$]/g, ''))
  return out
}

/**
 * Whether an inline script can only read.
 *
 * This is the answer to a concrete complaint: a `node -e` that loaded a YAML file
 * and printed two numbers was shown as "the result is not knowable up front" with
 * thirty lines of code to read. The script's text *is* readable, so the decision
 * is made on what it names — a disk-writing call, a writing `open()` mode, or a
 * way to launch another program withdraws the shortcut, and nothing else does.
 *
 * The order matters. Strings go first so a message that mentions "write" is not
 * mistaken for a call, then the harmless sinks (`console.log`, `process.stdout
 * .write`) are erased so printing is never read as writing. Only then are
 * identifiers compared against the writing words. A script whose payload is not
 * even a string (built at run time from variables) returns `false`: unknown
 * is not the same as harmless.
 */
function scriptReadsOnly(payload) {
  if (typeof payload !== 'string' || payload.trim() === '') return false
  // A writing `open()` mode is the one signal that lives inside a string literal,
  // so it is checked before the literals are stripped.
  if (SHELL_SCRIPT_WRITE_OPEN_RE.test(payload)) return false
  const code = payload
    .replace(SHELL_SCRIPT_STRING_RE, ' ')
    .replace(SHELL_SCRIPT_HARMLESS_SINKS, ' ')
  const words = scriptWords(code)
  // Nothing left once the literals and the printing calls are gone: the script
  // computes nothing and writes nothing.
  if (words.length === 0) return true
  for (const word of words) {
    if (SHELL_SCRIPT_OPAQUE_WORDS.has(word)) return false
    if (SHELL_SCRIPT_WRITE_WORDS.has(word)) return false
  }
  // The everyday method names only count with a disk module spelled out in front.
  if (SHELL_SCRIPT_CONTEXT_RE.test(code)) return false
  return true
}

/**
 * The source text a statement hands to an interpreter, or `null`.
 *
 * `node -e '…'`, `python -c '…'`, `py -3 -c '…'`. The flag is looked up anywhere
 * after the host name because `python -3 -c` puts an option in between.
 */
function inlineScriptOf(statement) {
  const tokens = tokenize(statement)
  if (tokens.length < 2) return null
  const lowered = tokens.map((token) => token.toLowerCase())
  let verb = lowered[0]
  if (verb.includes('/') || verb.includes('\\')) return null
  verb = verb.replace(/\.(?:exe|com|bat|cmd|ps1)$/, '')
  if (!SHELL_SCRIPT_HOSTS.has(verb)) return null
  for (let i = 1; i < tokens.length; i += 1) {
    if (!SHELL_SCRIPT_FLAGS.has(lowered[i])) continue
    const payload = tokens[i + 1]
    if (payload === undefined) return null
    const whole = wholeQuoted(payload)
    return whole === null ? stripQuotes(payload) : whole
  }
  return null
}

/** Command words that only move the working directory. */
const SHELL_CD_VERBS = new Set([
  'cd', 'chdir', 'set-location', 'sl', 'push-location', 'pushd', 'pop-location', 'popd',
])

/** One readable line for a statement: whitespace collapsed, length capped. */
function statementText(statement, limit = 200) {
  const flat = String(statement).replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * How many brackets a fragment opens, counting only the ones outside quotes.
 *
 * `splitStatements` breaks at `|`, `&`, `{` and `}`, which is right for the gate —
 * a delete hidden inside `if (...) { ... }` has to be seen on its own — but wrong
 * for reading. One `($sha.ComputeHash($b) | ForEach-Object { … }) -join ''` came out
 * as four separate "steps", so the panel listed twelve lines for what the reviewer
 * would have read as one expression. The count says whether a fragment can stand
 * alone or is the middle of something.
 */
function bracketDelta(text) {
  let delta = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') delta += 1
    else if (ch === ')' || ch === ']' || ch === '}') delta -= 1
  }
  return delta
}

/**
 * A command broken into the steps it performs, for commands with no diff to show.
 *
 * The panel used to answer "the result is not knowable up front" with the whole
 * command in one block — thirty lines of one-liner that had to be read as code to
 * find out whether anything was even being written. The statement boundaries are
 * already known here (`splitStatements`), and so is the destructive intent of each
 * one, so the panel can list "switch directory → set a variable → write this file"
 * instead. The raw text stays available underneath for the cases where the summary
 * is not enough.
 *
 * Fragments that do not balance are held and folded into the next one: a step that
 * ends in the middle of a parenthesis is not a step a reader can judge.
 */
function describeSteps(command) {
  const steps = []
  const vars = new Map()
  let count = 0
  let open = 0
  let held = null
  const flush = () => {
    if (held === null) return
    steps.push(held.step)
    held = null
  }
  for (const statement of splitStatements(command)) {
    count += 1
    // Past the cap the parser stops reading, and a list of steps that covers only
    // part of the command would read as if that were all of it.
    if (count > SHELL_MAX_STATEMENTS) break
    trackAssignment(statement, vars)
    const ops = shellOpsOf(statement, vars)
    const tokens = tokenize(statement)
    let verb = tokens.length === 0 ? '' : tokens[0].toLowerCase()
    const moduleCut = verb.lastIndexOf('\\')
    if (moduleCut !== -1) verb = verb.slice(moduleCut + 1)
    verb = verb.replace(/\.(?:exe|com|bat|cmd|ps1)$/, '')
    const flags = held === null ? new Set() : held.flags
    if (SHELL_CD_VERBS.has(verb)) flags.add('cd')
    if (ops.some((item) => item.shape === true)) flags.add('opaque')
    if (ops.some((item) => item.op === 'delete')) flags.add('delete')
    else if (ops.length > 0) flags.add('write')
    if (flags.size === 0 && (verb.startsWith('$') || verb === 'set-variable')) flags.add('note')

    const target = ops.find((item) => item.shape !== true && typeof item.path === 'string' && item.path !== '')
    // An inline script is the part worth reading, so it gets its own line rather
    // than being buried in the middle of the statement that launched it.
    const payload = inlineScriptOf(statement)

    if (held === null) {
      held = { text: statement, flags, step: { kind: 'run', text: '' } }
      if (target !== undefined) held.step.path = target.path
      if (payload !== null) held.step.code = statementText(payload, 400)
    } else {
      held.text += ` ${statement.trim()}`
      if (target !== undefined && held.step.path === undefined) held.step.path = target.path
      if (payload !== null && held.step.code === undefined) held.step.code = statementText(payload, 400)
    }

    open = Math.max(0, open + bracketDelta(statement))
    if (open === 0) {
      held.step.text = statementText(held.text)
      held.step.kind = held.flags.has('opaque')
        ? 'opaque'
        : held.flags.has('delete')
          ? 'delete'
          : held.flags.has('write')
            ? 'write'
            : held.flags.has('cd')
              ? 'cd'
              : held.flags.has('note')
                ? 'note'
                : 'run'
      flush()
    }
  }
  if (held !== null) {
    held.step.text = statementText(held.text)
    flush()
  }
  return steps
}

/**
 * Whether every inline script in a command only reads.
 *
 * `'none'` when the command has no inline script at all — that is the ordinary
 * case and the caller keeps its existing wording. `'writes'` as soon as one
 * script cannot be cleared, so a read-only script followed by a writing one is
 * still reviewed.
 */
function inlineScriptVerdict(command) {
  let seen = 0
  let count = 0
  for (const statement of splitStatements(command)) {
    count += 1
    // Past the cap `parseShellCommand` gives up and reviews nothing, so a
    // read-only verdict over the first forty statements would be a guess about
    // the rest. Refuse to clear a command this parser does not finish reading.
    if (count > SHELL_MAX_STATEMENTS) return 'unknown'
    const payload = inlineScriptOf(statement)
    if (payload === null) continue
    seen += 1
    if (!scriptReadsOnly(payload)) return 'writes'
  }
  return seen === 0 ? 'none' : 'read-only'
}

/**
 * Write calls that do not touch the disk.
 *
 * `process.stdout.write` and `console.log` are how every script reports what it
 * did, and counting them as a write kept every read-only one-liner behind the
 * panel — the exact complaint this recognition exists to answer. They are
 * blanked out before the identifier scan.
 */
const SHELL_SCRIPT_HARMLESS_SINKS =
  /(?:process\s*\.\s*(?:stdout|stderr)|console|sys\s*\.\s*(?:stdout|stderr)|stdout|stderr)\s*\.\s*(?:write|writelines?|log|error|warn|info|debug)\b/g

/** `git` subcommands that rewrite the working tree or the index. */
const SHELL_GIT_MUTATING = new Set([
  'clean',
  'checkout',
  'reset',
  'restore',
  'rm',
  'mv',
  'switch',
  'stash',
  'gc',
  'prune',
  'update-ref',
  'submodule',
  'branch',
  'worktree',
])

/** Unix tools that rewrite or remove files in place. */
const SHELL_UNIX_MUTATORS = new Set(['truncate', 'dd', 'shred', 'unlink', 'touch'])

/**
 * Prefixes that remove rather than fill. `clear-` is deliberately absent: emptying
 * a file is an edit, and a shape-level match on it must not claim the file dies.
 */
const SHELL_DELETE_PREFIXES = ['remove-']
/** The unix tools that take a file away rather than rewrite it. */
const SHELL_UNIX_REMOVERS = new Set(['unlink', 'shred', 'rm'])

/** Defaults, overridable from `cordis.patch.yml` via `config:`. */
const DEFAULT_SETTINGS = {
  files: true,
  shell: true,
  skipTemp: true,
  skipScratch: true,
  skipSelf: true,
  skipNoise: true,
  history: true,
  trace: true,
  timeoutMs: 300_000,
  shellTimeoutMs: 120_000,
}

/**
 * The plugin must never gate its own source. A broken sidebar half would
 * otherwise lock the only path to repairing it, which is a deadlock, not a
 * review. Both the checkout and any profile copy carry this segment.
 */
const SELF_SEGMENT = 'dsh-diff-review'

/** Absolute package root of this module (undefined when it cannot be derived). */
const SELF_ROOT = (() => {
  try {
    const here = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase()
    const cut = here.lastIndexOf('/lib/index.js')
    return cut === -1 ? undefined : here.slice(0, cut)
  } catch {
    return undefined
  }
})()

/** True for paths inside this plugin's own package (checkout or profile copy). */
function isSelfPath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  const insideRoot = SELF_ROOT !== undefined
    && (normalised === SELF_ROOT || normalised.startsWith(`${SELF_ROOT}/`))
  if (insideRoot) return true
  return normalised.includes(`/node_modules/${SELF_SEGMENT}/`)
}

/**
 * A review gate is only armed while a browser half is actually alive.
 *
 * Without this the plugin would happily park a `write` forever whenever the
 * sidebar is not mounted (plugin failed to load, page reloaded, window closed),
 * deadlocking the agent on a decision nobody can make. The browser half pings
 * `heartbeat` on every poll tick; a missing ping means "nobody is watching, let
 * the tool through".
 *
 * The window has to survive background throttling: a Chromium page that is not
 * visible clamps `setInterval` to roughly one tick per minute, so a short window
 * (the original 8s) read as "nobody is watching" the moment the user switched
 * windows — the panel then never appeared at all, which is exactly the failure
 * this constant used to cause. Anything above the clamp keeps the gate armed
 * across a hidden window while still going quiet once the page is really gone.
 */
const HEARTBEAT_TTL_MS = 180_000

/** An unanswered review never wedges the session: `DEFAULT_SETTINGS.timeoutMs`. */

/**
 * Append-only trace file, because the panel is not always observable.
 *
 * The diagnostics inside the sidebar only exist while that tab is mounted and
 * readable, which is exactly what fails when the gate misbehaves. A plain log
 * line per gate call is the only evidence that survives a reload, and it costs
 * nothing when tracing is off.
 */
const TRACE_FILE = (() => {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (typeof home !== 'string' || home.trim() === '') return undefined
    const dir = `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.dsh/logs`
    mkdirSync(dir, { recursive: true })
    return `${dir}/diff-review.log`
  } catch {
    return undefined
  }
})()

/**
 * Where whole-file snapshots live, so an accepted change can be taken back.
 *
 * Inside `~/.dsh/` for the same reason the trace file is: it is state the
 * plugin owns rather than a file in the workspace, and keeping it out of the
 * project tree means it never shows up in a diff or a build. `skipScratch`
 * already stops the gate from reviewing writes there.
 */
const HISTORY_ROOT = (() => {
  try {
    // The override exists so tests can point the store at a temporary directory
    // instead of filling the real home. It is not a documented user setting.
    const override = process.env.DSH_DIFF_REVIEW_HISTORY_ROOT
    if (typeof override === 'string' && override.trim() !== '') {
      return override.replace(/\\/g, '/').replace(/\/+$/, '')
    }
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (typeof home !== 'string' || home.trim() === '') return undefined
    return `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.dsh/diff-review/history`
  } catch {
    return undefined
  }
})()

/**
 * Resolved at `apply()` time rather than import time.
 *
 * The gate test loads this module before it can set the override, so a value
 * frozen at import would send every snapshot into the real home directory. The
 * environment is read once per apply, which is also when the store is built.
 */
function historyRoot() {
  try {
    const override = process.env.DSH_DIFF_REVIEW_HISTORY_ROOT
    if (typeof override === 'string' && override.trim() !== '') {
      return override.replace(/\\/g, '/').replace(/\/+$/, '')
    }
  } catch {
    /* fall through to the frozen value */
  }
  return HISTORY_ROOT
}

/** Never throws: a trace failure must not change a tool's fate. */
function trace(settings, event, fields) {
  if (settings === undefined || settings.trace !== true) return
  if (TRACE_FILE === undefined) return
  try {
    const stamp = new Date().toISOString()
    const detail = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
    appendFileSync(TRACE_FILE, `${stamp} ${event}${detail}\n`)
  } catch {
    /* tracing is a courtesy, not a contract */
  }
}

const inject = ['tools', 'webServer', 'connection', 'fs']

/* ------------------------------------------------------------------ diff -- */

/** LCS line diff over two string arrays; `null` when the pair is too large. */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null
  const W = m + 1
  const dp = new Int32Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * W
    const nextRow = row + W
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[row + j] = a[i] === b[j]
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'equal', ai: i, bi: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ t: 'del', ai: i })
      i += 1
    } else {
      ops.push({ t: 'add', bi: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ t: 'del', ai: i })
    i += 1
  }
  while (j < m) {
    ops.push({ t: 'add', bi: j })
    j += 1
  }
  return ops
}

function splitLines(text) {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function buildRows(beforeText, afterText) {
  const a = splitLines(beforeText ?? '')
  const b = splitLines(afterText ?? '')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  const rows = []
  for (let i = 0; i < prefix; i += 1) rows.push({ t: 'equal', a: i + 1, b: i + 1, text: a[i] })

  const ops = lcsOps(midA, midB)
  if (ops === null) {
    for (let i = 0; i < midA.length; i += 1) rows.push({ t: 'del', a: prefix + i + 1, b: null, text: midA[i] })
    for (let i = 0; i < midB.length; i += 1) rows.push({ t: 'add', a: null, b: prefix + i + 1, text: midB[i] })
  } else {
    for (const op of ops) {
      if (op.t === 'equal') {
        rows.push({ t: 'equal', a: prefix + op.ai + 1, b: prefix + op.bi + 1, text: midA[op.ai] })
      } else if (op.t === 'del') {
        rows.push({ t: 'del', a: prefix + op.ai + 1, b: null, text: midA[op.ai] })
      } else {
        rows.push({ t: 'add', a: null, b: prefix + op.bi + 1, text: midB[op.bi] })
      }
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const ai = a.length - suffix + i
    const bi = b.length - suffix + i
    rows.push({ t: 'equal', a: ai + 1, b: bi + 1, text: a[ai] })
  }

  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.t === 'add') added += 1
    else if (row.t === 'del') removed += 1
  }
  return { rows, added, removed, oldLineCount: a.length, newLineCount: b.length }
}

/** Collapse long unchanged runs into `gap` rows, keeping CONTEXT_LINES around edits. */
function toHunks(rows) {
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].t === 'equal') continue
    const from = Math.max(0, i - CONTEXT_LINES)
    const to = Math.min(rows.length - 1, i + CONTEXT_LINES)
    for (let k = from; k <= to; k += 1) keep[k] = true
  }
  const out = []
  let skipped = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ t: 'gap', count: skipped })
        skipped = 0
      }
      out.push(rows[i])
    } else {
      skipped += 1
    }
  }
  if (skipped > 0) out.push({ t: 'gap', count: skipped })
  return out
}

/* ------------------------------------------------------------------ shell -- */

/**
 * `pwsh` carries a single command string, so destructive shell work has to be
 * recognised from the text itself. The parsing below is deliberately
 * conservative: when a statement does not look like a delete/overwrite we let it
 * through, and when a target cannot be resolved we still ask, but without a diff.
 */
const SHELL_MAX_STATEMENTS = 40
const SHELL_MAX_TARGETS = 20
/** Tokens a shell would expand; we cannot predict what they hit. */
const SHELL_WILDCARD_RE = /[*?[\]]/

/**
 * True for a path the shell expands *before* any cmdlet sees it: `$p`,
 * `$(Get-Item x)`, `${env:TEMP}\a.txt`, `$env:TEMP\a.txt`, `D:\$name\x`.
 *
 * This matters more than it looks. `Remove-Item -LiteralPath $p` used to arrive
 * here as the literal string `$p`, resolve to nothing, and be dropped by the
 * "nothing to delete" branch — so deleting a file through a variable went
 * through completely unreviewed. Anything we cannot resolve up front has to be
 * treated as an unknown target and reviewed as a command, never as a no-op.
 */
function isShellExpanded(displayPath) {
  const value = String(displayPath)
  if (value.startsWith('$')) return true
  if (value.includes('$(') || value.includes('${')) return true
  // A variable at the head of a path segment: `D:\$name\x`. A literal `$` inside
  // a file name (`a$b.txt`) has no separator in front of it and stays reviewable.
  return /[\\/]\$/.test(value)
}

const TEMP_ROOTS = [process.env.TEMP, process.env.TMP, '/tmp']
  .filter((value) => typeof value === 'string' && value.trim() !== '')
  .map((value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())

/** True for paths the OS keeps for scratch space (never worth a review). */
function isTempPath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  return TEMP_ROOTS.some((root) => normalised === root || normalised.startsWith(`${root}/`))
}

/**
 * The workspace scratch directory, `.dsh`, is an extension of the same idea.
 *
 * The OS temp directory is not the only place scratch work lands: this harness
 * tells the agent to keep every throwaway script and export under
 * `<workspace>/.dsh/`, and a workspace can sit on any drive, so the path cannot
 * be predicted from an environment variable. Those files are produced and
 * deleted inside one turn, so parking them only taught the user to click through
 * their own scratch space — the exact noise `skipTemp` exists to prevent.
 *
 * The whole directory is covered, not just `.dsh/tmp`: the agent also drops
 * one-off scripts straight into `.dsh/`, and the harness keeps its own state
 * there (`vision-router` artifacts, logs). None of it is project source, and all
 * of it is documented as disposable. The segment is matched anywhere in the path
 * so nested folders are covered too, and a lookalike like `.dsh/tmpfoo` is not.
 */
function isScratchPath(displayPath) {
  const normalised = `/${String(displayPath).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '')}`
  return normalised.includes('/.dsh/') || normalised.endsWith('/.dsh')
}

/**
 * Directory names whose contents are produced, never authored.
 *
 * Reviewing a build artefact one file at a time is the largest single source of
 * noise the log has: of 799 gate calls on this machine, 188 landed inside one of
 * these directories, 152 of them in `__pycache__` alone — every one of them a
 * `delete` of something Python regenerates on the next import. The reviewer was
 * asked to approve removing a bytecode cache they never wrote, over and over.
 *
 * The list is deliberately short and every entry is unambiguous: a directory a
 * tool owns outright, matched as a whole segment so `dist` does not also catch
 * `distribution/` or `a-dist/`. Names that are *sometimes* source — `bin`, `lib`,
 * `public`, `static`, `docs`, `src` — are absent on purpose: a project can put
 * hand-written files there, and silently letting a write through is the one
 * failure this gate exists to prevent.
 *
 * Version-control directories are absent for a sharper reason: they are where the
 * *contents* are the danger. `.git/hooks/pre-commit` is a script that runs on the
 * next commit and `.git/objects` holds the history; both are writes a reviewer has
 * to see. Skipping the unreadable pack files would also skip those two, so the
 * whole tree stays gated.
 */
const NOISE_SEGMENTS = new Set([
  // Python bytecode and tool caches
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.ipynb_checkpoints',
  // Dependency trees
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  // Build output
  'dist',
  'build',
  'out',
  'target',
  'obj',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.turbo',
  '.gradle',
])

/**
 * True for paths that only exist because something generated them.
 *
 * The check is segment-wise rather than a substring test so `D:\a\dist` matches
 * and `D:\a\distro` does not. A trailing separator is tolerated because callers
 * pass both file paths and bare directory paths.
 */
function isNoisePath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  for (const segment of normalised.split('/')) {
    if (NOISE_SEGMENTS.has(segment)) return true
  }
  return false
}

/* ---------------------------------------------- binary / formatting noise -- */

/**
 * Extensions whose bytes have no lines to diff.
 *
 * Reading one of these as UTF-8 yields a screen of replacement characters, and
 * "which replacement character changed" is not a review: the useful fact is the
 * size. Anything not listed here is still read as text and demoted at runtime
 * when the read itself says it is not text, so this list only has to catch the
 * common cases before we pay for a failed read.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff', '.psd',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.pyc', '.class', '.pdb',
])

/** `.map` files are JSON, but forty thousand rows of base64 help nobody. */
const SOURCE_MAP_SUFFIX = '.map'

/**
 * How the panel should describe a file: as lines, as bytes, or as a source map.
 *
 * A source map is text and a diff of it would be correct, which is exactly why
 * it needs its own answer: correct and useless looks like a bug.
 */
function contentKind(displayPath) {
  const lower = String(displayPath ?? '').replace(/\\/g, '/').toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base.endsWith(SOURCE_MAP_SUFFIX)) return 'sourcemap'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'text'
  return BINARY_EXTENSIONS.has(base.slice(dot)) ? 'binary' : 'text'
}

/** UTF-8 byte length, which is what "N → M bytes" has to count. */
function utf8Bytes(text) {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0
}

/** Line endings normalised to LF, everything else left alone. */
function withLf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * True when the two texts differ only in how their lines end.
 *
 * A file rewritten by a tool that defaults to CRLF reads as "every line
 * changed" in a naive diff, which is the loudest possible way to report nothing.
 */
function lineEndingsOnly(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  if (a === b) return false
  return withLf(a) === withLf(b)
}

/** Indentation and trailing spaces dropped, line structure kept. */
function squashIndent(text) {
  return withLf(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, '').replace(/^[ \t]+/u, ''))
    .join('\n')
}

/**
 * True when the change is pure reformatting.
 *
 * Reported as its own category rather than folded into "no change": the bytes
 * did change and an undo still has to be possible, but a reviewer should not
 * hunt through four hundred re-indented lines for a real edit that is not there.
 */
function formattingOnly(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  if (a === b) return false
  return squashIndent(a) === squashIndent(b)
}

/**
 * Where a here-string ends: the index just past `'@` / `"@`, or the end of the
 * text when it is never closed.
 *
 * The opener must sit at the end of a line and the terminator at the start of
 * one, which is why a `'@` in the middle of a line of text does not close it.
 */
function hereStringEnd(text, start) {
  const terminator = `${text[start + 1]}@`
  let index = start + 2
  while (index < text.length) {
    const at = text.indexOf(terminator, index)
    if (at === -1) return text.length
    if (at === 0 || text[at - 1] === '\n' || text[at - 1] === '\r') return at + 2
    index = at + 2
  }
  return text.length
}

/**
 * Split a PowerShell command into simple statements, honouring quotes.
 *
 * Braces separate statements too, because a script block (`if (...) { ... }`,
 * `foreach (...) { ... }`, `& { ... }`) is a *sequence* of statements that the
 * shell runs. Leaving them glued on made the whole block one token run whose
 * first token was `if(Test-Path`, which matches no cmdlet — so a delete hidden
 * inside an `if` that merely tested for existence went through unreviewed.
 * `${name}` is the one brace that belongs to its statement, so it is kept whole.
 *
 * A here-string (`@'...'@`, `@"..."@`) is copied out whole: its body spans
 * newlines and routinely contains `|`, `&`, braces and quotes — a markdown table
 * is enough. Tearing it apart would not only lose the content but invent
 * commands out of prose.
 */
function splitStatements(command) {
  const out = []
  let current = ''
  let quote = ''
  let expansions = 0
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote !== '') {
      current += ch
      if (ch === '`' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '@' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      const end = hereStringEnd(command, i)
      current += command.slice(i, end)
      i = end - 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' && (current.endsWith('$') || current.endsWith('@'))) {
      expansions += 1
      current += ch
      continue
    }
    if (ch === '}' && expansions > 0) {
      expansions -= 1
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '&' || ch === '{' || ch === '}') {
      if (current.trim() !== '') out.push(current)
      current = ''
      if (ch === '|' || ch === '&') {
        const follow = command[i + 1]
        if (follow === ch) i += 1
      }
      continue
    }
    current += ch
  }
  if (current.trim() !== '') out.push(current)
  return out
}

/** Split one statement into tokens, keeping quoted strings intact. */
function tokenize(statement) {
  const tokens = []
  let current = ''
  let quote = ''
  let started = false
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i]
    if (quote !== '') {
      current += ch
      if (ch === '`' && quote === '"' && i + 1 < statement.length) {
        current += statement[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '@' && (statement[i + 1] === "'" || statement[i + 1] === '"')) {
      // One token, however many lines it covers: the cmdlet receives the body
      // as a single string argument.
      const end = hereStringEnd(statement, i)
      current += statement.slice(i, end)
      started = true
      i = end - 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * The body of a here-string token, or `null` when the token is not one.
 *
 * PowerShell drops the newline that follows the opener and the one that precedes
 * the terminator; everything between them is the value. The quotes are the same
 * two forms as everywhere else: `@'` never expands, `@"` expands.
 */
function hereStringBody(token) {
  if (typeof token !== 'string' || token.length < 4) return null
  if (token[0] !== '@' || (token[1] !== "'" && token[1] !== '"')) return null
  if (!token.endsWith(`${token[1]}@`)) return null
  let body = token.slice(2, -2)
  body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  return { body, interpolates: token[1] === '"' }
}

function stripQuotes(token) {
  let value = token
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === last && (first === "'" || first === '"')) value = value.slice(1, -1)
  }
  return value
}

/**
 * Split one `-Path`/positional argument into its target list.
 *
 * PowerShell also accepts a comma-separated list inside a single argument
 * (`Remove-Item 'a.txt','b.txt'`), and that comma sits *outside* the quotes, so
 * each element has to be unquoted on its own. Stripping the whole token first
 * left half a quote glued to every name, and the panel ended up showing
 * `a.txt'` and `'b.txt` as if those were the files about to be deleted.
 */
function splitTargetList(text) {
  const parts = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => stripQuotes(part.trim())).filter((part) => part !== '')
}

/**
 * The argument tokens of the first `::Name(...)` call in a statement.
 *
 * A .NET call takes positionals only — `[IO.File]::WriteAllText('a.txt', 'body')` —
 * so there are no `-Path` flags to read and the parenthesis is the argument list.
 * Quotes are kept intact per argument (unlike `splitTargetList`) because the caller
 * needs `literalOf` to see whether an argument was a literal string or an expression.
 * Splitting only happens on commas outside quotes, since a JSON body inside a string
 * would otherwise be cut in half.
 */
function callArgumentsOf(statement) {
  const open = statement.indexOf('(', statement.search(SHELL_MUTATING_MEMBER_RE))
  if (open === -1) return []
  const args = []
  let current = ''
  let quote = ''
  let depth = 0
  for (let i = open + 1; i < statement.length; i += 1) {
    const ch = statement[i]
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') {
      depth += 1
      current += ch
      continue
    }
    if (ch === ')') {
      if (depth === 0) {
        args.push(current.trim())
        break
      }
      depth -= 1
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  return args.filter((arg) => arg !== '')
}

/**
 * Substitute `$env:NAME` with the value this process actually sees.
 *
 * A script naming its scratch file as `$env:TEMP\out.txt` is naming a real
 * location, and the harness already knows it: `process.env.TEMP` is the same
 * value the child shell resolves. Left unexpanded, the path never matched
 * `isTempPath`, so deleting a throwaway file in the OS temp directory still
 * asked the user to approve it — the exact noise `skipTemp` promises to skip.
 *
 * An undefined variable is left untouched, so the gate falls back to confirming
 * the command instead of pointing at a path that does not exist.
 */
function expandEnvVars(text) {
  if (!text.includes('$env:')) return text
  return text.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name) => {
    const value = process.env[name]
    return typeof value === 'string' && value !== '' ? value : whole
  })
}

/** A bare `$name` or `${name}` token: the only form we treat as a variable. */
const VARIABLE_TOKEN_RE = /^\$([A-Za-z_][A-Za-z0-9_:]*)$/
const VARIABLE_BRACED_RE = /^\$\{([A-Za-z_][A-Za-z0-9_:]*)\}$/

/** The variable a whole token names, or `null` when the token is anything else. */
function variableNameOf(token) {
  if (typeof token !== 'string') return null
  const braced = VARIABLE_BRACED_RE.exec(token)
  if (braced !== null) return braced[1].toLowerCase()
  const plain = VARIABLE_TOKEN_RE.exec(token)
  return plain === null ? null : plain[1].toLowerCase()
}

/** Backtick escapes PowerShell honours inside a double-quoted string. */
const SHELL_ESCAPES = {
  0: '\0',
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}

/** Resolve PowerShell backtick escapes: ``"a`nb"`` is the two-line string `a\nb`. */
function unescapeDouble(inner) {
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch !== '`' || i + 1 >= inner.length) {
      out += ch
      continue
    }
    const next = inner[i + 1]
    out += SHELL_ESCAPES[next] === undefined ? next : SHELL_ESCAPES[next]
    i += 1
  }
  return out
}

/**
 * The text a double-quoted body turns into, or `null` when the shell decides it.
 *
 * Escapes are resolved and every variable reference is substituted, so
 * `"$dir\out.txt"` and `"hello $name"` are exact whenever those variables were
 * assigned a literal earlier in the same command. One unknown reference makes
 * the whole string unknowable — half a path is worse than no path.
 */
function expandDouble(inner, vars) {
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '`' && i + 1 < inner.length) {
      const next = inner[i + 1]
      out += SHELL_ESCAPES[next] === undefined ? next : SHELL_ESCAPES[next]
      i += 1
      continue
    }
    if (ch !== '$') {
      out += ch
      continue
    }
    const rest = inner.slice(i)
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_:]*)\}|^\$([A-Za-z_][A-Za-z0-9_:]*)/.exec(rest)
    if (match === null) return null
    const name = String(match[1] === undefined ? match[2] : match[1]).toLowerCase()
    const known = vars === undefined ? undefined : vars.get(name)
    if (known === undefined) return null
    // A trailing `.`/`[` is property or index access, which we cannot replay.
    const after = rest[match[0].length]
    if (after === '.' || after === '[') return null
    out += known
    i += match[0].length - 1
  }
  return out
}

/**
 * The body of a token that is exactly one quoted string, else `null`.
 *
 * The closing quote has to be the token's last character. `'a'+'b'` begins and
 * ends with a quote yet is two literals the shell joins, and slicing off the
 * outer pair turned it into the garbage text `a'+'b` — content the reviewer was
 * shown as if it were about to be written. A doubled quote inside a
 * single-quoted string is an escaped quote, not a terminator.
 */
function wholeQuoted(token) {
  const quote = token[0]
  if (quote !== "'" && quote !== '"') return null
  let out = ''
  for (let i = 1; i < token.length; i += 1) {
    const ch = token[i]
    if (ch !== quote) {
      out += ch
      continue
    }
    if (quote === "'" && token[i + 1] === "'") {
      out += "'"
      i += 1
      continue
    }
    return i === token.length - 1 ? out : null
  }
  return null
}

/**
 * The text a token *literally* means, or `null` when the shell decides it.
 *
 * Three forms qualify: a quoted string whose variables are all known, a bare
 * word the shell would pass through unchanged, and a whole-token variable that
 * the same command assigned a literal earlier (`$t = 'a'` then `-Value $t`
 * writes exactly `a`). Everything else (`$(...)`, `Get-Date`, `$env:X`, a
 * variable built at run time) is state we cannot replay — guessing there would
 * show the reviewer content that is not what gets written.
 */
function literalOf(token, vars) {
  if (typeof token !== 'string' || token.length < 2) return null
  const name = variableNameOf(token)
  if (name !== null) {
    const known = vars === undefined ? undefined : vars.get(name)
    return known === undefined ? null : known
  }
  // A here-string is one argument whose body spans lines: `@'...'@` is literal,
  // `@"..."@` expands exactly like a double-quoted string does.
  const here = hereStringBody(token)
  if (here !== null) return here.interpolates ? expandDouble(here.body, vars) : here.body
  const quoted = wholeQuoted(token)
  if (quoted !== null) {
    // Single quotes never expand; double quotes only when every variable in them
    // is one we watched being assigned.
    return token[0] === '"' ? expandDouble(quoted, vars) : quoted
  }
  // A bare word reaches the cmdlet as written, unless the shell can expand it.
  // The rejected characters are the expansion and scoping syntaxes: `$` (a
  // variable), `(`/`)` (a sub-expression), `@` (a here-string or splat), `{`/`}`
  // (a script block) and `;`/`|`/`,` (statement and list separators).
  // A leftover quote means the token was a *mix* of quoted and unquoted text
  // (`'a'+'b'`), i.e. an expression the shell still has to evaluate; a bare word
  // could never contain one.
  if (/[$(){};|,@'"]/.test(token)) return null
  return token.includes('`') ? unescapeDouble(token) : token
}

/**
 * Substitute the variables we watched being assigned, inside a longer string.
 *
 * `$dir\probe.js` is the ordinary way a script names its output file. Replacing
 * only *known* variables keeps the result exact; anything left over means the
 * shell still has work to do, so the caller keeps the raw text and the gate
 * stays at command level instead of pointing at a name full of `$`.
 *
 * A reference followed by `.` or `[` is property or index access (`$a.Length`),
 * which is not plain substitution, so it is left alone and reported incomplete.
 */
function expandVars(text, vars) {
  if (!text.includes('$')) return { text, complete: true }
  if (vars === undefined || vars.size === 0) return { text, complete: false }
  const replaced = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_:]*)\}|\$([A-Za-z_][A-Za-z0-9_:]*)/g,
    (whole, braced, plain, offset) => {
      const name = String(braced === undefined ? plain : braced).toLowerCase()
      const known = vars.get(name)
      if (known === undefined) return whole
      const after = text[offset + whole.length]
      if (after === '.' || after === '[') return whole
      return known
    },
  )
  return { text: replaced, complete: !replaced.includes('$') }
}

/**
 * Remember `$name = <literal>` so a later `-Value $name` stays knowable.
 *
 * Scripts almost never inline their payload: they build it in a variable first,
 * then hand the variable to the cmdlet. Without tracking those assignments every
 * such write fell back to "the result is not knowable", which is what the panel
 * used to say for perfectly ordinary `Set-Content -Value $content` calls. Only a
 * single literal right-hand side qualifies — `$a = 'x' + $b` needs the shell.
 */
function trackAssignment(statement, vars) {
  let tokens = tokenize(statement)
  // `$t='D:\x'` has no spaces, so tokenizing leaves the assignment as one token.
  // That compact form is at least as common as the spaced one, and missing it
  // meant the very next `Remove-Item $t` fell back to command level.
  if (tokens.length === 1) {
    const compact = /^(\$[A-Za-z_][A-Za-z0-9_:]*)=(.+)$/s.exec(tokens[0])
    if (compact !== null) tokens = [compact[1], '=', compact[2]]
  }
  if (tokens.length !== 3) return
  const name = variableNameOf(tokens[0])
  if (name === null || tokens[1] !== '=') return
  // `$n = Get-Date` has the shape of an assignment but the right-hand side is a
  // *command call*: the variable ends up holding the output, not the word. A
  // bare `verb-noun` is how every cmdlet is spelled, and a bare word that looks
  // like one is far more likely a call than a filename.
  if (/^[a-z][a-z0-9]*-[a-z][a-z0-9]*$/i.test(tokens[2])) return
  const value = literalOf(tokens[2], vars)
  if (value === null) return
  vars.set(name, value)
}

/** Destructive intents of one statement: `{ op, path, value, append }`. */
function shellOpsOf(statement, vars) {
  const tokens = tokenize(statement)
  if (tokens.length === 0) return []
  const ops = []

  // Redirection is destructive no matter which command produces the stream.
  // The left-hand token is only knowable when it is a literal: `$js > f` is
  // produced at run time, `'text' > f` is not.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '>' || token === '>|' || token === '>>' || token === '2>') {
      const next = tokens[i + 1]
      if (next !== undefined) {
        ops.push({
          op: 'write',
          path: stripQuotes(next),
          value: token === '2>' ? null : literalOf(tokens[i - 1], vars),
          append: token === '>>',
        })
      }
      continue
    }
    if (token.length > 1 && token.startsWith('>')) {
      ops.push({
        op: 'write',
        path: stripQuotes(token.replace(/^>+/, '')),
        value: literalOf(tokens[i - 1], vars),
        append: token.includes('>>'),
      })
    }
  }

  const lowered = tokens.map((token) => token.toLowerCase())
  // `-WhatIf` means nothing is touched; never gate a dry run.
  if (lowered.includes('-whatif') || lowered.includes('-wi')) return ops

  let verb = lowered[0]
  // `Microsoft.PowerShell.Management\Remove-Item` is the same cmdlet with its
  // module spelled out; whatever sits in front of the backslash is not a path.
  const moduleCut = verb.lastIndexOf('\\')
  if (moduleCut !== -1 && /^[a-z][a-z0-9.]*$/.test(verb.slice(0, moduleCut))) {
    verb = verb.slice(moduleCut + 1)
  }
  // `cmd.exe`, `node.EXE`, `x.ps1`: the extension never changes what the tool does.
  verb = verb.replace(/\.(?:exe|com|bat|cmd|ps1)$/, '')

  // A .NET member call writes through the framework: `[IO.File]::WriteAllText(…)`.
  // Nothing about it follows the cmdlet conventions, so the call shape is the only
  // signal, and the arguments are positional rather than flagged.
  if (SHELL_MUTATING_MEMBER_RE.test(statement)) {
    const args = callArgumentsOf(statement)
    const deleting = SHELL_MEMBER_DELETE_RE.test(statement)
    // The first argument is a positional path, so it goes through the same
    // literal test as a flagged one would. `WriteAllText($env:TEMP + '\x', 'y')`
    // passes an *expression*; stripping its quotes left the text `…\Temp + '\x'`
    // and the panel showed that as the file about to be written. An expression
    // means the name is unknowable, so it falls back to the command-level review.
    const target = args.length > 0 ? literalOf(args[0], vars) : null
    // ...but the member name is only half the story. `[SHA256]::Create()` shares
    // its name with `[File]::Create('a')` and creates nothing on disk; reviewing
    // it meant stopping the reviewer over a hash object held in memory. The type
    // in front of `::` decides, and a call that neither comes from a disk type nor
    // names a path cannot be about a file at all.
    const memberAt = statement.search(SHELL_MUTATING_MEMBER_RE)
    const owner = memberAt === -1 ? '' : statement.slice(0, memberAt)
    if (target === null && !SHELL_DISK_MEMBER_OWNER.test(owner)) return ops
    ops.push({
      op: deleting ? 'delete' : 'write',
      path: target === null ? verb : target,
      shape: true,
      wildcard: target === null,
      value: deleting || args.length < 2 ? null : literalOf(args[1], vars),
      append: SHELL_MEMBER_APPEND_RE.test(statement),
    })
    return ops
  }

  // `./tool`, `C:\tool.exe`: a program path, not a cmdlet name.
  if (verb.includes('/') || verb.includes('\\')) return ops

  const isDelete = SHELL_DELETE_CMDLETS.has(verb)
  // Emptying a file is an edit, not a removal: the path survives and the result
  // is a known empty string. Conflating the two made `Clear-Content` read as
  // "the file is about to be deleted" and kept it gated inside an exempt request,
  // even though the panel could show the whole content as removed lines.
  const isTruncate = SHELL_TRUNCATE_CMDLETS.has(verb)
  const isWrite = SHELL_WRITE_CMDLETS.has(verb)
  const known = isDelete || isTruncate || isWrite
  const prefixed = !known
    && SHELL_MUTATING_PREFIXES.some((prefix) => verb.startsWith(prefix))
    && !SHELL_HARMLESS_VERBS.has(verb)
  const codeHost = SHELL_CODE_HOSTS.has(verb)
    && lowered.some((item) => SHELL_INLINE_CODE_FLAGS.has(item))
  // An interpreter running source text we can read does not have to be confirmed
  // as a whole: `node -e` that loads a YAML file and prints two numbers touches
  // nothing. Only the interpreters whose payload is ordinary source text are
  // cleared here (`cmd /c`, `bash -c` hand over *shell*, judged elsewhere), and
  // the shortcut is withdrawn the moment the text names a write, a writing open
  // mode, or a way to launch another program.
  if (codeHost && inlineScriptOf(statement) !== null) {
    let clear = false
    try {
      clear = scriptReadsOnly(inlineScriptOf(statement))
    } catch {
      clear = false
    }
    if (clear) return ops
  }
  const runsCode = SHELL_EXEC_ALWAYS.has(verb) || codeHost
  const gitMutating = verb === 'git'
    && lowered.slice(1).some((item) => SHELL_GIT_MUTATING.has(item))
  const unixMutator = SHELL_UNIX_MUTATORS.has(verb)
  if (!known && !prefixed && !runsCode && !gitMutating && !unixMutator) return ops

  if (!known) {
    // Nothing here has flag conventions to read: the payload is a string handed to
    // another program, or git's own arguments. Confirm the command itself rather
    // than inventing a file list. A `remove-…` verb still counts as a removal even
    // without a readable target, so it keeps asking inside an exempt request.
    const removes = gitMutating
      || SHELL_UNIX_REMOVERS.has(verb)
      || SHELL_DELETE_PREFIXES.some((prefix) => verb.startsWith(prefix))
    ops.push({
      op: removes ? 'delete' : 'write',
      path: verb,
      shape: true,
      wildcard: true,
      value: null,
      append: false,
    })
    return ops
  }

  // Emptying a file produces content like any other write — the known empty
  // string — so it takes the write path all the way through: `op: 'write'`, a
  // literal `''` value, and therefore a diff of "every line removed".
  const writes = isWrite || isTruncate
  const op = writes ? 'write' : 'delete'
  const paths = []
  // The content only matters for writes, and only when it is a literal: `-Value
  // $x` and `-Value (Get-Date)` are produced later, so the panel falls back to
  // confirming the command.
  let value = isTruncate ? '' : null
  let positionalSeen = false
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    const lower = lowered[i]
    if (token.startsWith('-')) {
      if (SHELL_VALUE_FLAGS.has(lower)) {
        const next = tokens[i + 1]
        if (SHELL_PATH_FLAGS.has(lower) && next !== undefined && !next.startsWith('-')) {
          for (const part of splitTargetList(next)) paths.push(part)
        }
        if ((lower === '-value' || lower === '-inputobject') && writes && next !== undefined) {
          value = literalOf(next, vars)
        }
        i += 1
      }
      continue
    }
    // Write cmdlets take `-Path` then `-Value` positionally: only the first
    // positional can be a target. Delete cmdlets accept a list of paths.
    if (!isDelete && positionalSeen) {
      if (writes && value === null) value = literalOf(token, vars)
      continue
    }
    positionalSeen = true
    for (const part of splitTargetList(token)) paths.push(part)
  }

  // `Add-Content` and `Out-File -Append` extend the file; the rest replace it.
  const append = SHELL_APPEND_CMDLETS.has(verb) || lowered.includes('-append')
  if (paths.length === 0) {
    // A mutating cmdlet with no target of its own takes its input from a pipeline:
    // `Get-ChildItem | Remove-Item -Force` deletes whatever the left side produced,
    // and that list only exists while the command runs. Confirm the command itself.
    ops.push({ op, path: verb, shape: true, wildcard: true, value: null, append })
    return ops
  }
  for (const path of paths) ops.push({ op, path, value: writes ? value : null, append })
  return ops
}

/** All destructive intents of a command, in source order. */
function parseShellCommand(command) {  const ops = []
  // Assignments are tracked in source order, so a script that builds its payload
  // in a variable and then writes it still yields the exact text being written.
  const vars = new Map()
  let statements = 0
  for (const statement of splitStatements(command)) {
    statements += 1
    // Past the cap we stop guessing and, with no ops collected, the gate lets the
    // command through untouched rather than reviewing a half-parsed command.
    if (statements > SHELL_MAX_STATEMENTS) return []
    trackAssignment(statement, vars)
    for (const item of shellOpsOf(statement, vars)) {
      if (item.path === undefined || item.path === '') continue
      // A path that is itself a variable we watched being assigned resolves the
      // same way the value does: `$p = 'D:\a.txt'; Remove-Item $p` is reviewable.
      const pathVar = variableNameOf(item.path)
      const assigned = pathVar !== null && vars.has(pathVar) ? vars.get(pathVar) : item.path
      // `"$dir\probe.js"` is how scripts name their output; substituting the
      // variables we saw assigned turns it into the real file.
      const path = expandEnvVars(expandVars(assigned, vars).text)
      if (path === '') continue
      // A wildcard or variable target cannot be resolved up front: keep it, but
      // flag it so the gate confirms the command itself instead of pretending to
      // know the files. Without the variable case this silently allowed every
      // delete whose path was built in a variable.
      //
      // `item.wildcard` carries the shape verdict: a shape op whose payload is not
      // a path at all (`git clean -fdx`, `iex $code`) arrives already flagged, and
      // the check below cannot rediscover that from a token like `git`.
      const unknown = item.wildcard === true
        || SHELL_WILDCARD_RE.test(path)
        || isShellExpanded(path)
      ops.push({
        op: item.op,
        path,
        wildcard: unknown,
        // A shape match carries the verb instead of a path: `iex` and `git` are not
        // files, so the record must be able to tell it apart from a wildcard like
        // `D:\x\*`, which is still a real location worth showing.
        shape: item.shape === true,
        // `value` is the literal text the command writes, when the shell does not
        // decide it. It stays attached to a wildcard target because the gate needs
        // to know a wildcard delete carries no content at all.
        value: item.value === undefined ? null : item.value,
        append: item.append === true,
      })
      if (ops.length >= SHELL_MAX_TARGETS) return ops
    }
  }
  return ops
}

/* ------------------------------------------------------------------- http -- */

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeFail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/* ------------------------------------------------------------------- main -- */

function apply(ctx, config) {
  /**
   * Settings live in `cordis.patch.yml` under `config:`; every key is optional
   * and falls back to `DEFAULT_SETTINGS`. The plugin stays dependency-free, so
   * the merge is plain and defensive instead of a schemastery schema.
   */
  const settings = { ...DEFAULT_SETTINGS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = config[key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = value
    }
  }

  /**
   * Whole-file snapshots, so an accepted change can be taken back.
   *
   * `enabled` is read live rather than captured, because it is a setting a
   * reader can flip. The store swallows its own failures: a snapshot that could
   * not be written must never decide whether a tool runs.
   */
  // Named apart from the helper on purpose: `const historyRoot = historyRoot()`
  // would shadow the function and hit its own temporal dead zone.
  const snapshotRoot = historyRoot()
  const history = snapshotRoot === undefined
    ? undefined
    : createHistory({ root: snapshotRoot, enabled: () => settings.history === true })

  /** @type {Map<string, object>} */
  const pending = new Map()
  let counter = 0
  let lastHeartbeat = 0

  /**
   * The turn each session is on, and which sessions have writes waved through.
   *
   * The switch is per session and stays on until it is turned off by hand (or
   * the process restarts): asking once per request turned out to be a promise
   * the reader could not keep track of — every new message silently re-armed the
   * gate, so "I already allowed this" and "why is it asking again" were both true
   * at once.
   *
   * It is keyed by session because one shared flag made two conversations
   * disagree about their own state: switching it off in the conversation on
   * screen also re-armed (or silenced) every other conversation, and the button
   * in a conversation with nothing pending then had no state of its own to show.
   * A switch belongs to the conversation whose writes it covers.
   *
   * `turns` is still tracked, but only for the diagnostics line: knowing which
   * turn a session is on is the difference between "the host reports turns" and
   * "something else is wrong", and that distinction has cost hours before.
   */
  const turns = new Map()
  /** Sessions whose writes are waved through. A Set, because the only state is on. */
  const allowed = new Set()

  ctx.on('session/event', (session, event) => {
    const id = session === null || session === undefined ? undefined : session.id ?? session.header?.id
    if (typeof id !== 'string') return
    if (event === null || typeof event !== 'object') return
    const data = event.data
    if (data === null || typeof data !== 'object') return
    // Every session event carries the turn it belongs to (`tool/call`,
    // `assistant/message`, `turn/start` …), so take the number from whichever
    // one arrives. Relying on `turn/start` alone made the button depend on an
    // event the host may not deliver to plugins at all, and a gate that can
    // never learn its turn can never offer the exemption.
    if (typeof data.turn === 'number') turns.set(id, data.turn)
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      // Turns no longer drive any behaviour, so this is purely a diagnostic —
      // and without it a missing turn number is indistinguishable from a host
      // that never reports turns at all.
      trace(settings, 'turn', { type: event.type, session: id, turn: data.turn ?? null })
    }
  })

  const nextId = () => {
    counter += 1
    return `c${Date.now().toString(36)}${counter.toString(36)}`
  }

  const armed = () => Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS

  /**
   * Record the poller without drowning the log.
   *
   * The browser polls every 1.2 s, so logging each tick would bury the gate
   * events. Log the first contact and every state change (no poller → poller,
   * and poller → gone), which is exactly the transition that arms or disarms
   * the gate.
   */
  let pollerLogged = false
  let pollerLastAt = 0
  const tracePoller = () => {
    const now = Date.now()
    const revived = pollerLastAt !== 0 && now - pollerLastAt > HEARTBEAT_TTL_MS
    if (!pollerLogged || revived) trace(settings, 'poller', { first: !pollerLogged, gapMs: pollerLastAt === 0 ? -1 : now - pollerLastAt })
    pollerLogged = true
    pollerLastAt = now
  }

  /**
   * Resolve the calling session and its directory.
   *
   * `SessionHeader.cwd` is optional on purpose — a session that never committed
   * a directory falls back to the deployment default — so reading the header
   * alone would silently disable the gate. The last resort below is the same
   * Service the host itself consults when it needs the effective directory.
   */
  const dirOf = (session) => {
    if (session === null || typeof session !== 'object') return undefined
    try {
      // Optional access: the Service is present in every shipped profile, but a
      // hard `inject` entry would make this plugin refuse to mount without it.
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined || workingDirectory === null) return undefined
      const value = workingDirectory.get(session)
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** Last resort: the deployment directory the host itself falls back to. */
  const defaultDir = () => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const value = workingDirectory?.defaultDirectory
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  const usableDir = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

  const sessionOf = (exec) => {
    const agent = exec?.agent
    const session = agent?.session
    const header = session?.header ?? session
    if (header === null || typeof header !== 'object') return undefined
    const cwdSource =
      usableDir(header.cwd) ??
      usableDir(session?.cwd) ??
      usableDir(agent?.cwd) ??
      dirOf(session) ??
      defaultDir()
    const idSource = header.id ?? session?.id
    return {
      id: typeof idSource === 'string' ? idSource : undefined,
      cwd: cwdSource,
    }
  }

  /**
   * The part of one reviewed file a list row and a pane header need.
   *
   * Kept separate from the record so a multi-file command can carry one of these
   * per file without the poller handing the browser every row of every diff.
   */
  const fileSummaryOf = (file) => ({
    path: file.path,
    op: file.op,
    kind: file.kind,
    note: file.note,
    computed: file.computed === true,
    truncated: file.truncated === true,
    added: file.added,
    removed: file.removed,
    oldLineCount: file.oldLineCount,
    newLineCount: file.newLineCount,
    bytesBefore: file.bytesBefore,
    bytesAfter: file.bytesAfter,
  })

  const summaryOf = (rec) => ({
    id: rec.id,
    sessionId: rec.sessionId,
    tool: rec.tool,
    path: rec.path,
    displayPath: rec.displayPath,
    fileless: rec.fileless === true,
    op: rec.op,
    added: rec.added,
    removed: rec.removed,
    oldLineCount: rec.oldLineCount,
    newLineCount: rec.newLineCount,
    createdAt: rec.createdAt,
    truncated: rec.truncated,
    reviewable: rec.reviewable,
    reason: rec.reason,
    command: rec.command,
    targets: rec.targets,
    // A command touching several files arrives as one reviewed call with one
    // entry per file: the panel lists them and switches between their diffs.
    files: Array.isArray(rec.files) ? rec.files.map(fileSummaryOf) : undefined,
    kind: rec.kind,
    note: rec.note,
    bytesBefore: rec.bytesBefore,
    bytesAfter: rec.bytesAfter,
    // A command with no diff to show still gets read: the statements it performs
    // are listed instead of one thirty-line block of code.
    steps: Array.isArray(rec.steps) ? rec.steps : undefined,
  })

  const listForSession = (sessionId) => {
    const out = []
    for (const rec of pending.values()) {
      if (sessionId === undefined || rec.sessionId === sessionId) out.push(summaryOf(rec))
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /* ------------------------------------------------------------- gate ---- */

  /**
   * Keep a record of a change the manual switch waved through.
   *
   * The switch promises to stop interrupting, not to stop remembering. Nobody
   * reads the diff, but the bytes the tool is about to replace are still here
   * for this one instant, and a reviewer who later realises what went past can
   * still take it back. The entry is settled as `allowed`, not `accepted`: no
   * one ever looked at it, and the list must not pretend otherwise.
   */
  const rememberAllowed = (rec) => {
    try {
      history?.record(rec)
      history?.settle(rec.sessionId, rec.id, 'allow')
    } catch {
      /* bookkeeping only: it must never decide the tool's fate */
    }
  }

  /**
   * Park a record until the browser half answers it.
   *
   * Resolves with `'accept' | 'reject' | 'cancel' | 'timeout'`. `cancel` comes
   * from `exec.signal` (the user pressed Esc, the turn was interrupted);
   * `timeout` is the last-resort release so an unattended review never wedges
   * the agent.
   */
  const awaitDecision = async (rec, signal, timeoutMs) => {
    const decision = new Promise((resolve) => {
      rec.resolve = resolve
    })
    pending.set(rec.id, rec)
    trace(settings, 'park', {
      id: rec.id,
      tool: rec.tool,
      op: rec.op,
      path: rec.displayPath,
      added: rec.added,
      removed: rec.removed,
      pending: pending.size,
      timeoutMs,
    })
    try {
      return await new Promise((resolve) => {
        let settled = false
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
        const finish = (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        const onAbort = () => finish('cancel')
        if (signal.aborted) {
          finish('cancel')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => finish('timeout'), Math.max(10_000, timeoutMs))
        if (typeof timer.unref === 'function') timer.unref()
        decision.then((value) => finish(value))
      })
    } finally {
      pending.delete(rec.id)
    }
  }

  /** Translate a parked record's verdict into a `tools/pre-execute` decision. */
  const settle = async (rec, exec, next) => {
    // Snapshot before asking, not after. An unanswered review times out and is
    // allowed through (fail-open), and by the time that verdict lands the bytes
    // the change replaced are already gone — the one moment they can still be
    // copied is now.
    try {
      history?.record(rec)
    } catch {
      /* a snapshot that cannot be taken must not decide the tool's fate */
    }
    const outcome = await awaitDecision(rec, exec.signal, rec.timeoutMs ?? settings.timeoutMs)
    try {
      history?.settle(rec.sessionId, rec.id, outcome)
    } catch {
      /* same: bookkeeping only */
    }
    trace(settings, 'verdict', { id: rec.id, tool: rec.tool, op: rec.op, path: rec.displayPath, outcome })
    if (outcome === 'accept') return next()
    if (outcome === 'cancel') return { kind: 'cancel' }
    // Fail open: an unanswered review is not a refusal.
    if (outcome === 'timeout') return next()
    return {
      kind: 'deny',
      reason:
        rec.tool === 'pwsh'
          ? `The user rejected the shell command that touches ${rec.displayPath}.`
          : `The user rejected the change to ${rec.displayPath}.`,
      displayReason: {
        en: 'Rejected in the diff review panel.',
        zh: '已在对比审查面板中拒绝。',
      },
    }
  }

  /**
   * One reviewable file: what it holds now, what it will hold, and how to word it.
   *
   * Every branch in `buildShellRecord` used to compute this inline for the single
   * case, which is exactly why a command touching two files fell back to "the
   * result is not knowable". Splitting it out makes a multi-file command the same
   * calculation repeated, not a special case.
   */
  const describeFile = async ({ path, existed, target, ops, size }, exec) => {
    const kind = contentKind(path)
    const entry = {
      path,
      existed,
      op: 'update',
      kind,
      before: '',
      after: '',
      rows: [],
      added: 0,
      removed: 0,
      oldLineCount: 0,
      newLineCount: 0,
      truncated: false,
      computed: false,
      // Whether the size after the command is knowable at all. A binary file is
      // reported by size alone, so this is its whole diff.
      understood: false,
      bytesBefore: typeof size === 'number' ? size : 0,
      bytesAfter: typeof size === 'number' ? size : 0,
      note: '',
    }
    const anyDelete = ops.some((item) => item.op === 'delete')
    entry.op = !existed ? 'create' : anyDelete ? 'delete' : 'update'

    // A binary file has no lines to compare: the useful fact is the size, and
    // reading it as UTF-8 would only produce a screen of replacement characters.
    // The size after the command is knowable only when the last operation writes
    // a literal or removes the file; `null` says so instead of claiming 0 bytes.
    if (kind !== 'text') {
      let afterBytes = null
      const last = ops[ops.length - 1]
      if (last !== undefined && last.op === 'delete') {
        afterBytes = 0
      } else if (last !== undefined && last.op === 'write' && typeof last.value === 'string') {
        afterBytes = last.append && entry.bytesBefore !== 0
          ? entry.bytesBefore + utf8Bytes(last.value)
          : utf8Bytes(last.value)
      }
      entry.bytesAfter = afterBytes
      // The bytes are known even though the text is not: `understood` is what
      // separates "a binary file, 24 → 1 bytes" from "the shell decides later".
      // `computed` stays false because no line diff exists, and history must not
      // offer a text restore for it.
      entry.understood = afterBytes !== null
      return entry
    }

    // A wildcard target is expanded by the shell, so nothing about the file is
    // knowable: naming it is still worth the prompt, inventing a diff is not.
    if (target === undefined) return entry

    let before = ''
    if (existed) {
      try {
        before = await ctx.fs.readText(target, exec.signal)
      } catch {
        return entry
      }
      if (before.length > MAX_STORED_CHARS) {
        before = before.slice(0, MAX_STORED_CHARS)
        entry.truncated = true
      }
    }
    let next = before
    for (const item of ops) {
      if (item.op === 'delete') {
        next = ''
        continue
      }
      if (typeof item.value !== 'string') return entry
      next = item.append ? next + item.value : item.value
    }
    if (next.length > MAX_STORED_CHARS) {
      next = next.slice(0, MAX_STORED_CHARS)
      entry.truncated = true
    }

    const built = buildRows(before, next)
    entry.before = before
    entry.after = next
    entry.rows = toHunks(built.rows)
    entry.added = built.added
    entry.removed = built.removed
    entry.oldLineCount = built.oldLineCount
    entry.newLineCount = built.newLineCount
    entry.bytesBefore = utf8Bytes(before)
    entry.bytesAfter = utf8Bytes(next)
    entry.computed = true
    // The bytes changed, but only in ways no reviewer needs to hunt through:
    // say which way, then let the reader open the panes if they care.
    if (lineEndingsOnly(before, next)) entry.note = 'line-endings'
    else if (formattingOnly(before, next)) entry.note = 'formatting'
    return entry
  }

  /**
   * Reviewable record for a tool this plugin does not know by name.
   *
   * Only the shape is known: a mutating verb and one or more paths. The paths are
   * resolved and read the same way a file tool's would be, so a third-party
   * filesystem server gets a real before/after whenever its arguments carry the
   * new text. When they do not, the file is still named and the panel says the
   * content is not knowable — which is the truth, and better than a guess.
   */
  const buildIntentRecord = async (exec, session, intent) => {
    const groups = []
    const seen = new Map()
    for (const raw of intent.paths) {
      let resolved
      try {
        resolved = await ctx.fs.resolve(raw, { cwd: session.cwd, signal: exec.signal })
      } catch {
        continue
      }
      const displayPath = resolved.displayPath
      if (settings.skipTemp && isTempPath(displayPath)) continue
      if (settings.skipScratch && isScratchPath(displayPath)) continue
      if (settings.skipSelf && isSelfPath(displayPath)) continue
      if (settings.skipNoise && isNoisePath(displayPath)) continue
      let info
      try {
        info = await ctx.fs.stat(resolved, exec.signal)
      } catch {
        continue
      }
      const existed = info !== undefined
      // Removing what is not there changes nothing, and asking about it would be
      // a prompt with no file behind it.
      if (intent.op === 'delete' && !existed) continue
      if (existed && info.type !== 'file') continue
      if (seen.has(displayPath)) continue
      seen.set(displayPath, true)
      // The content argument, when the call carries exactly one path. Reusing it
      // for several paths would claim the same bytes were written to every one of
      // them, which is a different change from the one being made.
      const value = intent.paths.length === 1 && typeof intent.content === 'string' ? intent.content : null
      groups.push({
        path: displayPath,
        existed,
        target: resolved,
        size: info === undefined ? 0 : info.size,
        ops: [{ op: intent.op, value, append: false }],
      })
    }
    if (groups.length === 0) return undefined

    const files = []
    for (const group of groups) files.push(await describeFile(group, exec))
    const first = files[0]
    const pathList = files.map((item) => item.path).join(', ')
    // Only a call that named one path and carried its new text can be diffed. A
    // call that named a path and nothing else is still worth a prompt — the file
    // is about to change — but the bytes are genuinely unknown, so the panel says
    // exactly that rather than inventing an empty new file.
    const shown = files.length === 1 && first.computed === true

    return {
      id: nextId(),
      sessionId: session.id,
      tool: exec.name,
      path: pathList,
      displayPath: pathList,
      fileless: false,
      op: files.some((item) => item.op === 'delete') ? 'delete' : first.op,
      intent: intent.verb,
      before: shown ? first.before : '',
      after: shown ? first.after : '',
      rows: shown ? first.rows : [],
      added: shown ? first.added : 0,
      removed: shown ? first.removed : 0,
      oldLineCount: shown ? first.oldLineCount : 0,
      newLineCount: shown ? first.newLineCount : 0,
      files: files.length === 1 ? undefined : files,
      createdAt: Date.now(),
      truncated: files.some((item) => item.truncated),
      reviewable: shown || files.some((item) => item.understood === true),
      reason: shown ? undefined : 'shell-command',
      // Nothing was derived here: the arguments never said what the new text
      // would be, so neither an undo nor a diff could be trusted.
      known: false,
      cwd: session.cwd,
      timeoutMs: settings.timeoutMs,
      resolve: undefined,
    }
  }

  /**
   * Reviewable record for a `pwsh` command that deletes or overwrites files.
   *
   * Shell work is confirmed at command level because the resulting bytes are not
   * knowable up front. Two cases are knowable and get a real diff instead:
   * deleting one text file (we can read what is about to be lost) and writing one
   * file from a quoted literal (the text is right there in the command). Anything
   * else reports `reason: 'shell-command'`, which the panel words as "the result
   * is not knowable up front" — a different statement from "too large to show".
   */
  const buildShellRecord = async (exec, session, args) => {
    const command = args.command
    if (typeof command !== 'string' || command.trim() === '') return undefined
    const ops = parseShellCommand(command)
    if (ops.length === 0) return undefined

    const targets = []
    for (const item of ops) {
      if (item.wildcard) {
        // The shell expands it and we cannot: review the command, not the files.
        targets.push({
          op: item.op,
          path: item.path,
          existed: false,
          size: 0,
          target: undefined,
          shape: item.shape === true,
          value: item.value === undefined ? null : item.value,
          append: item.append === true,
        })
        continue
      }
      let resolved
      try {
        resolved = await ctx.fs.resolve(item.path, { cwd: session.cwd, signal: exec.signal })
      } catch {
        continue
      }
      if (settings.skipTemp && isTempPath(resolved.displayPath)) continue
      if (settings.skipScratch && isScratchPath(resolved.displayPath)) continue
      if (settings.skipSelf && isSelfPath(resolved.displayPath)) continue
      if (settings.skipNoise && isNoisePath(resolved.displayPath)) continue
      let info
      try {
        info = await ctx.fs.stat(resolved, exec.signal)
      } catch {
        continue
      }
      if (item.op === 'delete' && info === undefined) continue
      targets.push({
        op: item.op,
        path: resolved.displayPath,
        existed: info !== undefined,
        size: info === undefined ? 0 : info.size,
        target: resolved,
        shape: false,
        value: item.value === undefined ? null : item.value,
        append: item.append === true,
      })
    }
    if (targets.length === 0) return undefined

    // A shape-level match has no file of its own: `iex $code` and `git clean -fdx`
    // touch whatever they touch at run time. Their `path` is the verb, a synthetic
    // marker that keeps the op in the queue — it must never be shown as a file name.
    // A wildcard target (`D:\x\*`) is different: the location is real even though
    // the file list is not, so it keeps its path.
    const fileless = targets.every((item) => item.shape === true)

    // Group the operations by file, keeping first-seen order. One file touched
    // twice is ordinary (`WriteAllText` to seed it, then `Set-Content`), and the
    // outcome has to be replayed in command order — not read off one op.
    const groups = []
    const byPath = new Map()
    for (const item of targets) {
      let group = byPath.get(item.path)
      if (group === undefined) {
        group = { path: item.path, existed: item.existed, target: item.target, size: item.size ?? 0, ops: [] }
        byPath.set(item.path, group)
        groups.push(group)
      }
      // A file created earlier in the same command starts out empty, and a file
      // that already existed keeps its size until it is read.
      group.existed = group.existed || item.existed
      if (item.target !== undefined) group.target = item.target
      if (typeof item.size === 'number' && item.size > 0) group.size = item.size
      group.ops.push({ op: item.op, value: item.value, append: item.append })
    }

    const files = []
    for (const group of groups) files.push(await describeFile(group, exec))

    const first = files[0]
    const multi = files.length > 1
    // Two different questions, deliberately kept apart:
    //  - `computed`: is there a text diff? Only this may drive `known`, because a
    //    snapshot is a copy of the text and a binary file has none to copy.
    //  - `visible`: is there anything at all to show? A binary file qualifies on
    //    its byte counts, which is the whole review for a file with no lines.
    const textDiff = multi
      ? files.every((item) => item.computed === true)
      : first.computed === true
    const visible = multi
      ? files.every((item) => item.computed === true || item.understood === true)
      : first.computed === true || first.understood === true
    const truncated = files.some((item) => item.truncated)
    const reviewable = multi || (visible && first.added + first.removed <= 4000)
    let reason
    // Only the case "we never saw the content" earns the shell-command wording;
    // a literal write that is simply too large keeps the oversized wording.
    if (!visible) reason = 'shell-command'

    // With no diff to show, the command text is the whole review — so it is worth
    // breaking into the steps it performs: switch directory, set a variable, write
    // this file, launch that script. Nothing here is new information: the
    // statement boundaries and their intent were already computed above.
    let steps
    if (!visible) {
      try {
        steps = describeSteps(command)
      } catch {
        steps = undefined
      }
    }

    // A change nobody can see is not worth interrupting for: asking the reviewer
    // to approve bytes that only exist once the shell runs is a prompt they cannot
    // answer. That covers `-Value $x`, `$js > file`, `"hello $env:USERNAME"` — one
    // known file, invisible text. Three shapes stay gated: a delete (it cannot be
    // undone, and the *file* is worth naming even when the content is not), a
    // command touching several files (naming them is the whole review), and a
    // fileless match — `iex $code`, `node -e "…"`, `powershell -EncodedCommand` —
    // where not even the target is knowable, so the effect could be anything.
    if (!visible && !fileless && !targets.some((item) => item.op === 'delete') && files.length === 1) {
      return undefined
    }

    // A command that only touches files which do not exist yet creates them; the
    // badge has to say so, or a brand-new file reads as an edit of nothing.
    const anyDelete = files.some((item) => item.op === 'delete')
    const anyCreate = files.every((item) => item.op === 'create')

    const pathList = files.map((item) => item.path).join(', ')

    return {
      id: nextId(),
      sessionId: session.id,
      tool: 'pwsh',
      // A fileless match has no file to name, and printing the verb there would read
      // as a path the user is about to create. The panel shows the command instead.
      path: fileless ? '' : pathList,
      displayPath: fileless ? '' : pathList,
      fileless,
      // A shape match is neither a create nor an edit of anything nameable, so it
      // gets its own badge rather than claiming the file is new.
      op: fileless ? 'shell' : anyDelete ? 'delete' : anyCreate ? 'create' : 'update',
      command,
      // One entry per file, each carrying its own before/after. The flat fields
      // below stay for the single-file case, which is what most commands are and
      // what every existing panel path reads.
      files: multi ? files : undefined,
      targets: files.map((item) => ({ op: item.op, path: item.path, existed: item.existed })),
      before: multi ? '' : first.before,
      after: multi ? '' : first.after,
      rows: multi ? [] : first.rows,
      added: multi ? 0 : first.added,
      removed: multi ? 0 : first.removed,
      oldLineCount: multi ? 0 : first.oldLineCount,
      newLineCount: multi ? 0 : first.newLineCount,
      kind: multi ? undefined : first.kind,
      note: multi ? undefined : first.note,
      bytesBefore: multi ? undefined : first.bytesBefore,
      bytesAfter: multi ? undefined : first.bytesAfter,
      createdAt: Date.now(),
      truncated,
      reviewable,
      reason,
      steps: steps !== undefined && steps.length > 0 ? steps : undefined,
      // Whether the bytes after this command were derived, not guessed. The
      // snapshot store needs the distinction: only a known outcome can be
      // verified before an undo, and an unverified undo could revert work done
      // after the change being taken back. A multi-file command is only known
      // when every file in it was, and a binary file never is — nothing was read.
      known: textDiff && truncated === false && files.length === 1,
      cwd: session.cwd,
      timeoutMs: settings.shellTimeoutMs,
      resolve: undefined,
    }
  }

  /**
   * Why the last gated call went through untouched.
   *
   * A gate that silently allows everything looks exactly like a gate that is
   * not installed, so every early return records itself here and `list` hands
   * the record to the panel. Without that the only symptom is "nothing
   * happens", which is unreadable on a live UI.
   */
  const diag = {
    gateCalls: 0,
    tools: [],
    lastTool: '',
    lastReason: '',
    lastAt: 0,
    lastKeys: [],
    lastSession: '',
    lastError: '',
    lastArmed: false,
    lastHeartbeatAge: -1,
    lastShape: null,
    recent: [],
  }
  const pass = (reason, next) => {
    diag.lastReason = reason
    diag.lastAt = Date.now()
    // A single "last reason" cannot show a sequence: an unanswered test needs
    // to see that the gate ran, which early return it took, and whether the
    // heartbeat moved between two calls. Keep a short ring buffer instead.
    diag.recent.push({ tool: diag.lastTool, reason, at: diag.lastAt, armed: Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS })
    if (diag.recent.length > 12) diag.recent.shift()
    trace(settings, 'pass', {
      tool: diag.lastTool,
      reason,
      armed: Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS,
      heartbeatAgeMs: lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat,
      keys: diag.lastKeys,
      session: diag.lastSession,
    })
    return next()
  }
  const diagSnapshot = () => ({
    calls: diag.gateCalls,
    tools: diag.tools.slice(0, 24),
    tool: diag.lastTool,
    reason: diag.lastReason,
    at: diag.lastAt,
    heartbeatAgeMs: diag.lastHeartbeatAge,
    armed: diag.lastArmed,
    pending: pending.size,
    keys: diag.lastKeys,
    session: diag.lastSession,
    shape: diag.lastShape,
    error: diag.lastError,
    recent: diag.recent.slice(),
    // Without this the empty panel cannot tell "the host never reported a turn"
    // apart from "the panel looked in the wrong place", and those two have
    // completely different fixes. Turns drive no behaviour now, so it is purely
    // a diagnostic.
    turns: Object.fromEntries(turns),
    allowAll: Object.fromEntries(Array.from(allowed).map((id) => [id, true])),
    settings,
    selfRoot: SELF_ROOT ?? '',
    tempRoots: TEMP_ROOTS,
  })

  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        diag.gateCalls += 1
        diag.lastTool = exec.name
        diag.lastAt = Date.now()
        if (diag.tools.length < 24) diag.tools.push(exec.name)
        const rawArgs = exec.arguments
        diag.lastKeys = rawArgs !== null && typeof rawArgs === 'object' ? Object.keys(rawArgs).slice(0, 12) : []
        // The shape of the execution is the one thing the panel cannot infer:
        // if the gate reads "not-gated" for a name we expected, or "no-session"
        // for a live turn, these fields say why without another restart.
        diag.lastShape = {
          exec: exec !== null && typeof exec === 'object' ? Object.keys(exec).slice(0, 16) : null,
          hasAgent: exec.agent !== undefined && exec.agent !== null,
          agentKeys: exec.agent !== null && typeof exec.agent === 'object' ? Object.keys(exec.agent).slice(0, 10) : null,
          sessionKeys:
            exec.agent?.session !== null && typeof exec.agent?.session === 'object'
              ? Object.keys(exec.agent.session).slice(0, 12)
              : null,
        }
        // Decide what kind of call this is before anything else, because the
        // three diffable tools and everything else are answered differently:
        // the known ones are read exactly, an unknown one is judged by shape.
        const args = exec.arguments
        const hasArgs = args !== null && typeof args === 'object'
        const shellTool = exec.name === 'pwsh'
        const fileTool = DIFFABLE_TOOLS.has(exec.name) && !shellTool
        const intent = hasArgs && !shellTool && !fileTool ? mutatingIntent(exec.name, args) : undefined
        // A tool whose name and arguments carry neither a mutating verb nor a
        // path is not changing a file: `read`, `grep`, `web_fetch`, a viewer, a
        // database query. Those must not be interrupted — asking about a call
        // that cannot touch the disk is exactly the noise this gate exists to
        // avoid.
        if (!shellTool && !fileTool && intent === undefined) return pass('not-mutating', next)
        if (!armed()) {
          diag.lastHeartbeatAge = lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat
          return pass('not-armed', next)
        }
        const session = sessionOf(exec)
        diag.lastSession = session === undefined ? 'none' : `${session.id ?? '?'}@${session.cwd ?? '?'}`
        if (session === undefined || session.cwd === undefined) return pass('no-session', next)

        // Reviewer flipped the manual switch in this conversation: every later
        // write here goes straight through until it is flipped back or the
        // process restarts. A delete is still asked about — the switch promises
        // to stop interrupting for writes, and a removal cannot be undone, so
        // silence there would overrun the promise.
        //
        // Read from the session, not from one shared flag: a switch flipped in
        // the conversation on screen must not silently cover the others.
        const turnAllowed = session.id !== undefined && allowed.has(session.id)

        if (args === null || typeof args !== 'object') return pass('no-args', next)

        if (exec.name === 'pwsh') {
          if (!settings.shell) return pass('shell-disabled', next)
          const command = typeof args.command === 'string' ? args.command : ''
          // With the switch on, a command whose text contains neither a removal nor
          // a shape-level match needs no disk work at all: it can only write.
          const ops = parseShellCommand(command)
          // Nothing was recognised as destructive. When the reason is an inline
          // script that only reads, say so: the log distinguishes "this command
          // never touched a file" from "this command could not be read".
          if (ops.length === 0 && inlineScriptVerdict(command) === 'read-only') {
            return pass('script-read-only', next)
          }
          const inspect = ops.some((item) => item.op === 'delete' || item.shape === true)
          // Even when the switch lets a write through, the record is built first:
          // the panel shows nothing, but the history keeps what was replaced and
          // the change can still be taken back after the fact. Building it is the
          // only chance — once the tool runs, those bytes are gone.
          let rec
          try {
            rec = await buildShellRecord(exec, session, args)
          } catch {
            rec = undefined
            if (turnAllowed === true && !inspect) return pass('allow-all', next)
            return pass('shell-error', next)
          }
          if (rec === undefined) {
            if (turnAllowed === true && !inspect) return pass('allow-all', next)
            return pass('shell-not-destructive', next)
          }
          // The switch is judged on the record, not on the raw text. A command that
          // writes a file and removes it again leaves the workspace exactly as it
          // was: `buildShellRecord` drops a removal whose path did not exist when
          // the command started, so the record still reads `create` or `update`.
          // Keying off the text alone made every "write a scratch file, run it,
          // delete it" command stop for approval although nothing could be lost —
          // and the prompt still carried a diff, so it read as a write being
          // reviewed a second time right after "allow all writes".
          //
          // Only `create` and `update` are waved through here. A removal is gated
          // by definition, and a fileless record (`op: 'shell'` — `iex $code`,
          // `node -e "…"`) has no knowable effect at all, so silence there would
          // overrun what the switch promises.
          if (turnAllowed === true && (rec.op === 'create' || rec.op === 'update')) {
            rememberAllowed(rec)
            return pass('allow-all', next)
          }
          return settle(rec, exec, next)
        }

        // The switch no longer short-circuits here. Each branch below builds its
        // record first and only then decides whether to ask: a change that is
        // waved through still has its previous bytes copied into the history, so
        // "allow all writes" means "stop asking", never "stop remembering".
        //
        // A tool this plugin was not written for, judged only by its shape. The
        // path was named, so the review can at least name the file; the new text
        // is only shown when the call carries it as a string argument, because
        // inventing a diff out of a parameter this plugin does not understand
        // would be worse than saying it is unknown.
        if (intent !== undefined) {
          if (!settings.files) return pass('files-disabled', next)
          let rec
          try {
            rec = await buildIntentRecord(exec, session, intent)
          } catch {
            if (turnAllowed === true) return pass('allow-all', next)
            return pass('intent-error', next)
          }
          if (rec === undefined) {
            if (turnAllowed === true) return pass('allow-all', next)
            return pass('intent-skipped', next)
          }
          if (turnAllowed === true) {
            rememberAllowed(rec)
            return pass('allow-all', next)
          }
          return settle(rec, exec, next)
        }

        if (!settings.files) return pass('files-disabled', next)
        const filePath = args.file_path
        if (typeof filePath !== 'string' || filePath.trim() === '') return pass('no-file-path', next)

        let target
        try {
          target = await ctx.fs.resolve(filePath, { cwd: session.cwd, signal: exec.signal })
        } catch {
          return pass('resolve-failed', next)
        }
        if (settings.skipTemp && isTempPath(target.displayPath)) return pass('temp-skipped', next)
        if (settings.skipScratch && isScratchPath(target.displayPath)) return pass('scratch-skipped', next)
        if (settings.skipSelf && isSelfPath(target.displayPath)) return pass('self-skipped', next)
        if (settings.skipNoise && isNoisePath(target.displayPath)) return pass('noise-skipped', next)

        let existed = false
        let beforeText = ''
        try {
          const info = await ctx.fs.stat(target, exec.signal)
          if (info !== undefined) {
            if (info.type !== 'file') return pass('not-a-file', next)
            existed = true
            beforeText = await ctx.fs.readText(target, exec.signal)
          }
        } catch {
          return pass('stat-failed', next)
        }

        let afterText
        if (exec.name === 'write') {
          if (typeof args.content !== 'string') return pass('no-content', next)
          afterText = args.content
          if (existed && beforeText === afterText) return pass('identical', next)
        } else {
          const oldString = args.old_string
          const newString = args.new_string
          if (typeof oldString !== 'string' || typeof newString !== 'string') return pass('no-edit-strings', next)
          if (oldString === newString) return pass('edit-identical', next)
          if (!existed) return pass('edit-missing-file', next)
          const replaceAll = args.replace_all === true
          const occurrences = oldString === '' ? 0 : beforeText.split(oldString).length - 1
          if (occurrences === 0) return pass('edit-no-match', next)
          if (!replaceAll && occurrences > 1) return pass('edit-ambiguous', next)
          afterText = replaceAll
            ? beforeText.split(oldString).join(newString)
            : beforeText.replace(oldString, () => newString)
          if (afterText === beforeText) return pass('edit-no-change', next)
        }

        let truncated = false
        let storedBefore = beforeText
        let storedAfter = afterText
        if (storedBefore.length > MAX_STORED_CHARS) {
          storedBefore = storedBefore.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
        if (storedAfter.length > MAX_STORED_CHARS) {
          storedAfter = storedAfter.slice(0, MAX_STORED_CHARS)
          truncated = true
        }

        const built = buildRows(storedBefore, storedAfter)
        // A file tool names its path exactly, so the panel can say what kind of
        // file this is and whether the change is only formatting. Without it a
        // re-indented file reads as four hundred real edits, which is the
        // loudest possible way to report nothing.
        const kind = contentKind(target.displayPath)
        let note = ''
        if (kind === 'text' && truncated === false) {
          if (lineEndingsOnly(storedBefore, storedAfter)) note = 'line-endings'
          else if (formattingOnly(storedBefore, storedAfter)) note = 'formatting'
        }
        const rec = {
          id: nextId(),
          sessionId: session.id,
          tool: exec.name,
          path: target.displayPath,
          displayPath: target.displayPath,
          op: existed ? 'update' : 'create',
          before: storedBefore,
          after: storedAfter,
          rows: toHunks(built.rows),
          added: built.added,
          removed: built.removed,
          oldLineCount: built.oldLineCount,
          newLineCount: built.newLineCount,
          kind,
          note,
          bytesBefore: utf8Bytes(storedBefore),
          bytesAfter: utf8Bytes(storedAfter),
          createdAt: Date.now(),
          truncated,
          reviewable: built.added + built.removed <= 4000,
          // A file tool names its bytes exactly, and both sides were read or
          // computed here, so an undo of this change can be verified before it
          // overwrites anything. Truncation is the one exception: the stored
          // text is then not the file, and the snapshot store refuses the undo.
          known: truncated === false,
          cwd: session.cwd,
          timeoutMs: settings.timeoutMs,
          resolve: undefined,
        }

        // Same rule as the shell path: the record is already built, so a waved
        // through write can be remembered without asking about it.
        if (turnAllowed === true) {
          rememberAllowed(rec)
          return pass('allow-all', next)
        }

        return settle(rec, exec, next)
      }),
    'dsh-diff-review: file change gate',
  )

  /* ------------------------------------------------------------- routes -- */

  const api = {
    async list(payload) {
      // Capture the heartbeat state BEFORE this call refreshes it: the panel
      // must be able to show whether the poller was actually alive a moment
      // ago, and reporting the just-refreshed value would always read healthy.
      diag.lastArmed = armed()
      diag.lastHeartbeatAge = lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat
      lastHeartbeat = Date.now()
      tracePoller()
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      const turn = sessionId === undefined ? undefined : turns.get(sessionId)
      return {
        changes: listForSession(sessionId),
        timeoutMs: settings.timeoutMs,
        armed: diag.lastArmed,
        // The switch is per session, so the answer is a table the panel can look
        // its own conversation up in. A single boolean could not carry this: it
        // made every open conversation render the state of whichever one was
        // toggled last, which is exactly how a button came to vanish in a
        // conversation nobody had touched.
        allowAll: Object.fromEntries(Array.from(allowed).map((id) => [id, true])),
        turn: typeof turn === 'number' ? turn : null,
        diag: diagSnapshot(),
      }
    },
    async detail(payload) {
      const id = typeof payload.id === 'string' ? payload.id : ''
      const rec = pending.get(id)
      if (rec === undefined) return { missing: true }
      // One panel exists per Session, and a change belongs to exactly one of
      // them. The id alone is not a permission: a tab showing Session B must
      // not be able to read Session A's diff just because it learned the id
      // from the shared poll. Requests that name no Session stay permissive so
      // the routes remain usable from tools and tests, but every panel names
      // its own.
      const owner = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      if (owner !== undefined && rec.sessionId !== owner) return { missing: true }
      // A command touching several files is one decision with several diffs.
      // The flat fields describe the whole call; `files` carries one full diff
      // per file so the panel can show them one at a time instead of pretending
      // a five-file command has one before/after.
      if (Array.isArray(rec.files) && rec.files.length > 1) {
        return {
          change: summaryOf(rec),
          files: rec.files.map((file) => ({
            path: file.path,
            op: file.op,
            kind: file.kind,
            note: file.note,
            before: file.before,
            after: file.after,
            rows: file.rows,
            added: file.added,
            removed: file.removed,
            oldLineCount: file.oldLineCount,
            newLineCount: file.newLineCount,
            bytesBefore: file.bytesBefore,
            bytesAfter: file.bytesAfter,
            computed: file.computed === true,
          })),
        }
      }
      return {
        change: summaryOf(rec),
        rows: rec.rows,
        before: rec.before,
        after: rec.after,
      }
    },
    async decide(payload) {
      lastHeartbeat = Date.now()
      const id = typeof payload.id === 'string' ? payload.id : ''
      const rec = pending.get(id)
      // The manual switch: turned on or off for one conversation, reported as a
      // table, and kept ahead of the pending lookup because switching off must
      // work from the empty panel too — that is where a reader lands right
      // after allowing everything.
      if (payload.action === 'setAllowAll') {
        const owner = typeof payload.sessionId === 'string' ? payload.sessionId : ''
        if (owner === '') return { missing: true }
        if (payload.value === true) allowed.add(owner)
        else allowed.delete(owner)
        trace(settings, 'allow-all', { value: payload.value === true, session: owner })
        return { ok: true, allowAll: Object.fromEntries(Array.from(allowed).map((id) => [id, true])) }
      }
      if (rec === undefined) return { missing: true }
      // Same ownership rule as `detail`: a panel decides only what it shows.
      // Without this the UI filter was the only thing preventing Session B from
      // answering Session A's prompt, and a filter is a display rule, not an
      // authorization rule.
      const owner = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      if (owner !== undefined && rec.sessionId !== owner) return { missing: true }
      // Flipping the switch on also accepts the change on screen: the reviewer saw
      // enough right here and should not have to answer a second dialog for the
      // very change they just approved. One action so the two cannot disagree.
      // The switch belongs to the record's own session — pressing it in a tab
      // must never wave through some other conversation's writes.
      if (payload.action === 'allowTurn') {
        allowed.add(rec.sessionId)
        trace(settings, 'allow-all', { value: true, id: rec.id, session: rec.sessionId })
        rec.resolve('accept')
        return { ok: true, allowAll: Object.fromEntries(Array.from(allowed).map((id) => [id, true])) }
      }
      const action = payload.action === 'accept' ? 'accept' : 'reject'
      rec.resolve(action)
      return { ok: true }
    },
    /**
     * Changes this conversation already reviewed, newest first.
     *
     * Separate from `list`, which reports what is still waiting: the history
     * outlives the prompt it came from, because the thing a reader wants back
     * is usually the change they accepted a moment ago.
     */
    async history(payload) {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId === '') return { entries: [] }
      return { entries: history?.list(sessionId) ?? [] }
    },
    /**
     * Put one file back the way it was before the reviewed change.
     *
     * Every check here exists because the alternative is destructive: the file
     * on disk may have been written again since, by this conversation or by
     * anything else. Restoring without verifying would silently throw that work
     * away, so a mismatch is refused rather than forced.
     */
    async restore(payload) {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (sessionId === '' || id === '') return { missing: true }
      const found = history?.read(sessionId, id)
      if (found === undefined) return { missing: true }
      const { entry, before } = found
      if (entry.restorable !== true) return { error: 'not-restorable' }
      // No verification basis means no safe undo: without it, the only thing
      // between the reader and a newer version of the file is hope.
      if (entry.verify === null || entry.verify === undefined) return { error: 'not-restorable' }
      // A rejected change never reached the disk, and a pending one may not have
      // yet: undoing either would revert bytes this change never wrote. A change
      // the manual switch waved through did reach the disk, so it can be undone
      // like an accepted one — the only difference is that no one read it first.
      const applied = entry.state === 'accepted' || entry.state === 'timeout' || entry.state === 'allowed'
      if (!applied) return { error: 'not-applied' }
      if (entry.restoredAt !== null && entry.restoredAt !== undefined) return { error: 'already-restored' }
      if (entry.existed === true && typeof before !== 'string') return { error: 'not-restorable' }

      let target
      try {
        target = await ctx.fs.resolve(entry.path, entry.cwd === '' ? {} : { cwd: entry.cwd })
      } catch {
        return { error: 'resolve-failed' }
      }
      let info
      try {
        info = await ctx.fs.stat(target)
      } catch {
        info = undefined
      }
      if (entry.verify.kind === 'absent') {
        // The change removed the file. Undo means creating it again, which is
        // only honest while nothing has taken its place.
        if (info !== undefined) return { error: 'stale' }
      } else {
        if (info === undefined) return { error: 'stale' }
        let current
        try {
          current = await ctx.fs.readText(target)
        } catch {
          return { error: 'stale' }
        }
        if (sha256(current) !== entry.verify.sha) return { error: 'stale' }
      }

      try {
        if (entry.existed === true) await ctx.fs.writeText(target, before ?? '')
        else await ctx.fs.deleteFile(target)
      } catch (error) {
        trace(settings, 'restore-error', { id, message: error instanceof Error ? error.message : String(error) })
        return { error: 'write-failed' }
      }
      history?.markRestored(sessionId, id)
      trace(settings, 'restore', { id, path: entry.path, existed: entry.existed === true })
      return { ok: true }
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (ctx.connection.requestRejection(req) !== undefined) {
            // The fence says no: the most common reason a browser half looks
            // dead is that its requests never arrive, so record the refusal.
            trace(settings, 'route-rejected', { url: req.url ?? '', origin: req.headers?.origin ?? '', host: req.headers?.host ?? '' })
            writeFail(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            trace(settings, 'route-method', { method: req.method ?? '' })
            writeFail(res, 405, 'method-not-allowed', 'POST required')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`)
            ? pathname.slice(API_PREFIX.length + 1)
            : undefined
          const handler = method !== undefined && Object.hasOwn(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') {
            trace(settings, 'route-unknown', { method: String(method) })
            writeFail(res, 404, 'not-found', `unknown method: ${String(method)}`)
            return
          }
          try {
            const payload = await readJsonBody(req)
            const value = await handler(payload)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            trace(settings, 'route-error', { method, message: error instanceof Error ? error.message : String(error) })
            writeFail(res, 400, 'bad-request', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    'dsh-diff-review: api routes',
  )
}

export { apply, inject, NS, API_PREFIX }
